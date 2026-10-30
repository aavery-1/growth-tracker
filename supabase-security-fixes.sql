-- =========================================================================
-- NGC Growth Hub: fix Supabase Security & Performance Advisor warnings
-- Run once in Supabase -> SQL Editor -> New query -> paste -> Run.
-- Everything runs in one transaction: if any step fails, nothing changes.
--
-- Fixes:
--   * Function Search Path Mutable          (stamp_actor, enforce_email_domain)
--   * Public / Signed-In Users Can Execute SECURITY DEFINER Function
--   * Auth RLS Initialization Plan          (auth.uid() re-evaluated per row)
--   * Multiple Permissive Policies          (growth_milestones, growth_schools, profiles)
--   * Security Definer View                 (growth_audit_v, if flagged)
-- Not fixable in SQL: Leaked Password Protection (a dashboard toggle, see AUTH-SETUP.md).
--
-- Access rules after this script (same as before):
--   everyone signed in can read; editors and admins can write milestones and schools;
--   people can edit their own profile but not their role; admins can manage all profiles.
-- =========================================================================

begin;

-- 1. RLS helper functions move to a private schema the API does not expose,
--    so nobody can call them directly; policies still can.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.is_role(check_role public.user_role)
returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = check_role);
$$;

create or replace function private.is_editor_or_admin()
returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role in ('editor', 'admin'));
$$;

revoke all on function private.is_role(public.user_role) from public;
revoke all on function private.is_editor_or_admin() from public;
grant execute on function private.is_role(public.user_role) to authenticated;
grant execute on function private.is_editor_or_admin() to authenticated;


-- 2. Rebuild the policies on the four app tables: one permissive policy per action,
--    with auth calls wrapped in (select ...) so they run once per query, not per row.
do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('profiles', 'growth_milestones', 'growth_schools', 'growth_audit')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end$$;

-- profiles
create policy profiles_select on public.profiles
  for select to authenticated using (true);
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or (select private.is_role('admin')))
  with check (
    (select private.is_role('admin'))
    or (id = (select auth.uid())
        and role = (select p.role from public.profiles p where p.id = (select auth.uid())))   -- no self-promotion
  );
create policy profiles_insert on public.profiles
  for insert to authenticated with check ((select private.is_role('admin')));
create policy profiles_delete on public.profiles
  for delete to authenticated using ((select private.is_role('admin')));

-- growth_milestones
create policy milestones_select on public.growth_milestones
  for select to authenticated using (true);
create policy milestones_insert on public.growth_milestones
  for insert to authenticated with check ((select private.is_editor_or_admin()));
create policy milestones_update on public.growth_milestones
  for update to authenticated
  using ((select private.is_editor_or_admin())) with check ((select private.is_editor_or_admin()));
create policy milestones_delete on public.growth_milestones
  for delete to authenticated using ((select private.is_editor_or_admin()));

-- growth_schools
create policy schools_select on public.growth_schools
  for select to authenticated using (true);
create policy schools_insert on public.growth_schools
  for insert to authenticated with check ((select private.is_editor_or_admin()));
create policy schools_update on public.growth_schools
  for update to authenticated
  using ((select private.is_editor_or_admin())) with check ((select private.is_editor_or_admin()));
create policy schools_delete on public.growth_schools
  for delete to authenticated using ((select private.is_editor_or_admin()));

-- growth_audit (read-only from the app; rows are written by the audit trigger)
create policy audit_select on public.growth_audit
  for select to authenticated using (true);


-- 3. The old public helpers are no longer used by any policy. Dropping them fails
--    (and rolls everything back) if something else still depends on them.
drop function if exists public.is_role(public.user_role);
drop function if exists public.is_editor_or_admin();


-- 4. Trigger functions: pin search_path and stop the API from calling them directly.
--    Triggers keep working: Postgres checks EXECUTE only when a trigger is created.
alter function public.stamp_actor() set search_path = '';
alter function public.enforce_email_domain() set search_path = public;

revoke execute on function public.stamp_actor()          from public, anon, authenticated;
revoke execute on function public.handle_new_user()      from public, anon, authenticated;
revoke execute on function public.log_audit()            from public, anon, authenticated;
revoke execute on function public.enforce_email_domain() from public, anon, authenticated;


-- 5. Audit view runs with the reader's permissions instead of the owner's.
alter view public.growth_audit_v set (security_invoker = true);

commit;


-- Check: the policies now in place (expect 4 on profiles, 4 per growth table, 1 on growth_audit)
select tablename, policyname, cmd from pg_policies
where schemaname = 'public' and tablename in ('profiles', 'growth_milestones', 'growth_schools', 'growth_audit')
order by tablename, cmd;
