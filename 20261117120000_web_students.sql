-- Web students: a student can now sign in on the website (Supabase Auth email + password)
-- instead of, or as well as, WhatsApp. Web students have an auth_id and no phone number.
alter table wa_users add column if not exists auth_id uuid unique references auth.users(id) on delete set null;
alter table wa_users add column if not exists email text;
alter table wa_users alter column phone drop not null;
alter table wa_users add constraint wa_users_identity_check check (phone is not null or auth_id is not null);
