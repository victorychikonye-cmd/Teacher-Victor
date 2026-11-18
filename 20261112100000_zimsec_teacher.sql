-- =====================================================================
-- ZIMSEC AI Teacher (WhatsApp chatbot) · database + monetisation module
-- Supabase / Postgres. Run once (supabase db push, or the SQL editor).
--
-- Students are identified by their WhatsApp number (wa_users). The bot talks to
-- the database with the service-role key only. Staff who use the web dashboard
-- sign in with Supabase Auth (zpay_admins). WhatsApp admins are listed in zpay_wa_admins.
-- Prices are always computed here, never by the bot or a browser.
-- No EcoCash PIN / password / OTP column exists anywhere. Never add one.
-- =====================================================================

-- ---------- 1. Staff ------------------------------------------------
create table zpay_admins (                       -- web dashboard staff (Supabase Auth)
  user_id uuid primary key references auth.users on delete cascade,
  role text not null default 'admin' check (role in ('owner','admin')),
  created_at timestamptz not null default now()
);
create table zpay_wa_admins (                    -- WhatsApp staff, number as 263771234567
  phone text primary key check (phone ~ '^[0-9]{9,15}$'),
  role text not null default 'admin' check (role in ('owner','admin')),
  created_at timestamptz not null default now()
);

create function zpay_is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from zpay_admins where user_id = auth.uid()) $$;
create function zpay_is_owner() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from zpay_admins where user_id = auth.uid() and role = 'owner') $$;
create function zpay_my_role() returns text language sql stable security definer set search_path = public as
$$ select role from zpay_admins where user_id = auth.uid() $$;

-- ---------- 2. Students (WhatsApp) ----------------------------------
create table wa_users (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null check (phone ~ '^[0-9]{9,15}$'),
  name text,
  level text,
  state text not null default 'new',
  ctx jsonb not null default '{}',
  history jsonb not null default '[]',          -- last few tutor turns
  free_day date, free_used int not null default 0,
  ai_day date, ai_count int not null default 0,
  session_until timestamptz,
  notify boolean not null default true,
  blocked boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table wa_seen (msg_id text primary key, at timestamptz not null default now());  -- webhook de-duplication
create table wa_activity (
  id bigserial primary key,
  user_id uuid not null references wa_users on delete cascade,
  kind text not null, subject text, topic text,
  score numeric, out_of numeric,
  at timestamptz not null default now()
);
create index wa_activity_user_ix on wa_activity (user_id, at desc);

-- ---------- 3. Owner settings (single row) --------------------------
create table zpay_settings (
  id boolean primary key default true check (id),
  ecocash_number text not null default '0786610390' check (ecocash_number ~ '^07[78][0-9]{7}$'),
  ecocash_account_name text not null default '',
  support_contact text not null default '',
  currency text not null default 'USD',
  level_multipliers jsonb not null default
    '{"Form 1":1,"Form 2":1,"Form 3":1.1,"Form 4":1.1,"Lower 6":1.25,"Upper 6":1.25}',
  free_daily_questions int not null default 5 check (free_daily_questions between 0 and 100),
  expiry_notice_days int not null default 3 check (expiry_notice_days between 1 and 30),
  order_valid_minutes int not null default 1440 check (order_valid_minutes between 10 and 10080)
);
insert into zpay_settings default values;

-- ---------- 4. Paid services & owner-approved price limits ----------
create table zpay_services (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  description text,
  kind text not null check (kind in ('one_off','access')),   -- credits vs time-limited access
  unit_label text not null default 'item',
  duration_days int check (duration_days > 0),                -- access packages only
  expected_units_per_day numeric(8,2) not null default 0,     -- expected AI usage per day (access)
  ai_cost_per_unit numeric(10,4) not null default 0,          -- measured AI processing cost
  fixed_cost numeric(10,2) not null default 0,
  ops_overhead_pct numeric(5,2) not null default 15,
  margin_pct numeric(5,2) not null default 100,
  min_price numeric(10,2) not null check (min_price > 0),     -- per unit, owner-defined
  max_price numeric(10,2) not null,
  max_units int not null default 50,
  covered_by_access boolean not null default false,           -- included in daily/weekly/monthly access
  enabled boolean not null default true,                      -- owner can suspend
  check (max_price >= min_price),
  check (kind = 'one_off' or duration_days is not null)
);

create table zpay_discounts (
  code text primary key check (code = upper(code)),
  percent numeric(5,2) not null check (percent > 0 and percent <= 90),
  service_id uuid references zpay_services,                  -- null = any service
  starts_at timestamptz, ends_at timestamptz,
  max_uses int, used_count int not null default 0,
  active boolean not null default true
);

-- ---------- 5. Orders, entitlements, seats, receipts, audit ---------
create sequence zpay_receipt_seq;

create table zpay_orders (
  id uuid primary key default gen_random_uuid(),
  reference text unique not null,
  user_id uuid not null references wa_users,
  service_id uuid not null references zpay_services,
  service_name text not null,
  units int not null check (units > 0),
  form_level text,
  unit_price numeric(10,2) not null,
  discount_code text,
  discount_pct numeric(5,2) not null default 0,
  amount numeric(10,2) not null check (amount > 0),
  currency text not null,
  pay_to text not null,                                       -- number shown to the student
  method text not null default 'ecocash',
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment','submitted','verified','rejected','expired','cancelled')),
  ecocash_txn_id text,                                        -- confirmation ID from the SMS (not a secret)
  payer_msisdn text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  submitted_at timestamptz,
  verified_at timestamptz,
  verified_by uuid,                                           -- web admin
  verified_by_label text,                                     -- e.g. 'wa:263771234567'
  verification_source text check (verification_source in ('admin','provider')),
  admin_note text
);
-- One EcoCash transaction ID can back only one live order (blocks duplicate / fraudulent claims)
create unique index zpay_orders_txn_uq on zpay_orders (upper(ecocash_txn_id))
  where ecocash_txn_id is not null and status in ('submitted','verified');
create index zpay_orders_user_ix on zpay_orders (user_id, created_at desc);
create index zpay_orders_status_ix on zpay_orders (status, created_at desc);

create table zpay_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references wa_users,
  service_id uuid not null references zpay_services,
  service_name text not null,
  order_id uuid not null unique references zpay_orders,       -- UNIQUE = no duplicate activation
  status text not null default 'active' check (status in ('active','expired','used')),
  starts_at timestamptz not null,
  expires_at timestamptz,                                      -- null for credit packs
  units int not null,
  units_remaining int,                                         -- credit packs only
  agreed_price numeric(10,2) not null,                         -- locked; never changed afterwards
  notified_at timestamptz,                                     -- expiry reminder sent
  created_at timestamptz not null default now()
);
create index zpay_ent_user_ix on zpay_entitlements (user_id, status, expires_at);

create table zpay_seats (                                      -- school subscription seats
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references zpay_entitlements on delete cascade,
  user_id uuid not null references wa_users,
  added_at timestamptz not null default now(),
  unique (entitlement_id, user_id)
);

create table zpay_receipts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references zpay_orders,
  user_id uuid not null,
  receipt_no text unique not null,
  issued_at timestamptz not null default now()
);

create table zpay_price_recs (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references zpay_services,
  current_ai_cost numeric(10,4), current_margin numeric(5,2), current_unit_price numeric(10,2),
  proposed_ai_cost numeric(10,4) not null, proposed_margin numeric(5,2) not null,
  proposed_unit_price numeric(10,2) not null,                  -- already clamped to min/max
  rationale text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  decided_by uuid, decided_at timestamptz
);

create table zpay_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor uuid, action text not null, entity text, entity_id text, details jsonb
);
create function zpay_audit_immutable() returns trigger language plpgsql as
$$ begin raise exception 'audit log is append-only'; end $$;
create trigger zpay_audit_no_change before update or delete on zpay_audit
  for each row execute function zpay_audit_immutable();

create function zpay_log(p_action text, p_entity text, p_id text, p_details jsonb default '{}')
returns void language sql security definer set search_path = public as
$$ insert into zpay_audit (actor, action, entity, entity_id, details) values (auth.uid(), p_action, p_entity, p_id, p_details) $$;

-- Every change to settings / services / discounts is logged with old and new values
create function zpay_audit_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform zpay_log(tg_op || ' ' || tg_table_name, tg_table_name,
    coalesce(to_jsonb(new)->>'id', to_jsonb(new)->>'code'),
    jsonb_build_object('old', case when tg_op = 'INSERT' then null else to_jsonb(old) end, 'new', to_jsonb(new)));
  return new;
end $$;
create trigger zpay_settings_audit  after insert or update on zpay_settings  for each row execute function zpay_audit_change();
create trigger zpay_services_audit  after insert or update on zpay_services  for each row execute function zpay_audit_change();
create trigger zpay_discounts_audit after insert or update on zpay_discounts for each row execute function zpay_audit_change();

-- ---------- 6. Pricing engine ---------------------------------------
-- cost-plus: (AI cost + fixed) x (1+overhead) x (1+margin) x level multiplier,
-- rounded to 5c, then CLAMPED to the owner's min/max. Always per unit.
create function zpay_unit_price(s zpay_services, p_level text, p_ai_cost numeric default null, p_margin numeric default null)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare m numeric; base numeric; p numeric;
  c numeric := coalesce(p_ai_cost, s.ai_cost_per_unit);
  g numeric := coalesce(p_margin, s.margin_pct);
begin
  select (level_multipliers->>p_level)::numeric into m from zpay_settings;
  m := coalesce(m, 1);
  base := case when s.kind = 'access'
               then coalesce(s.duration_days,1) * s.expected_units_per_day * c + s.fixed_cost
               else c + s.fixed_cost end;
  p := round(base * (1 + s.ops_overhead_pct/100) * (1 + g/100) * m * 20) / 20;
  return least(greatest(p, s.min_price), s.max_price);
end $$;

create function zpay_discount_pct(p_code text, p_service uuid) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare d zpay_discounts;
begin
  if p_code is null or trim(p_code) = '' then return 0; end if;
  select * into d from zpay_discounts
   where code = upper(trim(p_code)) and active
     and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
     and (max_uses is null or used_count < max_uses) and (service_id is null or service_id = p_service);
  if not found then raise exception 'Invalid or expired discount code'; end if;
  return d.percent;
end $$;

-- Read-only price preview shown BEFORE any payment is started
create function zpay_quote(p_user uuid, p_service text, p_units int default 1, p_level text default null, p_discount text default null)
returns table (unit_price numeric, discount_pct numeric, amount numeric, currency text)
language plpgsql stable security definer set search_path = public as $$
declare s zpay_services; up numeric; pct numeric; cur text;
begin
  if p_user is null then raise exception 'Unknown student'; end if;
  select * into s from zpay_services where code = p_service and enabled;
  if not found then raise exception 'This service is currently unavailable'; end if;
  if p_units < 1 or p_units > s.max_units then raise exception 'Quantity must be between 1 and %', s.max_units; end if;
  up := zpay_unit_price(s, p_level);
  pct := zpay_discount_pct(p_discount, s.id);
  select z.currency into cur from zpay_settings z;
  return query select up, pct, round(up * p_units * (1 - pct/100), 2), cur;
end $$;

-- ---------- 7. Payment workflow -------------------------------------
create function zpay_create_order(p_user uuid, p_service text, p_units int default 1, p_level text default null, p_discount text default null)
returns zpay_orders language plpgsql security definer set search_path = public as $$
declare s zpay_services; st zpay_settings; o zpay_orders; up numeric; pct numeric; amt numeric;
begin
  if p_user is null then raise exception 'Unknown student'; end if;
  select * into s from zpay_services where code = p_service and enabled;
  if not found then raise exception 'This service is currently unavailable'; end if;
  if p_units < 1 or p_units > s.max_units then raise exception 'Quantity must be between 1 and %', s.max_units; end if;
  select * into st from zpay_settings;
  -- Idempotent: the same open request returns the same order (no duplicate transactions)
  select * into o from zpay_orders
   where user_id = p_user and service_id = s.id and units = p_units
     and coalesce(form_level,'') = coalesce(p_level,'')
     and coalesce(discount_code,'') = coalesce(upper(nullif(trim(p_discount),'')),'')
     and status = 'awaiting_payment' and expires_at > now()
   order by created_at desc limit 1;
  if found then return o; end if;
  if (select count(*) from zpay_orders where user_id = p_user and status = 'awaiting_payment' and expires_at > now()) >= 5 then
    raise exception 'You have too many unpaid orders. Pay or cancel one first.'; end if;
  up  := zpay_unit_price(s, p_level);
  pct := zpay_discount_pct(p_discount, s.id);
  amt := round(up * p_units * (1 - pct/100), 2);
  insert into zpay_orders (reference, user_id, service_id, service_name, units, form_level, unit_price,
                           discount_code, discount_pct, amount, currency, pay_to, expires_at)
  values ('ZAT-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)), p_user, s.id, s.name, p_units,
          p_level, up, upper(nullif(trim(p_discount),'')), pct, amt, st.currency, st.ecocash_number,
          now() + make_interval(mins => st.order_valid_minutes))
  returning * into o;
  perform zpay_log('order_created','order',o.id::text,jsonb_build_object('reference',o.reference,'amount',o.amount,'user',p_user));
  return o;
end $$;

-- Student submits the EcoCash confirmation ID. This does NOT activate anything.
create function zpay_submit_payment(p_user uuid, p_order uuid, p_txn text, p_msisdn text)
returns zpay_orders language plpgsql security definer set search_path = public as $$
declare o zpay_orders;
  t text := upper(trim(coalesce(p_txn,'')));
  m text := regexp_replace(coalesce(p_msisdn,''), '[^0-9]', '', 'g');
begin
  if t !~ '^[A-Z0-9.-]{6,30}$' then
    raise exception 'That does not look like an EcoCash transaction ID. Copy it exactly from the confirmation SMS.'; end if;
  if m !~ '^(07[78][0-9]{7}|2637[78][0-9]{7})$' then
    raise exception 'Enter the EcoCash number you paid from, e.g. 0771234567'; end if;
  if (select count(*) from zpay_audit where action = 'payment_submitted' and details->>'user' = p_user::text
        and at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many attempts. Please try again later.'; end if;
  select * into o from zpay_orders where id = p_order and user_id = p_user for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status not in ('awaiting_payment','expired') then raise exception 'This order is already %', o.status; end if;
  begin
    update zpay_orders set status = 'submitted', ecocash_txn_id = t, payer_msisdn = m, submitted_at = now()
     where id = o.id returning * into o;
  exception when unique_violation then
    raise exception 'This transaction ID has already been used';
  end;
  perform zpay_log('payment_submitted','order',o.id::text,jsonb_build_object('reference',o.reference,'txn',t,'user',p_user));
  return o;
end $$;

create function zpay_cancel_order(p_user uuid, p_order uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  update zpay_orders set status = 'cancelled' where id = p_order and user_id = p_user and status = 'awaiting_payment';
end $$;

-- INTERNAL. The single place where access is granted. Idempotent and row-locked, so a
-- double click, a retry or a provider webhook can never activate the same order twice.
-- To add automated EcoCash verification later: an Edge Function (service role) that checks the
-- provider's signed callback (amount + reference match), then calls this with p_source = 'provider'.
create function zpay_activate_order(p_order uuid, p_actor uuid, p_source text, p_note text default null, p_actor_label text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o zpay_orders; s zpay_services; v_start timestamptz; v_end timestamptz;
begin
  select * into o from zpay_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'verified' then return; end if;
  if o.status in ('rejected','cancelled') then raise exception 'Order is %', o.status; end if;
  select * into s from zpay_services where id = o.service_id;
  update zpay_orders set status = 'verified', verified_at = now(), verified_by = p_actor, verified_by_label = p_actor_label,
         verification_source = p_source, admin_note = coalesce(p_note, admin_note) where id = o.id;
  if s.kind = 'access' then
    -- stack on top of an existing active period so the student never loses paid days
    select greatest(now(), coalesce(max(expires_at), now())) into v_start from zpay_entitlements
     where user_id = o.user_id and service_id = s.id and status = 'active' and expires_at > now();
    v_end := v_start + make_interval(days => s.duration_days);
  else
    v_start := now(); v_end := null;
  end if;
  insert into zpay_entitlements (user_id, service_id, service_name, order_id, starts_at, expires_at, units, units_remaining, agreed_price)
  values (o.user_id, s.id, o.service_name, o.id, v_start, v_end, o.units,
          case when s.kind = 'one_off' then o.units end, o.unit_price)
  on conflict (order_id) do nothing;
  insert into zpay_receipts (order_id, user_id, receipt_no)
  values (o.id, o.user_id, 'RCT-' || to_char(now() at time zone 'Africa/Harare','YYMMDD') || '-' || lpad(nextval('zpay_receipt_seq')::text, 5, '0'))
  on conflict (order_id) do nothing;
  if o.discount_code is not null then update zpay_discounts set used_count = used_count + 1 where code = o.discount_code; end if;
  perform zpay_log('order_verified','order',o.id::text,
    jsonb_build_object('source',p_source,'actor',p_actor,'by',p_actor_label,'amount',o.amount,'reference',o.reference));
end $$;

-- Web dashboard verification (Supabase Auth admins)
create function zpay_admin_verify(p_order uuid, p_approve boolean, p_note text default null)
returns zpay_orders language plpgsql security definer set search_path = public as $$
declare o zpay_orders;
begin
  if not zpay_is_admin() then raise exception 'Not authorised'; end if;
  select * into o from zpay_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if p_approve then
    if o.status not in ('submitted','verified') then raise exception 'Only submitted payments can be verified'; end if;
    perform zpay_activate_order(o.id, auth.uid(), 'admin', p_note, 'web');
  else
    if o.status not in ('submitted','awaiting_payment') then raise exception 'Cannot reject an order that is %', o.status; end if;
    update zpay_orders set status = 'rejected', admin_note = p_note, verified_by = auth.uid(), verified_by_label = 'web', verified_at = now() where id = o.id;
    perform zpay_log('order_rejected','order',o.id::text,jsonb_build_object('note',p_note,'reference',o.reference,'by','web'));
  end if;
  select * into o from zpay_orders where id = p_order;
  return o;
end $$;

-- WhatsApp verification (admins listed in zpay_wa_admins). Called by the bot only.
create function zpay_wa_verify(p_admin_phone text, p_reference text, p_approve boolean, p_note text default null)
returns zpay_orders language plpgsql security definer set search_path = public as $$
declare o zpay_orders; payer text;
begin
  if not exists (select 1 from zpay_wa_admins where phone = p_admin_phone) then raise exception 'Not authorised'; end if;
  select * into o from zpay_orders where reference = upper(trim(p_reference)) for update;
  if not found then raise exception 'Order not found'; end if;
  select phone into payer from wa_users where id = o.user_id;
  if payer = p_admin_phone then raise exception 'You cannot verify your own payment. Use another admin or the web dashboard.'; end if;
  if p_approve then
    if o.status not in ('submitted','verified') then raise exception 'Only submitted payments can be verified (this one is %)', o.status; end if;
    perform zpay_activate_order(o.id, null, 'admin', p_note, 'wa:' || p_admin_phone);
  else
    if o.status not in ('submitted','awaiting_payment') then raise exception 'Cannot reject an order that is %', o.status; end if;
    update zpay_orders set status = 'rejected', admin_note = p_note, verified_by_label = 'wa:' || p_admin_phone, verified_at = now() where id = o.id;
    perform zpay_log('order_rejected','order',o.id::text,jsonb_build_object('note',p_note,'reference',o.reference,'by','wa:' || p_admin_phone));
  end if;
  select * into o from zpay_orders where id = o.id;
  return o;
end $$;

-- ---------- 8. Access checks ----------------------------------------
create function zpay_has_access(p_user uuid, p_services text[]) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from zpay_entitlements e join zpay_services s on s.id = e.service_id
     where s.code = any (p_services) and s.enabled and e.status = 'active'
       and e.starts_at <= now() and (e.expires_at is null or e.expires_at > now())
       and (e.units_remaining is null or e.units_remaining > 0)
       and (e.user_id = p_user or exists (select 1 from zpay_seats z where z.entitlement_id = e.id and z.user_id = p_user))) $$;

-- Use one credit of a one-off service (tutoring session, assignment, mock exam...)
create function zpay_consume_unit(p_user uuid, p_service text) returns int language plpgsql security definer set search_path = public as $$
declare eid uuid; remaining int;
begin
  select e.id into eid from zpay_entitlements e join zpay_services s on s.id = e.service_id
   where e.user_id = p_user and s.code = p_service and s.enabled and e.status = 'active' and e.units_remaining > 0
   order by e.starts_at limit 1 for update of e skip locked;
  if eid is null then raise exception 'No remaining credits for this service'; end if;
  update zpay_entitlements set units_remaining = units_remaining - 1,
         status = case when units_remaining - 1 = 0 then 'used' else status end
   where id = eid returning units_remaining into remaining;
  return remaining;
end $$;

-- School subscription: the buyer adds student seats by WhatsApp number
create function zpay_add_seat(p_user uuid, p_phone text) returns jsonb language plpgsql security definer set search_path = public as $$
declare e zpay_entitlements; n int; target uuid;
  ph text := regexp_replace(coalesce(p_phone,''), '[^0-9]', '', 'g');
begin
  if ph ~ '^07[0-9]{8}$' then ph := '263' || substr(ph, 2); end if;
  if ph !~ '^263[0-9]{9}$' then raise exception 'Enter a valid Zimbabwe mobile number, e.g. 0771234567'; end if;
  select e2.* into e from zpay_entitlements e2 join zpay_services s on s.id = e2.service_id
   where e2.user_id = p_user and s.code = 'school_term' and e2.status = 'active' and e2.expires_at > now()
   order by e2.expires_at desc limit 1 for update of e2;
  if not found then raise exception 'You do not have an active school subscription'; end if;
  insert into wa_users (phone) values (ph) on conflict (phone) do nothing;
  select id into target from wa_users where phone = ph;
  if target = p_user then raise exception 'You already have access with this subscription'; end if;
  if exists (select 1 from zpay_seats where entitlement_id = e.id and user_id = target) then
    raise exception 'That student already has a seat'; end if;
  select count(*) into n from zpay_seats where entitlement_id = e.id;
  if n >= e.units then raise exception 'All % seats are in use', e.units; end if;
  insert into zpay_seats (entitlement_id, user_id) values (e.id, target);
  perform zpay_log('seat_added','entitlement',e.id::text,jsonb_build_object('student',ph,'by',p_user));
  return jsonb_build_object('phone', ph, 'used', n + 1, 'total', e.units, 'expires_at', e.expires_at);
end $$;

-- Expiry job. Access is also time-checked live in zpay_has_access, so lag here is harmless.
create function zpay_run_maintenance() returns void language plpgsql security definer set search_path = public as $$
begin
  update zpay_orders set status = 'expired' where status = 'awaiting_payment' and expires_at < now();
  update zpay_entitlements set status = 'expired' where status = 'active' and expires_at is not null and expires_at <= now();
  delete from wa_seen where at < now() - interval '3 days';
end $$;

-- ---------- 9. Owner dashboard --------------------------------------
create function zpay_public_config() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ecocash_number', ecocash_number, 'ecocash_name', ecocash_account_name,
    'currency', currency, 'expiry_notice_days', expiry_notice_days, 'order_valid_minutes', order_valid_minutes,
    'levels', (select coalesce(jsonb_agg(k order by k), '[]') from jsonb_object_keys(level_multipliers) k))
  from zpay_settings $$;

create function zpay_dashboard_data() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare tz constant text := 'Africa/Harare'; v_today date := (now() at time zone 'Africa/Harare')::date; r jsonb;
begin
  select jsonb_build_object(
    'currency', (select currency from zpay_settings),
    'total_revenue', coalesce(sum(o.amount) filter (where o.status = 'verified'), 0),
    'today', coalesce(sum(o.amount) filter (where o.status = 'verified' and (o.verified_at at time zone tz)::date = v_today), 0),
    'week',  coalesce(sum(o.amount) filter (where o.status = 'verified' and (o.verified_at at time zone tz)::date >= date_trunc('week', v_today::timestamp)::date), 0),
    'month', coalesce(sum(o.amount) filter (where o.status = 'verified' and (o.verified_at at time zone tz)::date >= date_trunc('month', v_today::timestamp)::date), 0),
    'subscription_revenue', coalesce(sum(o.amount) filter (where o.status = 'verified' and s.kind = 'access'), 0),
    'paying_students', count(distinct o.user_id) filter (where o.status = 'verified'),
    'successful', count(*) filter (where o.status = 'verified'),
    'pending_verification', count(*) filter (where o.status = 'submitted'),
    'awaiting_payment', count(*) filter (where o.status = 'awaiting_payment'),
    'failed', count(*) filter (where o.status in ('rejected','expired','cancelled'))
  ) into r from zpay_orders o join zpay_services s on s.id = o.service_id;
  r := r || jsonb_build_object(
    'top_services', (select coalesce(jsonb_agg(t), '[]') from (
        select s.name, count(*) as purchases, sum(o.amount) as revenue
          from zpay_orders o join zpay_services s on s.id = o.service_id
         where o.status = 'verified' group by s.name order by count(*) desc limit 5) t),
    'daily', (select jsonb_agg(d order by d.day) from (
        select (v_today - i) as day,
               coalesce((select sum(x.amount) from zpay_orders x where x.status = 'verified'
                          and (x.verified_at at time zone tz)::date = (v_today - i)), 0) as revenue
          from generate_series(0, 13) i) d));
  return r;
end $$;

create function zpay_dashboard() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not zpay_is_admin() then raise exception 'Not authorised'; end if;
  return zpay_dashboard_data();
end $$;

create function zpay_wa_summary(p_admin_phone text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from zpay_wa_admins where phone = p_admin_phone) then raise exception 'Not authorised'; end if;
  return zpay_dashboard_data();
end $$;

create function zpay_admin_transactions(p_status text default null, p_search text default null, p_limit int default 100)
returns table (id uuid, reference text, created_at timestamptz, status text, amount numeric, currency text,
  service_name text, units int, user_phone text, user_name text, ecocash_txn_id text, payer_msisdn text,
  submitted_at timestamptz, verified_at timestamptz, admin_note text, pay_to text, receipt_no text, verified_by_label text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not zpay_is_admin() then raise exception 'Not authorised'; end if;
  return query
  select o.id, o.reference, o.created_at, o.status, o.amount::numeric, o.currency, o.service_name, o.units,
         u.phone, u.name, o.ecocash_txn_id, o.payer_msisdn,
         o.submitted_at, o.verified_at, o.admin_note, o.pay_to, r.receipt_no, o.verified_by_label
    from zpay_orders o
    left join wa_users u on u.id = o.user_id
    left join zpay_receipts r on r.order_id = o.id
   where (p_status is null or o.status = p_status)
     and (p_search is null or p_search = '' or o.reference ilike '%' || p_search || '%'
          or o.ecocash_txn_id ilike '%' || p_search || '%' or u.phone like '%' || p_search || '%'
          or o.payer_msisdn like '%' || p_search || '%')
   order by o.created_at desc limit least(p_limit, 500);
end $$;

create function zpay_export_report(p_from date, p_to date)
returns table (receipt_no text, reference text, verified_at timestamptz, service text, units int, unit_price numeric,
  discount_pct numeric, amount numeric, currency text, ecocash_txn_id text, payer_msisdn text, student_phone text)
language plpgsql security definer set search_path = public as $$
begin
  if not zpay_is_owner() then raise exception 'Owner only'; end if;
  perform zpay_log('report_exported','report',null,jsonb_build_object('from',p_from,'to',p_to));
  return query
  select r.receipt_no, o.reference, o.verified_at, o.service_name, o.units, o.unit_price::numeric, o.discount_pct::numeric,
         o.amount::numeric, o.currency, o.ecocash_txn_id, o.payer_msisdn, u.phone
    from zpay_orders o join zpay_receipts r on r.order_id = o.id left join wa_users u on u.id = o.user_id
   where o.status = 'verified'
     and (o.verified_at at time zone 'Africa/Harare')::date between p_from and p_to
   order by o.verified_at;
end $$;

-- ---------- 10. AI price recommendations (owner approves) -----------
-- Called only by the price-advisor Edge Function (service role).
create function zpay_insert_rec(p_service uuid, p_cost numeric, p_margin numeric, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare s zpay_services; rid uuid;
begin
  select * into s from zpay_services where id = p_service;
  if not found then raise exception 'Unknown service'; end if;
  if p_cost < 0 or p_margin < 0 or p_margin > 300 then raise exception 'Recommendation out of range'; end if;
  insert into zpay_price_recs (service_id, current_ai_cost, current_margin, current_unit_price,
                               proposed_ai_cost, proposed_margin, proposed_unit_price, rationale)
  values (s.id, s.ai_cost_per_unit, s.margin_pct, zpay_unit_price(s, null),
          p_cost, p_margin, zpay_unit_price(s, null, p_cost, p_margin), left(p_reason, 1000))
  returning id into rid;
  return rid;
end $$;

-- Approving changes the price for NEW orders only. Open orders keep their quoted amount and
-- active entitlements keep agreed_price, so no customer's agreed price changes without consent.
create function zpay_decide_rec(p_rec uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r zpay_price_recs;
begin
  if not zpay_is_owner() then raise exception 'Owner only'; end if;
  select * into r from zpay_price_recs where id = p_rec and status = 'pending' for update;
  if not found then raise exception 'Recommendation not found or already decided'; end if;
  if p_approve then
    update zpay_services set ai_cost_per_unit = r.proposed_ai_cost, margin_pct = r.proposed_margin where id = r.service_id;
  end if;
  update zpay_price_recs set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now() where id = r.id;
  perform zpay_log('price_rec_' || case when p_approve then 'approved' else 'rejected' end, 'price_rec', r.id::text, to_jsonb(r));
end $$;

-- ---------- 11. Row Level Security ----------------------------------
-- Student-facing tables (wa_*, seats) have NO policies: only the bot (service role) can touch them.
do $$ declare t text; begin
  foreach t in array array['zpay_admins','zpay_wa_admins','zpay_settings','zpay_services','zpay_discounts','zpay_orders',
                           'zpay_entitlements','zpay_seats','zpay_receipts','zpay_price_recs','zpay_audit',
                           'wa_users','wa_seen','wa_activity'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
  end loop;
  foreach t in array array['zpay_orders','zpay_entitlements','zpay_seats','zpay_receipts','zpay_price_recs','zpay_audit',
                           'zpay_admins','zpay_wa_admins','wa_users','wa_seen','wa_activity'] loop
    execute format('revoke insert, update, delete on %I from authenticated', t);   -- writes only via functions
  end loop;
  revoke select on wa_users, wa_seen, wa_activity, zpay_seats, zpay_wa_admins from authenticated;
end $$;

create policy admins_read    on zpay_admins       for select using (zpay_is_admin());
create policy settings_read  on zpay_settings     for select using (zpay_is_admin());
create policy settings_upd   on zpay_settings     for update using (zpay_is_owner()) with check (zpay_is_owner());
create policy services_read  on zpay_services     for select using (zpay_is_admin());
create policy services_ins   on zpay_services     for insert with check (zpay_is_owner());
create policy services_upd   on zpay_services     for update using (zpay_is_owner()) with check (zpay_is_owner());
create policy disc_read      on zpay_discounts    for select using (zpay_is_admin());
create policy disc_ins       on zpay_discounts    for insert with check (zpay_is_owner());
create policy disc_upd       on zpay_discounts    for update using (zpay_is_owner()) with check (zpay_is_owner());
create policy recs_read      on zpay_price_recs   for select using (zpay_is_admin());
create policy orders_read    on zpay_orders       for select using (zpay_is_admin());
create policy ent_read       on zpay_entitlements for select using (zpay_is_admin());
create policy receipts_read  on zpay_receipts     for select using (zpay_is_admin());
create policy audit_read     on zpay_audit        for select using (zpay_is_admin());

-- Function permissions: lock everything, then open only what each role needs.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'zpay\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    if r.proname in ('zpay_is_admin','zpay_is_owner','zpay_my_role','zpay_public_config','zpay_admin_verify',
                     'zpay_admin_transactions','zpay_dashboard','zpay_export_report','zpay_decide_rec')
    then execute format('grant execute on function %s to authenticated', r.sig); end if;
    if r.proname in ('zpay_quote','zpay_create_order','zpay_submit_payment','zpay_cancel_order','zpay_has_access',
                     'zpay_consume_unit','zpay_add_seat','zpay_wa_verify','zpay_wa_summary','zpay_public_config',
                     'zpay_insert_rec','zpay_activate_order','zpay_run_maintenance')
    then execute format('grant execute on function %s to service_role', r.sig); end if;
  end loop;
end $$;

-- ---------- 12. Starter catalogue (EXAMPLE numbers: replace with your real costs) ----------
insert into zpay_services
 (code, name, description, kind, unit_label, duration_days, expected_units_per_day, ai_cost_per_unit, ops_overhead_pct, margin_pct, min_price, max_price, max_units, covered_by_access) values
 ('premium_tutoring','Premium AI Tutoring','30-minute premium tutoring session with unlimited questions','one_off','session',null,0,0.10,20,300,0.25,2.00,50,true),
 ('extra_assignment','Additional Assignments','Extra ZIMSEC-style practice assignment with AI marking','one_off','assignment',null,0,0.06,20,300,0.25,1.50,20,true),
 ('mock_exam','Mock Examination','Full timed mock paper with AI marking and feedback','one_off','paper',null,0,0.25,20,300,0.50,3.00,10,false),
 ('advanced_revision','Advanced Revision Materials','In-depth revision notes and practice questions','one_off','pack',null,0,0.12,20,300,0.50,3.00,10,true),
 ('performance_report','Detailed Performance Report','Topic-by-topic strengths, weaknesses and a study plan','one_off','report',null,0,0.05,20,300,0.25,1.50,10,true),
 ('premium_daily','Premium Access - 1 Day','Unlimited premium features for 24 hours','access','day',1,10,0.01,20,100,0.50,1.00,1,false),
 ('premium_weekly','Premium Access - 1 Week','Unlimited premium features for 7 days','access','week',7,10,0.01,20,100,2.00,4.00,1,false),
 ('premium_monthly','Monthly Premium Membership','Unlimited premium features for 30 days','access','month',30,10,0.01,20,100,5.00,10.00,1,false),
 ('school_term','School Subscription (per term)','Term-long access for each student seat at your school','access','student',90,8,0.01,20,50,3.00,12.00,2000,false);
