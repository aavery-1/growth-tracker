-- =========================================================================
-- NGC Growth Hub: team sync
-- Run once in Supabase -> SQL Editor -> New query -> paste -> Run.
-- Run AFTER supabase-auth-setup.sql and supabase-security-fixes.sql.
-- Safe to run again. Everything runs in one transaction.
--
-- What it adds:
--   1. growth_settings: shared markets, teams, owners, statuses, starter
--      templates and campaigns, so every signed-in person sees the same lists.
--      Everyone signed in can read them; only admins can change them.
--   2. growth_patch(): saves only the fields a person changed, in one step on
--      the server, so two people editing different fields of the same
--      milestone no longer overwrite each other.
--   3. growth_add_note(): adds a note to a milestone or school in one step on
--      the server, so notes posted at the same time are all kept. The note is
--      signed with the poster's profile name.
-- =========================================================================

begin;

-- 1. Shared settings ------------------------------------------------------
create table if not exists public.growth_settings (
  id         text primary key,          -- markets | teams | owners | statuses | templates | campaigns
  doc        jsonb not null,
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.growth_settings enable row level security;

do $$
declare r record;
begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'growth_settings'
  loop
    execute format('drop policy %I on public.growth_settings', r.policyname);
  end loop;
end$$;

create policy settings_select on public.growth_settings
  for select to authenticated using (true);
create policy settings_insert on public.growth_settings
  for insert to authenticated with check ((select private.is_role('admin')));
create policy settings_update on public.growth_settings
  for update to authenticated
  using ((select private.is_role('admin'))) with check ((select private.is_role('admin')));
create policy settings_delete on public.growth_settings
  for delete to authenticated using ((select private.is_role('admin')));

-- same attribution and audit trail as milestones and schools
drop trigger if exists stamp_settings on public.growth_settings;
create trigger stamp_settings
  before insert or update on public.growth_settings
  for each row execute function public.stamp_actor();

drop trigger if exists audit_settings on public.growth_settings;
create trigger audit_settings
  after insert or update or delete on public.growth_settings
  for each row execute function public.log_audit();

-- live updates for all three tables
do $$
declare t text;
begin
  foreach t in array array['growth_milestones', 'growth_schools', 'growth_settings'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;


-- 2. Field-level save -----------------------------------------------------
-- Creates the row if it is new; otherwise merges only the given fields into
-- the stored record and removes the fields listed in p_unset.
-- Runs with the caller's permissions, so the row rules above still apply
-- (viewers are refused).
create or replace function public.growth_patch(p_table text, p_id text, p_set jsonb, p_unset text[] default '{}')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare result jsonb;
begin
  if p_table not in ('growth_milestones', 'growth_schools', 'growth_settings') then
    raise exception 'Unknown table %', p_table;
  end if;
  execute format(
    'insert into public.%1$I as t (id, doc, updated_at) values ($1, $2 - $3, now())
     on conflict (id) do update set doc = (t.doc || $2) - $3, updated_at = now()
     returning doc', p_table)
  into result using p_id, coalesce(p_set, '{}'::jsonb), coalesce(p_unset, '{}'::text[]);
  return result;
end;
$$;


-- 3. Notes ----------------------------------------------------------------
create or replace function public.growth_add_note(p_table text, p_id text, p_note jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result jsonb;
  who text;
  note jsonb;
begin
  if p_table not in ('growth_milestones', 'growth_schools') then
    raise exception 'Unknown table %', p_table;
  end if;
  select coalesce(nullif(full_name, ''), email) into who from public.profiles where id = (select auth.uid());
  note := jsonb_build_object(
    't',    coalesce(p_note->'t', to_jsonb((extract(epoch from now()) * 1000)::bigint)),
    'text', coalesce(p_note->>'text', ''),
    'by',   coalesce(who, p_note->>'by', ''));
  execute format(
    'update public.%1$I set doc = jsonb_set(doc, ''{noteLog}'',
        coalesce(case when jsonb_typeof(doc->''noteLog'') = ''array'' then doc->''noteLog'' end, ''[]''::jsonb)
        || jsonb_build_array($2)), updated_at = now()
     where id = $1 returning doc', p_table)
  into result using p_id, note;
  if result is null then
    raise exception 'You do not have permission to add notes, or the record no longer exists.';
  end if;
  return result;
end;
$$;

revoke all on function public.growth_patch(text, text, jsonb, text[]) from public, anon;
revoke all on function public.growth_add_note(text, text, jsonb) from public, anon;
grant execute on function public.growth_patch(text, text, jsonb, text[]) to authenticated;
grant execute on function public.growth_add_note(text, text, jsonb) to authenticated;

commit;


-- Check: expect 4 policies on growth_settings and both functions listed
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'growth_settings' order by cmd;
select proname from pg_proc where proname in ('growth_patch', 'growth_add_note');
