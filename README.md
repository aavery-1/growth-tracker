# KIPP Team &amp; Family — Growth Task Force Tracker

A simple, shared board for the cross-functional task force driving school openings — everything
you're accountable for up to the **transition to Regional Operations**, tracked to each school's opening.

Aligned to the NGC Operating Charter. Two tabs:

| Tab | What it's for |
|-----|----------------|
| **At-a-Glance** | The charter's stakeholder-facing artifact: readiness by school across the two state portfolios (NJ / FL) with **red/yellow/green** status, the on-schedule **North Star** (share of schools on track to open on time), the FY27 priorities, and the growth-capital raises ($7M SoFla, $1.5M Paterson). Print to PDF for the pre-read. |
| **Board** | The Master Growth Project Plan. A spreadsheet-style board (like Monday.com) — click any cell to edit; it saves automatically. **Group by State** (default, for the biweekly FL/NJ blocks), School, Team, Quarter, or Market; filter by state; switch to **Kanban** to drag items between statuses. |

## Editing

Just click. There's no "edit mode," no save button:
- Click a **status** cell → pick Not started / In progress / Blocked / Done.
- Click **owner** → type or pick a name. Click **date** → set the year/quarter. Click the **star** to flag a key milestone. Click the **item name** to rename it.
- **+ New item** (top) or **+ Add item** (bottom of any group) to add.
- The ⤢ icon opens the full detail (notes, dependency, schools, delete).

Every change saves instantly — you'll see "All changes saved" in the header.

## Sharing it with the committee (two options)

### Option A — Live sync with Supabase (recommended: everyone shares one board, in real time)

1. Create a free project at [supabase.com](https://supabase.com).
2. In Supabase → **SQL Editor**, run this once:
   ```sql
   create table if not exists growth_milestones (id text primary key, doc jsonb not null, updated_at timestamptz default now());
   create table if not exists growth_schools    (id text primary key, doc jsonb not null, updated_at timestamptz default now());
   alter table growth_milestones enable row level security;
   alter table growth_schools    enable row level security;
   create policy "rw_m" on growth_milestones for all using (true) with check (true);
   create policy "rw_s" on growth_schools    for all using (true) with check (true);
   alter publication supabase_realtime add table growth_milestones;
   alter publication supabase_realtime add table growth_schools;
   ```
   *(This lets anyone with the anon key read/write — fine for an internal committee tool. To lock it
   down later, add auth and tighten the policies.)*
3. In Supabase → **Project Settings → API**, copy the **Project URL** and the **anon public** key.
4. In the tracker, open **⚙ (top-right) → Live sync (Supabase)**, paste both, and **Connect & go live**.
   The first person to connect seeds the board; after that, everyone who connects to the same project
   sees each other's edits live. Each teammate does step 4 once (their browser remembers it).

> The **anon key is designed to be public** on the client side, so it's safe to share with the committee.

### Option B — Publish via GitHub (no live sync)

Edit locally, then **⚙ → Publish via GitHub** to commit your `data.json`; teammates see it on refresh.
Or **Export data.json** and commit it yourself. Good if you don't want a backend.

## Hosting

Static files — host anywhere:
1. Put `index.html`, `styles.css`, `app.js`, `data.json` in a repo.
2. GitHub: **Settings → Pages → Deploy from branch → main / root**. Live at
   `https://<org>.github.io/<repo>/`. Share the link.
3. Live sync needs a real host (like Pages) — it doesn't run inside the claude.ai artifact preview,
   which blocks external calls.

Run locally: `python3 -m http.server 4599`, then open `http://localhost:4599`.

## Files
```
index.html   styles.css   app.js   data.json   assets/
```
`data.json` is the seed data (100 milestones, 5 markets, 9 teams, normalized from the 2030 Strat Plan
workbook). Some FL items are flagged ⚑ to confirm Miami-Dade vs Broward; the "Transition to Regional
Operations (prep for FDOS)" milestones mark where the committee hands off to the regional team.
