-- =========================================================================
-- NGC Growth Hub: comments, Slack alerts, Monday digest, Outlook calendar feed
-- Run once in Supabase -> SQL Editor -> New query -> paste -> Run.
-- Safe to run again. Everything runs in one transaction: if any step fails,
-- nothing changes.
--
-- Adds:
--   1. Comments: everyone signed in (viewers too) can comment and @mention.
--      Comments still can't change any other field.
--   2. Slack: instant alerts (status turns at risk, behind or blocked; a key
--      milestone completes; someone is @mentioned; an opening date moves)
--      and a Monday 8am digest. The Slack link is stored where the website
--      can't read it. Admins paste it in Growth Hub -> Settings.
--   3. Calendar feed for Outlook: a private link per person. Needs the
--      growth-calendar Edge Function (see INTEGRATIONS-SETUP.md).
--   4. "Since the last meeting": reads the audit log to show what changed.
--
-- Uses two free Supabase extensions: pg_net (web requests) and pg_cron (schedule).
-- =========================================================================

begin;

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create schema if not exists private;

-- 1. Integration settings (private: the API can't read this table) --------
create table if not exists private.growth_integrations (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
alter table private.growth_integrations enable row level security;
revoke all on private.growth_integrations from public, anon, authenticated;

insert into private.growth_integrations (key, value) values
  ('site_url', 'https://aavery-1.github.io/growth-tracker/'),
  ('alerts', 'on'),
  ('digest', 'on')
on conflict (key) do nothing;

create or replace function private.cfg(p_key text)
returns text language sql stable security definer set search_path = '' as $$
  select value from private.growth_integrations where key = p_key;
$$;

create or replace function private.slack_esc(t text)
returns text language sql immutable set search_path = '' as $$
  select replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$$;

create or replace function private.fmt_date(d text)
returns text language sql immutable set search_path = '' as $$
  select case when d ~ '^\d{4}-\d{2}-\d{2}' then to_char(left(d, 10)::date, 'Mon FMDD, YYYY') else coalesce(d, '') end;
$$;

create or replace function private.status_label(k text)
returns text language sql immutable set search_path = '' as $$
  select case k when 'not_started' then 'Not started' when 'on_track' then 'On track' when 'at_risk' then 'At risk'
    when 'behind' then 'Behind' when 'blocked' then 'Blocked' when 'complete' then 'Complete' else coalesce(k, '') end;
$$;

create or replace function private.actor_name()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(full_name, ''), email) from public.profiles where id = (select auth.uid());
$$;

-- One milestone as a Slack line: linked name, then market, owner, due date
create or replace function private.m_line(p_id text, d jsonb)
returns text language sql stable security definer set search_path = '' as $$
  select '*<' || coalesce(private.cfg('site_url'), '') || '?m=' || p_id || '|' || private.slack_esc(d->>'activity') || '>*'
    || coalesce(nullif(' · ' || concat_ws(' · ',
         nullif(private.slack_esc(d->>'market'), ''),
         nullif(private.slack_esc(d->>'owner'), ''),
         case when d->>'due_date' is not null then 'due ' || private.fmt_date(d->>'due_date') end), ' · '), '');
$$;

create or replace function private.slack_post(p_text text)
returns void language plpgsql security definer set search_path = '' as $$
declare u text := private.cfg('slack_webhook');
begin
  if u is null or u = '' or p_text is null or p_text = '' then return; end if;
  perform net.http_post(
    url := u,
    body := jsonb_build_object('text', p_text, 'unfurl_links', false, 'unfurl_media', false),
    headers := '{"Content-Type": "application/json"}'::jsonb);
end;
$$;

-- 2. Comments: anyone signed in, with @mentions ---------------------------
create or replace function public.growth_add_note(p_table text, p_id text, p_note jsonb)
returns jsonb
language plpgsql
security definer          -- viewers can comment; this function only ever appends to noteLog
set search_path = ''
as $$
declare
  result jsonb;
  who text;
  note jsonb;
  ments jsonb;
begin
  if p_table not in ('growth_milestones', 'growth_schools') then
    raise exception 'Unknown table %', p_table;
  end if;
  select coalesce(nullif(full_name, ''), email) into who from public.profiles where id = (select auth.uid());
  if who is null then
    raise exception 'Sign in to comment.';
  end if;
  if length(coalesce(p_note->>'text', '')) = 0 or length(p_note->>'text') > 4000 then
    raise exception 'Comments must be 1 to 4000 characters.';
  end if;
  select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into ments
    from jsonb_array_elements_text(case when jsonb_typeof(p_note->'mentions') = 'array' then p_note->'mentions' else '[]'::jsonb end) x
    where length(x) between 1 and 80;
  note := jsonb_build_object(
    't',    coalesce(p_note->'t', to_jsonb((extract(epoch from now()) * 1000)::bigint)),
    'text', p_note->>'text',
    'by',   who);
  if jsonb_array_length(ments) > 0 then note := note || jsonb_build_object('mentions', ments); end if;
  execute format(
    'update public.%1$I set doc = jsonb_set(doc, ''{noteLog}'',
        coalesce(case when jsonb_typeof(doc->''noteLog'') = ''array'' then doc->''noteLog'' end, ''[]''::jsonb)
        || jsonb_build_array($2)), updated_at = now()
     where id = $1 returning doc', p_table)
  into result using p_id, note;
  if result is null then
    raise exception 'That record no longer exists.';
  end if;
  return result;
end;
$$;
revoke all on function public.growth_add_note(text, text, jsonb) from public, anon;
grant execute on function public.growth_add_note(text, text, jsonb) to authenticated;

-- 3. Instant Slack alerts --------------------------------------------------
-- Statement-level triggers: a bulk change (import, reschedule) sends one
-- short message instead of dozens.
create or replace function private.growth_milestone_alerts()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record; nt record;
  lines text[] := '{}';
  who text := coalesce(private.actor_name(), 'Someone');
  st text; total int;
begin
  if coalesce(private.cfg('slack_webhook'), '') = '' or private.cfg('alerts') = 'off' then return null; end if;

  for r in select n.id::text as id, n.doc as nd, o.doc as od from new_rows n join old_rows o on o.id = n.id
           where (n.doc->>'status') is distinct from (o.doc->>'status') loop
    st := r.nd->>'status';
    if st in ('at_risk', 'behind', 'blocked') then
      lines := lines || (':warning: ' || private.m_line(r.id, r.nd) || ' is now *' || private.status_label(st) || '*'
        || case when st = 'blocked' and coalesce(r.nd->>'dependency', '') <> '' then ': ' || private.slack_esc(r.nd->>'dependency') else '' end
        || ' · changed by ' || private.slack_esc(who));
    elsif st = 'complete' and (coalesce(r.nd->>'keyMilestone', '') = 'true' or coalesce(r.nd->>'greenlight', '') = 'true') then
      lines := lines || (':white_check_mark: Key milestone done: ' || private.m_line(r.id, r.nd) || ' · ' || private.slack_esc(who));
    end if;
  end loop;

  -- New comments that @mention someone (comments are only ever appended)
  for nt in
    select n.id::text as id, n.doc as nd, e.value as note
    from new_rows n join old_rows o on o.id = n.id
    cross join lateral jsonb_array_elements(case when jsonb_typeof(n.doc->'noteLog') = 'array' then n.doc->'noteLog' else '[]'::jsonb end) with ordinality e(value, i)
    where e.i > coalesce(jsonb_array_length(case when jsonb_typeof(o.doc->'noteLog') = 'array' then o.doc->'noteLog' end), 0)
      and case when jsonb_typeof(e.value->'mentions') = 'array' then jsonb_array_length(e.value->'mentions') > 0 else false end
  loop
    lines := lines || (':speech_balloon: *' || private.slack_esc(nt.note->>'by') || '* mentioned '
      || (select string_agg('*' || private.slack_esc(x) || '*', ', ') from jsonb_array_elements_text(nt.note->'mentions') x)
      || ' on ' || private.m_line(nt.id, nt.nd) || E'\n>' || replace(private.slack_esc(left(nt.note->>'text', 400)), E'\n', E'\n>'));
  end loop;

  total := coalesce(array_length(lines, 1), 0);
  if total = 0 then return null; end if;
  if total > 6 then
    perform private.slack_post(array_to_string(lines[1:5], E'\n') || E'\n…and ' || (total - 5) || ' more changes in <' || coalesce(private.cfg('site_url'), '') || '|Growth Hub>');
  else
    perform private.slack_post(array_to_string(lines, E'\n'));
  end if;
  return null;
end;
$$;

drop trigger if exists slack_milestone_alerts on public.growth_milestones;
create trigger slack_milestone_alerts
  after update on public.growth_milestones
  referencing old table as old_rows new table as new_rows
  for each statement execute function private.growth_milestone_alerts();

create or replace function private.growth_school_alerts()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record; lines text[] := '{}'; who text := coalesce(private.actor_name(), 'Someone');
begin
  if coalesce(private.cfg('slack_webhook'), '') = '' or private.cfg('alerts') = 'off' then return null; end if;
  for r in select n.doc as nd, o.doc as od from new_rows n join old_rows o on o.id = n.id
           where (n.doc->>'opening_date') is distinct from (o.doc->>'opening_date')
              or (n.doc->>'openingFY') is distinct from (o.doc->>'openingFY') loop
    lines := lines || (':calendar: *' || private.slack_esc(concat_ws(' ', r.nd->>'market', r.nd->>'display_label')) || '* opening moved'
      || case when r.od->>'opening_date' is not null and r.nd->>'opening_date' is not null
              then ' from ' || private.fmt_date(r.od->>'opening_date') || ' to ' || private.fmt_date(r.nd->>'opening_date')
              else ' from FY' || coalesce(r.od->>'openingFY', '?') || ' to FY' || coalesce(r.nd->>'openingFY', '?') end
      || ' · ' || private.slack_esc(who));
  end loop;
  if coalesce(array_length(lines, 1), 0) > 0 then perform private.slack_post(array_to_string(lines, E'\n')); end if;
  return null;
end;
$$;

drop trigger if exists slack_school_alerts on public.growth_schools;
create trigger slack_school_alerts
  after update on public.growth_schools
  referencing old table as old_rows new table as new_rows
  for each statement execute function private.growth_school_alerts();

-- 4. Monday digest ---------------------------------------------------------
create or replace function private.growth_open_milestones()
returns table (id text, doc jsonb) language sql stable security definer set search_path = '' as $$
  select m.id::text, m.doc from public.growth_milestones m
  where coalesce(m.doc->>'status', '') <> 'complete' and coalesce(m.doc->>'_draft', '') <> 'true';
$$;

create or replace function private.growth_weekly_digest(p_force boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare
  t date := (now() at time zone 'America/New_York')::date;
  cad int := coalesce((select nullif(doc->'meeting'->>'cadenceDays', '')::int from public.growth_settings where id = 'meeting'), 14);
  nxt text := (select doc->'meeting'->>'next' from public.growth_settings where id = 'meeting');
  site text := coalesce(private.cfg('site_url'), '');
  msg text; sec text; n int; any_sec boolean := false;
begin
  if not p_force and private.cfg('digest') = 'off' then return null; end if;

  msg := '*Growth Hub weekly digest · ' || to_char(t, 'Mon FMDD') || '*'
    || case when nxt ~ '^\d{4}-\d{2}-\d{2}$' then E'\nNext committee meeting: ' || private.fmt_date(nxt) else '' end;

  -- One capped list per condition, in this order
  for sec in
    select s.x from (values
      (1, 'Overdue', 'od'), (2, 'Due in the next 7 days', 'wk'), (3, 'Blocked', 'bl'), (4, 'Marked at risk or behind', 'rk')) v(ord, title, k),
    lateral (
      select case when c.cnt = 0 then null else E'\n\n*' || v.title || ' (' || c.cnt || E')*\n' || c.items
        || case when c.cnt > 8 then E'\n• …and ' || (c.cnt - 8) || ' more' else '' end end as x
      from (
        select count(*) as cnt,
               string_agg('• ' || private.m_line(q.id, q.doc), E'\n' order by q.rn) filter (where q.rn <= 8) as items
        from (
          select o.id, o.doc, row_number() over (order by o.doc->>'due_date' nulls last) as rn
          from private.growth_open_milestones() o
          where case v.k
            when 'od' then o.doc->>'due_date' < t::text
            when 'wk' then o.doc->>'due_date' between t::text and (t + 6)::text
            when 'bl' then o.doc->>'status' = 'blocked'
            when 'rk' then o.doc->>'status' in ('at_risk', 'behind') and coalesce(o.doc->>'due_date', '9999') >= t::text
          end) q
      ) c
    ) s
    order by v.ord
  loop
    if sec is not null then msg := msg || sec; any_sec := true; end if;
  end loop;

  -- Check-ins needed: due within 6 months, no check-in in the update window, grouped by owner
  select string_agg('• ' || private.slack_esc(z.o) || ': ' || z.c, E'\n' order by z.c desc, z.o), count(*) into sec, n
  from (
    select x.o, count(*) as c from private.growth_open_milestones() m,
      lateral jsonb_array_elements_text(
        case when coalesce(m.doc->>'owner', '') = '' then '["Unassigned"]'::jsonb else jsonb_build_array(m.doc->>'owner') end
        || case when jsonb_typeof(m.doc->'coOwners') = 'array' then m.doc->'coOwners' else '[]'::jsonb end) x(o)
    where m.doc->>'due_date' is not null and m.doc->>'due_date' <= (t + 180)::text
      and case when jsonb_typeof(m.doc->'checkins') = 'array' and jsonb_array_length(m.doc->'checkins') > 0
               then left(m.doc->'checkins'->-1->>'t', 10) <= (t - cad)::text else true end
    group by x.o
  ) z;
  if n > 0 then msg := msg || E'\n\n*Check-ins needed*\n' || sec; any_sec := true; end if;

  if not any_sec then msg := msg || E'\n\nNothing overdue, blocked, or due this week.'; end if;
  msg := msg || E'\n\n<' || site || '|Open Growth Hub>';
  perform private.slack_post(msg);
  return msg;
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'growth-weekly-digest') then
    perform cron.unschedule('growth-weekly-digest');
  end if;
  -- Mondays 12:00 UTC = 7am Eastern in winter, 8am in summer
  perform cron.schedule('growth-weekly-digest', '0 12 * * 1', 'select private.growth_weekly_digest()');
end$$;

-- 5. Admin controls used by Growth Hub -> Settings -------------------------
create or replace function public.growth_integrations_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u text := private.cfg('slack_webhook');
begin
  if not (select private.is_role('admin')) then raise exception 'Only admins can see integration settings.'; end if;
  return jsonb_build_object(
    'slack', coalesce(u, '') <> '',
    'slack_hint', case when coalesce(u, '') <> '' then right(u, 4) end,
    'alerts', coalesce(private.cfg('alerts'), 'on') <> 'off',
    'digest', coalesce(private.cfg('digest'), 'on') <> 'off');
end;
$$;

create or replace function public.growth_integrations_set(p_slack_webhook text default null, p_clear_slack boolean default false,
                                                          p_alerts boolean default null, p_digest boolean default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not (select private.is_role('admin')) then raise exception 'Only admins can change integration settings.'; end if;
  if p_clear_slack then
    delete from private.growth_integrations where key = 'slack_webhook';
  elsif p_slack_webhook is not null then
    if p_slack_webhook !~ '^https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+$' then
      raise exception 'That is not a Slack webhook link. It starts with https://hooks.slack.com/services/';
    end if;
    insert into private.growth_integrations (key, value) values ('slack_webhook', p_slack_webhook)
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if p_alerts is not null then
    insert into private.growth_integrations (key, value) values ('alerts', case when p_alerts then 'on' else 'off' end)
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if p_digest is not null then
    insert into private.growth_integrations (key, value) values ('digest', case when p_digest then 'on' else 'off' end)
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  return public.growth_integrations_get();
end;
$$;

create or replace function public.growth_slack_test()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (select private.is_role('admin')) then raise exception 'Only admins can send a test message.'; end if;
  if coalesce(private.cfg('slack_webhook'), '') = '' then raise exception 'Add a Slack webhook link first.'; end if;
  perform private.slack_post(':wave: Growth Hub is connected. Alerts and the Monday digest will post here. Sent by '
    || private.slack_esc(coalesce(private.actor_name(), 'an admin')));
end;
$$;

create or replace function public.growth_slack_digest_now()
returns text language plpgsql security definer set search_path = '' as $$
begin
  if not (select private.is_role('admin')) then raise exception 'Only admins can send the digest.'; end if;
  if coalesce(private.cfg('slack_webhook'), '') = '' then raise exception 'Add a Slack webhook link first.'; end if;
  return private.growth_weekly_digest(true);
end;
$$;

-- 6. Calendar feed for Outlook --------------------------------------------
create table if not exists private.growth_calendar_tokens (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  token      text not null unique,
  owner_name text,
  created_at timestamptz not null default now()
);
alter table private.growth_calendar_tokens enable row level security;
revoke all on private.growth_calendar_tokens from public, anon, authenticated;

-- Returns this person's private calendar token, creating it the first time.
-- p_reset = true replaces it, so an old link stops working.
create or replace function public.growth_calendar_token(p_owner text default null, p_reset boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); tk text;
begin
  if uid is null or not exists (select 1 from public.profiles where id = uid) then raise exception 'Sign in first.'; end if;
  if p_reset then delete from private.growth_calendar_tokens where user_id = uid; end if;
  insert into private.growth_calendar_tokens (user_id, token, owner_name)
    values (uid, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), nullif(left(p_owner, 120), ''))
  on conflict (user_id) do update set owner_name = coalesce(excluded.owner_name, private.growth_calendar_tokens.owner_name)
  returning token into tk;
  return tk;
end;
$$;

-- Called by the growth-calendar Edge Function. Calendar apps can't sign in,
-- so the long random token in the link is the key.
create or replace function public.growth_calendar_feed(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare own text;
begin
  if p_token is null or length(p_token) < 40 then return null; end if;
  select t.owner_name into own from private.growth_calendar_tokens t join public.profiles p on p.id = t.user_id where t.token = p_token;
  if not found then return null; end if;
  return jsonb_build_object(
    'owner', own,
    'site', coalesce(private.cfg('site_url'), ''),
    'milestones', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'activity', doc->'activity', 'due_date', doc->'due_date', 'status', doc->'status',
        'market', doc->'market', 'owner', doc->'owner', 'coOwners', doc->'coOwners', 'team', doc->'functional_area'))
      from public.growth_milestones where doc->>'due_date' is not null and coalesce(doc->>'_draft', '') <> 'true'), '[]'::jsonb),
    'schools', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'label', doc->'display_label', 'market', doc->'market', 'opening_date', doc->'opening_date'))
      from public.growth_schools where doc->>'opening_date' is not null), '[]'::jsonb));
end;
$$;

-- 7. Since the last meeting -----------------------------------------------
-- Each milestone's status, due date and progress as of p_since, from the audit log.
create or replace function public.growth_changes_since(p_since timestamptz)
returns table (id text, was jsonb, is_new boolean)
language sql stable security invoker set search_path = '' as $$
  with base as (
    select distinct on (a.entity_id) a.entity_id, a.changed_data->'doc' as doc
    from public.growth_audit a
    where a.entity_type = 'milestone' and a.action <> 'delete' and a.ts <= p_since
    order by a.entity_id, a.ts desc),
  created as (
    select distinct a.entity_id from public.growth_audit a
    where a.entity_type = 'milestone' and a.action = 'insert' and a.ts > p_since)
  select m.id::text,
         case when b.doc is not null then jsonb_build_object('status', b.doc->'status', 'due_date', b.doc->'due_date', 'progress_percent', b.doc->'progress_percent') end,
         c.entity_id is not null and b.doc is null
  from public.growth_milestones m
  left join base b on b.entity_id = m.id::text
  left join created c on c.entity_id = m.id::text
  where b.doc is not null or c.entity_id is not null;
$$;

-- Permissions: helpers stay private; the app calls only the public functions.
revoke all on function private.cfg(text), private.slack_esc(text), private.fmt_date(text), private.status_label(text),
  private.actor_name(), private.m_line(text, jsonb), private.slack_post(text),
  private.growth_milestone_alerts(), private.growth_school_alerts(), private.growth_open_milestones(), private.growth_weekly_digest(boolean) from public, anon, authenticated;
revoke all on function public.growth_integrations_get(), public.growth_integrations_set(text, boolean, boolean, boolean),
  public.growth_slack_test(), public.growth_slack_digest_now(), public.growth_calendar_token(text, boolean),
  public.growth_calendar_feed(text), public.growth_changes_since(timestamptz) from public, anon;
grant execute on function public.growth_integrations_get(), public.growth_integrations_set(text, boolean, boolean, boolean),
  public.growth_slack_test(), public.growth_slack_digest_now(), public.growth_calendar_token(text, boolean),
  public.growth_changes_since(timestamptz) to authenticated;
grant execute on function public.growth_calendar_feed(text) to anon, authenticated;

commit;

-- Check: expect 2 triggers, 1 scheduled job, and 7 functions
select tgname from pg_trigger where tgname in ('slack_milestone_alerts', 'slack_school_alerts');
select jobname, schedule from cron.job where jobname = 'growth-weekly-digest';
select proname from pg_proc where proname in ('growth_add_note', 'growth_integrations_get', 'growth_integrations_set',
  'growth_slack_test', 'growth_slack_digest_now', 'growth_calendar_token', 'growth_calendar_feed', 'growth_changes_since');
