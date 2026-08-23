-- =========================================================================
-- NGC Growth Hub — Supabase Auth + Audit + RLS setup
-- Run this ONCE in your Supabase project (SQL Editor → New query → paste → Run).
-- Idempotent-friendly: uses IF NOT EXISTS / CREATE OR REPLACE where possible.
-- Assumes the existing growth_milestones and growth_schools tables already exist
-- (created earlier when you enabled Supabase live sync).
-- =========================================================================


-- 1. ROLES
-- -------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum ('admin', 'editor', 'viewer');
  end if;
end$$;


-- 2. PROFILES TABLE (linked to auth.users)
-- -------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text,
  email        text unique,
  department   text,
  role         user_role not null default 'viewer',
  mfa_enrolled boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role);


-- 3. AUTO-CREATE PROFILE ON SIGN-UP
-- -------------------------------------------------------------------------
-- New auth.users row → profile row auto-inserted with default role = 'viewer'.
-- Admin must promote users to 'editor' or 'admin' explicitly.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer   -- runs as function owner (postgres) so it can INSERT past RLS
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- 4. ATTRIBUTION COLUMNS on existing tables
-- -------------------------------------------------------------------------
alter table public.growth_milestones add column if not exists created_by uuid references auth.users(id);
alter table public.growth_milestones add column if not exists updated_by uuid references auth.users(id);
alter table public.growth_schools    add column if not exists created_by uuid references auth.users(id);
alter table public.growth_schools    add column if not exists updated_by uuid references auth.users(id);


-- 5. STAMP ATTRIBUTION AUTOMATICALLY on every write
-- -------------------------------------------------------------------------
create or replace function public.stamp_actor()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_by := coalesce(new.updated_by, auth.uid());
  elsif tg_op = 'UPDATE' then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_milestones on public.growth_milestones;
create trigger stamp_milestones
  before insert or update on public.growth_milestones
  for each row execute function public.stamp_actor();

drop trigger if exists stamp_schools on public.growth_schools;
create trigger stamp_schools
  before insert or update on public.growth_schools
  for each row execute function public.stamp_actor();


-- 6. IMMUTABLE AUDIT LOG
-- -------------------------------------------------------------------------
create table if not exists public.growth_audit (
  id           uuid primary key default gen_random_uuid(),
  actor        uuid references auth.users(id),
  action       text not null,          -- 'insert' | 'update' | 'delete'
  entity_type  text not null,          -- 'milestone' | 'school'
  entity_id    text not null,
  changed_data jsonb,                  -- {doc: {...}} snapshot at the time
  ts           timestamptz not null default now()
);

create index if not exists growth_audit_ts_idx      on public.growth_audit (ts desc);
create index if not exists growth_audit_actor_idx   on public.growth_audit (actor);
create index if not exists growth_audit_entity_idx  on public.growth_audit (entity_type, entity_id);

-- Audit trigger uses SECURITY DEFINER so it can insert past the audit table's
-- deny-all RLS. Clients cannot INSERT/UPDATE/DELETE audit rows directly.
create or replace function public.log_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  et text;
  eid text;
  data jsonb;
begin
  et := case tg_table_name
          when 'growth_milestones' then 'milestone'
          when 'growth_schools'    then 'school'
          else tg_table_name
        end;
  if tg_op = 'DELETE' then
    eid := old.id::text;
    data := jsonb_build_object('doc', old.doc);
    insert into public.growth_audit (actor, action, entity_type, entity_id, changed_data)
      values (auth.uid(), 'delete', et, eid, data);
    return old;
  else
    eid := new.id::text;
    data := jsonb_build_object('doc', new.doc);
    insert into public.growth_audit (actor, action, entity_type, entity_id, changed_data)
      values (auth.uid(), lower(tg_op), et, eid, data);
    return new;
  end if;
end;
$$;

drop trigger if exists audit_milestones on public.growth_milestones;
create trigger audit_milestones
  after insert or update or delete on public.growth_milestones
  for each row execute function public.log_audit();

drop trigger if exists audit_schools on public.growth_schools;
create trigger audit_schools
  after insert or update or delete on public.growth_schools
  for each row execute function public.log_audit();


-- 7. ROW LEVEL SECURITY (RLS)
-- -------------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.growth_milestones enable row level security;
alter table public.growth_schools    enable row level security;
alter table public.growth_audit      enable row level security;

-- Helper: is the caller an admin/editor?
create or replace function public.is_role(check_role user_role)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = check_role);
$$;

create or replace function public.is_editor_or_admin()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('editor', 'admin'));
$$;

-- --- PROFILES policies ---
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));
  -- users may edit their own row but CANNOT self-promote to admin/editor

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles for all to authenticated
  using (public.is_role('admin'))
  with check (public.is_role('admin'));

-- --- MILESTONES policies ---
drop policy if exists milestones_select on public.growth_milestones;
create policy milestones_select on public.growth_milestones for select to authenticated using (true);

drop policy if exists milestones_write on public.growth_milestones;
create policy milestones_write on public.growth_milestones for all to authenticated
  using (public.is_editor_or_admin())
  with check (public.is_editor_or_admin());

-- --- SCHOOLS policies ---
drop policy if exists schools_select on public.growth_schools;
create policy schools_select on public.growth_schools for select to authenticated using (true);

drop policy if exists schools_write on public.growth_schools;
create policy schools_write on public.growth_schools for all to authenticated
  using (public.is_editor_or_admin())
  with check (public.is_editor_or_admin());

-- --- AUDIT policies (read for all authenticated, no direct writes) ---
drop policy if exists audit_select on public.growth_audit;
create policy audit_select on public.growth_audit for select to authenticated using (true);
-- No INSERT/UPDATE/DELETE policies → all direct writes denied.
-- Only the log_audit() trigger (SECURITY DEFINER) can insert rows.


-- 8. HELPFUL VIEW — audit with human-readable actor names
-- -------------------------------------------------------------------------
create or replace view public.growth_audit_v as
  select
    a.id, a.ts, a.action, a.entity_type, a.entity_id,
    a.actor,
    p.full_name as actor_name,
    p.email     as actor_email,
    a.changed_data
  from public.growth_audit a
  left join public.profiles p on p.id = a.actor
  order by a.ts desc;

grant select on public.growth_audit_v to authenticated;


-- =========================================================================
-- MANUAL BOOTSTRAP STEP (RUN ONCE, AFTER YOU SIGN UP AS THE FIRST USER):
-- =========================================================================
-- 1. Go to Supabase → Authentication → Users → "Add user" → invite yourself
--    with your email. Follow the invite link and set a password.
-- 2. Return here, replace the email below with your own, and run this line:
--
--    update public.profiles set role = 'admin' where email = 'you@kippnj.org';
--
-- 3. From then on, invite the rest of the team via the same Users panel;
--    they'll show up as role = 'viewer'. Promote them from the app's admin
--    UI (Phase 3) or with SQL:
--
--    update public.profiles set role = 'editor' where email = 'teammate@kippnj.org';
-- =========================================================================
