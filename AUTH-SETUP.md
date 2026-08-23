# NGC Growth Hub — Auth Setup (Phase 1)

**Goal:** replace the shared-password gate with real user accounts, so every edit is attributed and an immutable audit log records who did what.

**What this gives you:**
- Individual accounts via email + password (invite-only)
- Role-based access: `admin` / `editor` / `viewer`
- Automatic attribution on every write (`created_by`, `updated_by`)
- Tamper-proof audit log in the database
- SOC 2-aligned access controls (Row-Level Security on every table)
- Optional MFA (TOTP — Google Authenticator, 1Password, etc.)

**Time to complete:** ~10 minutes. You do all of this in the Supabase dashboard once.

---

## Step 1 — Run the SQL migration (2 min)

1. Open your Supabase project → **SQL Editor** (left sidebar) → **New query**
2. Open `supabase-auth-setup.sql` from this project, copy the entire file
3. Paste into the SQL Editor and click **Run**
4. You should see `Success. No rows returned.` The script is idempotent — safe to re-run

**What it creates:**
- `profiles` table (linked to Supabase's built-in `auth.users`)
- Auto-trigger: new signups get a profile row with default role `viewer`
- Attribution columns on `growth_milestones` + `growth_schools`
- Attribution triggers: every write stamps `created_by` / `updated_by` from the session
- `growth_audit` table (immutable log)
- Audit triggers: every INSERT/UPDATE/DELETE on milestones/schools writes an audit row
- RLS policies: authenticated users can read; only editor+admin can write; audit is read-only from the client

---

## Step 2 — Configure Auth settings (2 min)

In Supabase dashboard:

1. **Authentication → Providers → Email**
   - Enable Email provider (usually on by default)
   - **Confirm email:** ON (users verify their email before first login)
   - **Secure email change:** ON
   - Save

2. **Authentication → Providers → Email → Advanced Settings**
   - **Enable email signups:** **OFF** (invite-only, per your architecture choice)
   - Save

3. **Authentication → Policies → Password Settings**
   - **Minimum password length:** 12
   - **Require:** lowercase, uppercase, digits, symbols (check all four)
   - Save

4. **Authentication → Providers → MFA**
   - Enable **TOTP** (Time-based one-time password)
   - Optional at this stage — will be exposed as an enrollment flow in Phase 3
   - Save

---

## Step 3 — Create your admin account (2 min)

1. **Authentication → Users → Add user → Send invitation**
2. Enter your email address (e.g., `avery.aden1@gmail.com` or your KIPP email)
3. Choose **"Send an invite link"** (Supabase emails you a magic link)
4. Check email → click the invite link → set your password
5. Return to Supabase → **SQL Editor** and run:
   ```sql
   update public.profiles set role = 'admin' where email = 'YOUR_EMAIL@here';
   ```
   (Replace with the email you invited)
6. Verify:
   ```sql
   select id, email, full_name, role from public.profiles;
   ```
   You should see yourself with `role = 'admin'`.

---

## Step 4 — Invite your team (varies)

Same flow as step 3, minus the SQL promotion — new invites default to `viewer`.

**Promote to editor** (day-to-day committee members):
```sql
update public.profiles set role = 'editor' where email in (
  'teammate1@kippnj.org',
  'teammate2@kippnj.org'
);
```

**Promote another admin** (rare — only for people who need to manage users):
```sql
update public.profiles set role = 'admin' where email = 'boss@kippnj.org';
```

Phase 3 will replace these SQL updates with a proper Admin panel in the app.

---

## Step 5 — Verify (1 min)

Back in Supabase → **SQL Editor**, run:

```sql
-- Check profiles + roles
select email, full_name, role, mfa_enrolled from public.profiles;

-- Check that RLS is enabled everywhere
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('profiles', 'growth_milestones', 'growth_schools', 'growth_audit');
-- Every row should show rowsecurity = true

-- Check that audit triggers exist
select tgname, tgrelid::regclass as table_name
from pg_trigger
where tgname like 'audit_%';
-- Should show audit_milestones and audit_schools

-- Confirm no anonymous access
set role anon;
select * from public.growth_milestones limit 1;
-- Should return 0 rows (RLS blocks anon)
reset role;
```

---

## What happens next

Once you've run the SQL and confirmed with the queries above, tell me — I'll wire the client code (turn 2):

- **Sign-in screen** replaces the shared-password gate (togglable via a setting so nothing breaks mid-migration)
- **User badge** in the header shows your name + role, with a sign-out control
- **Attribution flows automatically** — no client-side changes needed; the DB triggers stamp everything
- **Old activity log keeps working** locally; Phase 2 will point it at the DB `growth_audit_v` view instead

---

## FAQ / compliance notes

**Q: Does this satisfy FERPA?**
This app tracks operational school-opening milestones (real estate, hires, permits, enrollment campaigns), not student PII. FERPA is triggered by student-level educational records — grades, IDs, discipline, health data. As long as no student PII enters this tool, FERPA doesn't apply. If you ever add student-touching data, add a separate compliance review then.

**Q: SOC 2 status?**
Supabase itself is **SOC 2 Type 2 certified** at the infrastructure level. This setup implements the application-level controls that matter for SOC 2 alignment:
- ✅ Access controls (Supabase Auth + RLS)
- ✅ Audit trail (immutable `growth_audit` table + triggers)
- ✅ Encryption at rest (Supabase-managed) + in transit (HTTPS)
- ✅ Password policy (12 chars, complexity)
- ✅ Session timeout (Supabase JWT, refresh flow)
- ✅ Optional MFA (TOTP)
- ⚠️ Data retention + incident response plans — organizational policies, not code

For a formal SOC 2 audit later, you'd need retention & incident-response docs and a signed BAA-equivalent with Supabase. Reach out if that comes up.

**Q: Can I roll this back if something breaks?**
Yes. The SQL script is additive — it adds columns/tables/triggers but doesn't drop or modify your milestone/school data. To fully revert:
```sql
drop trigger if exists audit_milestones on public.growth_milestones;
drop trigger if exists audit_schools    on public.growth_schools;
drop trigger if exists stamp_milestones on public.growth_milestones;
drop trigger if exists stamp_schools    on public.growth_schools;
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.log_audit, public.stamp_actor, public.handle_new_user, public.is_role, public.is_editor_or_admin cascade;
drop view if exists public.growth_audit_v;
drop table if exists public.growth_audit;
drop table if exists public.profiles;
-- Attribution columns are safe to leave in place (nullable, no data loss)
```

**Q: What if a user's account is deleted in Supabase?**
Their profile row cascades and deletes. Their historical `created_by` / `updated_by` foreign keys become NULL (the audit rows retain their `changed_data` snapshots either way). Audit history is preserved.
