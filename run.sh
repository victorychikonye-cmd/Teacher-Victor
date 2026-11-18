#!/usr/bin/env bash
# Runs the end-to-end bot test against a scratch Postgres (needs psql and Node 22+).
# Usage:  PGHOST=/path/to/socket-or-host PGPORT=5432 tests/bot/run.sh
# It creates a fresh database "zimsec_bot_test" with Supabase-like roles, applies the migration, and runs the test.
set -euo pipefail
: "${PGHOST:?set PGHOST}"; : "${PGPORT:=5432}"
here="$(cd "$(dirname "$0")" && pwd)"
export PGHOST PGPORT PGDATABASE=zimsec_bot_test
admin=(psql -h "$PGHOST" -p "$PGPORT" -U postgres -X -q -v ON_ERROR_STOP=1)
"${admin[@]}" -d postgres -c "drop database if exists $PGDATABASE" -c "create database $PGDATABASE"
"${admin[@]}" -d "$PGDATABASE" -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if; end \$\$;" \
  -c "create schema auth; create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create function auth.uid() returns uuid language sql stable as \$\$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
      grant usage on schema auth to authenticated, service_role, anon; grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to service_role, authenticated;
      alter default privileges in schema public grant all on sequences to service_role, authenticated;"
"${admin[@]}" -d "$PGDATABASE" -f "$here/../../supabase/migrations/20261112100000_zimsec_teacher.sql"
[ "${SETUP_ONLY:-}" = "1" ] && { echo "Scratch database $PGDATABASE is ready."; exit 0; }
node --experimental-strip-types --no-warnings "$here/run.mjs"
