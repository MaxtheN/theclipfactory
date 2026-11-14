# Summary
Prepare an additive private Supabase foundation in user-created project nywbjxmratokyplwjjhu. Keep current SQLite runtime unchanged; no automatic content or credential upload.

# Code Reuse And Package Structure
Follow existing Store record identity and append-only experiment/evidence model. New supabase/migrations/202611140001_growth_factory.sql and docs/cloud-state.md. No app.py or frontend logic changes. SQL uses PostgreSQL auth.uid and ownership RLS.

# Components And Flow
Three tables: gf_workspaces (owner-bound identity), gf_records (workspace-scoped kind/id/version JSON saved state), gf_events (append-only evidence ledger). Authenticated users create only own workspaces, access only owned workspace records/events. No anonymous grants, no workspace ownership transfer, no unrestricted security-definer function, no public storage bucket. Kind allowlist excludes credentials/local paths and tokens; app sync is explicitly disabled until an allowlisted projection/auth/conflict protocol exists. No service-role key in desktop app. SQL uses transaction and all-or-nothing creation; abort if objects already exist.

# Steps
1. Inspect project existing schema/read-only table editor.
2. Delegate SQL generation under this plan, then independently review tenant isolation and grants.
3. Apply reviewed additive SQL in browser SQL Editor on exact named project.
4. Read back schema/RLS/grants and rollback-contained authorization checks; record limits and connection gates.

# Testing
Review transaction and search paths. Verify public has no existing gf_* before apply; no deletion/migration of existing tables. Query pg_tables/pg_policies/table_privileges to verify RLS and grants. Run rollback-contained cross-owner/anonymous access tests using synthetic JWT claims and no persisted auth users if feasible; no real data uploads. App baseline709 backend passes6skips,265frontend passes. Cloud remains unused by app until later authenticated sync integration.
