-- =========================================================================
-- NGC Growth Hub: fix "Failed to delete selected users: Database error loading user"
-- Run in Supabase -> SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- Cause 1: accounts created or edited with SQL can leave NULLs in auth.users text
--          columns that Supabase Auth expects to be '' (empty). Auth then can't load
--          the account, so deleting it (and often signing in) fails.
-- Cause 2: growth_milestones / growth_schools / growth_audit point at auth.users with
--          no delete rule, so deleting anyone who ever made an edit is blocked.
--          Fix: when an account is deleted, its rows stay and their author is cleared.
-- =========================================================================

-- Step 0 (read-only): which accounts have the NULL problem?
select email,
       confirmation_token is null      as null_confirmation_token,
       recovery_token is null          as null_recovery_token,
       email_change_token_new is null  as null_email_change_token_new,
       email_change is null            as null_email_change
from auth.users
where confirmation_token is null or recovery_token is null
   or email_change_token_new is null or email_change is null
order by email;

begin;

-- 1. Replace NULLs with '' so Supabase Auth can load every account
update auth.users set
  confirmation_token         = coalesce(confirmation_token, ''),
  recovery_token             = coalesce(recovery_token, ''),
  email_change_token_new     = coalesce(email_change_token_new, ''),
  email_change_token_current = coalesce(email_change_token_current, ''),
  email_change               = coalesce(email_change, ''),
  phone_change               = coalesce(phone_change, ''),
  phone_change_token         = coalesce(phone_change_token, ''),
  reauthentication_token     = coalesce(reauthentication_token, '')
where confirmation_token is null or recovery_token is null
   or email_change_token_new is null or email_change_token_current is null
   or email_change is null or phone_change is null
   or phone_change_token is null or reauthentication_token is null;

-- 2. Deleting an account keeps its milestones, schools and history; only the author link is cleared
alter table public.growth_milestones
  drop constraint if exists growth_milestones_created_by_fkey,
  drop constraint if exists growth_milestones_updated_by_fkey,
  add constraint growth_milestones_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null,
  add constraint growth_milestones_updated_by_fkey foreign key (updated_by) references auth.users(id) on delete set null;

alter table public.growth_schools
  drop constraint if exists growth_schools_created_by_fkey,
  drop constraint if exists growth_schools_updated_by_fkey,
  add constraint growth_schools_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null,
  add constraint growth_schools_updated_by_fkey foreign key (updated_by) references auth.users(id) on delete set null;

alter table public.growth_audit
  drop constraint if exists growth_audit_actor_fkey,
  add constraint growth_audit_actor_fkey foreign key (actor) references auth.users(id) on delete set null;

commit;
