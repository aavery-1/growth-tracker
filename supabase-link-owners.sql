-- =========================================================================
-- NGC Growth Hub: link each account to its owner name
-- The app shows each person their own milestones by matching their account's
-- display name (profiles.full_name) to the owner name on the milestones. The app also
-- matches by login email as a backup, so this step mainly keeps names tidy.
-- Run AFTER the accounts exist (Authentication -> Users -> Add user).
-- 1. Emails are filled in from the account list. Anne Tatreau and Katie Ibeh still need theirs (replace EMAIL).
-- 2. Run the whole file in Supabase -> SQL Editor. Safe to re-run.
-- Owner names must stay spelled exactly as below (they match the Owner column).
-- =========================================================================

update public.profiles p
set full_name = v.owner_name, updated_at = now()
from (values
  ('Aden Avery',               'aavery@kippteamandfamily.org'),
  ('David Branson',            'dbranson@kippteamandfamily.org'),
  ('Doug Chu',                 'dchu@kippteamandfamily.org'),
  ('Susie Chu',                'schu@kippteamandfamily.org'),
  ('Maria-Cristina Ventresca', 'mventresca@kippteamandfamily.org'),
  ('Gabriella DiFilippo',      'gdifilippo@kippteamandfamily.org'),
  ('Kyle Rosenkrans',          'krosenkrans@kippteamandfamily.org'),
  ('Anne Tatreau',             'EMAIL'),
  ('Monica Kress',             'mkress@kippmiami.org'),
  ('Charlie Schmidt',          'cschmidt@kippmiami.org'),
  ('Katie Ibeh',               'EMAIL')
) as v(owner_name, email)
where lower(p.email) = lower(v.email);

-- Check: every account and the owner it is linked to (blank = not linked)
select p.email, p.full_name, p.role,
       case when p.full_name in ('Aden Avery','David Branson','Doug Chu','Susie Chu','Maria-Cristina Ventresca',
                                 'Gabriella DiFilippo','Kyle Rosenkrans','Anne Tatreau','Monica Kress',
                                 'Charlie Schmidt','Katie Ibeh')
            then 'linked' else 'NOT LINKED' end as owner_link
from public.profiles p
order by owner_link desc, p.full_name;
