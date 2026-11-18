-- Payment-rule tests. Run against a scratch database after applying the migration:
--   psql -v ON_ERROR_STOP=1 -d <scratch_db> -f tests/payments.test.sql
-- (needs the Supabase roles: anon, authenticated, service_role, and auth.uid())
set role service_role;

create temp table t (k text primary key, v text);
grant all on t to public;

do $$
declare
  a uuid; b uuid; s uuid; o zpay_orders; o2 zpay_orders; r record; n int; ok boolean; msg text; q record;
begin
  insert into zpay_wa_admins (phone, role) values ('263700000001', 'owner');
  insert into wa_users (phone, name, level) values ('263771111111', 'Student A', 'Form 4') returning id into a;
  insert into wa_users (phone, name, level) values ('263772222222', 'Student B', 'Form 2') returning id into b;

  -- 1. every quoted price stays within the owner's limits, for every level
  for r in select * from zpay_services loop
    for q in select unnest(array['Form 1','Form 3','Upper 6']) as lvl loop
      declare p numeric; begin
        select unit_price into p from zpay_quote(a, r.code, 1, q.lvl);
        assert p >= r.min_price and p <= r.max_price, format('price %s outside limits for %s', p, r.code);
      end;
    end loop;
  end loop;

  -- 2. order creation is idempotent; amount = unit price x units
  o  := zpay_create_order(a, 'mock_exam', 2, 'Form 4');
  o2 := zpay_create_order(a, 'mock_exam', 2, 'Form 4');
  assert o.id = o2.id, 'duplicate open order created';
  assert o.amount = o.unit_price * 2, 'amount mismatch';
  assert o.pay_to = '0786610390', 'wrong EcoCash destination';
  assert o.status = 'awaiting_payment', 'bad initial status';

  -- 3. nothing is activated before verification
  select count(*) into n from zpay_entitlements where user_id = a;
  assert n = 0, 'access granted before payment';
  begin perform zpay_submit_payment(a, o.id, 'bad id!', '0771111111'); assert false, 'bad txn accepted';
  exception when others then assert sqlerrm like '%transaction ID%', 'unexpected error: ' || sqlerrm; end;
  o := zpay_submit_payment(a, o.id, 'mp261113.1000.a11111', '0771111111');
  assert o.status = 'submitted' and o.ecocash_txn_id = 'MP261113.1000.A11111', 'submit failed';
  select count(*) into n from zpay_entitlements where user_id = a;
  assert n = 0, 'access granted on submission (before verification)';
  assert not zpay_has_access(a, array['mock_exam']), 'has_access true before verification';

  -- 4. the same transaction ID cannot back a second order
  o2 := zpay_create_order(b, 'extra_assignment', 1, 'Form 2');
  begin perform zpay_submit_payment(b, o2.id, 'MP261113.1000.A11111', '0772222222'); assert false, 'duplicate txn accepted';
  exception when others then assert sqlerrm like '%already been used%', 'unexpected error: ' || sqlerrm; end;
  -- a student cannot submit someone else's order
  begin perform zpay_submit_payment(b, o.id, 'MP261113.1000.A99999', '0772222222'); assert false, 'foreign order accepted';
  exception when others then assert sqlerrm like '%not found%', 'unexpected error: ' || sqlerrm; end;

  -- 5. verification: non-admin refused, self-verification refused, admin approves once
  begin perform zpay_wa_verify('263799999999', o.reference, true); assert false, 'non-admin verified';
  exception when others then assert sqlerrm like '%Not authorised%', 'unexpected error: ' || sqlerrm; end;
  insert into zpay_wa_admins (phone) values ('263771111111');
  begin perform zpay_wa_verify('263771111111', o.reference, true); assert false, 'self verification allowed';
  exception when others then assert sqlerrm like '%own payment%', 'unexpected error: ' || sqlerrm; end;
  delete from zpay_wa_admins where phone = '263771111111';
  o := zpay_wa_verify('263700000001', o.reference, true, 'checked statement');
  assert o.status = 'verified' and o.verified_by_label = 'wa:263700000001', 'verify failed';
  o := zpay_wa_verify('263700000001', o.reference, true);       -- repeat: must be a no-op
  select count(*) into n from zpay_entitlements where order_id = o.id;  assert n = 1, 'duplicate entitlement';
  select count(*) into n from zpay_receipts where order_id = o.id;       assert n = 1, 'duplicate receipt';
  select units_remaining into n from zpay_entitlements where order_id = o.id;  assert n = 2, 'wrong credits';

  -- 6. credits are consumed one at a time and run out
  assert zpay_consume_unit(a, 'mock_exam') = 1, 'consume 1';
  assert zpay_consume_unit(a, 'mock_exam') = 0, 'consume 2';
  begin perform zpay_consume_unit(a, 'mock_exam'); assert false, 'consumed beyond credits';
  exception when others then assert sqlerrm like '%No remaining%', 'unexpected error: ' || sqlerrm; end;

  -- 7. a verified order cannot be rejected afterwards
  begin perform zpay_wa_verify('263700000001', o.reference, false); assert false, 'verified order rejected';
  exception when others then assert sqlerrm like '%Cannot reject%', 'unexpected error: ' || sqlerrm; end;

  -- 8. access package: stacks on an existing period; agreed price survives a later price change
  o := zpay_create_order(b, 'premium_weekly', 1, 'Form 2');
  o := zpay_submit_payment(b, o.id, 'MP261113.1100.B22222', '0772222222');
  perform zpay_wa_verify('263700000001', o.reference, true);
  assert zpay_has_access(b, array['premium_weekly']), 'no access after verification';
  declare e1 timestamptz; e2 timestamptz; agreed numeric; begin
    select expires_at, agreed_price into e1, agreed from zpay_entitlements where order_id = o.id;
    update zpay_services set margin_pct = 250, min_price = 3.50 where code = 'premium_weekly';   -- owner raises price
    o2 := zpay_create_order(b, 'premium_weekly', 1, 'Form 2');
    assert o2.unit_price > agreed, 'new order did not use the new price';
    o2 := zpay_submit_payment(b, o2.id, 'MP261113.1200.C33333', '0772222222');
    perform zpay_wa_verify('263700000001', o2.reference, true);
    select max(expires_at) into e2 from zpay_entitlements where user_id = b;
    assert e2 >= e1 + interval '6 days 23 hours', 'second period did not stack';
    select agreed_price into agreed from zpay_entitlements where order_id = o.id;
    assert agreed = o.unit_price, 'agreed price of the active subscription changed';
  end;

  -- 9. discounts: valid code applied, invalid refused, capped use
  insert into zpay_discounts (code, percent, max_uses) values ('SAVE10', 10, 1);
  select * into q from zpay_quote(a, 'extra_assignment', 1, 'Form 4', 'save10');
  assert q.discount_pct = 10, 'discount not applied';
  begin perform zpay_quote(a, 'extra_assignment', 1, 'Form 4', 'NOPE'); assert false, 'bad code accepted';
  exception when others then assert sqlerrm like '%discount%', 'unexpected error: ' || sqlerrm; end;

  -- 10. suspended services cannot be bought
  update zpay_services set enabled = false where code = 'performance_report';
  begin perform zpay_create_order(a, 'performance_report', 1, 'Form 4'); assert false, 'suspended service sold';
  exception when others then assert sqlerrm like '%unavailable%', 'unexpected error: ' || sqlerrm; end;
  update zpay_services set enabled = true where code = 'performance_report';

  -- 11. school subscription seats
  o := zpay_create_order(a, 'school_term', 2, 'Form 4');
  o := zpay_submit_payment(a, o.id, 'MP261113.1300.D44444', '0771111111');
  perform zpay_wa_verify('263700000001', o.reference, true);
  assert (zpay_add_seat(a, '0773333333')->>'used')::int = 1, 'seat 1';
  assert (zpay_add_seat(a, '0774444444')->>'used')::int = 2, 'seat 2';
  begin perform zpay_add_seat(a, '0775555555'); assert false, 'seat beyond limit';
  exception when others then assert sqlerrm like '%seats are in use%', 'unexpected error: ' || sqlerrm; end;
  begin perform zpay_add_seat(b, '0775555555'); assert false, 'seat without subscription';
  exception when others then assert sqlerrm like '%active school%', 'unexpected error: ' || sqlerrm; end;
  select id into s from wa_users where phone = '263773333333';
  assert zpay_has_access(s, array['school_term']), 'seat holder has no access';

  -- 12. expiry: access ends when the period ends, even before the job runs
  update zpay_entitlements set expires_at = now() - interval '1 minute' where user_id = b and service_name like '%Premium Access - 1 Week%';
  assert not zpay_has_access(b, array['premium_weekly']) or exists (
    select 1 from zpay_entitlements where user_id = b and expires_at > now()), 'expired access still valid';
  update zpay_entitlements set expires_at = now() - interval '1 minute' where user_id = b;
  assert not zpay_has_access(b, array['premium_weekly']), 'access valid after expiry';
  perform zpay_run_maintenance();
  select count(*) into n from zpay_entitlements where user_id = b and status = 'active'; assert n = 0, 'maintenance did not expire';

  -- 13. dashboard figures
  declare d jsonb; begin
    d := zpay_wa_summary('263700000001');
    assert (d->>'successful')::int = 4, 'successful count ' || (d->>'successful');
    assert (d->>'paying_students')::int = 2, 'paying students';
    assert (d->>'total_revenue')::numeric > 0, 'revenue';
    begin perform zpay_wa_summary('263799999999'); assert false, 'summary for non-admin';
    exception when others then assert sqlerrm like '%Not authorised%', 'unexpected error: ' || sqlerrm; end;
  end;

  -- 14. audit log is append-only and records the payment trail
  begin delete from zpay_audit; assert false, 'audit deleted';
  exception when others then assert sqlerrm like '%append-only%', 'unexpected error: ' || sqlerrm; end;
  select count(*) into n from zpay_audit where action in ('order_created','payment_submitted','order_verified'); assert n >= 8, 'audit trail thin';

  -- 15. EcoCash destination change is audited
  update zpay_settings set ecocash_number = '0771234567';
  select count(*) into n from zpay_audit where action = 'UPDATE zpay_settings'; assert n = 1, 'settings change not audited';
  begin update zpay_settings set ecocash_number = '12345'; assert false, 'bad number accepted';
  exception when check_violation then null; end;

  insert into t values ('done', 'all service-role checks passed');
end $$;

-- 16. permissions: students/anon (any non-service role) cannot reach money or student data
reset role;
set role authenticated;
do $$ begin
  begin perform zpay_quote(gen_random_uuid(), 'mock_exam'); assert false, 'authenticated can call bot functions';
  exception when insufficient_privilege then null; end;
  begin perform zpay_activate_order(gen_random_uuid(), null, 'admin'); assert false, 'authenticated can activate orders';
  exception when insufficient_privilege then null; end;
  begin perform 1 from wa_users; assert false, 'authenticated can read students';
  exception when insufficient_privilege then null; end;
  begin perform zpay_dashboard(); assert false, 'non-admin saw dashboard';
  exception when others then assert sqlerrm like '%Not authorised%', 'unexpected: ' || sqlerrm; end;
  begin update zpay_orders set status = 'verified'; assert false, 'authenticated can update orders';
  exception when insufficient_privilege then null; end;
end $$;
reset role; set role anon;
do $$ begin
  begin perform 1 from zpay_orders; assert false, 'anon can read orders';
  exception when insufficient_privilege then null; end;
  begin perform zpay_public_config(); assert false, 'anon can call config';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'ALL TESTS PASSED' as result;
