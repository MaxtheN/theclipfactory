# Private cloud state foundation

Target: Supabase project `spdtisizhcepmsogjvnr` ("jduhking's Project", us-east-2, Free). The cloud moved here on 2026-11-19 from the original project `nywbjxmratokyplwjjhu`, which is no longer used; accounts and rows were not carried over.

**Current update (2026-11-14):** the metadata migration was applied and verified. Later work added Supabase Auth and publishing media storage. The Mac app still uses SQLite for operational state; there is no general metadata sync client or always-on hosted publishing/learning worker. The metadata/RLS design below is distinct from Auth and the publish bucket. See [publishing](instagram-publishing.md) and the [current handoff](HANDOFF.md).

## Three tables

| Table | Purpose | Authenticated app access |
| --- | --- | --- |
| `gf_workspaces` | Workspace UUID, owner UUID, name, creation time | Read own; create with own `auth.uid()` only |
| `gf_records` | `(workspace_id, kind, id)`, positive version, object JSON (256KiB maximum), timestamps | Read/insert own; update only `version`, `data`, `updated_at` |
| `gf_events` | Workspace-scoped record reference, event type, object JSON (256KiB maximum), time | Read/append own only |

Ownership uses Supabase's authenticated subject. There is intentionally no `auth.users` foreign key, so rollback-contained JWT probes need no authentication-user writes. There is no workspace update/ownership-transfer policy and no anonymous, delete, truncate or event-update grant. Record identity columns cannot be updated by the app role. All tables enable and force RLS; no security-definer helper or trigger is introduced.

This is **single-owner privacy**, not team membership/sharing. Administrators and roles with `BYPASSRLS` remain privileged. Events are append-only for app roles, not a cryptographic audit log or proof of human approval.

Allowed record/event kinds are `profiles`, `campaigns`, `strategy_versions`, `campaign_observations`, `clips`, `feedback`, `learning_policies`, `learning_publications`, `learning_snapshots`, and `learning_experiments`. They designate future **metadata projections**, never permission to upload the raw Store objects. Config, connected accounts, OAuth intents, jobs, raw video, exports and runtime records are excluded.

## Apply and verify

1. Confirm the exact project above and inspect existing `public.gf_*` objects. Do not apply over any existing namespace.
2. Independently review `supabase/migrations/202611140001_growth_factory.sql`, then run the complete file in SQL Editor as one transaction. It deliberately raises on existing gf relations/types/functions; it does not use `IF NOT EXISTS`, drop objects, or replace policies. Any failure must roll back the transaction.
3. Read back the schema, RLS, seven policies and grants using the queries below. `authenticated` receives table SELECT/INSERT and column UPDATE only on record data/version/update time; `anon` and PUBLIC receive no table privileges.
4. Run `supabase/tests/growth_factory_rls.sql` as SQL Editor administrator. It uses two synthetic JWT subjects, verifies own inserts/updates and foreign invisibility, rejects foreign inserts/ownership changes/record identity changes/deletes/event mutation/private kinds, checks anonymous denial, then **ROLLBACK**. No `auth.users` rows or fixtures persist. If SQL Editor stops at an error, explicitly run `ROLLBACK` before continuing. A success string is not a substitute for reviewing the script and result.

```sql
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('gf_workspaces','gf_records','gf_events');

select tablename, policyname, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'public' and tablename in ('gf_workspaces','gf_records','gf_events')
order by tablename, policyname;

select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema = 'public' and table_name in ('gf_workspaces','gf_records','gf_events')
order by table_name, grantee, privilege_type;

select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name in ('gf_workspaces','gf_records','gf_events')
  and privilege_type = 'UPDATE'
order by table_name, column_name, grantee;
```

The JWT probes test database authorization under administrator-supplied claims; they do not test token signing, Auth sign-in, the Data API, or a desktop session. No local PostgreSQL/Supabase CLI was available during SQL preparation, so execution remains the reviewed browser verification step.

## Required before any app sync

- Explicit user sign-in and per-workspace access; a publishable key alone grants no user identity. Never place a service-role key in the desktop app.
- A reviewed field-by-field projection. The kind allowlist and RLS **do not scan or remove secrets inside JSON**. Exclude credentials, OAuth/provider state, local paths, source media/transcripts, and raw model logs unless a separate explicit content-sharing design is approved.
- A conflict/replay protocol and transaction strategy for records plus events. `version > 0` is a data constraint, not automatic version advancement or optimistic locking; a future client must compare an expected version and verify the returned update.
- Cloud state must not become authority to publish/spend or approve local rendered bytes. Retain exact local hash, review and publication gates.
- Separate team membership, deletion/retention and backup decisions. This migration does not silently add sharing, erase history or change the local runtime.

References: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL row-security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## Verified provider readback — 2026-11-19 (`spdtisizhcepmsogjvnr`)

The project was empty (no `gf_*` objects, buckets or policies). The three migrations were applied unchanged, in order, through the Management API SQL endpoint; each ran as its own transaction. `supabase/tests/growth_factory_rls.sql` returned `RLS probes passed; synthetic rows rolled back.` and `growth_factory_readback.sql` returned 3 tables, 3 RLS enabled, 3 forced RLS, 7 policies, 0 anonymous/PUBLIC table grants; authenticated record data update true, record id/workspace/event update false, record delete false; 0 rows. Storage: bucket `gf-publish` public, 50 MB limit, `video/mp4` and `image/jpeg`; 4 `gf_publish_*` policies, all `authenticated`.

Auth: email + password sign-up enabled with email confirmation **off** (`mailer_autoconfirm`), matching the original project. The publishable key in `clip_factory/cloud_config.json` was replaced.

Live smoke through `clip_factory.cloud.SupabaseClient` with a throwaway user: sign-up returned a session, password sign-in and refresh worked, the user created and read back its own workspace and appended a `profiles/created` event, uploaded an MP4 to its own `gf-publish/<uid>/<sha256>.mp4`, read it from the public URL, was refused an upload under another user's prefix, deleted its object and logged out. Anonymous REST reads of `gf_workspaces` return 401. The throwaway user and its rows were then deleted.

## Verified provider readback — 2026-11-14 (original project `nywbjxmratokyplwjjhu`)

Exact reviewed migration was pasted, copied back and matched before SQL Editor execution; result Success. Full rollback probe file also matched, then returned `RLS probes passed; synthetic rows rolled back.` Catalog readback:3tables,3RLSenabled,3forcedRLS,7policies,0anonymous/PUBLICtablegrants; authenticated record data update=true, recordID/workspace/eventupdate=false, recorddelete=false. All three table rowcounts0 after rollback. This certifies the database controls under test claims; it does not certify app Auth, user tokens, team sharing or cloud sync. SQL Editor query73c22432-a834-4930-a78b-2516738659f1.
