/* ============================================================
   School Opening Timeline & Project Management
   3-tab tool per implementation spec.
   Vanilla JS · auto-save · optional Supabase live sync.
   ============================================================ */
'use strict';

/* ---------- workstreams ----------
   One app serves several workstream boards. The page sets window.NGC_WS before app.js loads
   (readiness.html = 'readiness', enabling.html = 'enabling'). Milestones share one table and carry
   `ws`; records without it belong to Growth Readiness. Schools and owners are shared across boards;
   teams, starter templates and capital campaigns are kept per board. */
const WS = window.NGC_WS || 'readiness';
const WS_PAGE = { readiness: 'readiness.html', enabling: 'enabling.html' };
const WS_OWN_SETTINGS = ['teams', 'templates', 'campaigns', 'seeded'];
const WS_SEED = {
  // url: starting tasks, teams and owners (built from the Enabling Work sheet of the
  // "KTAF - New School Openings - Workspace" workbook). Loaded into the shared board once.
  enabling: { title: 'Enabling Work', url: 'enabling-seed.json' }
};
function mergeOwners(list) {
  const own = meta().owners || (meta().owners = []), have = new Set(own.map(o => o.name));
  let added = 0; (list || []).forEach(o => { if (o && o.name && !have.has(o.name)) { own.push({ name: o.name, role: o.role || '' }); have.add(o.name); added++; } });
  return added;
}
const inWs = d => !!d && (d.ws || 'readiness') === WS;
const wsOtherIds = new Map();   // id -> workstream, for records that belong to another board
try { localStorage.setItem('ngc_last_ws', WS); } catch (e) {}   // "Last opened" on the home page
function stampWs() { if (WS !== 'readiness' && state.data) (state.data.milestones || []).forEach(m => { if (!m.ws) m.ws = WS; }); }

const LS = { theme: 'ngc_theme', data: WS === 'readiness' ? 'ngc_data' : 'ngc_data_' + WS, gh: 'ngc_gh', supabase: 'ngc_supabase', ui: 'ngc_ui', gate: 'ngc_gate', team: 'ngc_team' };
/* Safe storage - sandboxed iframes (e.g. the published artifact) throw on any localStorage access.
   Never let that break app init / event wiring. */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

const state = {
  data: null,
  view: 'progress',              // progress(dashboard) | plan | reports
  planGroup: 'team',             // team | stage | market | year | school  (default: Workstream)
  planFocus: false,              // "Needs attention" quick filter (overdue/due-soon/behind)
  progressView: 'charts',        // charts | list
  progressDim: 'team',           // team | year | market | school | state
  dashBreakdown: 'workstream',   // dashboard progress breakdown: workstream | school
  reportsTab: 'overview',       // overview | timeline | list
  expanded: {},                  // progress section/item expand map
  filters: { states: new Set(), fys: new Set(), types: new Set(), areas: new Set(), owners: new Set(), markets: new Set(), statuses: new Set(), priorities: new Set(), openingFYs: new Set(), schoolId: '', search: '', timing: '' },
  sb: { connected: false, client: null },
  auth: { user: null, profile: null, wired: false },
};

/* ---------- palette (spec colors) ---------- */
const STATE_COLOR = { NJ: '#002D9C', FL: '#005D5D' }; // Carbon categorical: Blue 80, Teal 70
// IBM Carbon throughout: Blue 60 for primary actions, support colors for status (see RAG), categorical palette for categories.
// Market palette: distinct hues, deliberately non-overlapping with status colors
// Category colors follow Carbon's data visualization palette (carbondesignsystem.com). Reds are skipped: red means "behind".
const MARKET_COLOR = { Newark: '#6929C4', Paterson: '#1192E8', Camden: '#005D5D', Broward: '#9F1853', 'Miami-Dade': '#198038', Orange: '#002D9C', Orlando: '#002D9C' };
const TYPE_COLOR = { ES: '#1192E8', MS: '#005D5D', HS: '#6929C4' };
const mkColor = m => MARKET_COLOR[m] || '#6F6F6F';
const stColor = s => STATE_COLOR[s] || '#6F6F6F';
const PRIORITY = { high: { label: 'High', color: '#DA1E28' }, medium: { label: 'Medium', color: '#B28600' }, low: { label: 'Low', color: '#6F6F6F' } };

/* ---------- utils ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const uid = () => Math.random().toString(36).slice(2, 12);
function fyLabel(fy) { return fy ? `${String(fy - 1).slice(-2)}–${String(fy).slice(-2)}` : '-'; }
function fyList() { const lo = Math.min(2026, currentFY() - 1), hi = Math.max(2033, currentFY() + 7); return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i); }
// KIPP fiscal year runs July-June and is named for the year it ends: FY27 = Jul 2026 - Jun 2027.
// Q1 = Jul-Sep, Q2 = Oct-Dec, Q3 = Jan-Mar, Q4 = Apr-Jun.
function fyOfMonth(y, mo) { return mo >= 6 ? y + 1 : y; }   // mo is 0-based (6 = July)
function fqOfMonth(mo) { return 'Q' + (Math.floor(((mo + 6) % 12) / 3) + 1); }
function currentFY() { const n = new Date(); return fyOfMonth(n.getFullYear(), n.getMonth()); }
// Date math runs on local calendar days, never clock time, so hours and DST can't shift a count.
function today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function dayNum(d) { return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000; }
function daysBetween(a, b) { return dayNum(b) - dayNum(a); }
// whole calendar months from a to b (Oct 30 -> Aug 1 = 9, since the 10th month isn't complete)
function monthsBetween(a, b) { return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0); }
// the fiscal quarter a day falls in, with its first/last day and days remaining until its last day
function fiscalQuarter(d = today()) {
  const fy = fyOfMonth(d.getFullYear(), d.getMonth()), qi = Math.floor(((d.getMonth() + 6) % 12) / 3);
  const startMo = (6 + qi * 3) % 12, startY = startMo >= 6 ? fy - 1 : fy;
  const start = new Date(startY, startMo, 1), end = new Date(startY, startMo + 3, 0);
  return { fy, q: 'Q' + (qi + 1), start, end, daysLeft: daysBetween(d, end) };
}
function fqLabel(fq) { return `FY${String(fq.fy).slice(-2)} ${fq.q}`; }
// a task with a due date always reports the fiscal year + quarter that date falls in
function syncFiscal(m) {
  const d = /^(\d{4})-(\d{2})/.exec(m.due_date || ''); if (!d) return m;
  m.targetFY = fyOfMonth(+d[1], +d[2] - 1); m.targetQuarter = fqOfMonth(+d[2] - 1);
  return m;
}
function initials(n) { return String(n || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase(); }
// deterministic per-person avatar color (Asana/Jira-style), so each owner is visually distinct
const AVATAR_COLORS = ['#002D9C', '#6929C4', '#005D5D', '#9F1853', '#8A3800', '#0072C3', '#198038', '#491D8B', '#004144', '#00539A']; // Carbon, all 4.5:1+ with white initials
function avatarColor(n) { const s = String(n || ''); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; }
// initials-only person chip: colored circle, full name on hover. `unassigned` = neutral dashed circle.
// everyone accountable for a milestone: the owner plus any co-owners
function ownersOf(m) { return [m.owner, ...(m.coOwners || [])].filter(Boolean); }
function ownsM(m, name) { return !!name && ownersOf(m).includes(name); }
function personChip(name, cls) {
  if (!name) return `<span class="pchip pchip-none ${cls || ''}" title="Unassigned">–</span>`;
  return `<span class="pchip ${cls || ''}" title="${esc(name)}" style="background:${avatarColor(name)}">${esc(initials(name))}</span>`;
}
function fmtMoney(n) { n = +n || 0; const a = Math.abs(n), sg = n < 0 ? '-' : ''; if (a >= 999500) return sg + '$' + (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'; if (a >= 1e3) return sg + '$' + Math.round(a / 1e3) + 'K'; return sg + '$' + Math.round(a); }
function parseDate(s) { return s ? new Date(s + 'T00:00:00') : null; }
function daysUntil(s) { const d = parseDate(s); if (!d) return null; return daysBetween(today(), d); }
function fmtDate(s) { const d = parseDate(s); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-'; }
/* ---------- threaded notes (attach to a task or school; surface wherever it's opened) ---------- */
function fmtWhen(t) { try { return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
function noteItemHtml(nt) { return `<div class="note-item"><div class="note-meta"><b>${nt.by ? esc(nt.by) : 'Someone'}</b> · ${esc(fmtWhen(nt.t))}</div><div class="note-text">${renderNoteText(nt)}</div></div>`; }
async function postNote(wrap) {
  if (!wrap || !canComment()) return;
  const kind = wrap.dataset.notekind, id = wrap.dataset.noteid;
  const inp = wrap.querySelector('#noteInput'), au = wrap.querySelector('#noteAuthor'), btn = wrap.querySelector('#noteAdd');
  const text = (inp.value || '').trim(); if (!text) { inp.focus(); return; }
  const by = ((au && au.value) || currentDisplayName() || '').trim();
  const ent = kind === 'school' ? (state.data.schools || []).find(x => x.id === id) : findM(id);
  if (!ent) return;
  const nt = { t: Date.now(), by, text }, ments = mentionsIn(text);
  if (ments.length) nt.mentions = ments;
  closeMentionMenu();
  const live = state.sb && state.sb.connected && sbLoaded && state.auth.user;
  if (live) {
    // Notes are added on the server in one step, so two people posting at once both keep their note.
    if (btn) btn.disabled = true;
    try {
      await sbFlush();   // a just-created record must exist on the server first
      const table = kind === 'school' ? SB_TABLE.s : SB_TABLE.m, last = kind === 'school' ? sbLastSchools : sbLastPushed;
      const r = await state.sb.client.rpc('growth_add_note', { p_table: table, p_id: id, p_note: nt });
      if (r.error) throw r.error;
      const base = last.has(id) ? JSON.parse(last.get(id)) : null;
      mergeIncoming(ent, base, r.data); last.set(id, JSON.stringify(r.data));
      autosaveWriteLocal();
    } catch (e) {
      console.error(e); if (btn) btn.disabled = false;
      return toast("Couldn't post the note: " + syncErrorText(e), 'err');
    }
    if (btn) btn.disabled = false;
  } else {
    if (!Array.isArray(ent.noteLog)) ent.noteLog = [];
    ent.noteLog.push(nt); autosave();
  }
  const thread = wrap.querySelector('.note-thread');
  thread.innerHTML = (ent.noteLog || []).slice().sort((x, y) => x.t - y.t).map(noteItemHtml).join('');
  inp.value = ''; inp.focus();
  thread.scrollTop = thread.scrollHeight;
}
function notesSection(kind, id, log) {
  const items = (log || []).slice().sort((a, b) => a.t - b.t).map(noteItemHtml).join('') || '<div class="note-empty muted">No comments yet</div>';
  return `<div class="notes-field" data-notekind="${kind}" data-noteid="${esc(id)}"><label class="notes-label">Comments</label>
    <div class="note-thread">${items}</div>
    <div class="note-add"><input id="noteAuthor" type="hidden" value="${esc(currentDisplayName())}"><input id="noteInput" maxlength="4000" class="note-input" placeholder="Add a comment. Type @ to mention someone" autocomplete="off" aria-label="Add a comment"><button class="btn btn-filled btn-sm" id="noteAdd">Post</button></div></div>`;
}

/* ---------- status meta ---------- */
// Display-time status colors: earlier default colors map to Carbon support colors.
// A color someone customized in Settings is left as they set it. Stored data is not changed.
const ADS_STATUS = { not_started: '#8D8D8D', on_track: '#0043CE', at_risk: '#B28600', behind: '#DA1E28', complete: '#24A148', blocked: '#A2191F' };
const LEGACY_STATUS = { not_started: ['#C7CCD6', '#B7B9BE'], on_track: ['#43B0E6', '#357DE8'], at_risk: ['#F6A11C', '#E06C00'], behind: ['#E63E2F', '#C9372C'], complete: ['#4A8C1F', '#79A81E', '#6A9A23'], blocked: ['#B3261E', '#AE2E24'] };
const SM = k => { const m = state.data.meta.statusMeta[k] || { label: k, color: '#ccc', text: '#000' }; const old = LEGACY_STATUS[k];
  return old && [].concat(old).includes(String(m.color).toUpperCase()) ? Object.assign({}, m, { color: ADS_STATUS[k] }) : m; };
// Carbon status indicator (shape plus label) for the standard statuses; custom statuses keep their own color with readable text.
/* Carbon glyphs used inside text and small controls */
const CI = n => `<svg class="ci" viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true">${CI_PATHS[n]}</svg>`;
const CI_PATHS = { close: '<path d="M17.4141 16L24 9.4141 22.5859 8 16 14.5859 9.4143 8 8 9.4141 14.5859 16 8 22.5859 9.4143 24 16 17.4141 22.5859 24 24 22.5859 17.4141 16z"/>', flag: '<path d="M6,30H4V2H28l-5.8,9L28,20H6ZM6,18H24.33L19.8,11l4.53-7H6Z"/>', arrow: '<path d="M18 6L16.57 7.393 24.15 15 4 15 4 17 24.15 17 16.57 24.573 18 26 28 16 18 6z"/>', check: '<path d="M13 24L4 15 5.414 13.586 13 21.171 26.586 7.586 28 9 13 24z"/>' };
function statusLozenge(k) { const m = SM(k); return ADS_STATUS[k] ? `<span class="stpill st-${k}"><i></i>${esc(m.label)}</span>` : `<span class="stpill" style="background:${m.color}22;color:var(--cds-text-primary)"><i style="background:${m.color}"></i>${esc(m.label)}</span>`; }
function statusDot(k) { return ADS_STATUS[k] ? `<i class="stdot st-${k}"></i>` : `<i class="stdot" style="background:${SM(k).color}"></i>`; }

/* ---------- timing (live, date-driven urgency) ---------- */
const SEV = { not_started: 0, on_track: 1, at_risk: 2, behind: 3, blocked: 4, complete: 9 };
function worseStatus(a, b) { return (SEV[a] || 0) >= (SEV[b] || 0) ? a : b; }
// open items due today through 30 days from today (Oct 30 -> through Nov 29)
function dueWithin30(m) { const d = daysUntil(m.due_date); return effectiveStatus(m) !== 'complete' && d != null && d >= 0 && d <= 30; }
// open items due today through the last day of the current fiscal quarter
function dueThisQuarter(m) { const d = daysUntil(m.due_date); return effectiveStatus(m) !== 'complete' && d != null && d >= 0 && d <= fiscalQuarter().daysLeft; }
function timingLevel(m) {
  if (m.status === 'complete') return 'done';
  const d = daysUntil(m.due_date); if (d == null) return 'none';
  if (d < 0) return 'overdue';
  if (d <= 14) return 'this_month';   // key kept for saved filters; it means due within the next 14 days
  if (d <= 30) return 'soon';
  return 'ok';
}
/* effective health = manual status escalated by real timing (never downgraded) */
function effectiveStatus(m) {
  if (m.status === 'complete') return 'complete';
  if (m.status === 'blocked') return 'blocked';
  const t = timingLevel(m); let s = m.status || 'not_started';
  if (t === 'overdue') s = worseStatus(s, 'behind');
  else if (t === 'this_month') s = worseStatus(s, 'at_risk');
  const lc = lastCheckin(m); if (lc && lc.forecast && m.due_date && lc.forecast > m.due_date) s = worseStatus(s, 'behind');
  if (missedCheckpoints(m).length) s = worseStatus(s, 'at_risk');
  return s;
}
function dueBadge(m) {
  const t = timingLevel(m), d = daysUntil(m.due_date);
  if (t === 'overdue') return `<span class="due-badge overdue">${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} overdue</span>`;
  if (t === 'this_month') return `<span class="due-badge month">Due ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : 'in ' + d + ' days'}</span>`;
  if (t === 'soon') return `<span class="due-badge soon">${d === 0 ? "Due today" : `Due in ${d} day${d === 1 ? "" : "s"}`}</span>`;
  return '';
}

/* ---------- data load / save ---------- */
// Per-version migrations. Each runs when upgrading TO that version from anything lower.
// Mutate the cached user data in place; `base` is the fresh data.json (read-only reference).
// This preserves user edits across version bumps - only the targeted fields change.
const DATA_MIGRATIONS = {
  16: (data /* , base */) => {
    // Fix "complete" status color: #79A81E failed WCAG AA contrast with white text (~2.9:1).
    // Only override if the cached value is the known-bad one (respects user customization).
    const sm = data.meta && data.meta.statusMeta;
    if (sm && sm.complete && sm.complete.color === '#79A81E') sm.complete.color = '#4A8C1F';
  },
  17: (data, base) => {
    if (data.meta && base.meta && base.meta.milestoneTemplates && !data.meta.milestoneTemplates) {
      data.meta.milestoneTemplates = JSON.parse(JSON.stringify(base.meta.milestoneTemplates));
    }
  },
  18: (data /* , base */) => {
    // Flip everyone to Individual accounts as the default (shared-password mode retired).
    if (data.meta) data.meta.authMode = 'supabase';
  },
  19: (data, base) => {
    // Oct 30 2026: milestones hard-reset to the SY28/SY29 fiscal-quarter spreadsheet (72 rows, the source of truth).
    data.milestones = JSON.parse(JSON.stringify(base.milestones));
  },
  20: (data, base) => {
    // owner roster gains login emails (backup link from account to owner); keep any local edits otherwise
    const em = Object.fromEntries(((base.meta && base.meta.owners) || []).filter(o => o.email).map(o => [o.name, o.email]));
    ((data.meta && data.meta.owners) || []).forEach(o => { if (!o.email && em[o.name]) o.email = em[o.name]; });
  }
};
/* Normalize milestone shape on every load. This is idempotent and cheap.
   It resolves the schema debt (team vs functional_area, schools vs schoolIds,
   three booleans vs one type) without needing a versioned migration. Reads
   throughout the app assume the normalized shape. Writes still populate
   both fields on new items for backward compatibility. */
const TEAM_ALIASES = { 'Advancement': 'Fundraising' };   // one canonical label per functional team
function canonTeam(v) { return TEAM_ALIASES[v] || v; }
function normalizeData(data) {
  if (!data || !Array.isArray(data.milestones)) return data;
  // Keep the team roster on one canonical label set (functional_area is the read of record).
  if (data.meta) {
    if (Array.isArray(data.meta.teams)) data.meta.teams = data.meta.teams.map(canonTeam);
    if (Array.isArray(data.meta.functionalAreas)) data.meta.functionalAreas = data.meta.functionalAreas.map(canonTeam);
    else if (Array.isArray(data.meta.teams)) data.meta.functionalAreas = data.meta.teams.slice();
  }
  data.milestones.forEach(m => {
    // Team: functional_area is the canonical read; sync team = functional_area.
    if (m.functional_area && !m.team) m.team = m.functional_area;
    else if (m.team && !m.functional_area) m.functional_area = m.team;
    m.functional_area = canonTeam(m.functional_area); m.team = canonTeam(m.team);
    // Schools: schoolIds is the source of truth; keep schools codes as a mirror.
    if (!Array.isArray(m.schoolIds)) m.schoolIds = [];
    if (!Array.isArray(m.schools)) m.schools = [];
    // Derived type enum from the historical boolean flags. Preserves flags for
    // any code path that still reads them; new UI can read m.type directly.
    if (!m.type) m.type = m.greenlight ? 'greenlight' : m.transition ? 'transition' : m.keyMilestone ? 'key' : 'task';
    syncFiscal(m);
  });
  return data;
}

async function loadData() {
  let base;
  if (window.__EMBEDDED_DATA__) base = JSON.parse(JSON.stringify(window.__EMBEDDED_DATA__));
  else { try { base = await (await fetch('data.json', { cache: 'no-store' })).json(); } catch (e) { $('.container').innerHTML = '<div class="empty-state">We couldn\'t load the board<button class="btn btn-tonal btn-sm" onclick="location.reload()">Refresh</button></div>'; return null; } }
  if (WS !== 'readiness') {   // another board: shared schools/owners/statuses, its own tasks and teams
    const cfg = WS_SEED[WS] || {};
    let seed = null;
    if (cfg.url) { try { seed = await (await fetch(cfg.url, { cache: 'no-store' })).json(); } catch (e) { console.warn('Board starting data not found:', e); } }
    state.wsSeed = seed;
    base.milestones = seed && seed.milestones ? JSON.parse(JSON.stringify(seed.milestones)) : [];
    base.campaigns = [];
    if (base.meta) {
      base.meta.milestoneTemplates = [];
      if (cfg.title) base.meta.title = cfg.title;
      if (seed && seed.teams) { base.meta.teams = seed.teams.slice(); base.meta.functionalAreas = seed.teams.slice(); }
      if (seed && seed.owners) { const o = base.meta.owners || (base.meta.owners = []), have = new Set(o.map(x => x.name)); seed.owners.forEach(x => { if (!have.has(x.name)) o.push({ name: x.name, role: x.role || '' }); }); }
    }
  }
  try {
    const s = JSON.parse(lsGet(LS.data) || 'null');
    if (s && s.milestones && WS !== 'readiness' && !s.milestones.length && base.milestones.length) throw 0;   // an empty early copy: use the starting data
    if (s && s.milestones) {
      const baseV = (base.meta && base.meta.version) || 0;
      const cachedV = s.__baseVersion || 0;
      if (cachedV === baseV) return normalizeData(s);          // versions match - use cache as-is
      if (cachedV < baseV) {                                    // upgrade path - migrate in place, keep user data
        for (let v = cachedV + 1; v <= baseV; v++) {
          const fn = DATA_MIGRATIONS[v];
          if (fn) { try { fn(s, base); } catch (e) { console.warn('data migration v' + v + ' failed:', e); } }
        }
        s.__baseVersion = baseV;
        try { lsSet(LS.data, JSON.stringify(s)); } catch (e) {}   // persist the migrated cache
        return normalizeData(s);
      }
      return normalizeData(s);                                  // cached ahead of shipped (unexpected) - trust cache
    }
  } catch (e) {}
  return normalizeData(base);
}
let saveTimer = null;
function autosaveWriteLocal() { stampWs(); try { const c = JSON.parse(JSON.stringify(state.data)); c.milestones = (c.milestones || []).filter(m => !m._draft); c.__baseVersion = state.data.meta && state.data.meta.version; lsSet(LS.data, JSON.stringify(c)); return true; } catch (e) { return false; } }
function autosave() {
  const b = $('#saveState'), live = state.sb && state.sb.connected;
  if (b) { b.textContent = live ? 'Syncing…' : 'Saving…'; b.className = 'save-state saving'; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { const ok = autosaveWriteLocal(); if (live) sbPushDebounced(); if (b) { b.textContent = ok ? (live ? 'Synced • live' : 'All changes saved') : 'Save failed'; b.className = 'save-state ' + (ok ? 'saved' : 'err'); } }, 250);
}

/* ---------- selectors ---------- */
const M = () => state.data.milestones;
const findM = id => M().find(m => m.id === id);
const meta = () => state.data.meta;
const markets = () => meta().markets;
const teams = () => meta().teams;
const statesMeta = () => meta().states;
const stateOfMarket = mk => { const s = statesMeta().find(s => s.markets.includes(mk)); return s ? s.code : ''; };
// tasks belong to a school by its STABLE id; composite (code+market+openingFY) is a legacy fallback for any un-migrated task
const taskInSchool = (m, s) => Array.isArray(m.schoolIds) ? m.schoolIds.includes(s.id) : ((m.schools || []).includes(s.code) && m.openingFY === s.openingFY && m.market === s.market);
const schoolMs = s => M().filter(m => taskInSchool(m, s));

function passFilters(m) {
  const f = state.filters;
  if (f.states.size && !f.states.has(m.state)) return false;
  if (f.fys.size && !f.fys.has(m.targetFY)) return false;
  if (f.areas.size && !f.areas.has(m.functional_area)) return false;
  if (f.owners.size && !ownersOf(m).some(o => f.owners.has(o)) && !(f.owners.has('__none__') && !ownersOf(m).length)) return false;
  if (f.markets.size && !f.markets.has(m.market)) return false;
  if (f.statuses.size && !f.statuses.has(effectiveStatus(m))) return false;
  if (f.priorities.size && !f.priorities.has(m.priority)) return false;
  if (f.timing === 'due30') { if (!dueWithin30(m)) return false; }
  else if (f.timing === 'dueQ') { if (!dueThisQuarter(m)) return false; }
  else if (f.timing && timingLevel(m) !== f.timing) return false;
  if (f.flag && !flagPass(m, f.flag)) return false;
  if (f.openingFYs.size && m.openingFY && !f.openingFYs.has(m.openingFY)) return false;
  if (f.schoolId) { const sc = state.data.schools.find(x => x.id === f.schoolId); if (!sc || !taskInSchool(m, sc)) return false; }
  if (f.search) { const q = f.search.toLowerCase(); if (!`${m.activity} ${m.workstream} ${m.functional_area} ${m.market} ${ownersOf(m).join(' ')} ${(m.tags || []).join(' ')}`.toLowerCase().includes(q)) return false; }
  return true;
}
function filtered() { return M().filter(m => !m._draft && passFilters(m)); }
function pct(list) { return list.length ? Math.round(100 * list.filter(m => m.status === 'complete').length / list.length) : 0; }

/* school rollup status (worst-of) for timeline/health */
function avgProgress(list) {
  if (!list.length) return 0;
  return Math.round(list.reduce((a, m) => a + (effectiveStatus(m) === 'complete' ? 100 : Math.max(0, Math.min(100, +m.progress_percent || 0))), 0) / list.length);
}
function rollupStatus(list) {
  // Same rules as ragReady so a school's status matches on every screen (blocked counts as behind)
  return { green: 'complete', red: 'behind', yellow: 'at_risk', blue: 'on_track', none: 'not_started' }[ragReady(list).key];
}

/* ---------- toggle a Set filter ---------- */
function toggleFilter(key, val, cast) {
  const set = state.filters[key]; val = cast ? cast(val) : val;
  if (set.has(val)) set.delete(val); else set.add(val);
  // cascade cleanup: drop downstream selections that no longer belong
  if (key === 'states') { const ok = new Set(marketsForStates()); [...state.filters.markets].forEach(mk => { if (!ok.has(mk)) state.filters.markets.delete(mk); }); }
  if (key === 'states' || key === 'markets') { const sc = state.filters.schoolId && schoolById(state.filters.schoolId); if (sc && !schoolFacetPass(sc, null)) state.filters.schoolId = ''; }
  if (key === 'areas') saveTeamScope();
}
function clearFilters() { ['states', 'fys', 'types', 'areas', 'owners', 'markets', 'statuses', 'priorities', 'openingFYs'].forEach(k => state.filters[k].clear()); state.filters.schoolId = ''; state.filters.search = ''; state.filters.timing = ''; state.filters.flag = ''; const cb = $('#cbSearch'); if (cb) cb.value = ''; saveTeamScope(); }
// The Team lens is the one filter that follows a leader across pages (their "my function" scope),
// so it survives tab navigation and reloads. Everything else is transient to the current view.
function clearTransientFilters() { ['states', 'fys', 'types', 'owners', 'markets', 'statuses', 'priorities', 'openingFYs'].forEach(k => state.filters[k].clear()); state.filters.schoolId = ''; state.filters.search = ''; state.filters.timing = ''; state.filters.flag = ''; const cb = $('#cbSearch'); if (cb) cb.value = ''; }
function saveTeamScope() { lsSet(LS.team, JSON.stringify([...state.filters.areas])); }
function restoreTeamScope() { try { const t = JSON.parse(lsGet(LS.team) || '[]'); const valid = new Set(teams()); t.forEach(v => { if (valid.has(v)) state.filters.areas.add(v); }); } catch (e) {} }
/* which opening cohorts (fiscal years) to display - empty = show all */
function openingYears() { return [...new Set(state.data.schools.filter(s => s.openingFY).map(s => s.openingFY))].sort((a, b) => a - b); }
function oyShown(fy) { return !state.filters.openingFYs.size || state.filters.openingFYs.has(fy); }
function toggleOpeningYear(fy) {
  // Additive: no selection = show all; click a year to add it to the filter; click again to remove.
  // No more "seed all then subtract" trick - that made the first click read as "delete this year."
  const f = state.filters.openingFYs;
  f.has(fy) ? f.delete(fy) : f.add(fy);
  if (f.size === openingYears().length) f.clear();   // selecting every year is equivalent to no filter
}

/* ============================================================
   TAB 1 - SCHOOL OPENING TIMELINE (Gantt)
   ============================================================ */
function ganttSchools() {
  const f = state.filters;
  return state.data.schools.filter(s => s.openingFY)
    .filter(s => !f.states.size || f.states.has(s.state))
    .filter(s => !f.types.size || f.types.has(s.school_type))
    .filter(s => !f.markets.size || f.markets.has(s.market))
    .filter(s => !f.fys.size || f.fys.has(s.openingFY))
    .filter(s => oyShown(s.openingFY));
}
function fchip(key, val, label, color) {
  const on = state.filters[key].has(val);
  return `<button class="fchip ${on ? 'on' : ''}" data-fkey="${key}" data-fval="${esc(val)}" ${key === 'fys' ? 'data-num="1"' : ''}>${color ? `<i style="background:${color}"></i>` : ''}${esc(label)}</button>`;
}

/* ---------- unified filter bar (dropdown menus, live counts) ---------- */
const FILTER_LABEL = { openingFYs: 'Opening year', states: 'State', types: 'Type', markets: 'Market', fys: 'Due year', areas: 'Team', owners: 'Owner', statuses: 'Status', priorities: 'Priority' };
/* Hierarchical facets: a menu's options are limited by the filters chosen above it
   (State → Market → Year → Team → Status). Empty upstream = show everything. */
const selStates = () => state.filters.states;
function marketsForStates() { const ss = selStates(); const all = markets(); if (!ss.size) return all; return all.filter(mk => statesMeta().some(st => ss.has(st.code) && (st.markets || []).includes(mk))); }
function facetPass(m, skip) {
  const f = state.filters;
  if (skip !== 'states' && f.states.size && !f.states.has(m.state)) return false;
  if (skip !== 'markets' && f.markets.size && !f.markets.has(m.market)) return false;
  if (skip !== 'fys' && f.fys.size && !f.fys.has(m.targetFY)) return false;
  if (skip !== 'areas' && f.areas.size && !f.areas.has(m.functional_area)) return false;
  if (skip !== 'owners' && f.owners.size && !ownersOf(m).some(o => f.owners.has(o)) && !(f.owners.has('__none__') && !ownersOf(m).length)) return false;
  if (skip !== 'statuses' && f.statuses.size && !f.statuses.has(effectiveStatus(m))) return false;
  return true;
}
function schoolFacetPass(s, skip) {
  const f = state.filters;
  if (skip !== 'states' && f.states.size && !f.states.has(s.state)) return false;
  if (skip !== 'markets' && f.markets.size && !f.markets.has(s.market)) return false;
  return true;
}
function filterOpts(key) {
  if (key === 'states') return statesMeta().map(s => [s.code, s.name, stColor(s.code)]);
  if (key === 'types') return [['ES', 'Elementary (ES)'], ['MS', 'Middle (MS)'], ['HS', 'High (HS)']];
  if (key === 'markets') return marketsForStates().map(m => [m, m, mkColor(m)]);
  if (key === 'openingFYs') return openingYears().map(fy => [String(fy), 'Fall ' + (fy - 1)]);
  if (key === 'fys') {
    const yrs = new Set();
    M().forEach(m => { if (m.targetFY && facetPass(m, 'fys')) yrs.add(m.targetFY); });
    state.data.schools.forEach(s => { if (s.openingFY && schoolFacetPass(s, 'fys')) yrs.add(s.openingFY); });
    return fyList().filter(fy => yrs.has(fy)).map(fy => [String(fy), fyLabel(fy)]);
  }
  if (key === 'areas') {
    const present = new Set(); M().forEach(m => { if (facetPass(m, 'areas')) present.add(m.functional_area); });
    const list = teams().filter(t => present.has(t)); return (list.length ? list : teams()).map(t => [t, t]);
  }
  if (key === 'owners') {
    const present = new Set(); M().forEach(m => { if (facetPass(m, 'owners')) ownersOf(m).forEach(o => present.add(o)); });
    return [['__none__', 'Unassigned'], ...[...present].sort((a, b) => a.localeCompare(b)).map(o => [o, o])];
  }
  if (key === 'statuses') return meta().statuses.map(s => [s, SM(s).label, SM(s).color]);
  if (key === 'priorities') return ['high', 'medium', 'low'].map(p => [p, PRIORITY[p].label, PRIORITY[p].color]);
  return [];
}
function activeCount() { let n = 0; ['states', 'types', 'markets', 'fys', 'areas', 'owners', 'statuses', 'priorities', 'openingFYs'].forEach(k => n += state.filters[k].size); if (state.filters.schoolId) n++; if (state.filters.search) n++; if (state.filters.timing) n++; if (state.filters.flag) n++; return n; }
/* Readable name for a selected filter value ("Florida", "Fall 2027"), so filter buttons say what is on */
function fbValueLabel(k, v) {
  if (v === undefined) v = [...state.filters[k]][0];
  if (v === '__none__') return 'Unassigned';
  let o; try { o = filterOpts(k).find(x => String(x[0]) === String(v)); } catch (e) {}
  return o ? o[1] : String(v);
}
function filterBar(menus, opts = {}) {
  // #fSearch removed - #cbSearch in the header content-bar is the single, wired search across every view
  const search = '';
  const btns = menus.map(k => { const n = state.filters[k].size; const show = k === 'owners' && mineOn() ? 0 : n, val = show ? fbValueLabel(k) : ''; return `<button class="fb-menu ${show ? 'on' : ''}" data-fmenu="${k}"${val ? ` title="${esc(FILTER_LABEL[k] + ': ' + [...state.filters[k]].map(v => fbValueLabel(k, v)).join(', '))}"` : ''}><span class="fb-name">${FILTER_LABEL[k]}</span>${val ? `<span class="fb-val">${esc(val)}</span>` : ''}${show > 1 ? `<span class="fb-count">+${show - 1}</span>` : ''}<svg class="fb-chev" viewBox="0 0 32 32" fill="currentColor" width="13" height="13"><path d="M16 22L6 12 7.4 10.6 16 19.2 24.6 10.6 26 12z"/></svg></button>`; }).join('');
  const school = opts.school ? `<select id="dashSchool" class="fb-select"><option value="">All schools</option>${state.data.schools.filter(s => s.openingFY && schoolFacetPass(s, null) && (!state.filters.fys.size || state.filters.fys.has(s.openingFY))).sort((a, b) => (a.openingFY - b.openingFY) || a.market.localeCompare(b.market)).map(s => `<option value="${s.id}" ${state.filters.schoolId === s.id ? 'selected' : ''}>${esc(s.market)} · ${esc(s.display_label)}</option>`).join('')}</select>` : '';
  const me = menus.includes('owners') ? myOwnerName() : '';
  const mine = me ? `<button class="fb-mine ${mineOn() ? 'on' : ''}" id="mineToggle" aria-pressed="${mineOn()}" title="Show only milestones owned by ${esc(me)}">${mineOn() ? CI('check') : ''}Assigned to you</button>` : '';
  return `<div class="filterbar" id="filterbar"><span class="fb-label">Filters</span>${search}${mine}${btns}${school}<button class="fb-clear ${activeCount() ? '' : 'is-empty'}" id="clearFilters"${activeCount() ? '' : ' disabled'}>Clear all</button><span class="fb-spacer"></span>${opts.right || ''}</div>`;
}
/* toggle chips to show / hide opening-year cohorts */
function openFilterMenu(anchor, key) {
  const set = state.filters[key];
  const html = `<div class="pop-title">${FILTER_LABEL[key]}</div><div class="pop-list pop-checks">${filterOpts(key).map(([v, l, color]) => { const on = set.has(key === 'fys' || key === 'openingFYs' ? Number(v) : v); return `<label class="pop-check"><input type="checkbox" data-fkey="${key}" data-fval="${esc(v)}" ${on ? 'checked' : ''}>${color ? `<i class="fdot" style="background:${color}"></i>` : ''}${esc(l)}</label>`; }).join('')}</div>`;
  const p = openPopover(anchor, html);
  p.addEventListener('change', e => {
    const cb = e.target.closest('[data-fkey]'); if (!cb) return;
    const k = cb.dataset.fkey;
    toggleFilter(k, cb.dataset.fval, k === 'fys' || k === 'openingFYs' ? Number : null);
    // Dashboard renders the applied-filter chip row inside the filter bar, so every change needs a
    // rerender to refresh those chips (badges on the menu buttons alone aren't enough).
    const needsFullRerender = k === 'states' || k === 'markets' || k === 'fys' || k === 'openingFYs' || state.view === 'progress';
    if (needsFullRerender) { rerender(); const btn = $(`.fb-menu[data-fmenu="${k}"]`); if (btn) openFilterMenu(btn, k); else closePopover(); }
    else { updateMenuBadge(k); refreshBody(); }
  });
}
function updateMenuBadge(key) {
  const btn = $(`.fb-menu[data-fmenu="${key}"]`);
  if (btn) { const n = state.filters[key].size; btn.classList.toggle('on', !!n); let c = btn.querySelector('.fb-count'); if (n) { if (!c) { c = document.createElement('span'); c.className = 'fb-count'; btn.insertBefore(c, btn.querySelector('.fb-chev')); } c.textContent = n; } else if (c) c.remove(); }
  const cl = $('#clearFilters'); if (cl) cl.classList.toggle('hide', !activeCount());
}
function refreshBody() { const kb0 = document.querySelector('.kanban'), kbX = kb0 ? kb0.scrollLeft : 0; if (kbX) requestAnimationFrame(() => { const k = document.querySelector('.kanban'); if (k) k.scrollLeft = kbX; }); const sec = $('#view-' + state.view); const b = sec ? sec.querySelector('#viewBody') : $('#viewBody'); if (!b) return rerender(); if (state.view === 'progress') b.innerHTML = progressBodyHtml(); else if (state.view === 'timeline') b.innerHTML = ganttBodyHtml(); else b.innerHTML = planBodyHtml(); if (typeof paintAvatars === 'function') requestAnimationFrame(() => paintAvatars(b)); if (typeof updateFilterBubble === 'function') updateFilterBubble(); }
function otCard(s) {
  const sm = schoolMs(s), r = ragReady(sm), n = sm.length;
  const done = sm.filter(m => effectiveStatus(m) === 'complete').length;
  const pct = avgProgress(sm);
  const mk = mkColor(s.market);
  const opens = s.opening_date ? parseDate(s.opening_date) : null;
  const mo = opens ? Math.max(0, monthsBetween(today(), opens)) : null;
  // Group header already announces "Fall YYYY · N months out" - only surface a card-level date when unscheduled.
  const when = s.openingFY ? '' : 'Opening not scheduled';
  const openDue = sm.filter(m => m.due_date && effectiveStatus(m) !== 'complete'), late = openDue.filter(m => daysUntil(m.due_date) < 0).length;
  const nextDue = openDue.map(m => m.due_date).sort()[0];
  const nextLbl = nextDue ? parseDate(nextDue).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const statusLbl = n === 0 ? 'Not yet scoped' : r.label.split(' · ')[0];   // "On track" / "At risk" / "Behind" / "Complete" / "Not started"
  return `<article class="ot-card" data-drillschool="${esc(s.id)}" style="--mk:${mk}">
      <div class="ot-card-top">
        <span class="ot-mkt"><i style="background:${mk}"></i>${esc(s.market)}</span>
        ${n ? statusLozenge(rollupStatus(sm)) : `<span class="stpill st-not_started"><i></i>Not yet scoped</span>`}
      </div>
      <h4 class="ot-title">${esc(s.display_label)}<small>${esc(s.market)}, ${esc(s.state)}</small></h4>
      ${when ? `<p class="ot-when">${esc(when)}</p>` : ''}
      ${n ? `<div class="ot-prog">
        <div class="ot-prog-lbl"><b>${done} of ${n}</b> milestones clear<span class="ot-prog-pct">${pct}%</span></div>
        <div class="ot-prog-bar"><span style="width:${pct}%"></span></div>
        ${late ? `<div class="ot-late">${late} past due</div>` : nextLbl ? `<div class="ot-next">Next: ${esc(nextLbl)}</div>` : ''}
      </div>` : `<div class="ot-prog"><div class="ot-prog-empty">No milestones yet</div></div>`}
    </article>`;
}
function ganttBodyHtml() {
  const list = ganttSchools();
  if (!list.length) return S().length ? '<div class="empty-state">No openings match these filters<button class="btn btn-tonal btn-sm" data-clearfilters>Clear filters</button></div>' : '<div class="empty-state">No school openings yet</div>';
  const now = Date.now();
  const terms = [...new Set(list.map(s => s.openingFY))].filter(Boolean).sort((a, b) => a - b);
  const body = terms.map(fy => {
    const cs = list.filter(s => s.openingFY === fy).sort((a, b) => a.state.localeCompare(b.state) || a.market.localeCompare(b.market) || a.display_label.localeCompare(b.display_label));
    const first = new Date(Math.min(...cs.map(s => +parseDate(s.opening_date))));
    const mo = Math.max(0, monthsBetween(today(), first)), dl = daysBetween(today(), first);
    const when = dl <= 0 ? 'opening now' : mo < 1 ? `${dl} day${dl === 1 ? '' : 's'} out` : `${mo} month${mo === 1 ? '' : 's'} out`;
    return `<section class="ot-term">
      <div class="ot-rail"><span class="ot-node"></span></div>
      <div class="ot-term-body">
        <div class="ot-term-h"><h3>Fall ${fy - 1}</h3><span class="ot-when">${when} · ${cs.length} school${cs.length === 1 ? '' : 's'}</span></div>
        <div class="ot-grid">${cs.map(otCard).join('')}</div>
      </div>
    </section>`;
  }).join('');
  return `<div class="ot">${body}</div>`;
}
function renderTimeline() {
  // No H2 - sidebar already indicates active page. Action button floats right.
  const el = $('#view-timeline'); if (el) el.innerHTML = `
    <div class="view-actions">
      <button class="btn btn-filled" id="addSchool"><svg viewBox="0 0 32 32" fill="currentColor" width="16" height="16"><path d="M17 15L17 8 15 8 15 15 8 15 8 17 15 17 15 24 17 24 17 17 24 17 24 15z"/></svg>Add school opening</button>
    </div>
    ${filterBar(['openingFYs', 'states', 'markets', 'types'])}
    <div id="viewBody">${ganttBodyHtml()}</div>`;
}
// (Deleted: renderReports + reportsBodyHtml. The Reports tab was removed
//  months ago; the functions had no callers and referenced a #view-reports
//  element that no longer exists in index.html.)

/* ============================================================
   TAB 2 - PROGRESS MONITORING (collapsible)
   ============================================================ */
function chev(open) { return `<svg class="chev ${open ? 'open' : ''}" viewBox="0 0 32 32" fill="currentColor" width="16" height="16"><path d="M22 16L12 26 10.6 24.6 19.2 16 10.6 7.4 12 6z"/></svg>`; }

const URANK = { overdue: 0, this_month: 1, soon: 2, ok: 3, none: 4, done: 5 };
function bySortUrgency(a, b) { return (URANK[timingLevel(a)] - URANK[timingLevel(b)]) || ((a.targetFY || 9999) - (b.targetFY || 9999)); }


function progressBodyHtml() {
  return dashboardHtml(filtered());   // Dashboard is the only status view; drill-downs jump to the Project Plan
}
function renderProgress() {
  const printBtn = `<button class="btn btn-ghost btn-sm" id="dashPrint" title="Print report"><svg viewBox="0 0 32 32" fill="currentColor" width="16" height="16"><path d="M28,9H25V3H7V9H4a2,2,0,0,0-2,2V21a2,2,0,0,0,2,2H7v6H25V23h3a2,2,0,0,0,2-2V11A2,2,0,0,0,28,9ZM9,5H23V9H9ZM23,27H9V17H23Zm5-6H25V15H7v6H4V11H28Z"/></svg><span class="pr-l">Print report</span></button>`;
  // Filter bar is always visible on the dashboard: it's a primary scoping control, not an occasional detour.
  // Menus kept to what changes the STATUS picture: State, Market, Workstream. Opening year lives on the cohort strip;
  // status/priority filters belong to the Project Plan (the dashboard IS the status/priority view).
  $('#view-progress').innerHTML = `
    <div class="dash-filters" id="dashFilters">${filterBar(hasSchoolWork() ? ['openingFYs', 'states', 'markets', 'areas', 'owners'] : ['states', 'markets', 'areas', 'owners'], { right: appliedFilterChips({ hiddenOnly: true }) + printBtn })}</div>
    <div class="mast-status" id="mastStatus"><div class="ms-l"><div class="ms-greet" id="msGreet" role="heading" aria-level="1"></div><div class="cb-brief" id="cbBrief" aria-label="Today at a glance"></div></div><div class="cb-quarter" id="cbQuarter"></div></div>
    <div id="viewBody">${progressBodyHtml()}</div>`;
}
/* Applied-filter chips: shown inline in the filter bar so the current scope is visible at a glance
   and individually removable (no "open the panel to see what's on" hunt). */
function appliedFilterChips(opts = {}) {
  const f = state.filters, chips = [];
  const push = (label, onRemove) => chips.push(`<button class="af-chip" data-afclear="${onRemove}" title="Remove filter"><span>${esc(label)}</span><svg viewBox="0 0 32 32" fill="currentColor" width="12" height="12"><path d="M17.4141 16L24 9.4141 22.5859 8 16 14.5859 9.4143 8 8 9.4141 14.5859 16 8 22.5859 9.4143 24 16 17.4141 22.5859 24 24 22.5859 17.4141 16z"/></svg></button>`);
  if (!opts.hiddenOnly) f.states.forEach(v => push('State: ' + v, 'states:' + v));
  if (!opts.hiddenOnly) f.markets.forEach(v => push(v, 'markets:' + v));
  if (!opts.hiddenOnly) f.areas.forEach(v => push(v, 'areas:' + v));
  if (!opts.hiddenOnly) if (!mineOn()) f.owners.forEach(v => push(v === '__none__' ? 'Unassigned' : 'Owner: ' + v, 'owners:' + v));
  if (!opts.hiddenOnly) f.openingFYs.forEach(v => push('Fall ' + (v - 1), 'openingFYs:' + v));
  f.statuses.forEach(v => push(SM(v).label, 'statuses:' + v));
  if (f.timing) push(f.timing === 'overdue' ? 'Overdue' : f.timing === 'this_month' ? 'Due within 2 weeks' : f.timing === 'due30' ? 'Due in 30 days' : f.timing === 'dueQ' ? 'Due by end of ' + fiscalQuarter().q : 'Due soon', 'timing:');
  if (f.flag) push(FLAG_LABEL[f.flag] || f.flag, 'flag:');
  if (f.search) push('“' + f.search.slice(0, 24) + (f.search.length > 24 ? '…' : '') + '”', 'search:');
  if (f.schoolId) { const sc = schoolById(f.schoolId); if (sc) push(sc.market + ' · ' + sc.display_label, 'schoolId:'); }
  if (!chips.length) return '';
  return `<div class="af-chips">${chips.join('')}</div>`;
}
function removeAppliedFilter(spec) {
  const [key, val] = spec.split(':');
  const f = state.filters;
  if (key === 'timing') f.timing = '';
  else if (key === 'flag') f.flag = '';
  else if (key === 'search') { f.search = ''; const cb = $('#cbSearch'); if (cb) cb.value = ''; }
  else if (key === 'schoolId') f.schoolId = '';
  else if (f[key] instanceof Set) {
    if (key === 'openingFYs' || key === 'fys') f[key].delete(Number(val));
    else f[key].delete(val);
    if (key === 'states') { const ok = new Set(marketsForStates()); [...f.markets].forEach(mk => { if (!ok.has(mk)) f.markets.delete(mk); }); }
  }
  if (key === 'areas') saveTeamScope();
}

/* ============================================================
   TAB 3 - PROJECT PLAN (Kanban)
   ============================================================ */
function planCard(m, opts = {}) {
  const es = effectiveStatus(m), t = timingLevel(m), scol = SM(es).color;
  const urgent = t === 'overdue' || t === 'this_month';
  const nc = (m.noteLog || []).length;
  const mk = m.market ? mkColor(m.market) : '';
  // Information order (top → bottom): TITLE (what) · CONTEXT region · school + due date (where/when,
  //   one row) · PROGRESS · OWNER (who). Never lead with a date.
  // Drop the team chip when the list is already grouped by team (redundant inside its own group).
  const showTeam = m.functional_area && !opts.hideTeam;
  // School label: prefer stable schoolIds, fall back to legacy `schools` codes (already short labels like "ES3").
  let schoolNames = (Array.isArray(m.schoolIds) ? m.schoolIds : []).map(id => (state.data.schools.find(s => s.id === id) || {}).display_label).filter(Boolean);
  if (!schoolNames.length && Array.isArray(m.schools)) schoolNames = m.schools.filter(Boolean);
  const schoolLbl = schoolNames.length === 0 ? '' : schoolNames.length <= 2 ? schoolNames.join(', ') : `${schoolNames.length} schools`;
  const place = [m.market, schoolLbl].filter(Boolean).join(' · ');
  const flag = m.priority === 'high' ? '<span class="kc-flag kc-flag-high" title="High priority">' + CI('flag') + '</span>'
    : m.priority === 'low' ? '<span class="kc-flag kc-flag-low" title="Low priority">' + CI('flag') + '</span>' : '';
  // Plain due date (no overdue / due-soon status badge) sharing the context row, pushed right.
  const dueEl = m.due_date ? `<span class="kc-due"><svg viewBox="0 0 32 32" fill="currentColor" width="12" height="12"><path d="M16,30A14,14,0,1,1,30,16,14,14,0,0,1,16,30ZM16,4A12,12,0,1,0,28,16,12,12,0,0,0,16,4Z"/><path d="M20.59 22L15 16.41 15 7 17 7 17 15.58 22 20.59 20.59 22z"/></svg>${esc(fmtDate(m.due_date))}</span>` : '';
  const pct = Math.max(0, Math.min(100, m.progress_percent || 0));
  const prog = pct === 0 ? '' : `<div class="kc-prog"><div class="kc-prog-top"><span>Progress</span><b>${pct}%</b></div><div class="kc-prog-bar"><span style="width:${pct}%;background:${scol}"></span></div></div>`;
  const notes = nc ? `<span class="kc-notes" title="${nc} comment${nc === 1 ? '' : 's'}"><svg viewBox="0 0 32 32" fill="currentColor" width="13" height="13"><path d="M17.74,30,16,29l4-7h6a2,2,0,0,0,2-2V8a2,2,0,0,0-2-2H6A2,2,0,0,0,4,8V20a2,2,0,0,0,2,2h9v2H6a4,4,0,0,1-4-4V8A4,4,0,0,1,6,4H26a4,4,0,0,1,4,4V20a4,4,0,0,1-4,4H21.16Z"/><path d="M8 10H24V12H8zM8 16H18V18H8z"/></svg>${nc}</span>` : '';
  // Material card anatomy: headline · subhead · supporting line · action row (inset divider above actions)
  const sub = [place, showTeam ? m.functional_area : ''].filter(Boolean).join(' · ');
  const p = curProgress(m), reasons = watermelonReasons(m), stale = needsCheckin(m), hist = m.dateHistory || [];
  const slipTip = hist.length ? `${slipSummary(m)}: ` + hist.map(h => `${fmtDate(h.from)} → ${fmtDate(h.to)}${h.reason ? ' (' + h.reason + ')' : ''}`).join('; ') : '';
  const lookTip = [...reasons, slipTip].filter(Boolean).join('\n');
  const marker = reasons.length ? `<span class="kc-look" title="${esc(lookTip)}" aria-label="Needs a look. ${esc(lookTip)}">Needs a look</span>`
    : stale ? '<span class="kc-stale" title="No check-in in the last 2 weeks">Update missing</span>' : '';
  const done = es === 'complete';
  const due = done ? `<span class="kc-due2">${m.completedAt ? 'Completed ' + esc(fmtDate(m.completedAt.slice(0, 10))) : 'Completed'}</span>` : m.due_date ? `<span class="kc-due2 ${hist.length ? 'moved' : ''}" ${slipTip ? `title="${esc(slipTip)}"` : ''}>Due ${esc(fmtDate(m.due_date))}</span>` : '<span class="kc-due2 muted">No due date</span>';
  const pctEl = !done && p > 0 ? `<span class="kc-pct" title="${p}% progress"><span class="kc-bar"><span style="width:${p}%;background:${scol}"></span></span>${p}%</span>` : '';
  const stBtn = `<button class="kc-status" data-qstatus="${m.id}" title="Change status" style="--sc:${scol}"><i class="${ADS_STATUS[es] ? 'st-' + es : ''}"></i>${esc(SM(es).label)}<svg viewBox="0 0 32 32" fill="currentColor" width="12" height="12"><path d="M16 22L6 12 7.4 10.6 16 19.2 24.6 10.6 26 12z"/></svg></button>`;
  return `<div class="kcard kcard-v2 kcard-m3 ${urgent ? 'urgent' : ''} ${done ? 'is-done' : ''}" draggable="true" data-id="${m.id}" data-expand="${m.id}">
    <div class="kc-title" title="${esc(m.activity)}">${esc(m.activity)}</div>
    ${sub ? `<div class="kc-sub">${m.market ? `<span class="kc-mkdot" style="background:${mk}"></span>` : ''}<span>${esc(sub)}</span>${flag}</div>` : ''}
    <div class="kc-meta">${due}${pctEl}</div>
    <div class="kc-actions">${stBtn}${marker}<span class="kc-actions-r">${linksBadge(m)}${notes}<span class="kc-owners">${ownersOf(m).length ? ownersOf(m).slice(0, 4).map(o => personChip(o)).join('') + (ownersOf(m).length > 4 ? `<span class="kc-more" title="${esc(ownersOf(m).slice(4).join(', '))}">+${ownersOf(m).length - 4}</span>` : '') : personChip('')}</span></span></div>
  </div>`;
}
function planFocusHtml() {
  const list = filtered().filter(m => ['overdue', 'this_month'].includes(timingLevel(m)) || ['behind', 'at_risk'].includes(effectiveStatus(m)));
  if (!list.length) return '<div class="empty-state">Nothing needs attention in this view</div>';
  const rank = m => timingLevel(m) === 'overdue' ? 0 : effectiveStatus(m) === 'behind' ? 1 : timingLevel(m) === 'this_month' ? 2 : 3;
  list.sort((a, b) => rank(a) - rank(b) || (parseDate(a.due_date) || 9e15) - (parseDate(b.due_date) || 9e15));
  return `<div class="plan-focus-note">${list.length} need${list.length === 1 ? 's' : ''} attention, most urgent first</div><div class="plan-cards">${list.map(planCard).join('')}</div>`;
}
function planKanbanHtml() {
  const list = filtered();
  return '<div class="kanban">' + meta().stages.map(([sk, label]) => {
    const cards = list.filter(m => (m.stage || 'to_do') === sk);
    const ck = 'kc:' + sk, open = !state.expanded[ck];
    return `<div class="kcol ${open ? '' : 'collapsed'}"><div class="kcol-head stage-${sk}" data-toggle="${esc(ck)}" title="${open ? 'Collapse' : 'Expand'} column"><span class="kcol-name">${esc(label)}</span><span class="kcol-head-r"><span class="kcount">${cards.length}</span><button class="kcol-add" data-addstage="${esc(sk)}" title="Add milestone to ${esc(label)}" aria-label="Add milestone to ${esc(label)}">+</button></span></div>
      <div class="kcol-body" data-kstage="${sk}">${cards.map(planCard).join('')}<div class="kcol-drop">Drop here</div></div></div>`;
  }).join('') + '</div>';
}
function planListHtml() {
  const list = filtered(), gb = state.planGroup, g = {}, order = {};
  const keyOf = m => {
    if (gb === 'team') return m.functional_area;
    if (gb === 'priority') return (PRIORITY[m.priority] || {}).label;
    if (gb === 'market') return m.market || 'Network (CMO)';
    if (gb === 'state') { const st = (statesMeta().find(x => x.code === m.state) || {}).name || m.state || 'Network-wide'; order[st] = m.state === 'FL' ? 0 : m.state === 'NJ' ? 1 : 2; return st; }
    if (gb === 'year') { order['FY ' + fyLabel(m.targetFY)] = m.targetFY || 9999; return m.targetFY ? 'FY ' + fyLabel(m.targetFY) : 'No date'; }
    if (gb === 'school') { const s = state.data.schools.find(x => taskInSchool(m, x)); return s ? s.market + ' · ' + s.display_label : 'Not tied to a school'; }
    return m.functional_area;
  };
  list.forEach(m => { const k = keyOf(m) || '-'; (g[k] = g[k] || []).push(m); });
  const keys = Object.keys(g).sort((a, b) => gb === 'year' ? (order[a] || 9999) - (order[b] || 9999) : gb === 'state' ? (order[a] ?? 9) - (order[b] ?? 9) : a.localeCompare(b));
  if (!keys.length) return (M().length ? '<div class="empty-state">No milestones match these filters<button class="btn btn-tonal btn-sm" data-clearfilters>Clear filters</button></div>' : '<div class="empty-state">No milestones yet</div>');
  state._planKeys = keys.map(k => 'pg:' + k);
  if (state._expandAllOnce) { state._planKeys.forEach(k => state.expanded[k] = true); state._expandAllOnce = false; }
  // groups default COLLAPSED so the page opens as a scannable outline, not 132 cards
  return keys.map(k => {
    const ck = 'pg:' + k, open = !!state.expanded[ck];
    const risk = g[k].filter(m => ['overdue', 'this_month'].includes(timingLevel(m)) || ['behind', 'at_risk'].includes(effectiveStatus(m))).length;
    const flag = risk ? `<span class="pm-gflag">${risk} need${risk === 1 ? 's' : ''} attention</span>` : '';
    return `<div class="plan-group ${open ? '' : 'is-collapsed'}"><div class="plan-group-head" data-toggle="${esc(ck)}">${chev(open)}<span class="pg-name">${esc(k)}</span>${flag}<span class="pm-gcount">${g[k].length}</span></div><div class="plan-cards ${open ? '' : 'hide'}">${g[k].map(m => planCard(m, { hideTeam: gb === 'team' })).join('')}</div></div>`;
  }).join('');
}
function planBodyHtml() {
  if (state.planFocus) return planFocusHtml();
  return state.planGroup === 'stage' ? planKanbanHtml() : planListHtml();
}
function renderPlan() {
  const list = filtered();
  const focusN = list.filter(m => ['overdue', 'this_month'].includes(timingLevel(m)) || ['behind', 'at_risk'].includes(effectiveStatus(m))).length;
  const focusBtn = `<button class="btn btn-focus ${state.planFocus ? 'on' : ''}" id="planFocus">Needs attention${focusN ? ` <span class="focus-n">${focusN}</span>` : ''}</button>`;
  const isBoard = state.planGroup === 'stage';
  const viewToggle = `<div class="plan-view-toggle"><button class="pvt ${!isBoard ? 'on' : ''}" data-planview="list" title="List view" aria-label="List view"><svg viewBox="0 0 32 32" fill="currentColor" width="18" height="18"><circle cx="7" cy="9" r="3"/><circle cx="7" cy="23" r="3"/><path d="M16 22H30V24H16zM16 8H30V10H16z"/></svg><span class="pvt-l">List</span></button><button class="pvt ${isBoard ? 'on' : ''}" data-planview="board" title="Board view" aria-label="Board view"><svg viewBox="0 0 32 32" fill="currentColor" width="18" height="18"><path d="M24 4H26V28H24zM18 6V26H14V6h4m0-2H14a2 2 0 00-2 2V26a2 2 0 002 2h4a2 2 0 002-2V6a2 2 0 00-2-2zM6 4H8V28H6z"/></svg><span class="pvt-l">Board</span></button></div>`;
  const viewSel = isBoard ? '' : `<label class="tb-group ${state.planFocus ? 'is-dim' : ''}">Group by
    <select id="planGroupSel" ${state.planFocus ? 'disabled' : ''}>${[['team', 'Team'], ['state', 'State, Florida first'], ['school', 'School opening'], ['market', 'Market'], ['year', 'Due year']].map(([v, l]) => `<option value="${v}" ${state.planGroup === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const allOpen = (state._planKeys || []).length > 0 && state._planKeys.every(k => state.expanded[k]);
  const expandBtns = (!state.planFocus && !isBoard) ? `<button class="btn btn-ghost btn-sm" id="planToggleAll">${allOpen ? 'Collapse all' : 'Expand all'}</button>` : '';
  const csvBtn = `<button class="btn btn-ghost btn-sm" id="planCsv" >Export CSV</button>`;
  const right = `${appliedFilterChips({ hiddenOnly: true })}${viewToggle}${focusBtn}${viewSel}${expandBtns}${csvBtn}<button class="btn btn-filled" id="newItem"><svg viewBox="0 0 32 32" fill="currentColor" width="16" height="16"><path d="M17 15L17 8 15 8 15 15 8 15 8 17 15 17 15 24 17 24 17 17 24 17 24 15z"/></svg>New milestone</button>`;
  // No H2 - all actions live in the filter bar's right slot.
  $('#view-plan').innerHTML = `
    ${filterBar(['states', 'markets', 'fys', 'areas', 'owners'], { school: true, right })}
    <div id="viewBody">${planBodyHtml()}</div>`;
}

/* ============================================================
   EDIT ENGINE + cross-tab
   ============================================================ */
function hasSchoolWork() { return WS === 'readiness' || M().some(m => (m.schoolIds || []).length); }   // Enabling Work is network-wide, so school views stay hidden until a task names a school
function rerender() { const kb0 = document.querySelector('.kanban'), kbX = kb0 ? kb0.scrollLeft : 0; if (kbX) requestAnimationFrame(() => { const k = document.querySelector('.kanban'); if (k) k.scrollLeft = kbX; }); document.body.classList.toggle('no-school-work', !hasSchoolWork()); requestAnimationFrame(() => { if (typeof updateSticky === 'function') updateSticky(); }); if (state.view === 'progress') renderProgress(); else if (state.view === 'timeline') renderTimeline(); else renderPlan(); requestAnimationFrame(() => paintAvatars()); if (typeof updateFilterBubble === 'function') updateFilterBubble(); }

/* ============================================================
   TAB 0 - EXECUTIVE SUMMARY (board / chiefs readout, print-ready)
   ============================================================ */
function schoolsInView() {
  const f = state.filters;
  return state.data.schools.filter(s => s.openingFY)
    .filter(s => !f.states.size || f.states.has(s.state))
    .filter(s => !f.markets.size || f.markets.has(s.market))
    .filter(s => !f.fys.size || f.fys.has(s.openingFY))
    .filter(s => oyShown(s.openingFY))
    .sort((a, b) => (a.openingFY - b.openingFY) || a.market.localeCompare(b.market));
}
function fmtMoney(n) { n = +n || 0; const a = Math.abs(n), sg = n < 0 ? '-' : ''; if (a >= 999500) return sg + '$' + (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'; if (a >= 1e3) return sg + '$' + Math.round(a / 1e3) + 'K'; return sg + '$' + Math.round(a); }
/* consistent R/Y/G by milestone completion: <50% red · ≥50% yellow · all complete green */
/* greenlight/gating status per domain - deliberately distinct from market brand colors.
   grey = not started · blue = in progress · green = cleared (gate met) · amber/red = off-track */
// status palette drawn from the KIPP brand: green=complete, sky=on track, orange=at risk, red=behind
// Carbon support colors. Must match --status-* in styles.css.
const RAG = { green: '#24A148', blue: '#0043CE', yellow: '#B28600', red: '#DA1E28', none: '#8D8D8D' };
/* readiness = are we ON SCHEDULE (timing-aware), with % complete kept in the tooltip */
function ragReady(list) {
  if (!list.length) return { key: 'none', color: RAG.none, label: 'Not started' };
  const eff = list.map(effectiveStatus), done = eff.filter(s => s === 'complete').length, pctc = Math.round(100 * done / list.length);
  if (done === list.length) return { key: 'green', color: RAG.green, label: 'Complete' };
  if (eff.some(s => s === 'behind' || s === 'blocked')) return { key: 'red', color: RAG.red, label: 'Behind · ' + pctc + '% clear' };
  if (eff.some(s => s === 'at_risk')) return { key: 'yellow', color: RAG.yellow, label: 'At risk · ' + pctc + '% clear' };
  if (eff.some(s => s === 'on_track' || s === 'complete')) return { key: 'blue', color: RAG.blue, label: 'On track · ' + pctc + '% clear' };
  return { key: 'none', color: RAG.none, label: 'Not started' };
}
// monthly trend snapshots (localStorage) → powers the KPI "vs last month" deltas
function captureTrend() {
  const t0 = today(), ym = `${t0.getFullYear()}-${String(t0.getMonth() + 1).padStart(2, '0')}`;
  let t = []; try { t = JSON.parse(lsGet('ngc_trends') || '[]'); } catch (e) {}
  if (t.length && t[t.length - 1].ym === ym) return;
  const schools = state.data.schools, rags = schools.map(s => ragReady(schoolMs(s))), cnt = k => rags.filter(r => r.key === k).length;
  const attention = cnt('red') + cnt('yellow'), onTrack = schools.length - attention, overdue = M().filter(m => timingLevel(m) === 'overdue').length;
  t.push({ ym, onTrack, attention, overdue }); if (t.length > 24) t = t.slice(-24);
  try { lsSet('ngc_trends', JSON.stringify(t)); } catch (e) {}
}
/* ============================================================
   DASHBOARD building blocks (overview layout)
   ============================================================ */
const EH_IC = {
  table:    '<circle cx="7" cy="9" r="3"/><circle cx="7" cy="23" r="3"/><path d="M16 22H30V24H16zM16 8H30V10H16z"/>',
  warning:  '<path d="M16 23a1.5 1.5 0 101.5 1.5A1.5 1.5 0 0016 23zM15 12H17V21H15z"/><path d="M29,30H3a1,1,0,0,1-.8872-1.4614l13-25a1,1,0,0,1,1.7744,0l13,25A1,1,0,0,1,29,30ZM4.6507,28H27.3493l.002-.0033L16.002,6.1714h-.004L4.6487,27.9967Z"/>',
  check:    '<path d="M16 22H30V24H16zM14 19.4L12.6 18 6 24.6 3.4 22 2 23.4 6 27.4zM16 8H30V10H16zM14 5.4L12.6 4 6 10.6 3.4 8 2 9.4 6 13.4z"/>',
  people:   '<path d="M26 14H24v2h2a3.0033 3.0033 0 013 3v4h2V19A5.0058 5.0058 0 0026 14zM24 4a3 3 0 11-3 3 3 3 0 013-3m0-2a5 5 0 105 5A5 5 0 0024 2zM23 30H21V28a3.0033 3.0033 0 00-3-3H14a3.0033 3.0033 0 00-3 3v2H9V28a5.0059 5.0059 0 015-5h4a5.0059 5.0059 0 015 5zM16 13a3 3 0 11-3 3 3 3 0 013-3m0-2a5 5 0 105 5A5 5 0 0016 11zM8 14H6a5.0059 5.0059 0 00-5 5v4H3V19a3.0033 3.0033 0 013-3H8zM8 4A3 3 0 115 7 3 3 0 018 4M8 2a5 5 0 105 5A5 5 0 008 2z"/>',
  flag:     '<path d="M6,30H4V2H28l-5.8,9L28,20H6ZM6,18H24.33L19.8,11l4.53-7H6Z"/>'
};
function ehIc(k) { return `<svg class="eh-ic" viewBox="0 0 32 32" fill="currentColor" width="17" height="17">${EH_IC[k] || ''}</svg>`; }
const RAG_SEV = { red: 4, yellow: 3, blue: 2, none: 1, green: 0 };

/* ---- Progress monitoring by opening year (cohort) + by workstream ---- */
// The focused opening year = the single value in the openingFYs filter (null = all years).
// Focusing scopes the whole app (passFilters/schoolsInView/ganttSchools all honor openingFYs),
// so a drill from here into the Plan or Timeline stays on the same cohort.
function setDashCohort(v) {
  if (v === 'all') state.filters.openingFYs.clear();
  else {
    const fy = Number(v);
    // Click the currently-focused cohort again to unfocus (toggle behavior).
    if (state.filters.openingFYs.size === 1 && state.filters.openingFYs.has(fy)) state.filters.openingFYs.clear();
    else state.filters.openingFYs = new Set([fy]);
  }
  rerender();
  if (typeof updateFilterBubble === 'function') updateFilterBubble();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
// Progress broken down by workstream (functional area), scoped to the current focus.
function wsBreakdownRows(list) {
  const rows = teams().map(t => {
    const tl = list.filter(m => m.functional_area === t);
    if (!tl.length) return null;
    const done = tl.filter(m => effectiveStatus(m) === 'complete').length;
    return { t, n: tl.length, done, pctc: avgProgress(tl), r: ragReady(tl) };
  }).filter(Boolean).sort((a, b) => (RAG_SEV[b.r.key] || 0) - (RAG_SEV[a.r.key] || 0) || a.pctc - b.pctc);
  if (!rows.length) return '<div class="muted ex-empty">No milestones in scope</div>';
  return `<div class="wb-list">${rows.map(x => `<button class="wb-row" data-drilldim="team" data-drillval="${esc(x.t)}" title="Open ${esc(x.t)} in Milestones">
      <span class="wb-name">${esc(x.t)}</span>
      <span class="wb-bar"><span style="width:${x.pctc}%;background:${x.r.color}"></span></span>
      <span class="wb-pct">${x.pctc}%</span>
      <span class="wb-n" title="${x.done} of ${x.n} milestones complete">${x.done}/${x.n} done</span>
    </button>`).join('')}</div>`;
}
// Breakdown card with a By workstream / By school toggle.


// Growth-capital priority strip. Surface, don't hide — the charter names capital as one of
// three FY27 priorities ($7M SoFla + $1.5M Paterson). Compact horizontal bars so it earns a
// row without stealing focus from the readiness headline above.
function capitalPriorityStrip() {
  const camps = (state.data.campaigns || []).filter(c => !state.filters.states.size || state.filters.states.has(c.state));
  if (!camps.length) return '';
  const items = camps.map(c => {
    const met = c.target > 0 && c.raised >= c.target, p = c.target ? (met ? 100 : Math.min(99, Math.floor(100 * c.raised / c.target))) : 0;
    const gap = Math.max(0, (c.target || 0) - (c.raised || 0));
    const tone = met ? 'ok' : p >= 50 ? 'mid' : 'low';
    return `<div class="cap-item cap-tone-${tone}">
      <div class="cap-top"><span class="cap-name">${esc(c.name)}</span><span class="cap-vals">${c.raised ? `<b>${fmtMoney(c.raised)}</b><span class="muted"> of ${fmtMoney(c.target)}</span>` : `<b>${fmtMoney(c.target)}</b><span class="muted"> goal</span>`}</span></div>
      ${c.raised ? `<div class="cap-bar"><span style="width:${p}%"></span></div>
      <div class="cap-foot"><span class="cap-pct">${p}% raised</span><span class="muted">${met ? 'Target met' : fmtMoney(gap) + ' to go'}</span></div>` : `<div class="cap-foot"><span class="muted">No funds recorded yet</span></div>`}
    </div>`;
  }).join('');
  return `<section class="ex-card cap-card">
    <div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('flag')}<h3>Growth capital</h3></div></div>
    <div class="cap-grid">${items}</div>
  </section>`;
}

// Owners with slipping work — the charter frames commitments per owner (attend YOUR block,
// speak for YOUR function), and Aden's between-meetings job is to chase follow-ups. This card
// answers "who do I need to unblock?" — the primary question at a biweekly stand-up.

function dashboardHtml(list) {
  // Dashboard = the questions people bring: what do I do before the meeting (chair), how is each
  // opening doing, what needs attention, what's coming up, how is each team doing. Each answered once.
  const schools = schoolsInView();
  const sMs = s => state.filters.areas.size ? schoolMs(s).filter(m => state.filters.areas.has(m.functional_area)) : schoolMs(s);
  const f = state.filters, scopeParts = [...[...f.openingFYs].map(v => 'Fall ' + (v - 1)), ...f.states, ...f.markets, ...f.areas, ...[...f.owners].map(o => o === '__none__' ? 'Unassigned' : 'Owner: ' + o)];
  const asOf = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const rptHead = `<header class="print-only rpt-head"><div class="rpt-kicker">KIPP Team &amp; Family · Network Growth Committee</div><h1>Growth status report</h1><div class="rpt-meta">As of ${asOf} · ${esc(scopeParts.length ? scopeParts.join(', ') : 'All openings and teams')}</div></header>`;
  return `<div class="dash dash-v2">
    ${rptHead}
    ${isAdmin() ? committeeCard() : ''}
    ${greetBanner(list)}
    ${mentionsCard()}
    ${hasSchoolWork() ? openingsTable(schools, sMs) : ''}
    <div class="dash-pair">${attentionCard(list)}${comingUpCard(list)}</div>
    <div class="dash-pair dash-pair-wide">${teamsCard(list)}${capitalPriorityStrip()}</div>
  </div>`;
}
function relDue(m) {
  const d = daysUntil(m.due_date); if (d == null) return 'No due date';
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} overdue`;
  if (d === 0) return 'Due today';
  if (d <= 30) return `Due in ${d} day${d === 1 ? '' : 's'}`;
  return 'Due ' + fmtDate(m.due_date);
}
function whereLabel(m) {
  const sc = (m.schoolIds || []).map(schoolById).filter(Boolean);
  return sc.length ? (sc.length <= 2 ? sc.map(x => `${x.market} ${x.display_label}`).join(', ') : `${sc.length} openings`) : (m.market || 'Network-wide');
}
function statusPill(label, color) { const k = { [RAG.green]: "complete", [RAG.blue]: "on_track", [RAG.yellow]: "at_risk", [RAG.red]: "behind", [RAG.none]: "not_started", [ADS_STATUS.blocked]: "blocked" }[color]; return `<span class="dt-status">${k ? `<i class="stdot st-${k}"></i>` : `<i style="background:${color}"></i>`}${esc(label)}</span>`; }
function openingsTable(schools, sMs) {
  if (!schools.length) return '';
  const t = todayISO();
  const rows = schools.map(s => {
    const ms = sMs(s), r = ragReady(ms), open = ms.filter(m => m.status !== 'complete'), p = avgProgress(ms);
    const off = open.filter(m => ['behind', 'blocked'].includes(effectiveStatus(m))).length, risk = open.filter(m => effectiveStatus(m) === 'at_risk').length;
    const next = open.filter(m => m.due_date && m.due_date >= t).sort((a, b) => a.due_date < b.due_date ? -1 : 1)[0];
    const issues = off || risk ? [off ? `<span class="dt-bad">${off} behind</span>` : '', risk ? `<span class="dt-warn">${risk} at risk</span>` : ''].filter(Boolean).join(' · ') : '<span class="muted">None</span>';
    return `<tr data-drillschool="${esc(s.id)}" title="Open ${esc(s.market)} ${esc(s.display_label)}">
      <td><span class="dt-dot" style="background:${mkColor(s.market)}"></span><b>${esc(s.market)} ${esc(s.display_label)}</b></td>
      <td>Fall ${s.openingFY - 1}</td>
      <td>${statusPill(ms.length ? r.label.split(' · ')[0] : 'Not yet scoped', r.color)}</td>
      <td class="num"><span class="dt-prog"><span class="kc-bar"><span style="width:${p}%;background:${r.color}"></span></span>${p}%</span></td>
      <td>${issues}</td>
      <td class="dt-next">${next ? `${esc(next.activity)} <span class="muted">· ${esc(fmtDate(next.due_date))}</span>` : '<span class="muted">Nothing scheduled</span>'}</td></tr>`;
  }).join('');
  const rk = schools.map(s => ragReady(sMs(s)).key), onT = rk.filter(k => k === 'green' || k === 'blue').length;
  return `<section class="ex-card dt-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('flag')}<h3>School openings</h3></div><span class="dt-sum"><b>${onT} of ${schools.length}</b> on track</span></div>
    <div class="dt-wrap"><table class="dt"><thead><tr><th>Opening</th><th>Opens</th><th>Status</th><th class="num">Progress</th><th>Issues</th><th>Next due</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function attentionItems(list) {
  const rank = m => m.status === 'blocked' ? 0 : effectiveStatus(m) === 'behind' ? 1 : effectiveStatus(m) === 'at_risk' ? 2 : 3;
  return list.filter(m => m.status !== 'complete' && (['behind', 'at_risk', 'blocked'].includes(effectiveStatus(m)) || watermelonReasons(m).length))
    .sort((a, b) => rank(a) - rank(b) || ((a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1));
}
function listRow(m) {
  const es = effectiveStatus(m), look = !['behind', 'at_risk', 'blocked'].includes(es) && watermelonReasons(m).length;
  const label = m.status === 'blocked' ? 'Blocked' : look ? 'Needs a look' : SM(es).label;
  const color = look ? 'var(--status-at-risk)' : SM(m.status === 'blocked' ? 'blocked' : es).color;
  return `<div class="al-row" data-expand="${esc(m.id)}">${statusPill(label, color)}<div class="al-main"><div class="al-t">${esc(m.activity)}</div><div class="al-m">${esc(whereLabel(m))} · ${esc(ownersOf(m).join(', ') || 'Unassigned')}</div></div><span class="al-due">${esc(relDue(m))}</span></div>`;
}
function attentionCard(list) {
  const items = attentionItems(list), show = items.slice(0, 8);
  return `<section class="ex-card al-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('warning')}<h3>Needs attention</h3></div><span class="dt-sum">${items.length}</span></div>
    ${show.length ? `<div class="al-list">${show.map(listRow).join('')}</div>` : '<p class="muted ex-empty">Nothing needs attention</p>'}
    ${items.length > show.length ? `<button class="card-more" data-showmore="focus">View all ${items.length} in Milestones</button>` : ''}</section>`;
}
function comingUpCard(list) {
  const att = new Set(attentionItems(list).map(m => m.id));
  const items = list.filter(m => dueWithin30(m) && !att.has(m.id)).sort((a, b) => a.due_date < b.due_date ? -1 : 1), show = items.slice(0, 6);
  return `<section class="ex-card al-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('check')}<h3>Due in the next 30 days</h3></div><span class="dt-sum">${items.length}</span></div>
    ${show.length ? `<div class="al-list">${show.map(listRow).join('')}</div>` : `<p class="muted ex-empty">Nothing ${list.some(dueWithin30) ? 'else ' : ''}due in the next 30 days</p>`}
    ${items.length > show.length ? `<button class="card-more" data-drilldim="timing" data-drillval="due30">View all ${items.length} in Milestones</button>` : ''}</section>`;
}
function teamsCard(list) {
  const z = n => n ? n : '<span class="muted">0</span>', showCal = list.some(m => calibration([m]).n);
  const rows = teams().map(t => {
    const ms = list.filter(m => m.functional_area === t); if (!ms.length) return '';
    const open = ms.filter(m => m.status !== 'complete');
    const off = open.filter(m => ['behind', 'blocked'].includes(effectiveStatus(m))).length, risk = open.filter(m => effectiveStatus(m) === 'at_risk').length;
    const stale = open.filter(needsCheckin).length, cal = calibration(ms);
    return `<tr data-drilldim="team" data-drillval="${esc(t)}" title="Open ${esc(t)} in Milestones"><td><b>${esc(t)}</b></td><td class="num">${open.length}</td><td class="num ${off ? 'dt-bad' : ''}">${z(off)}</td><td class="num ${risk ? 'dt-warn' : ''}">${z(risk)}</td><td class="num">${z(stale)}</td><td class="num">${avgProgress(ms)}%</td>${showCal ? `<td class="num">${cal.n ? Math.round(100 * cal.k / cal.n) + '%' : '<span class="muted">0 of 0</span>'}</td>` : ''}</tr>`;
  }).join('');
  return `<section class="ex-card dt-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('people')}<h3>Teams</h3></div></div>
    <div class="dt-wrap"><table class="dt"><thead><tr><th>Team</th><th class="num">Open</th><th class="num">Behind</th><th class="num">At risk</th><th class="num">Updates missing</th><th class="num">Progress</th>${showCal ? '<th class="num">Forecast accuracy</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

/* The full greeting moved to the top content bar (updateGreeting).
   Here we render just the personal shortcut pill (only when the signed-in
   user has open tasks assigned to them). Empty otherwise. */
// "Your milestones" strip: the signed-in owner's own numbers, each one click into Milestones.
// Counted from all milestones (not the current filters) so it always reflects everything you own.
function greetBanner() {
  const me = myOwnerName(); if (!me || mineOn()) return '';
  const mine = myOpenTasks(me), fq = fiscalQuarter();
  if (!mine.length) return '';
  const stat = (n, label, timing, tone) => `<button class="my-stat ${n && tone ? 'my-' + tone : ''}" data-drillmine="${timing}"><span class="my-n">${n}</span><span class="my-l">${label}</span></button>`;
  // Only the counts that need attention get a tile; zero counts stay out of the way
  const tiles = [[mine.filter(m => timingLevel(m) === 'overdue').length, 'Overdue', 'overdue', 'r'], [mine.filter(m => effectiveStatus(m) === 'blocked').length, 'Blocked', 'blocked', 'y'],
    [mine.filter(dueWithin30).length, 'Due in 30 days', 'due30', ''], [mine.filter(dueThisQuarter).length, 'Due by end of ' + fq.q, 'dueQ', '']].filter(t => t[0]);
  if (!tiles.length) return `<section class="my-strip my-clear"><div class="my-head">Your milestones<button class="btn btn-tonal btn-sm my-ci" data-open-checkins>Check in</button></div><div class="pu-clear">Nothing overdue or due this quarter</div></section>`;
  return `<section class="my-strip"><div class="my-head">Your milestones · ${mine.length} open<button class="btn btn-tonal btn-sm my-ci" data-open-checkins>Check in${mine.filter(needsCheckin).length ? ` (${mine.filter(needsCheckin).length})` : ''}</button></div><div class="my-stats">${tiles.map(t => stat(...t)).join('')}</div></section>`;
}
function myOpenTasks(name) { return M().filter(m => ownsM(m, name) && effectiveStatus(m) !== 'complete'); }
function applyDrill(dim, val) {
  if (dim === 'team') state.filters.areas = new Set([val]);
  else if (dim === 'market') state.filters.markets = new Set([val]);
  else if (dim === 'state') state.filters.states = new Set([val]);
  else if (dim === 'year') state.filters.fys = new Set([Number(val)]);
  else if (dim === 'school') state.filters.schoolId = val;
  else if (dim === 'status') { state.filters.statuses = new Set([val]); state.filters.timing = ''; }
  else if (dim === 'timing') { state.filters.timing = val; state.filters.statuses.clear(); }
  else if (dim === 'riskbehind') { state.filters.statuses = new Set(['at_risk', 'behind']); state.filters.timing = ''; }
  else if (dim === 'flag') { state.filters.flag = val; }
  else if (dim === 'all') { /* just show the detailed list */ }
  state._expandAllOnce = true;
  setView('plan'); window.scrollTo({ top: 0, behavior: 'smooth' });   // dashboard = status; drilling opens the Project Plan, filtered
}
function refreshResults() { refreshBody(); }

function addItem(stage) {
  if (!guardEdit()) return;
  const st = stage || 'to_do', done = st === 'complete';
  const dm = state.filters.markets.size === 1 ? [...state.filters.markets][0] : '', dt = defaultTeam();
  const m = { id: uid(), state: stateOfMarket(dm) || '', market: dm, team: dt, functional_area: dt, workstream: 'General', activity: '', schools: [], schoolIds: [], targetFY: currentFY(), targetQuarter: '', openingFY: null, due_date: null, status: done ? 'complete' : 'not_started', stage: st, progress_percent: done ? 100 : 0, priority: 'medium', owner: myOwnerName(), dependency: '', keyMilestone: false, greenlight: false, transition: false, notes: '', tags: [] };
  m._draft = true; m.createdAt = new Date().toISOString(); if (!m.owner) m.owner = myOwnerName();
  M().push(m); openModal(m.id);   // draft: saved (and synced) only when the person clicks Save
}

/* popovers */
let popAnchor = null;
function closePopover() { const p = $('#popover'); if (p) { const back = p.contains(document.activeElement) ? popAnchor : null; p.remove(); if (back && document.contains(back)) back.focus({ preventScroll: true }); } document.removeEventListener('mousedown', outsidePop, true); }
function outsidePop(e) { if (!e.target.closest('#popover')) closePopover(); }
function openPopover(anchor, html) {
  closePopover();
  const p = document.createElement('div'); p.className = 'popover'; p.id = 'popover'; p.innerHTML = html; document.body.appendChild(p);
  const r = anchor.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 12, above = r.top - 60;
  if (p.offsetHeight > below && above > below) p.style.top = (window.scrollY + Math.max(56, r.top - p.offsetHeight - 6)) + 'px';
  else p.style.top = (window.scrollY + r.bottom + 6) + 'px';
  p.style.maxHeight = Math.max(160, Math.max(below, above)) + 'px'; p.style.overflowY = 'auto';
  p.style.left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - p.offsetWidth - 12)) + 'px';
  popAnchor = anchor;
  const firstCtl = p.querySelector('input, button, a[href]'); if (firstCtl) firstCtl.focus({ preventScroll: true });
  setTimeout(() => document.addEventListener('mousedown', outsidePop, true), 0);
  return p;
}

/* detail modal */
let modalId = null, modalMode = 'task', schoolId = null, modalOpenDoc = null;
// Save writes only fields this person changed in the modal. Any field they left alone keeps its
// current value, which may include a teammate's change that arrived while the modal was open.
function keepTeammateEdits(obj, opened, current) {
  if (!opened || !current) return;
  Object.keys({ ...opened, ...current }).forEach(k => {
    if (k === 'noteLog') return;
    if (jeq(obj[k], opened[k]) && !jeq(current[k], opened[k])) { if (k in current) obj[k] = clone(current[k]); else delete obj[k]; }
  });
}
// View-only accounts see the same modal with every field locked.
function lockModalIfReadOnly() {
  if (canEdit()) return;
  $$('#modalBody input, #modalBody select, #modalBody textarea, #modalBody #mBlockBtn, #modalBody .dep-x, #modalBody .lk-x, #modalBody #lkAdd').forEach(el => { el.disabled = true; });
  if (commentLive()) { const nf = $('#modalBody .notes-field'), ni = $('#noteInput'); if (nf) nf.classList.add('can-comment'); if (ni) ni.disabled = false; }
  $('#modalTitle').textContent += ' (view only)';
}
function openModal(id) {
  modalMode = 'task'; modalId = id; modalDirty = false; const m = findM(id); if (!m) return;
  modalOpenDoc = clone(m); requestAnimationFrame(() => { const b = $('#modalBody'); if (b) b.scrollTop = 0; });
  $('#modalTitle').textContent = m._draft ? 'New milestone' : 'Milestone details';
  $('#modalDelete').style.display = m._draft ? 'none' : '';
  const opt = (arr, val) => arr.map(x => Array.isArray(x) ? `<option value="${x[0]}" ${x[0] === val ? 'selected' : ''}>${esc(x[1])}</option>` : `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const schoolChecks = state.data.schools.filter(s => s.market === m.market).map(s => `<label class="field-check"><input type="checkbox" class="m-school" value="${esc(s.id)}" ${(m.schoolIds || []).includes(s.id) ? 'checked' : ''}> ${esc(s.display_label)} <span class="muted">${esc(fyLabel(s.openingFY))}</span></label>`).join('') || '<span class="muted">No schools in this market</span>';
  const linked = (m.schoolIds || []).map(id => schoolById(id)).filter(Boolean);
  const schoolLinks = linked.length ? `<div class="sm-school-links">Linked schools: ${linked.map(s => `<button class="sm-school-link" data-openschool="${esc(s.id)}" title="Open ${esc(s.display_label)}">${esc(s.market)} · ${esc(s.display_label)} ${CI('arrow')}</button>`).join('')}</div>` : '';
  const soSec = `
    <div class="m-sec-h">School openings</div>
    <div class="field"><div class="so-pick" id="mSchools">${schoolPicker(m)}</div>
      <div class="help-text">Optional</div></div>
    <div class="so-derived" id="mMarketDerived" ${(m.schoolIds || []).length ? '' : 'hidden'}>Market: <b id="mMarketName">${esc(m.market || '')}</b></div>
    <div class="field" id="mMarketWrap" ${(m.schoolIds || []).length ? 'hidden' : ''}><label>Market</label><select id="mMarket">${opt([['', 'Network-wide'], ...markets().map(x => [x, x])], (m.schoolIds || []).length ? '' : (m.market || ''))}</select></div>
`;
  $('#modalBody').innerHTML = `
    ${m.updatedAt ? `<div class="m-updated">Last updated ${esc(fmtWhen(m.updatedAt))}${m.updatedBy ? ' by ' + esc(m.updatedBy) : ''}</div>` : ''}
    <div class="field"><label>Milestone <span class="req">*</span></label><textarea id="mAct" placeholder="What needs to happen?">${esc(m.activity)}</textarea></div>
    ${m._draft ? soSec : checkinBlock(m)}
    <div class="field-row"><div class="field"><label>Status</label><select id="mStatus">${opt(meta().statuses.map(s => [s, SM(s).label]), m.status)}</select></div>
      <div class="field"><label>Progress</label><div class="prog-input"><input id="mProg" type="number" min="0" max="100" step="5" value="${m.progress_percent || 0}"><span>%</span></div></div></div>
    <div class="help-text field-help">Updates when overdue or due soon</div>
    <div class="block-flag ${m.status === 'blocked' ? 'on' : ''}" id="mBlockWrap">
      <div class="block-flag-row"><button type="button" class="btn-block" id="mBlockBtn" aria-pressed="${m.status === 'blocked'}">${CI('flag')} <span>${m.status === 'blocked' ? 'Blocked' : 'Flag as blocked'}</span></button>
      <span class="block-hint">${m.status === 'blocked' ? 'Click again to clear' : ''}</span></div>
      <div class="field block-reason"><label for="mBlockWhy">What's blocking it?</label><input id="mBlockWhy" value="${esc(m.dependency)}" ></div>
    </div>
    <div class="m-sec-h">Owner and timing</div>
    <div class="field-row"><div class="field"><label>Owner</label><select id="mOwner">${ownerOptions(m.owner)}</select>${m._draft ? '' : emailOwnersLink(m)}</div><div class="field"><label>Due date</label><input id="mDue" type="date" value="${esc(m.due_date || '')}"></div></div>
    <div class="field"><label>Co-owners</label>${coOwnerPicker(m)}</div>
    <div class="field"><label>Team</label><select id="mTeam">${opt(teams(), m.functional_area)}</select></div>
    ${checkpointsBlock(m)}
    ${linksDepsBlock(m)}
    ${m._draft ? '' : soSec}
    <div class="m-sec-h">Notes</div>
    <div class="field"><label>Notes and next steps</label><textarea id="mNotes">${esc(m.notes)}</textarea></div>
    <details class="sm-details"><summary>More options</summary>
      <div class="field"><label>Detail / sub-workstream</label><input id="mWs" value="${esc(m.workstream)}"></div>
      <div class="field-row"><div class="field"><label>Priority</label><select id="mPri">${opt([['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], m.priority)}</select></div></div>
      <div class="field-row"><div class="field"><label>Target fiscal year</label><select id="mFy" ${m.due_date ? 'disabled title="Set from the due date"' : ''}><option value="">-</option>${fyList().map(fy => `<option value="${fy}" ${m.targetFY === fy ? 'selected' : ''}>${fyLabel(fy)}</option>`).join('')}</select></div><div class="field"><label>Quarter</label><select id="mQ" ${m.due_date ? 'disabled title="Set from the due date"' : ''}>${opt(['', 'Q1', 'Q2', 'Q3', 'Q4'], m.targetQuarter)}</select></div></div>
      <div class="field"><label>Start date</label><input type="date" id="mStart" value="${esc(m.startDate || '')}"></div>
      <div class="field"><label>Board column</label><select id="mStage">${opt(meta().stages, m.stage || 'to_do')}</select></div>
      <div class="field"><label>Dependency / blockers</label><input id="mDep" value="${esc(m.dependency)}"></div>
      <div class="field-row"><label class="field-check"><input type="checkbox" id="mKey" ${m.keyMilestone ? 'checked' : ''}> Key milestone</label><label class="field-check"><input type="checkbox" id="mTrans" ${m.transition ? 'checked' : ''}> Transition to Regional Ops</label></div>
    </details>
    ${notesSection('task', m.id, m.noteLog)}`;
  // Blocked flag: one obvious toggle that drives the status select and restores the prior status on unflag
  const wrap = $('#mBlockWrap'), sel = $('#mStatus'), why = $('#mBlockWhy'), dep = $('#mDep');
  let prior = m.status !== 'blocked' ? (m.status || 'not_started') : (m.statusBeforeBlock || 'on_track');
  const paintBlock = () => {
    const on = sel.value === 'blocked';
    wrap.classList.toggle('on', on); $('#mBlockBtn').setAttribute('aria-pressed', on);
    $('#mBlockBtn span').textContent = on ? 'Blocked' : 'Flag as blocked';
    wrap.querySelector('.block-hint').textContent = on ? 'Click again to clear' : 'Flags it on the Dashboard';
  };
  $('#mBlockBtn').addEventListener('click', () => {
    if (sel.value === 'blocked') sel.value = prior; else { prior = sel.value; sel.value = 'blocked'; }
    sel.dispatchEvent(new Event('change', { bubbles: true })); paintBlock();
    if (sel.value === 'blocked') why.focus();
  });
  sel.addEventListener('change', () => { if (sel.value !== 'blocked') prior = sel.value; paintBlock(); });
  why.addEventListener('input', () => { dep.value = why.value; });
  dep.addEventListener('input', () => { why.value = dep.value; });
  $('#mCoBox').addEventListener('change', () => { const v = $$('#mCoBox .m-co').filter(x => x.checked).map(x => x.value); $('#mCoBox .co-sum').textContent = v.length ? v.join(', ') : 'None'; });
  wireForecastUI(m);
  // Openings picker: selected chips highlight; the market follows the selected openings
  $('#mSchools').addEventListener('change', () => {
    $$('#mSchools .so-opt').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
    const mk = derivedMarket($$('#mSchools .m-school').filter(x => x.checked).map(x => x.value));
    $('#mMarketDerived').hidden = !mk; $('#mMarketWrap').hidden = !!mk; if (mk) $('#mMarketName').textContent = mk;
  });
  lockModalIfReadOnly();
  $('#modalBackdrop').classList.add('open');
  if (m._draft) setTimeout(() => $('#mAct').focus(), 50);
}
function saveModal() {
  if (!guardEdit()) return;
  if (modalMode === 'school') return saveSchool();
  const m = findM(modalId); if (!m) { closeModal(); toast('A teammate removed this milestone, so your edits were not saved', 'warn'); return; }
  if (!$('#mAct').value.trim() && !m.activity) { markInvalid($('#mAct'), 'Add a milestone name'); return; }
  const startV = ($('#mStart') || {}).value, dueV0 = $('#mDue').value;
  if (startV && dueV0 && startV > dueV0) { const dt = $('#mStart').closest('details'); if (dt) dt.open = true; markInvalid($('#mStart'), 'Start date must be on or before the due date'); return; }
  const wasDraft = !!m._draft;
  const fx = readForecastUI(m); if (fx === false) return;
  snapshotForUndo((wasDraft ? 'Create milestone: ' : 'Edit milestone: ') + ($('#mAct').value.trim() || m.activity || '').slice(0, 40));
  const current = clone(m), prevStatus = m.status, prevProg = m.progress_percent || 0;
  m.activity = $('#mAct').value.trim() || m.activity; 
  m.team = $('#mTeam').value; m.functional_area = m.team; m.workstream = $('#mWs').value.trim() || 'General';
  m.schoolIds = $$('#mSchools .m-school').filter(x => x.checked).map(x => x.value);
  m.schools = m.schoolIds.map(id => { const sc = schoolById(id); return sc ? sc.code : null; }).filter(Boolean);
  m.market = derivedMarket(m.schoolIds) || $('#mMarket').value || ''; m.state = stateOfMarket(m.market) || '';
  m.targetFY = $('#mFy').value ? +$('#mFy').value : null; m.targetQuarter = $('#mQ').value;
  if ($('#mStatus').value === 'blocked' && m.status !== 'blocked') m.statusBeforeBlock = m.status;
  m.status = $('#mStatus').value; m.stage = $('#mStage').value; m.priority = $('#mPri').value;
  m.progress_percent = Math.max(0, Math.min(100, +$('#mProg').value || 0));
  m.startDate = ($('#mStart') || {}).value || null;
  applyForecastUI(m, fx, prevStatus);
  // Keep status, progress and board stage telling the same story
  if (m.status !== 'complete' && m.progress_percent === 100 && prevProg !== 100 && prevStatus === m.status) m.status = 'complete';
  if (m.status === 'complete') { m.progress_percent = 100; m.stage = 'complete'; }
  else { if (m.stage === 'complete') m.stage = 'in_progress'; if (prevStatus === 'complete' && m.progress_percent === 100) m.progress_percent = 95; }
  m.owner = $('#mOwner').value.trim(); m.coOwners = $$('#mCoBox .m-co').filter(x => x.checked).map(x => x.value).filter(x => x && x !== m.owner); m.due_date = $('#mDue').value || null; m.dependency = $('#mDep').value.trim();
  syncFiscal(m);
  m.notes = $('#mNotes').value.trim(); m.keyMilestone = $('#mKey').checked; m.transition = $('#mTrans').checked;
  const os = m.schoolIds.length ? schoolById(m.schoolIds[0]) : null; if (os) m.openingFY = os.openingFY;
  readLinksDeps(m);
  if (!wasDraft) keepTeammateEdits(m, modalOpenDoc, current);
  delete m._draft; touch(m);
  logActivity(wasDraft ? 'create' : 'edit', (wasDraft ? 'Created: ' : 'Updated: ') + m.activity, { itemId: m.id });
  autosave(); closeModal(); rerender();
  const late = m.due_date && (m.schoolIds || []).map(schoolById).filter(sc => sc && sc.opening_date && m.due_date > sc.opening_date);
  if (late && late.length) toast(`Saved. This is due after ${late[0].display_label} opens on ${fmtDate(late[0].opening_date)}`, 'warn');
  else toast(wasDraft ? 'Milestone added' : 'Saved', 'ok');
}
function deleteModal() {
  if (!guardEdit()) return;
  if (modalMode === 'school') return deleteSchool();
  if (!modalId) return; const m = findM(modalId), id = modalId;
  confirmDialog({ title: 'Delete this milestone?', message: `"${esc(m ? m.activity : 'This milestone')}" will be removed from the board`, confirmLabel: 'Delete', danger: true, onConfirm: () => { snapshotForUndo('Delete milestone: ' + (m ? m.activity : '')); logActivity('delete', 'Deleted: ' + (m ? m.activity : 'task')); state.data.milestones = M().filter(x => x.id !== id); autosave(); closeModal(); rerender(); toastAction('Milestone deleted', 'Undo', undo); } });
}
let taskReturnSchool = null;
let modalDirty = false;
function closeModal() {
  if (modalMode === 'task' && modalId) { const d = findM(modalId); if (d && d._draft) state.data.milestones = M().filter(x => x.id !== d.id); }
  modalDirty = false; $('#modalBackdrop').classList.remove('open'); modalId = null; const ret = taskReturnSchool; taskReturnSchool = null; if (ret) setTimeout(() => openSchoolModal(ret), 0); }
function attemptCloseModal() {
  if (!modalDirty) return closeModal();
  confirmDialog({
    title: 'Discard unsaved changes?',
    message: `You have unsaved edits in this ${modalMode === 'school' ? 'school' : 'milestone'}. Close without saving?`,
    confirmLabel: 'Discard',
    danger: true,
    onConfirm: () => closeModal()
  });
}

/* reusable confirmation popup (native confirm() is blocked in sandboxed iframes) */
function closeConfirm() { const w = $('#confirmBackdrop'); if (w) w.remove(); }
// In-app text entry (replaces the browser's prompt(), which looks like a system alert and is blocked in some browsers)
function nameDialog(current, onSave) {
  closeConfirm();
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  w.innerHTML = `<div class="confirm-box">
    <h3>Your name</h3>
    <div class="confirm-msg">Shown on your edits</div>
    <div class="confirm-typed"><input id="cfgName" autocomplete="name" placeholder="First and last name" value="${esc(current || '')}"></div>
    <div class="confirm-actions"><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn btn-filled" id="cfgOk">Save</button></div>
  </div>`;
  document.body.appendChild(w);
  const inp = w.querySelector('#cfgName');
  const done = ok => { const v = inp.value.trim(); closeConfirm(); if (ok && v) onSave(v); };
  w.addEventListener('click', e => { if (e.target === w || e.target.id === 'cfgCancel') done(false); else if (e.target.id === 'cfgOk') done(true); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
  setTimeout(() => inp.focus(), 30);
}
function confirmDialog(opts) {
  closeConfirm();
  const shared = state.sb && state.sb.connected;
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  const typedBlock = opts.requireTyped ? `<div class="confirm-typed"><label>Type <span class="mono">${esc(opts.requireTyped)}</span> to confirm</label><input id="cfgTyped" class="mono" autocomplete="off" placeholder="${esc(opts.requireTyped)}"></div>` : '';
  w.innerHTML = `<div class="confirm-box">
        <h3>${esc(opts.title)}</h3>
    <div class="confirm-msg">${opts.message}</div>
    ${opts.danger ? `<div class="confirm-shared">${shared ? 'This removes it for everyone on the shared board. You can undo right after' : 'You can undo right after'}</div>` : ''}
    ${typedBlock}
    <div class="confirm-actions"><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn ${opts.danger ? 'btn-danger-solid' : 'btn-filled'}" id="cfgOk"${opts.requireTyped ? ' disabled' : ''}>${esc(opts.confirmLabel || 'Confirm')}</button></div>
  </div>`;
  document.body.appendChild(w);
  if (opts.requireTyped) {
    const inp = w.querySelector('#cfgTyped'), okBtn = w.querySelector('#cfgOk');
    inp.addEventListener('input', () => { okBtn.disabled = (inp.value !== opts.requireTyped); });
    setTimeout(() => inp.focus(), 30);
  }
  const done = ok => { closeConfirm(); if (ok && opts.onConfirm) opts.onConfirm(); };
  w.addEventListener('click', e => { if (e.target === w || e.target.id === 'cfgCancel') done(false); else if (e.target.id === 'cfgOk' && !e.target.disabled) done(true); });
  setTimeout(() => { const btn = $('#cfgOk'); if (btn) btn.focus(); }, 0);
}

/* ============================================================
   SCHOOL MANAGEMENT - add / edit / remove openings + their tasks
   ============================================================ */
function schoolById(id) { return state.data.schools.find(s => s.id === id); }
function openSchoolModal(id) {
  if (!id && !guardEdit()) return;
  modalMode = 'school'; schoolId = id; modalDirty = false;
  const isNew = !id;
  const s0 = id ? schoolById(id) : null; modalOpenDoc = s0 ? clone(s0) : null;
  const s = s0 || { id: uid(), display_label: '', code: '', school_type: 'ES', pod_number: null, market: markets()[0], state: stateOfMarket(markets()[0]), openingFY: currentFY() + 1, openingQuarter: 'Q1', priority: false, confirmed: true, _new: true };
  $('#modalTitle').textContent = isNew ? 'Add a school opening' : `${s.market} ${s.display_label}`;
  const opt = (arr, val) => arr.map(x => Array.isArray(x) ? `<option value="${x[0]}" ${x[0] === val ? 'selected' : ''}>${esc(x[1])}</option>` : `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const sm = isNew ? [] : schoolMs(s);
  const roll = sm.length ? rollupStatus(sm) : 'not_started';
  const taskList = sm.length ? sm.slice().sort(bySortUrgency).map(m => `<div class="sm-task" data-expand="${m.id}">${statusDot(effectiveStatus(m))}<span class="sm-t-title">${esc(m.activity)}</span><span class="sm-t-team">${esc(m.functional_area || '')}</span><span class="sm-t-due">${dueBadge(m) || (m.due_date ? fmtDate(m.due_date) : '-')}</span></div>`).join('') : '<div class="muted" style="font-size:14px">No milestones yet</div>';
  const summary = isNew ? '' : `<div class="sm-summary">
    <span><span class="state-badge sm" style="background:${stColor(s.state)}">${esc(s.state)}</span> <b>${esc(s.market)}</b> · Fall ${s.openingFY - 1}</span>
    <span class="sm-summary-r"><span class="muted">${sm.length} milestone${sm.length === 1 ? '' : 's'}</span>${sm.length ? `<button class="btn btn-text btn-sm sm-openplan" data-openplanschool="${esc(s.id)}" >Open in Milestones ${CI('arrow')}</button>` : ''}</span></div>`;
  // plain calendar year - a school with openingFY=2028 opens in August 2027, so we show "2027"
  const fyField = `<div class="field"><label>Opens <span class="req">*</span></label><select id="sFy">${fyList().map(fy => `<option value="${fy}" ${s.openingFY === fy ? 'selected' : ''}>Fall ${fy - 1} (${fyLabel(fy)})</option>`).join('')}</select></div>`;
  const qField = `<input type="hidden" id="sQ" value="${esc(s.openingQuarter || 'Q1')}">`;   // every opening is in August; quarter kept for old data
  const marketOnly = `<div class="field"><label>Market / location <span class="req">*</span></label><select id="sMarket">${opt(markets(), s.market)}</select></div>`;
  const labelField = `<div class="field-row"><div class="field"><label>Label <span class="req">*</span></label><input id="sLabel" value="${esc(s.display_label || s.code || '')}" placeholder="ES4"></div><div class="field"><label>School type</label><select id="sType">${opt([['ES', 'Elementary (ES)'], ['MS', 'Middle (MS)'], ['HS', 'High (HS)']], s.school_type)}</select></div></div>`;
  const marketField = `<div class="field-row"><div class="field"><label>Market / location</label><select id="sMarket">${opt(markets(), s.market)}</select></div><div class="field"><label>Pod</label><input id="sPod" type="number" min="1" value="${s.pod_number || ''}" placeholder="4"></div></div>`;
  const confField = `<label class="field-check"><input type="checkbox" id="sConf" ${s.confirmed !== false ? 'checked' : ''}> Opening confirmed</label>`;
  $('#modalBody').innerHTML = isNew ? `
    ${labelField}
    ${marketOnly}
    ${fyField}
    <div class="field-row">${confField}</div>
    <details class="sm-details"><summary>More details</summary>
      <div class="field-row"><div class="field"><label>Pod</label><input id="sPod" type="number" min="1" value="${s.pod_number || ''}" placeholder="4"></div></div>${qField}
    </details>`
    : `
    ${summary}
    <div class="reschedule">
      <div class="rs-head">Reschedule opening</div>
      ${fyField}${qField}
      <label class="field-check"><input type="checkbox" id="sShift" checked> <span>Move open milestone deadlines too</span></label>
    </div>
    <div class="field"><label>Milestones</label><div class="sm-tasks">${taskList}</div>
      <div class="sm-task-actions"><button class="btn btn-tonal btn-sm" id="addTaskForSchool">+ Add milestone</button>${templatesButton(s)}</div>${templatesPanel(s)}</div>
    <details class="sm-details"><summary>More school details</summary>
      ${labelField}
      ${marketField}
      <div class="field-row">${confField}</div>
    </details>
    ${notesSection('school', s.id, s.noteLog)}`;
  $('#modalDelete').style.display = isNew ? 'none' : '';
  lockModalIfReadOnly();
  $('#modalBackdrop').classList.add('open');
}
function shiftDateYears(iso, years) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if (!m) return iso;
  const y = Number(m[1]) + years, leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const d = m[2] === '02' && m[3] === '29' && !leap ? '28' : m[3];   // Feb 29 lands on Feb 28 in non-leap years
  return `${y}-${m[2]}-${d}`;
}
function saveSchool() {
  if (!guardEdit()) return;
  const isNew = !schoolById(schoolId);
  const s = isNew ? { id: schoolId || uid() } : schoolById(schoolId);
  const old = { code: s.code, market: s.market, openingFY: s.openingFY }, current = isNew ? null : clone(s);
  const label = $('#sLabel').value.trim().toUpperCase().replace(/\s+/g, '');
  if (!label) { markInvalid($('#sLabel'), 'Add a label, like ES4'); return; }
  const dup = state.data.schools.find(x => x.id !== s.id && x.market === $('#sMarket').value && (x.display_label || '').toUpperCase() === label);
  if (dup) { toast(`${$('#sMarket').value} already has ${label}. Pick a different label.`, 'err'); $('#sLabel').focus(); return; }
  snapshotForUndo((isNew ? 'Add school ' : 'Edit school ') + label);
  s.display_label = label; s.code = label; s.school_type = $('#sType').value;
  s.pod_number = $('#sPod').value ? +$('#sPod').value : null;
  s.market = $('#sMarket').value; s.location = s.market; s.state = stateOfMarket(s.market);
  s.openingFY = +$('#sFy').value; s.fiscal_year = s.openingFY; s.openingQuarter = $('#sQ').value;
  s.opening_date = `${s.openingFY - 1}-08-01`; s.confirmed = $('#sConf').checked;
  if (!isNew) keepTeammateEdits(s, modalOpenDoc, current);
  const shiftEl = $('#sShift');
  const shift = (old.openingFY && s.openingFY && (!shiftEl || shiftEl.checked)) ? (s.openingFY - old.openingFY) : 0;
  let moved = 0;
  if (isNew) { delete s._new; state.data.schools.push(s); }
  else {
    // tasks stay linked by stable id; keep their denormalized fields in sync + slide deadlines on reschedule
    M().forEach(m => {
      if (!(m.schoolIds || []).includes(s.id)) return;
      if (old.code && old.code !== s.code) m.schools = (m.schools || []).map(c => c === old.code ? s.code : c);
      m.market = s.market; m.state = s.state; m.openingFY = s.openingFY;
      if (shift && m.status !== 'complete') {
        moved++;
        if (m.targetFY) m.targetFY += shift;
        if (m.due_date) { const from = m.due_date; m.due_date = shiftDateYears(m.due_date, shift); logDateMove(m, from, m.due_date, 'School opening moved'); }
        syncFiscal(m);
        m.tags = (m.tags || []).map(t => /^FY\d\d$/.test(t) ? 'FY' + String(s.openingFY).slice(-2) : t);
      }
    });
  }
  autosave(); const nid = s.id;
  logActivity(isNew ? 'create' : 'edit', (isNew ? 'Added school ' : 'Updated school ') + s.market + ' ' + label);
  if (isNew) { closeModal(); rerender(); toast('School added', 'ok'); setTimeout(() => openSchoolModal(nid), 60); }
  else { closeModal(); rerender(); if (shift) toastAction(`Opening moved ${Math.abs(shift)} year${Math.abs(shift) === 1 ? '' : 's'} ${shift > 0 ? 'later' : 'earlier'}. ${moved} deadline${moved === 1 ? '' : 's'} moved.`, 'Undo', undo); else toast('School saved', 'ok'); }
}
function deleteSchool() {
  if (!guardEdit()) return;
  const s = schoolById(schoolId); if (!s) return; const tasks = schoolMs(s), sid = s.id, mk = s.market, ofy = s.openingFY, cd = s.code;
  confirmDialog({ title: `Remove ${esc(s.market)} ${esc(s.display_label)}?`, message: `This removes it from the opening schedule` + (tasks.length ? ` Milestones that belong only to this school (up to <b>${tasks.length}</b>) are removed too.` : ''), confirmLabel: 'Remove school', danger: true, onConfirm: () => {
    snapshotForUndo('Remove school ' + s.display_label); logActivity('delete', 'Removed school ' + s.market + ' ' + s.display_label);
    state.data.schools = state.data.schools.filter(x => x.id !== sid);
    // unlink this school from its tasks; drop a task only if it belonged to no other school
    state.data.milestones = M().filter(m => {
      if (!(m.schoolIds || []).includes(sid)) return true;
      m.schoolIds = m.schoolIds.filter(id => id !== sid); m.schools = (m.schools || []).filter(c => c !== cd);
      return m.schoolIds.length > 0;
    });
    autosave(); closeModal(); rerender(); toastAction('School removed', 'Undo', undo);
  } });
}
/* ---------- milestone templates: quick-add starter pre-opening milestones ---------- */
function milestoneTemplates() { return (meta().milestoneTemplates || []); }
function templatesButton(s) {
  const tpls = milestoneTemplates(); if (!tpls.length) return '';
  return `<button class="btn btn-tonal btn-sm" id="tplToggle" >+ Load starter milestones (${tpls.length})</button>`;
}
function templatesPanel(s) {
  const tpls = milestoneTemplates(); if (!tpls.length) return '';
  const byWs = {};
  tpls.forEach(t => { (byWs[t.workstream] = byWs[t.workstream] || []).push(t); });
  const already = new Set(schoolMs(s).map(m => (m.activity || '').trim().toLowerCase()));
  const groups = Object.keys(byWs).map(ws => `
    <div class="tpl-group">
      <div class="tpl-group-h">${esc(ws)}</div>
      ${byWs[ws].map(t => {
        const dup = already.has(t.activity.trim().toLowerCase());
        const due = s.openingFY ? offsetDateISO(`${s.openingFY - 1}-08-01`, -(t.monthsBefore || 0)) : '';
        const flags = [t.keyMilestone && 'Key', t.greenlight && 'Greenlight', t.transition && 'Transition'].filter(Boolean).join(' ');
        return `<label class="tpl-item ${dup ? 'is-dup' : ''}" title="${dup ? 'A milestone with this name already exists on this school' : `Due ${due} (${t.monthsBefore} mo before opening)`}">
          <input type="checkbox" class="tpl-check" data-tplid="${esc(t.id)}" ${dup ? 'disabled' : ''}>
          <span class="tpl-act">${esc(t.activity)}${flags ? ` <span class="tpl-flags">${flags}</span>` : ''}</span>
          <span class="tpl-when">${t.monthsBefore} mo before</span>
        </label>`;
      }).join('')}
    </div>`).join('');
  return `<div class="tpl-panel hide" id="tplPanel">
    <div class="tpl-help">Check the milestones to add. Due dates are calculated from this school's opening (Fall ${s.openingFY - 1}). Milestones you already have are dimmed.</div>
    <div class="tpl-groups">${groups}</div>
    <div class="tpl-actions">
      <label class="tpl-selectall"><input type="checkbox" id="tplAll"> Select all available</label>
      <span class="tpl-count" id="tplCount">0 selected</span>
      <button class="btn btn-filled btn-sm" id="tplApply" disabled>Add selected</button>
    </div>
  </div>`;
}
function offsetDateISO(iso, monthDelta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if (!m) return iso;
  const t = new Date(+m[1], +m[2] - 1 + monthDelta, 1), last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  const d = new Date(t.getFullYear(), t.getMonth(), Math.min(+m[3], last));   // Aug 31 minus 6 months = Feb 28/29, not Mar 3
  const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}
function toggleTemplatesPanel() {
  const p = document.getElementById('tplPanel'); if (!p) return;
  p.classList.toggle('hide');
}
function updateTplSelection() {
  const checks = Array.from(document.querySelectorAll('#tplPanel .tpl-check:checked'));
  const cnt = document.getElementById('tplCount'), btn = document.getElementById('tplApply');
  if (cnt) cnt.textContent = `${checks.length} selected`;
  if (btn) btn.disabled = checks.length === 0;
}
function applyTemplatesToSchool() {
  if (!guardEdit()) return;
  const s = schoolById(schoolId); if (!s) return;
  const picked = Array.from(document.querySelectorAll('#tplPanel .tpl-check:checked')).map(c => c.dataset.tplid);
  if (!picked.length) return;
  const tpls = milestoneTemplates().filter(t => picked.includes(t.id));
  snapshotForUndo(`Add ${tpls.length} starter milestone${tpls.length === 1 ? '' : 's'} for ${s.display_label}`);
  let pastDue = 0;
  tpls.forEach(t => {
    const due = s.openingFY ? offsetDateISO(`${s.openingFY - 1}-08-01`, -(t.monthsBefore || 0)) : null;
    const m = {
      id: uid(), state: s.state, market: s.market, team: t.workstream, functional_area: t.workstream,
      workstream: 'General', activity: t.activity, schools: [s.code], schoolIds: [s.id],
      targetFY: s.openingFY, targetQuarter: '', openingFY: s.openingFY, due_date: due,
      status: 'not_started', stage: 'to_do', progress_percent: 0, priority: s.priority ? 'high' : 'medium',
      owner: '', dependency: '', keyMilestone: !!t.keyMilestone, greenlight: !!t.greenlight, transition: !!t.transition,
      notes: '', tags: [s.state, s.code, 'FY' + String(s.openingFY).slice(-2)]
    };
    touch(m); m.createdAt = m.updatedAt; if (due && due < todayISO()) pastDue++;
    M().push(syncFiscal(m));
  });
  logActivity('create', `Added ${tpls.length} starter milestone${tpls.length === 1 ? '' : 's'} to ${s.market} · ${s.display_label}`);
  autosave();
  if (pastDue) toast(`Added ${tpls.length} milestone${tpls.length === 1 ? '' : 's'}. ${pastDue} ${pastDue === 1 ? 'is' : 'are'} already past due: set new deadlines.`, 'warn');
  else toast(`Added ${tpls.length} milestone${tpls.length === 1 ? '' : 's'}`, 'ok');
  const reopenId = s.id;
  closeModal();
  setTimeout(() => openSchoolModal(reopenId), 60);
}

function addTaskForSchool() {
  if (!guardEdit()) return;
  const s = schoolById(schoolId); if (!s) return;
  const m = { id: uid(), state: s.state, market: s.market, team: defaultTeam(), functional_area: defaultTeam(), workstream: 'General', activity: '', schools: [s.code], schoolIds: [s.id], targetFY: s.openingFY, targetQuarter: '', openingFY: s.openingFY, due_date: null, status: 'not_started', stage: 'to_do', progress_percent: 0, priority: s.priority ? 'high' : 'medium', owner: myOwnerName(), dependency: '', keyMilestone: false, greenlight: false, transition: false, notes: '', tags: [s.state, s.code, 'FY' + String(s.openingFY).slice(-2)] };
  m._draft = true; m.createdAt = new Date().toISOString();
  M().push(m); openModal(m.id);
}
// Team for a new milestone: the one filter-selected team, else the team this person owns most, else the first team.
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
// People pickers draw from the team list (Settings, Customize, Owners). Names already on a
// milestone but not on the list stay selectable and are labeled, so nothing is silently dropped.
function rosterNames() { return (meta().owners || []).map(o => o.name).filter(Boolean); }
function ownerOptions(cur) {
  const names = rosterNames(), extra = cur && !names.includes(cur) ? [cur] : [];
  return `<option value="" ${!cur ? 'selected' : ''}>Unassigned</option>` + names.map(n => `<option value="${esc(n)}" ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')
    + extra.map(n => `<option value="${esc(n)}" selected>${esc(n)}, not on team list</option>`).join('');
}
function coOwnerPicker(m) {
  const cur = m.coOwners || [], names = [...rosterNames(), ...cur.filter(c => !rosterNames().includes(c))];
  const sum = cur.length ? cur.join(', ') : 'None';
  return `<details class="co-pick" id="mCoBox"><summary><span class="co-sum">${esc(sum)}</span></summary><div class="co-list">${names.map(n => `<label class="field-check"><input type="checkbox" class="m-co" value="${esc(n)}" ${cur.includes(n) ? 'checked' : ''}> ${esc(n)}${rosterNames().includes(n) ? '' : ' <span class="muted">· not on team list</span>'}</label>`).join('')}</div></details>`;
}
// School openings are the primary objects; a milestone links to one or more of them
function schoolPicker(m) {
  const sel = new Set(m.schoolIds || []), groups = {};
  state.data.schools.filter(x => x.openingFY).sort((a, b) => (a.market || '').localeCompare(b.market || '') || a.openingFY - b.openingFY || (a.display_label || '').localeCompare(b.display_label || ''))
    .forEach(x => (groups[x.market] = groups[x.market] || []).push(x));
  const html = Object.entries(groups).map(([mk, list]) => `<div class="so-group"><div class="so-mk"><i style="background:${mkColor(mk)}"></i>${esc(mk)}</div><div class="so-opts">${list.map(x => `<label class="so-opt ${sel.has(x.id) ? 'on' : ''}"><input type="checkbox" class="m-school" value="${esc(x.id)}" ${sel.has(x.id) ? 'checked' : ''}><span class="so-name">${esc(x.display_label)}</span><span class="so-when">Fall ${x.openingFY - 1}</span></label>`).join('')}</div></div>`).join('');
  return html || '<p class="muted">No school openings yet</p>';
}
function derivedMarket(ids) {
  const cnt = {}; (ids || []).forEach(id => { const x = schoolById(id); if (x && x.market) cnt[x.market] = (cnt[x.market] || 0) + 1; });
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : '';
}
function touch(m) {
  m.updatedAt = new Date().toISOString(); m.updatedBy = currentDisplayName() || '';
  if (m.status === 'complete') { if (!m.completedAt) m.completedAt = m.updatedAt; } else delete m.completedAt;
  return m;
}
function defaultTeam() {
  if (state.filters.areas.size === 1) return [...state.filters.areas][0];
  const me = myOwnerName(), c = {};
  if (me) M().forEach(m => { if (!m._draft && ownersOf(m).includes(me) && m.functional_area) c[m.functional_area] = (c[m.functional_area] || 0) + 1; });
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : teams()[0];
}

/* ============================================================
   SUPABASE LIVE SYNC (optional)
   ============================================================ */
let sbPushTimer = null, sbLastPushed = new Map(), sbLastSchools = new Map(), sbLastSettings = new Map(), sbLoaded = false;   // sbLoaded: never push before the shared data has loaded
let sbPushing = false, sbPushAgain = false, sbSettingsReady = false;
const S = () => state.data.schools;
const SB_TABLE = { m: 'growth_milestones', s: 'growth_schools', settings: 'growth_settings' };
/* Pre-filled shared project so the committee auto-connects on load (publishable key is public by design;
   the row rules in Supabase decide who can read or change anything). */
const SB_DEFAULT = { url: 'https://cwjmlunqfhaioyuijhkk.supabase.co', key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3am1sdW5xZmhhaW95dWlqaGtrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNjk3OTcsImV4cCI6MjEwMjc0NTc5N30.1OeHzNFoeCu7ezocqyqxvvpOinjYnnocGuwBGVbKynU' };
// project settings to use: the built-in project wins over a stale saved copy of the same project
function sbCfg() { const sc = sbSavedCfg(); return SB_DEFAULT.url && SB_DEFAULT.key && (!sc || !sc.url || sc.url === SB_DEFAULT.url) ? SB_DEFAULT : sc; }
function sbSavedCfg() { try { return JSON.parse(lsGet(LS.supabase) || 'null'); } catch (e) { return null; } }
// The Supabase library ships with the app (same site, pinned version), so connecting
// never depends on a third-party CDN that a school network or browser extension might block.
const SB_LIB_SRC = 'supabase-2.117.3.js';
let sbLibPromise = null;
function loadSupabaseLib() {
  if (window.supabase && window.supabase.createClient) return Promise.resolve(window.supabase);
  if (!sbLibPromise) sbLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = SB_LIB_SRC; s.async = true;
    s.onload = () => (window.supabase && window.supabase.createClient) ? resolve(window.supabase) : reject(new Error('the database library did not start'));
    s.onerror = () => { sbLibPromise = null; s.remove(); reject(new Error('could not load the database library')); };
    document.head.appendChild(s);
  });
  return sbLibPromise;
}
async function sbConnect(url, key, silent) {
  const s = $('#sbStatus'); if (s && !silent) s.innerHTML = '<div class="status-note warn">Connecting…</div>';
  try {
    const mod = await loadSupabaseLib();
    const client = mod.createClient(url, key);
    state.sb = { connected: true, client };
    lsSet(LS.supabase, JSON.stringify({ url, key }));
    // Auth bootstrap FIRST - restores session if any, wires onAuthStateChange to load data on sign-in
    try { await bootstrapAuth(client); } catch (e) { console.warn('bootstrapAuth failed:', e); }
    // With no session, skip data ops - they'd fail the row rules. Data loads after sign-in.
    if (!state.auth.user) {
      if (s && !silent) s.innerHTML = '<div class="status-note ok">Connected. Sign in to load the board</div>';
      renderDrawer(); return true;
    }
    // A failed data load (expired session, network blip) must not drop the client, or sign-in breaks too
    try { await sbLoadData(client); }
    catch (e) { console.error('Supabase data load failed:', e); state.sb.lastError = e.message || String(e); toast("Couldn't load the board: " + state.sb.lastError, 'err'); renderDrawer(); return true; }
    setSaveBadge('Synced • live', 'saved');
    if (s) s.innerHTML = '<div class="status-note ok">Connected. Changes save for everyone</div>'; renderDrawer(); return true;
  } catch (e) { console.error('Supabase connect failed:', e); state.sb = { connected: false, client: null, lastError: e.message || String(e) }; if (s) s.innerHTML = `<div class="status-note err">Couldn't connect: ${esc(e.message || e)}. Check your internet connection and try again.</div>`; return false; }
}
function setSaveBadge(text, cls) { const b = $('#saveState'); if (b) { b.textContent = text; b.className = 'save-state ' + cls; } }

/* ---------- shared settings (markets, teams, owners, statuses, starter templates, campaigns) ----------
   Each group is one row in growth_settings, so everyone sees the same lists. Admins write them. */
const SETTINGS_SECTIONS = {
  markets: ['states', 'markets'],
  teams: ['teams', 'functionalAreas'],
  owners: ['owners'],
  statuses: ['statuses', 'statusMeta', 'stages', 'priorities'],
  templates: ['milestoneTemplates'],
  meeting: ['meeting'],   // committee meeting date and update cadence
  campaigns: null,   // stored at state.data.campaigns, not in meta
  seeded: ['wsSeeded']   // other boards only: set once the starting tasks are loaded
};
// Teams, templates and campaigns are saved per workstream ("teams@enabling"); the rest is shared.
const wsSettingsId = id => (WS !== 'readiness' && WS_OWN_SETTINGS.includes(id)) ? id + '@' + WS : id;
function settingsDocs() {
  return Object.keys(SETTINGS_SECTIONS).filter(id => id !== 'seeded' || WS !== 'readiness').map(id => {
    const keys = SETTINGS_SECTIONS[id], doc = { id: wsSettingsId(id) };
    if (keys) keys.forEach(k => { if (meta()[k] !== undefined) doc[k] = meta()[k]; });
    else doc.items = state.data.campaigns || [];
    return JSON.parse(JSON.stringify(doc));
  });
}
function settingsIdHere(id) { const [sid, sws] = id.split('@'); return sws ? sws === WS : wsSettingsId(sid) === sid; }
function applySettingsDoc(doc) {
  if (!doc || typeof doc.id !== 'string' || !settingsIdHere(doc.id)) return;   // another workstream's settings
  const sid = doc.id.split('@')[0];
  if (!Object.prototype.hasOwnProperty.call(SETTINGS_SECTIONS, sid)) return;
  const keys = SETTINGS_SECTIONS[sid];
  if (keys) keys.forEach(k => { if (doc[k] !== undefined) meta()[k] = doc[k]; });
  else if (Array.isArray(doc.items)) state.data.campaigns = doc.items;
}

/* ---------- field-level merge helpers ----------
   A record is saved as only the fields this person changed, so two people editing
   different fields of the same milestone both keep their edits. Notes (noteLog) are
   never saved this way: they are appended on the server (growth_add_note). */
const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = o => JSON.parse(JSON.stringify(o));
function fieldDiff(base, next) {
  const set = {}, unset = [];
  Object.keys(next).forEach(k => { if (k !== 'noteLog' && !jeq(next[k], base[k])) set[k] = next[k]; });
  Object.keys(base).forEach(k => { if (k !== 'noteLog' && !(k in next)) unset.push(k); });
  return { set, unset };
}
// Bring a newer server copy into our record without losing our own unsaved changes:
// fields we have not changed since `base` take the incoming value; fields we changed stay ours.
function mergeIncoming(local, base, incoming) {
  new Set([...Object.keys(local), ...Object.keys(incoming)]).forEach(k => {
    if (k === 'noteLog' || jeq(local[k], base ? base[k] : undefined)) { if (k in incoming) local[k] = incoming[k]; else delete local[k]; }
  });
  return local;
}
// Keep a teammate's change in every undo snapshot, so Undo only reverses this person's own edits.
function applyRemoteToUndo(kind, id, base, doc) {
  if (typeof undoStack === 'undefined') return;
  undoStack.forEach(en => {
    const arr = en.snapshot && en.snapshot[kind]; if (!arr) return;
    const i = arr.findIndex(x => x.id === id);
    if (!doc) { if (i >= 0) arr.splice(i, 1); return; }
    if (i < 0) { if (!base) arr.push(clone(doc)); return; }   // added by a teammate: keep it after undo
    const keys = base ? Object.keys({ ...base, ...doc }).filter(k => !jeq(base[k], doc[k])) : Object.keys(doc);
    keys.forEach(k => { if (k in doc) arr[i][k] = clone(doc[k]); else delete arr[i][k]; });
  });
}

async function sbLoadData(client) {
  // milestones
  const rm = await client.from(SB_TABLE.m).select('id,doc'); if (rm.error) throw rm.error;
  const rows = (rm.data || []).map(r => r.doc).filter(Boolean);
  rows.forEach(d => { if (!inWs(d)) wsOtherIds.set(d.id, d.ws || 'readiness'); });
  if (rows.length) state.data.milestones = rows.filter(inWs).map(syncFiscal);
  else if (canEdit()) { stampWs(); const r = await client.from(SB_TABLE.m).upsert(M().map(m => ({ id: m.id, doc: m, updated_at: new Date().toISOString() }))); if (r.error) throw r.error; }
  sbLastPushed = new Map(M().map(m => [m.id, JSON.stringify(m)]));
  // schools
  const rs = await client.from(SB_TABLE.s).select('id,doc'); if (rs.error) throw rs.error;
  if (rs.data && rs.data.length) state.data.schools = rs.data.map(r => r.doc).filter(Boolean);
  else if (canEdit()) { const r = await client.from(SB_TABLE.s).upsert(S().map(x => ({ id: x.id, doc: x, updated_at: new Date().toISOString() }))); if (r.error) throw r.error; }
  sbLastSchools = new Map(S().map(x => [x.id, JSON.stringify(x)]));
  // shared settings (an admin's first sign-in after setup seeds any missing groups from their copy)
  const rset = await client.from(SB_TABLE.settings).select('id,doc');
  if (rset.error) { sbSettingsReady = false; console.warn('Shared settings unavailable - run supabase-team-sync.sql:', rset.error); }
  else { sbSettingsReady = true; (rset.data || []).forEach(r => applySettingsDoc(r.doc)); sbLastSettings = new Map((rset.data || []).map(r => [r.id, JSON.stringify(r.doc)])); }
  // Another board's first open by an editor: load its starting tasks, teams and owners into the shared data.
  const seed = state.wsSeed;
  if (WS !== 'readiness' && seed && seed.milestones && seed.milestones.length && !M().length && canEdit()
      && sbSettingsReady && !sbLastSettings.has(wsSettingsId('seeded'))) {
    state.data.milestones = clone(seed.milestones).map(m => syncFiscal(Object.assign(m, { ws: WS })));
    const r = await client.from(SB_TABLE.m).upsert(M().map(m => ({ id: m.id, doc: m, updated_at: new Date().toISOString() })));
    if (r.error) throw r.error;
    sbLastPushed = new Map(M().map(m => [m.id, JSON.stringify(m)]));
    if (seed.teams) { meta().teams = seed.teams.slice(); meta().functionalAreas = seed.teams.slice(); }
    mergeOwners(seed.owners);
    meta().wsSeeded = new Date().toISOString();
    if (isAdmin()) sbPushDebounced();   // saves this board's teams, the new owners and the "loaded" marker
  } else if (WS !== 'readiness' && seed && seed.owners && isAdmin() && sbSettingsReady) {
    // Owners assigned on this board but missing from the shared roster (e.g. an editor loaded the tasks): add them.
    const assigned = new Set(); M().forEach(m => { if (m.owner) assigned.add(m.owner); (m.coOwners || []).forEach(n => assigned.add(n)); });
    if (mergeOwners(seed.owners.filter(o => assigned.has(o.name)))) sbPushDebounced();
  }
  sbLoaded = true;
  if (!client._ngcChannels) {
    client.channel('gm_rt').on('postgres_changes', { event: '*', schema: 'public', table: SB_TABLE.m }, sbOnRemote).subscribe();
    client.channel('gs_rt').on('postgres_changes', { event: '*', schema: 'public', table: SB_TABLE.s }, sbOnRemote).subscribe();
    client.channel('gset_rt').on('postgres_changes', { event: '*', schema: 'public', table: SB_TABLE.settings }, sbOnRemote).subscribe();
    client._ngcChannels = true;
  }
  autosaveWriteLocal(); rerender(); applyRoleUI();
  if (sbSettingsReady && isAdmin() && settingsDocs().some(d => !sbLastSettings.has(d.id))) sbPushDebounced();
  // Load the team-wide audit feed so Team activity shows everyone's changes.
  refreshActivityViews();
}
function quietRerender() { if (!$('#popover') && !$('#modalBackdrop').classList.contains('open')) rerender(); }
function sbOnRemote(p) {
  try {
    if (p.table === SB_TABLE.settings) {
      const doc = p.new && p.new.doc; if (!doc) return; const j = JSON.stringify(doc);
      if (sbLastSettings.get(doc.id) === j) return;
      sbLastSettings.set(doc.id, j); applySettingsDoc(doc); autosaveWriteLocal(); quietRerender();
      if ($('#drawer').classList.contains('open') && !$('#drawer').contains(document.activeElement)) renderDrawer();
      return;
    }
    const isSchool = p.table === SB_TABLE.s, kind = isSchool ? 'schools' : 'milestones';
    const arr = isSchool ? S() : M(), last = isSchool ? sbLastSchools : sbLastPushed;
    if (!isSchool) {   // another workstream's record: remember it, never show or merge it here
      const nd = p.new && p.new.doc, oid = p.old && p.old.id;
      if (nd && !inWs(nd)) { wsOtherIds.set(nd.id, nd.ws || 'readiness'); return; }
      if (p.eventType === 'DELETE' && oid && !arr.some(x => x.id === oid)) return;
    }
    if (p.eventType === 'DELETE') {
      const id = p.old && p.old.id; if (!id) return;
      const na = arr.filter(x => x.id !== id); if (isSchool) state.data.schools = na; else state.data.milestones = na;
      last.delete(id); applyRemoteToUndo(kind, id, null, null);
      if (!isSchool && modalMode === 'task' && modalId === id && $('#modalBackdrop').classList.contains('open')) { modalDirty = false; modalId = null; $('#modalBackdrop').classList.remove('open'); toast('A teammate removed this milestone', 'warn'); }
    } else {
      const doc = p.new && p.new.doc; if (!doc) return; const j = JSON.stringify(doc); if (last.get(doc.id) === j) return;
      const base = last.has(doc.id) ? JSON.parse(last.get(doc.id)) : null;
      const i = arr.findIndex(x => x.id === doc.id);
      if (i >= 0 && base) mergeIncoming(arr[i], base, doc); else if (i >= 0) arr[i] = doc; else arr.push(doc);
      applyRemoteToUndo(kind, doc.id, base, doc);
      last.set(doc.id, j);
    }
    autosaveWriteLocal(); quietRerender();
    // A teammate changed data - pull the fresh audit so Team activity reflects who did it.
    sbFetchAudit(50).then(() => { renderActivityPanel(); if (state.view === 'progress' && !$('#modalBackdrop').classList.contains('open')) refreshBody(); });
  } catch (e) { console.error(e); }
}
// Saves only what changed since the last server copy. New records are inserted whole; changed
// records send just their changed fields; records this person removed are deleted.
async function sbPushTable(client, table, list, last, allowDelete) {
  const ops = [];
  list.forEach(x => {
    const j = JSON.stringify(x), b = last.get(x.id);
    if (b === j) return;
    if (b === undefined) return ops.push({ x, sent: JSON.parse(j), set: JSON.parse(j), unset: [] });
    const d = fieldDiff(JSON.parse(b), x);
    if (Object.keys(d.set).length || d.unset.length) ops.push({ x, sent: JSON.parse(j), set: d.set, unset: d.unset });
  });
  const results = await Promise.all(ops.map(op => client.rpc('growth_patch', { p_table: table, p_id: op.x.id, p_set: op.set, p_unset: op.unset })));
  results.forEach((r, i) => {
    if (r.error) throw r.error;
    const doc = r.data, op = ops[i]; if (!doc) return;
    last.set(op.x.id, JSON.stringify(doc));
    mergeIncoming(op.x, op.sent, doc);   // pick up teammates' fields the server already had
  });
  if (allowDelete) {
    const ids = new Set(list.map(x => x.id)), dels = [];
    last.forEach((_v, id) => { if (!ids.has(id)) dels.push(id); });
    if (dels.length) { const r = await client.from(table).delete().in('id', dels); if (r.error) throw r.error; dels.forEach(id => last.delete(id)); }
  }
}
function syncErrorText(e) {
  const msg = (e && (e.message || e.details)) || String(e);
  if (e && (e.code === 'PGRST202' || /growth_patch|growth_add_note/.test(msg))) return 'the shared board needs an update. Contact your Growth Hub admin';
  if (e && (e.code === '42501' || /row-level security|permission/i.test(msg))) return 'your account does not have permission to make that change';
  return msg;
}
// A failed save stays on screen, retries by itself, and retries as soon as the connection returns.
let syncRetry = 0;
function setSyncAlert(reason) {
  clearTimeout(syncRetry); let a = $('#syncAlert');
  if (!reason) { if (a) a.remove(); return; }
  if (!a) {
    a = document.createElement('div'); a.id = 'syncAlert'; a.className = 'sync-alert'; a.setAttribute('role', 'alert');
    a.innerHTML = '<span class="sync-msg"></span><button type="button" class="btn btn-ghost btn-sm" id="syncRetryBtn">Retry now</button>';
    document.body.appendChild(a); a.querySelector('#syncRetryBtn').addEventListener('click', () => sbPush());
  }
  a.querySelector('.sync-msg').textContent = "Your changes aren't on the shared board yet: " + reason + '. Keep this page open while we retry';
  syncRetry = setTimeout(() => sbPush(), 30000);
}
window.addEventListener('online', () => { if ($('#syncAlert')) sbPush(); });
window.addEventListener('beforeunload', e => { if ($('#syncAlert')) { e.preventDefault(); e.returnValue = ''; } });
async function sbPush() {
  if (!(state.sb && state.sb.connected) || !sbLoaded || !state.auth.user) return;
  const client = state.sb.client;
  if (!canEdit()) return sbDiscardLocal(client);
  if (sbPushing) { sbPushAgain = true; return; }
  sbPushing = true;
  try {
    stampWs();
    await sbPushTable(client, SB_TABLE.m, M().filter(m => !m._draft), sbLastPushed, true);
    await sbPushTable(client, SB_TABLE.s, S(), sbLastSchools, true);
    if (sbSettingsReady && isAdmin()) await sbPushTable(client, SB_TABLE.settings, settingsDocs(), sbLastSettings, false);
    autosaveWriteLocal();
    setSaveBadge('Synced • live', 'saved'); setSyncAlert(null);
  } catch (e) {
    console.error(e); setSaveBadge('Saved locally · sync error', 'err');
    setSyncAlert(syncErrorText(e));
  } finally {
    sbPushing = false;
    if (sbPushAgain) { sbPushAgain = false; sbPushDebounced(); }
  }
}
// View-only accounts never write. If anything changed on this screen, reload the shared copy.
async function sbDiscardLocal(client) {
  const dirty = M().some(m => sbLastPushed.get(m.id) !== JSON.stringify(m)) || S().some(s => sbLastSchools.get(s.id) !== JSON.stringify(s)) || M().length !== sbLastPushed.size || S().length !== sbLastSchools.size;
  if (!dirty) return;
  toast("You have view-only access, so that change wasn't saved", 'err');
  try { await sbLoadData(client); setSaveBadge('View only', 'saved'); } catch (e) { console.error(e); }
}
function sbPushDebounced() { clearTimeout(sbPushTimer); sbPushTimer = setTimeout(sbPush, 400); }
// Send any pending edits now (used before posting a note on a just-created record).
async function sbFlush() { clearTimeout(sbPushTimer); if (sbPushing) { await new Promise(r => setTimeout(r, 300)); } await sbPush(); }

/* ---------- drawer / export ---------- */
function renderDrawer() {
  const connected = state.sb && state.sb.connected && sbLoaded, admin = isAdmin(), p = currentProfile();
  let n = 0; const num = () => '';
  const who = p ? (p.full_name || p.email) : (state.auth.user ? state.auth.user.email : '');
  $('#drawerBody').innerHTML = `
    <section class="dw-sec">
      <div class="dw-h">${num()}<h4>Your account</h4></div>
      ${who ? `<div class="status-note ok">Signed in as <b>${esc(who)}</b><span class="dw-role">${esc((r => r.charAt(0).toUpperCase() + r.slice(1))(currentRole() || 'viewer'))}</span></div>` : ''}
      ${connected ? '' : '<p class="dw-help">Not connected. Changes won\'t reach your team</p>'}
      ${canEdit() ? '' : '<p class="dw-help">You have view-only access. Ask an admin to make you an editor.</p>'}
      ${connected ? '' : '<div class="dw-btns"><button class="btn btn-filled" id="sbReconnect">Reconnect</button></div>'}
      <div id="sbStatus"></div>
    </section>

    ${admin ? meetingSettingsHtml() : ''}
    ${admin ? integrationsSettingsHtml() : ''}
    ${admin ? `<details class="dw-sec dw-fold"><summary>${num()}Customize markets, teams, and owners</summary>
      
      ${sbSettingsReady ? '' : '<div class="status-note warn">These settings are not shared yet. Changes stay on this device</div>'}
      ${czSection('State', 'markets', statesMeta().flatMap(s => s.markets.map(mk => ({ mk, st: s.code }))))}
      ${czSection('Team', 'teams', teams().map(t => ({ mk: t })))}
      ${czOwners()}
    </details>

    <details class="dw-sec dw-fold"><summary>${num()}Manage school openings</summary>
      ${schoolsPanel()}
      <div class="ms-bulk">
        <div class="ms-bulk-warn">Bulk delete removes every school opening <b>and</b> every milestone tied to those schools. Milestones with no school attached remain untouched.</div>
        <button class="btn btn-danger-solid" id="msDeleteAll" ${state.data.schools.length ? '' : 'disabled'}>Delete all school openings</button>
      </div>
    </details>` : ''}

    <details class="dw-sec dw-fold"><summary>${num()}Back up${admin ? ' and restore' : ''} data</summary>
      <p class="dw-help">${admin ? 'Import adds and updates. It never deletes.' : ''}</p>
      <div class="dw-btns"><button class="btn" id="expBtn">Download backup</button><button class="btn" id="csvBtn">Export milestones to CSV</button>${admin ? '<button class="btn" id="impBtn">Import</button><input type="file" id="impFile" accept="application/json" class="hide">' : ''}</div>
    </details>

    <div class="dw-about">${WS_SEED[WS] ? WS_SEED[WS].title : 'Growth Readiness'} · ${M().length} milestones · ${state.data.schools.length} schools · v${meta().version || 1}</div>`;
}

/* ---------- schools management panel (drawer section 4) ---------- */
function schoolsPanel() {
  const schools = state.data.schools.slice().sort((a, b) => (a.openingFY || 0) - (b.openingFY || 0) || a.market.localeCompare(b.market) || a.display_label.localeCompare(b.display_label));
  if (!schools.length) return '<div class="ms-empty">No school openings yet</div>';
  const rows = schools.map(s => {
    const taskCount = schoolMs(s).length;
    return `<div class="ms-row">
      <span class="ms-badge" style="background:${stColor(s.state)}">${esc(s.state)}</span>
      <div class="ms-info"><b>${esc(s.market)}</b> · ${esc(s.display_label)}<span class="muted"> · Fall ${s.openingFY - 1}</span></div>
      <span class="ms-count" title="${taskCount} milestone${taskCount === 1 ? '' : 's'} tied to this school">${taskCount}</span>
      <button class="btn btn-text btn-sm" data-msedit="${esc(s.id)}" title="Edit school">Edit</button>
      <button class="btn btn-text btn-sm ms-del-btn" data-msdel="${esc(s.id)}" title="Remove school">Remove</button>
    </div>`;
  }).join('');
  return `<div class="ms-list">${rows}</div>`;
}
function bulkDeleteAllSchools() {
  if (!guardAdmin()) return;
  const n = state.data.schools.length;
  const nTasks = M().filter(m => (m.schoolIds || []).length).length;
  if (!n) return;
  confirmDialog({
    title: 'Delete every school opening?',
    danger: true,
    confirmLabel: 'Delete all',
    requireTyped: 'DELETE ALL',
    message: `This removes <b>${n} school opening${n === 1 ? '' : 's'}</b> and every milestone tied to them (roughly <b>${nTasks} milestone${nTasks === 1 ? '' : 's'}</b>). Milestones with no school attached remain.`,
    onConfirm: () => {
      snapshotForUndo('Bulk delete all schools');
      const sids = new Set(state.data.schools.map(s => s.id));
      state.data.schools = [];
      state.data.milestones = M().filter(m => {
        if (!(m.schoolIds || []).some(id => sids.has(id))) return true;
        m.schoolIds = (m.schoolIds || []).filter(id => !sids.has(id));
        m.schools = [];
        return m.schoolIds.length > 0;
      });
      logActivity('delete', `Bulk deleted ${n} school openings`);
      autosave(); rerender(); renderDrawer();
      toast(`${n} school${n === 1 ? '' : 's'} removed`, 'ok');
    }
  });
}

/* ---------- customize (markets / teams / owners) ---------- */
function czSection(label, type, rows) {
  const stOpts = statesMeta().map(s => `<option value="${esc(s.code)}">${esc(s.code)}</option>`).join('');
  const list = rows.map(r => `<div class="cz-row">
    <input class="cz-name" data-cztype="${type}" data-czold="${esc(r.mk)}" value="${esc(r.mk)}">
    ${type === 'markets' ? `<select class="cz-state" data-czmarket="${esc(r.mk)}">${statesMeta().map(s => `<option value="${esc(s.code)}" ${s.code === r.st ? 'selected' : ''}>${esc(s.code)}</option>`).join('')}</select>` : ''}
    <button class="cz-del" data-cztype="${type}" data-czval="${esc(r.mk)}" title="Remove" aria-label="Remove">${CI('close')}</button></div>`).join('');
  return `<div class="cz-block"><div class="cz-add">
      <input class="cz-new" id="czNew-${type}" placeholder="Add a ${esc(label === 'State' ? 'market' : 'team')}">
      ${type === 'markets' ? `<select id="czNewState">${stOpts}</select>` : ''}
      <button class="btn btn-tonal btn-sm" data-czadd="${type}">Add</button>
    </div>${list}</div>`;
}
function czOwners() {
  const rows = (meta().owners || []).map(o => `<div class="cz-row"><input class="cz-name" data-cztype="owner" data-czold="${esc(o.name)}" value="${esc(o.name)}"><input class="cz-role" data-czowner="${esc(o.name)}" value="${esc(o.role || '')}" placeholder="Role"><input class="cz-email" type="email" data-czowner="${esc(o.name)}" value="${esc(o.email || '')}" placeholder="email" aria-label="Email for ${esc(o.name)}"><button class="cz-del" data-cztype="owner" data-czval="${esc(o.name)}" title="Remove" aria-label="Remove">${CI('close')}</button></div>`).join('');
  return `<div class="cz-block"><h4 style="margin-top:14px">Owners</h4><div class="cz-add"><input class="cz-new" id="czNew-owner" placeholder="Add a person"><input class="cz-new" id="czNewRole" placeholder="Role, optional"><input class="cz-new" id="czNewEmail" type="email" placeholder="Email, optional"><button class="btn btn-tonal btn-sm" data-czadd="owner">Add</button></div>${rows}</div>`;
}
function czInUse(type, val) { if (type === 'owner') return M().filter(m => ownersOf(m).includes(val)).length; return type === 'markets' ? M().filter(m => m.market === val).length + state.data.schools.filter(s => s.market === val).length : M().filter(m => m.functional_area === val).length; }
function czRename(type, oldV, newV) {
  if (!guardAdmin()) return;
  newV = newV.trim(); if (!newV || newV === oldV) return;
  if (type === 'markets') {
    if (markets().includes(newV)) return toast('That market already exists', 'err');
    meta().markets = markets().map(x => x === oldV ? newV : x);
    statesMeta().forEach(s => s.markets = s.markets.map(x => x === oldV ? newV : x));
    M().forEach(m => { if (m.market === oldV) m.market = newV; if (m.location === oldV) m.location = newV; m.tags = (m.tags || []).map(t => t === oldV ? newV : t); });
    state.data.schools.forEach(s => { if (s.market === oldV) s.market = newV; if (s.location === oldV) s.location = newV; });
  } else if (type === 'teams') {
    if (teams().includes(newV)) return toast('That team already exists', 'err');
    meta().teams = teams().map(x => x === oldV ? newV : x); meta().functionalAreas = meta().teams;
    M().forEach(m => { if (m.team === oldV) m.team = newV; if (m.functional_area === oldV) m.functional_area = newV; });
  } else if (type === 'owner') {
    if ((meta().owners || []).some(o => o.name === newV)) { toast(`${newV} is already on the team list`, 'err'); renderDrawer(); return; }
    (meta().owners || []).forEach(o => { if (o.name === oldV) o.name = newV; });
    toast(`Renamed. Update ${newV}'s account name to match.`, 'warn');
    M().forEach(m => { if (m.owner === oldV) m.owner = newV; if (m.coOwners) m.coOwners = m.coOwners.map(o => o === oldV ? newV : o); });
  }
  autosave(); rerender(); renderDrawer();
}
function czRemove(type, val) {
  if (!guardAdmin()) return;
  const n = czInUse(type, val);
  if (n) return toast(type === 'owner' ? `${val} owns ${n} milestone${n === 1 ? '' : 's'}. Reassign ${n === 1 ? 'it' : 'them'} first.` : `${val} is used by ${n} item${n === 1 ? '' : 's'}. Reassign ${n === 1 ? 'it' : 'them'} first.`, 'err');
  confirmDialog({ title: `Remove "${esc(val)}"?`, message: `This removes the ${type === 'markets' ? 'market' : type === 'teams' ? 'team' : 'person'} from your lists.`, confirmLabel: 'Remove', danger: true, onConfirm: () => {
    if (type === 'owner') meta().owners = (meta().owners || []).filter(o => o.name !== val);
    else if (type === 'markets') { meta().markets = markets().filter(x => x !== val); statesMeta().forEach(s => s.markets = s.markets.filter(x => x !== val)); }
    else { meta().teams = teams().filter(x => x !== val); meta().functionalAreas = meta().teams; }
    autosave(); rerender(); renderDrawer();
  } });
}
function czAdd(type) {
  if (!guardAdmin()) return;
  const v = ($('#czNew-' + type) || {}).value ? $('#czNew-' + type).value.trim() : '';
  if (!v) return flagEmpty($('#czNew-' + type));
  if (type === 'markets') { if (markets().includes(v)) return toast('Already on the list', 'err'); const st = $('#czNewState').value; markets().push(v); const s = statesMeta().find(x => x.code === st); if (s) s.markets.push(v); }
  else if (type === 'teams') { if (teams().includes(v)) return toast('Already on the list', 'err'); teams().push(v); meta().functionalAreas = teams(); }
  else if (type === 'owner') { (meta().owners = meta().owners || []).push({ name: v, role: ($('#czNewRole') || {}).value || '', email: (($('#czNewEmail') || {}).value || '').trim() }); }
  autosave(); rerender(); renderDrawer();
}
function exportJson() { const b = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `growth-hub-backup-${todayISO()}.json`; a.click(); URL.revokeObjectURL(a.href); toast('Backup downloaded', 'ok'); }
// Spreadsheet export of what's on screen (current filters), for Excel and Google Sheets users
function exportCsv() {
  const list = filtered(), q = v => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  const head = ['Milestone', 'Status', 'Progress %', 'Due date', 'Owner', 'Co-owners', 'Team', 'Market', 'Schools', 'Priority', 'Blocked by', 'Notes', 'Last updated', 'Updated by'];
  const rows = list.map(m => [m.activity, SM(effectiveStatus(m)).label, m.progress_percent || 0, m.due_date || '', m.owner || '', (m.coOwners || []).join('; '), m.functional_area || '', m.market || '',
    (m.schoolIds || []).map(id => (schoolById(id) || {}).display_label).filter(Boolean).join('; '), (PRIORITY[m.priority] || {}).label || '', m.status === 'blocked' ? (m.dependency || '') : '', m.notes || '',
    m.updatedAt ? m.updatedAt.slice(0, 10) : '', m.updatedBy || ''].map(q).join(','));
  const b = new Blob(['\ufeff' + [head.map(q).join(','), ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `growth-hub-milestones-${todayISO()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  toast(`Exported ${list.length} milestone${list.length === 1 ? '' : 's'}`, 'ok');
}
// Admin only. Adds and updates records from a backup file; never deletes anything, so
// teammates' newer work stays. Shared settings in the file are not changed.
function importJson(file) {
  if (!guardAdmin()) return;
  const r = new FileReader();
  r.onload = () => {
    let d; try { d = JSON.parse(r.result); if (!Array.isArray(d.milestones)) throw 0; } catch (e) { return toast("That file isn't a Growth Hub backup", 'err'); }
    const ms = d.milestones.filter(x => x && x.id), ss = (Array.isArray(d.schools) ? d.schools : []).filter(x => x && x.id);
    const newM = ms.filter(x => !findM(x.id)).length, newS = ss.filter(x => !schoolById(x.id)).length;
    confirmDialog({
      title: 'Import this file?',
      message: `Adds <b>${newM}</b> and updates <b>${ms.length - newM}</b> milestones. Adds <b>${newS}</b> and updates <b>${ss.length - newS}</b> schools. Nothing is deleted.`,
      confirmLabel: 'Import',
      onConfirm: () => {
        snapshotForUndo('Import from file');
        const put = (arr, x) => { const i = arr.findIndex(y => y.id === x.id); if (i >= 0) arr[i] = x; else arr.push(x); };
        ms.forEach(x => put(M(), syncFiscal(x))); ss.forEach(x => put(S(), x));
        logActivity('edit', `Imported ${ms.length} milestones and ${ss.length} schools`);
        autosave(); rerender(); renderDrawer(); toast('Import complete', 'ok');
      }
    });
  };
  r.readAsText(file);
}

/* ---------- toast / theme / nav ---------- */
// One-click status change from a card (Linear/Asana pattern). Saves immediately; Undo in the toast.
function openStatusMenu(btn) {
  if (!guardEdit()) return;
  const m = findM(btn.dataset.qstatus); if (!m) return;
  const opts = meta().statuses.filter(k => k !== 'blocked');
  const p = openPopover(btn, `<div class="pop-title">Status</div><div class="pop-list">${opts.map(k => `<button class="pop-item qs-opt ${m.status === k ? 'on' : ''}" data-qs="${k}"><i class="fdot" style="background:${SM(k).color}"></i>${esc(SM(k).label)}</button>`).join('')}</div>`);
  p.addEventListener('click', e => {
    const o = e.target.closest('[data-qs]'); if (!o) return;
    const v = o.dataset.qs; closePopover(); if (v === m.status) return;
    snapshotForUndo('Status: ' + (m.activity || '').slice(0, 30));
    m.status = v; touch(m); if (CI_REV[v]) recordCheckin(m, CI_REV[v], null, '');
    if (v === 'complete') { m.progress_percent = 100; m.stage = 'complete'; }
    else { if (m.stage === 'complete') m.stage = 'in_progress'; if (m.progress_percent === 100) m.progress_percent = 95; }
    logActivity('status', `Set "${m.activity}" to ${SM(v).label}`, { itemId: m.id });
    autosave(); rerender();
    toastAction(`Marked ${SM(v).label.toLowerCase()}`, 'Undo', undo);
  });
}
function toastAction(msg, label, fn) {
  const w = $('#toastWrap'); capToasts(w); const t = document.createElement('div'); t.className = 'toast ok toast-act';
  t.innerHTML = `<span>${esc(msg)}</span><button class="toast-btn">${esc(label)}</button>`;
  t.querySelector('button').addEventListener('click', () => { t.remove(); fn(); });
  w.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .2s'; setTimeout(() => t.remove(), 200); }, 6000);
}
function capToasts(w) { while (w.children.length > 2) w.firstChild.remove(); }
function toast(msg, kind) { const w = $('#toastWrap'); capToasts(w); const t = document.createElement('div'); t.className = 'toast' + (kind ? ' ' + kind : ''); t.textContent = msg; w.appendChild(t); setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, kind === 'warn' || kind === 'err' ? 6000 : 2400); }
const VIEWS = ['progress', 'timeline', 'plan'];
function setView(v, fromPop) {
  if (!VIEWS.includes(v)) v = 'progress';
  if (v === 'reports') v = 'progress';
  if (v === 'timeline' && !hasSchoolWork()) v = 'progress';
  state.view = v;
  $$('.nav-tab').forEach(t => { const on = t.dataset.view === v; t.classList.toggle('active', on); if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  document.title = ({ progress: 'Dashboard', timeline: 'Openings', plan: 'Milestones' }[v] || 'Dashboard') + ' · ' + (WS_SEED[WS] ? WS_SEED[WS].title : 'Growth Readiness') + ' · Growth Hub';
  const pg = $('#planGroup'); if (pg) pg.classList.toggle('expanded', v === 'plan');
  $$('.nav-subitem').forEach(x => x.classList.toggle('active', v === 'plan' && (x.dataset.plan === 'focus' ? state.planFocus : (!state.planFocus && state.planGroup === x.dataset.plan))));
  $$('.view').forEach(s => { const on = s.id === 'view-' + v; s.classList.toggle('active', on); if (!on) s.innerHTML = ''; });
  
  document.body.dataset.view = v;
  if (typeof closeFilterPanel === 'function') closeFilterPanel();
  updateGreeting();
  rerender();
  if (typeof updateFilterBubble === 'function') updateFilterBubble();
  if (!fromPop) { try { if (location.hash !== '#' + v) history.pushState({ v }, '', '#' + v); } catch (e) {} }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function wireEvents() {
  $('#navTabs').addEventListener('click', e => {
    const si = e.target.closest('.nav-subitem');
    if (si) { const p = si.dataset.plan; if (p === 'focus') state.planFocus = true; else { state.planGroup = p; state.planFocus = false; } return setView('plan'); }
    const t = e.target.closest('.nav-tab');
    if (t) {
      // Manual sidebar nav clears transient filters so users aren't confused by leftover
      // filters carried in from a KPI drill. The Team lens intentionally persists across tabs.
      // Drills call setView() directly.
      if (activeCount()) clearTransientFilters();
      setView(t.dataset.view);
    }
  });
  const nt = $('#navToggle'); if (nt) nt.addEventListener('click', () => { const on = document.body.classList.toggle('nav-collapsed'); syncNavTitles(); lsSet('ngc_nav', on ? '1' : '0'); nt.title = on ? 'Expand menu' : 'Collapse menu'; const lbl = nt.querySelector('.nav-util-lbl'); if (lbl) lbl.textContent = on ? 'Expand' : 'Collapse'; });
  const showDrawer = () => { renderDrawer(); $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); };
  const openDrawer = () => {
    showDrawer();
  };
  const closeDrawer = () => { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); };
  $('#settingsBtn').addEventListener('click', openDrawer); $('#drawerClose').addEventListener('click', closeDrawer); $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('#modalClose').addEventListener('click', attemptCloseModal); $('#modalCancel').addEventListener('click', attemptCloseModal); $('#modalSave').addEventListener('click', saveModal); $('#modalDelete').addEventListener('click', deleteModal);
  $('#modalBackdrop').addEventListener('click', e => { if (e.target.id === 'modalBackdrop') attemptCloseModal(); });
  // any user edit inside the modal marks it dirty; save/close resets
  $('#modalBody').addEventListener('input', e => { if ((e.target.matches ? e.target.matches('input, textarea, select') : false)) modalDirty = true; });
  $('#modalBody').addEventListener('change', e => { if ((e.target.matches ? e.target.matches('input[type="checkbox"], input[type="radio"], select') : false)) modalDirty = true; });
  // the modal lives outside .container, so clicks inside it need their own delegation
  $('#modalBody').addEventListener('click', e => {
    if (e.target.closest('#noteAdd')) return postNote(e.target.closest('.notes-field'));
    if (e.target.closest('#addTaskForSchool')) { taskReturnSchool = schoolId; return addTaskForSchool(); }
    if (e.target.closest('#tplToggle')) return toggleTemplatesPanel();
    if (e.target.closest('#tplApply')) return applyTemplatesToSchool();
    if (e.target.id === 'tplAll') { const on = e.target.checked; document.querySelectorAll('#tplPanel .tpl-check:not([disabled])').forEach(c => c.checked = on); return updateTplSelection(); }
    if (e.target.classList && e.target.classList.contains('tpl-check')) return updateTplSelection();
    const op = e.target.closest('[data-openplanschool]'); if (op) { closeModal(); clearFilters(); state.filters.schoolId = op.dataset.openplanschool; setView('plan'); return; }
    const os = e.target.closest('[data-openschool]'); if (os) { closeModal(); return openSchoolModal(os.dataset.openschool); }
    const ex = e.target.closest('[data-expand]'); if (ex && !e.target.closest('button:not([data-expand]), a, input, select, textarea, label')) { if (modalMode === 'school') taskReturnSchool = schoolId; return openModal(ex.dataset.expand); }
  });
  $('#modalBody').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'noteInput' && !mentionMenuOpen()) { e.preventDefault(); postNote(e.target.closest('.notes-field')); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCmdk(); if ($('#modalBackdrop').classList.contains('open')) attemptCloseModal(); closeDrawer(); closePopover(); closeConfirm(); } });

  // keep timing colors live vs. the real date (on return-to-tab and within a minute of midnight)
  let _day = new Date().toDateString();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rerender(); });
  setInterval(() => { const t = new Date().toDateString(); if (t !== _day) { _day = t; rerender(); } }, 60000);

  document.addEventListener('dragstart', e => { const c = e.target.closest('.kcard'); if (c && !canEdit()) { e.preventDefault(); return; } if (c) { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); } });
  document.addEventListener('dragend', e => { const c = e.target.closest('.kcard'); if (c) c.classList.remove('dragging'); $$('.kcol-body.over').forEach(b => b.classList.remove('over')); });
  document.addEventListener('dragover', e => { const b = e.target.closest('.kcol-body'); if (b) { e.preventDefault(); b.classList.add('over'); } });
  document.addEventListener('dragleave', e => { const b = e.target.closest('.kcol-body'); if (b && !b.contains(e.relatedTarget)) b.classList.remove('over'); });
  document.addEventListener('drop', e => { const b = e.target.closest('.kcol-body'); if (b) { e.preventDefault(); b.classList.remove('over'); const m = findM(e.dataTransfer.getData('text/plain')); if (m && m.stage !== b.dataset.kstage && guardEdit()) { snapshotForUndo('Move milestone: ' + (m.activity || '').slice(0, 30)); logActivity('move', `Moved "${m.activity}" to ${b.dataset.kstage}`, { itemId: m.id }); const was = m.stage; m.stage = b.dataset.kstage; touch(m);
      if (m.stage === 'complete') { m.status = 'complete'; m.progress_percent = 100; }
      else if (m.status === 'complete' && m.stage === 'to_do') { m.status = 'not_started'; m.progress_percent = 0; }
      else { if (m.status === 'complete') { m.status = 'on_track'; if (m.progress_percent === 100) m.progress_percent = 95; } if (m.status === 'not_started' && m.stage !== 'to_do') m.status = 'on_track'; }
      touch(m); autosave(); refreshResults(); const col = (meta().stageMeta && meta().stageMeta[m.stage] && meta().stageMeta[m.stage].label) || (m.stage.charAt(0).toUpperCase() + m.stage.slice(1)).replace(/_/g, ' '); toastAction(`Moved to ${col}`, 'Undo', undo); } } });

  $('.container').addEventListener('click', e => {
    const fm = e.target.closest('.fb-menu'); if (fm) return openFilterMenu(fm, fm.dataset.fmenu);
    const oy = e.target.closest('[data-oyear]'); if (oy) { toggleOpeningYear(+oy.dataset.oyear); return rerender(); }
    if (e.target.closest('[data-oyall]')) { state.filters.openingFYs.clear(); return rerender(); }
    if (e.target.closest('#clearFilters, [data-clearfilters]')) { clearFilters(); return rerender(); }
    if (e.target.closest('#clearFilters2')) { clearFilters(); return rerender(); }
    if (e.target.closest('#pmExpandAll')) { (state._pmKeys || []).forEach(k => state.expanded[k] = true); return refreshBody(); }
    if (e.target.closest('#pmCollapseAll')) { state.expanded = {}; return refreshBody(); }
    const plv = e.target.closest('[data-planview]'); if (plv) { state.planGroup = plv.dataset.planview === 'board' ? 'stage' : (state._lastListGroup || 'team'); if (plv.dataset.planview !== 'board') state._lastListGroup = state.planGroup; return renderPlan(); }
    const pv = e.target.closest('[data-progressview]'); if (pv) { state.progressView = pv.dataset.progressview; return renderProgress(); }
    const pd = e.target.closest('[data-progressdim]'); if (pd) { state.progressDim = pd.dataset.progressdim; return refreshBody(); }
    const ch = e.target.closest('[data-cohort]'); if (ch) return setDashCohort(ch.dataset.cohort);
    const bd = e.target.closest('[data-dashbd]'); if (bd) { state.dashBreakdown = bd.dataset.dashbd; return refreshBody(); }
    if (e.target.closest('[data-open-checkins]')) return openCheckins();
    if (e.target.closest('[data-open-agenda]')) return openAgenda();
    if (e.target.closest('[data-mtg-held]')) return markMeetingHeld();
    if (e.target.closest('[data-open-settings]')) { renderDrawer(); $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); return; }
    if (e.target.closest('[data-copy-all]')) return copyText(reminderText(M().filter(needsCheckin)));
    const etm = e.target.closest('[data-email-team]'); if (etm) return emailTeam(etm.dataset.emailTeam);
    const ctm = e.target.closest('[data-copy-team]'); if (ctm) { const txt = teamNote(ctm.dataset.copyTeam); return txt ? copyText(txt) : null; }
    const qs = e.target.closest('[data-qstatus]'); if (qs) { e.stopPropagation(); return openStatusMenu(qs); }
    const dr = e.target.closest('[data-drilldim]'); if (dr) return applyDrill(dr.dataset.drilldim, dr.dataset.drillval);
    const gv = e.target.closest('[data-goview]'); if (gv) { window.scrollTo({ top: 0, behavior: 'smooth' }); return setView(gv.dataset.goview); }
    if (e.target.closest('[data-activityall]')) return toggleActivity();
    const as = e.target.closest('[data-addstage]'); if (as) return addItem(as.dataset.addstage);
    const cp = e.target.closest('[data-complete]'); if (cp) { if (!guardEdit()) { e.preventDefault(); return; } const m = findM(cp.dataset.complete); if (m) { snapshotForUndo('Complete: ' + (m.activity || '').slice(0, 30)); m.status = 'complete'; m.progress_percent = 100; m.stage = 'complete'; touch(m); logActivity('status', `Completed "${m.activity}"`, { itemId: m.id }); autosave(); rerender(); toast('Marked complete', 'ok'); } return; }
    const sm = e.target.closest('[data-showmore]'); if (sm) { const p = sm.dataset.showmore; if (p === 'focus') state.planFocus = true; else { state.planGroup = p; state.planFocus = false; } return setView('plan'); }
    const tg = e.target.closest('[data-toggle]'); if (tg) { const k = tg.dataset.toggle; state.expanded[k] = !state.expanded[k]; return refreshBody(); }
    const ex = e.target.closest('[data-expand]'); if (ex && !e.target.closest('button:not([data-expand]), a, input, select, textarea, label')) return openModal(ex.dataset.expand);
    const oi = e.target.closest('[data-openitem]'); if (oi) return openModal(oi.dataset.openitem);
    const dm = e.target.closest('[data-drillmine]');
    if (dm) {
      if (!myOwnerName()) return;
      clearTransientFilters(); setMine(true);
      const t = dm.dataset.drillmine;
      if (t === 'blocked') state.filters.statuses.add('blocked'); else if (t) state.filters.timing = t;
      return setView('plan');
    }
    if (e.target.closest('#mineToggle')) { setMine(!mineOn()); return rerender(); }
    const es2 = e.target.closest('[data-editschool]'); if (es2) return openSchoolModal(es2.dataset.editschool);
    const ds = e.target.closest('[data-drillschool]'); if (ds) return openSchoolModal(ds.dataset.drillschool);
    const dro = e.target.closest('[data-drillowner]'); if (dro) { clearFilters(); const nm = dro.dataset.drillowner; state.filters.search = nm; const cb = $('#cbSearch'); if (cb) cb.value = nm; setView('plan'); return; }
    const gp = e.target.closest('[data-goplan]'); if (gp) { const m = findM(gp.dataset.goplan); if (m) { state.filters.search = m.activity; const cb = $('#cbSearch'); if (cb) cb.value = m.activity; } setView('plan'); return; }
    if (e.target.closest('#planFocus')) { state.planFocus = !state.planFocus; return renderPlan(); }
    if (e.target.closest('#planCsv')) return exportCsv();
    const tAll = e.target.closest('#planToggleAll');
    if (tAll) { const keys = state._planKeys || [], open = keys.length > 0 && keys.every(k => state.expanded[k]); keys.forEach(k => { if (open) delete state.expanded[k]; else state.expanded[k] = true; }); tAll.textContent = open ? 'Expand all' : 'Collapse all'; return refreshBody(); }
    if (e.target.closest('#addSchool')) return openSchoolModal(null);
    if (e.target.closest('#addTaskForSchool')) return addTaskForSchool();
    if (e.target.closest('#newItem')) return addItem();
    if (e.target.closest('#dashPrint')) return window.print();
    const afc = e.target.closest('[data-afclear]'); if (afc) { removeAppliedFilter(afc.dataset.afclear); return rerender(); }
  });
  $('.container').addEventListener('change', e => {
    if (e.target.id === 'planGroupSel') { state.planGroup = e.target.value; state._lastListGroup = state.planGroup; refreshBody(); }
    else if (e.target.id === 'dashSchool') { state.filters.schoolId = e.target.value; refreshBody(); const cl = $('#clearFilters'); if (cl) cl.classList.toggle('hide', !activeCount()); }
  });

  $('#drawerBody').addEventListener('click', e => {
    if (e.target.id === 'sbReconnect') { const sc = sbCfg(); if (sc && sc.url && sc.key) sbConnect(sc.url, sc.key); return; }
    if (e.target.id === 'expBtn') return exportJson();
    if (e.target.id === 'csvBtn') return exportCsv();
    if (e.target.id === 'impBtn') { if (guardAdmin()) $('#impFile').click(); return; }
    if ((e.target.id === 'msDeleteAll' || e.target.closest('[data-msdel], [data-czadd], .cz-del')) && !guardAdmin()) return;
    if (e.target.id === 'msDeleteAll') return bulkDeleteAllSchools();
    const msE = e.target.closest('[data-msedit]'); if (msE) { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); return openSchoolModal(msE.dataset.msedit); }
    const msD = e.target.closest('[data-msdel]'); if (msD) { const sid = msD.dataset.msdel; const s = schoolById(sid); if (!s) return; const tasks = schoolMs(s); confirmDialog({ title: `Remove ${esc(s.display_label)}?`, message: `Remove <b>${esc(s.display_label)} (${esc(s.market)})</b>` + (tasks.length ? ` and its <b>${tasks.length} milestone${tasks.length === 1 ? '' : 's'}</b>` : '') + ' from the schedule.', confirmLabel: 'Remove school', danger: true, onConfirm: () => { snapshotForUndo('Remove school: ' + s.display_label); const cd = s.code; state.data.schools = state.data.schools.filter(x => x.id !== sid); state.data.milestones = M().filter(m => { if (!(m.schoolIds || []).includes(sid)) return true; m.schoolIds = m.schoolIds.filter(id => id !== sid); m.schools = (m.schools || []).filter(c => c !== cd); return m.schoolIds.length > 0; }); autosave(); rerender(); renderDrawer(); toast('School removed', 'ok'); } }); return; }
    const cza = e.target.closest('[data-czadd]'); if (cza) return czAdd(cza.dataset.czadd);
    const czd = e.target.closest('.cz-del'); if (czd) return czRemove(czd.dataset.cztype, czd.dataset.czval);
  });
  $('#drawerBody').addEventListener('change', e => {
    if (e.target.id === 'impFile' && e.target.files[0]) return importJson(e.target.files[0]);
    if (e.target.closest('.cz-row, .cz-add') && !guardAdmin()) return renderDrawer();
    if (e.target.classList.contains('cz-name')) return czRename(e.target.dataset.cztype, e.target.dataset.czold, e.target.value);
    if (e.target.classList.contains('cz-state')) { const mk = e.target.dataset.czmarket, to = e.target.value; statesMeta().forEach(s => s.markets = s.markets.filter(x => x !== mk)); const s = statesMeta().find(x => x.code === to); if (s && !s.markets.includes(mk)) s.markets.push(mk); M().forEach(m => { if (m.market === mk) m.state = to; }); state.data.schools.forEach(x => { if (x.market === mk) x.state = to; }); autosave(); rerender(); renderDrawer(); return; }
    if (e.target.classList.contains('cz-email')) { const o = (meta().owners || []).find(x => x.name === e.target.dataset.czowner), v = e.target.value.trim(); if (o) { if (v && !validEmail(v)) return toast('Check the email address', 'err'); o.email = v; autosave(); } return; }
    if (e.target.classList.contains('cz-role')) { const o = (meta().owners || []).find(x => x.name === e.target.dataset.czowner); if (o) { o.role = e.target.value; autosave(); } return; }
  });
}

/* ============================================================
   ACCOUNTS (Supabase Auth)
   Everyone signs in with their own invited account. Roles live in the profiles table.
   The database's row rules enforce them; the app hides edit controls to match.
   ============================================================ */
// Read once at load, before the auth library clears an invite or reset link from the address bar.
const AUTH_LINK = (() => {
  const h = (location.hash || '') + '&' + (location.search || '');
  const t = /[#&?]type=(recovery|invite)\b/.exec(h), er = /error_description=([^&]+)/.exec(h);
  return { type: t ? t[1] : null, error: er ? decodeURIComponent(er[1].replace(/\+/g, ' ')) : null };
})();
function authModeOn() { return true; }
function currentProfile() { return state.auth && state.auth.profile; }
function currentRole() { const p = currentProfile(); return p ? p.role : null; }
function isEditor() { const r = currentRole(); return r === 'editor' || r === 'admin'; }
function isAdmin() { return currentRole() === 'admin'; }
function canEdit() { return isEditor(); }
function guardEdit() { if (canEdit()) return true; toast('You have view-only access', 'err'); return false; }
function guardAdmin() { if (isAdmin()) return true; toast('Only admins can change shared settings', 'err'); return false; }
// Hide edit controls for view-only accounts (CSS keys off body.read-only).
function applyRoleUI() { document.body.classList.toggle('read-only', !!(state.auth && state.auth.user) && !canEdit()); }

async function loadProfile(userId) {
  const client = state.sb && state.sb.client; if (!client || !userId) return null;
  try {
    const { data, error } = await client.from('profiles').select('id, full_name, email, department, role, mfa_enrolled').eq('id', userId).single();
    if (error) throw error;
    state.auth.profile = data; return data;
  } catch (e) { console.warn('loadProfile failed:', e); return null; }
}

async function bootstrapAuth(client) {
  if (!client || state.auth.wired) return;
  state.auth.wired = true;
  const { data: { session } } = await client.auth.getSession();
  if (session && session.user) { state.auth.user = session.user; await loadProfile(session.user.id); }
  client.auth.onAuthStateChange(async (event, sess) => {
    if (event === 'PASSWORD_RECOVERY') { state.auth.needsPassword = true; if (state._booted) setTimeout(() => showAuthScreen(null, 'setpw'), 0); }
    if (sess && sess.user) {
      state.auth.user = sess.user; await loadProfile(sess.user.id);
      // First sign-in in auth mode: pull the board now that RLS lets us
      if (authModeOn() && !state.auth.reauth && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
        try { await sbLoadData(client); } catch (e) { console.warn('post-signin data load failed:', e); }
      }
    } else { state.auth.user = null; state.auth.profile = null; }
    updateUserBadge(); applyRoleUI();
    if (!state.auth.user && state._booted) return showAuthScreen();   // signed out mid-session
  });
  updateUserBadge();
}

// get a live client, reconnecting with the saved or built-in project settings if the first attempt failed
async function ensureSbClient() {
  if (state.sb && state.sb.client) return state.sb.client;
  const sc = sbCfg();
  if (sc && sc.url && sc.key) await sbConnect(sc.url, sc.key, true);
  if (state.sb && state.sb.client) return state.sb.client;
  throw new Error("Can't reach the database" + (state.sb && state.sb.lastError ? ` (${state.sb.lastError})` : '') + '. Check your connection and try again.');
}
async function signInEmail(email, password) {
  const client = await ensureSbClient();
  const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  state.auth.user = data.user; await loadProfile(data.user.id);
  return data.user;
}
async function signOutUser() {
  const client = state.sb && state.sb.client; if (!client) return;
  await client.auth.signOut();
  state.auth.user = null; state.auth.profile = null;
  showAuthScreen();
}

function showAuthScreen(err, mode, info) {
  mode = mode || 'signin';   // 'signin' | 'forgot' | 'setpw'
  let g = $('#gateScreen');
  if (!g) { g = document.createElement('div'); g.id = 'gateScreen'; g.className = 'gate-screen'; document.body.appendChild(g); }
  const logoSrc = (document.querySelector('.brand-logo') || {}).src || '';
  const intro = { signin: '', forgot: "We'll email you a reset link.", setpw: 'Choose a password.' }[mode];
  const fields = mode === 'signin' ? `
        <div class="field"><label for="authEmail">Work email</label><input id="authEmail" type="email" autocomplete="username" required></div>
        <div class="field"><label for="authPw">Password</label><input id="authPw" type="password" autocomplete="current-password" required></div>
        <button type="submit" class="btn btn-filled" id="authSubmit">Sign in</button>`
    : mode === 'forgot' ? `
        <div class="field"><label for="authEmail">Work email</label><input id="authEmail" type="email" autocomplete="username" required></div>
        <button type="submit" class="btn btn-filled" id="authSubmit">Send reset link</button>`
    : `
        <input type="email" autocomplete="username" value="${esc((state.auth.user && state.auth.user.email) || '')}" hidden>
        <div class="field"><label for="authPw">New password</label><input id="authPw" type="password" autocomplete="new-password" required minlength="12"></div>
        <div class="field"><label for="authPw2">Confirm new password</label><input id="authPw2" type="password" autocomplete="new-password" required minlength="12"></div>
        <button type="submit" class="btn btn-filled" id="authSubmit">Save password</button>`;
  const foot = mode === 'signin' ? '<button type="button" class="auth-link" data-authmode="forgot">Forgot password?</button><div>No account? Ask your admin.</div>'
    : mode === 'forgot' ? '<button type="button" class="auth-link" data-authmode="signin">Back to sign in</button>'
    : '<div>12+ characters with upper and lowercase, a number and a symbol</div>';
  g.innerHTML = `<div class="gate-card auth-card">
      <img class="gate-logo" src="${logoSrc}" alt="KIPP">
      <h1>${WS_SEED[WS] ? WS_SEED[WS].title : 'Growth Readiness'}</h1>
      ${intro ? `<p>${intro}</p>` : ''}
      <form id="authForm" autocomplete="on">${fields}</form>
      ${err ? `<div class="gate-err" role="alert">${esc(err)}</div>` : ''}
      ${info ? `<div class="gate-info" role="status">${esc(info)}</div>` : ''}
      <div class="auth-foot">${foot}</div>
    </div>`;
  g.querySelectorAll('[data-authmode]').forEach(b => b.addEventListener('click', () => showAuthScreen(null, b.dataset.authmode)));
  const f = $('#authForm'), sub = $('#authSubmit'), label = sub.textContent;
  f.addEventListener('submit', async e => {
    e.preventDefault();
    sub.disabled = true; sub.textContent = 'One moment…';
    try {
      if (mode === 'forgot') {
        await sendPasswordReset($('#authEmail').value);
        return showAuthScreen(null, 'signin', 'If that email has an account, a reset link is on its way. Check your inbox.');
      }
      if (mode === 'setpw') {
        const pw = $('#authPw').value, pw2 = $('#authPw2').value;
        const missing = PW_RULES.filter(([, ok]) => !ok(pw)).map(([t]) => t.toLowerCase());
        if (missing.length) throw new Error('Your password needs: ' + missing.join(', ') + '.');
        if (pw !== pw2) throw new Error('The two passwords do not match.');
        const client = await ensureSbClient();
        const { error } = await client.auth.updateUser({ password: pw }); if (error) throw error;
        state.auth.needsPassword = false; AUTH_LINK.type = null;
        try { history.replaceState(null, '', location.pathname + '#progress'); } catch (e2) {}
        g.remove(); return enterApp('Password saved');
      }
      await signInEmail($('#authEmail').value, $('#authPw').value);
      g.remove(); enterApp('Signed in');
    } catch (ex) {
      sub.disabled = false; sub.textContent = label;
      const email = $('#authEmail') ? $('#authEmail').value : '';
      showAuthScreen(ex.message || 'Something went wrong. Try again.', mode);
      if (email && $('#authEmail')) { $('#authEmail').value = email; setTimeout(() => { const p = $('#authPw'); if (p) p.focus(); }, 40); }
    }
  });
  setTimeout(() => { const i = $(mode === 'setpw' ? '#authPw' : '#authEmail'); if (i && !i.value) i.focus(); }, 30);
}
function enterApp(msg) { if (!state._booted) { state._booted = true; bootApp(); } else { updateUserBadge(); rerender(); toast(msg, 'ok'); } }
async function sendPasswordReset(email) {
  const client = await ensureSbClient();
  const { error } = await client.auth.resetPasswordForEmail((email || '').trim(), { redirectTo: location.origin + location.pathname });
  if (error) throw error;
}

/* ============================================================
   Level-up polish (Aug 22 2026): avatar palette, greeting,
   personalized My-tasks + inline Activity, rich user chip
   ============================================================ */
const _AVATAR_PAL = ['#0043CE','#6929C4','#005D5D','#9F1853','#8A3800','#0072C3','#198038','#491D8B','#004144','#00539A','#012749','#002D9C'];
function avatarColor(seed) { if (!seed) return '#75778B'; let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0; return _AVATAR_PAL[Math.abs(h) % _AVATAR_PAL.length]; }
function paintAvatars(root) {
  (root || document).querySelectorAll('.owner-avatar:not(.unassigned):not(.painted), .dact-avatar:not(.painted), .cb-user-avatar:not(.painted)').forEach(el => {
    const seed = el.getAttribute('data-seed') || el.textContent || '';
    if (!seed) return;
    el.style.background = avatarColor(seed); el.style.color = '#fff'; el.classList.add('painted');
  });
}
function timeGreeting() { const h = new Date().getHours(); return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
/* ---------- signed-in user -> owner roster ----------
   An account is linked to an owner, in order, by:
   1. its login email matching the owner's roster email
   2. its display name matching the owner name exactly (case, spacing and accents ignored)
   3. KIPP email convention: first initial + last name at a KIPP domain (atatreau@kippteamandfamily.org)
   No partial or last-name-only matching: "Doug Chu" must never pick up "Susie Chu"'s milestones. */
const KIPP_DOMAINS = ['kippteamandfamily.org', 'kippnj.org', 'kippmiami.org'];
function emailConventionMatch(email, owners) {
  const [local, domain] = String(email || '').toLowerCase().split('@');
  if (!local || !KIPP_DOMAINS.includes(domain)) return null;
  const hits = owners.filter(o => { const w = normName(o.name).split(' '); return w.length > 1 && (w[0][0] + w[w.length - 1]) === local.replace(/[^a-z0-9]/g, ''); });
  return hits.length === 1 ? hits[0] : null;   // ambiguous convention match = no match
}
const normName = n => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function myOwner() {
  const owners = meta().owners || [], p = currentProfile();
  if (p) {
    const em = String(p.email || '').toLowerCase();
    return owners.find(o => o.email && o.email.toLowerCase() === em) || owners.find(o => normName(o.name) === normName(p.full_name)) || emailConventionMatch(em, owners);
  }
  const n = normName(lsGet('ngc_author'));   // no-account mode: the name typed on this device
  return n ? owners.find(o => normName(o.name) === n) || null : null;
}
function myOwnerName() { const o = myOwner(); return o ? o.name : ''; }
// "Mine" scope = the owners filter set to just me; remembered per account on this device
function mineKey() { const p = currentProfile(); return 'ngc_mine_' + (p ? p.id : 'local'); }
function mineOn() { const me = myOwnerName(); return !!me && state.filters.owners.size === 1 && state.filters.owners.has(me); }
function setMine(on) {
  const me = myOwnerName(); if (!me) return;
  state.filters.owners.clear(); if (on) state.filters.owners.add(me);
  lsSet(mineKey(), on ? '1' : '0');
}
// first load for an account: owners with open milestones start on "Mine"; admins start on everything
function applyMyDefaults() {
  const me = myOwnerName(); if (!me) return;
  const saved = lsGet(mineKey());
  const on = saved != null ? saved === '1' : (!isAdmin() && M().some(m => ownsM(m, me) && effectiveStatus(m) !== 'complete'));
  if (on) setMine(true);
}
function currentDisplayName() { const p = currentProfile(); return (p && (p.full_name || p.email)) || lsGet('ngc_author') || ''; }

function updateUserBadge() {
  applyRoleUI();
  const btn = $('#cbUser'); if (!btn) return;
  const p = currentProfile();
  const name = (p && (p.full_name || p.email)) || lsGet('ngc_author') || '';
  const inits = initials(name) || '?';
  const role = p ? (p.role || 'viewer') : (name ? 'guest' : '');
  const email = (p && p.email) || '';
  // Sidebar profile card (Weihu-style): avatar + name + email + chevron.
  btn.innerHTML = `<span class="sp-avatar cb-user-avatar" data-seed="${esc(name || 'anon')}">${esc(inits)}</span>
    <span class="sp-info">
      <b class="sp-name">${esc(name || 'Sign in')}</b>
      <small class="sp-sub">${esc(email || role || 'Set your name')}</small>
    </span>
    <svg class="sp-chev" viewBox="0 0 32 32" fill="currentColor" width="16" height="16" aria-hidden="true"><path d="M22 16L12 26 10.6 24.6 19.2 16 10.6 7.4 12 6z"/></svg>`;
  btn.title = name ? `${name} · ${role}` : 'Set your name';
  if (p) btn.dataset.authed = '1'; else delete btn.dataset.authed;
  paintAvatars(btn);
  // Mirror onto the floating pill's avatar (colored directly - it persists
  // across renders, so we can't rely on paintAvatars' one-shot .painted guard).
  const pill = $('#cbPillUser');
  if (pill) {
    pill.textContent = inits;
    pill.style.background = avatarColor(name || 'anon');
    pill.title = name ? `${name} · ${role}` : 'Set your name';
    if (p) pill.dataset.authed = '1'; else delete pill.dataset.authed;
  }
  updateGreeting();
}

/* Top-bar greeting: "Good evening, Aden" + today's date. Runs on user
   change and view switch. Redundant dashboard banner is removed. */
function updateGreeting() {
  const line = $('#cbGreetLine'), dateEl = $('#cbGreetDate');
  if (!line || !dateEl) return;
  const v = state.view;
  // Per-page heading: the greeting lives on the Dashboard (where it sets the
  // day's tone); other pages get a clear title + a live count that earns the space.
  if (v === 'timeline') {
    dateEl.textContent = '';
    line.innerHTML = `<b>Openings</b>`;
  } else if (v === 'plan') {
    dateEl.textContent = '';
    line.innerHTML = `<b>Milestones</b>`;
  } else {
    const first = (currentDisplayName() || '').split(/\s+/)[0];
    const fq = fiscalQuarter();
    dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    line.innerHTML = first ? `${esc(timeGreeting())}, <b>${esc(first)}</b>` : `<b>Dashboard</b>`;
  }
}

function openUserMenu(anchor) {
  const p = currentProfile(); if (!p) return;
  closePopover();
  const html = `<div class="user-menu">
      <div class="um-head"><div class="um-name">${esc(p.full_name || p.email)}</div><div class="um-email">${esc(p.email || '')}</div><div class="um-role">Role: <b>${esc(p.role || 'viewer')}</b></div>
        ${myOwner() ? `<div class="um-role">Owner: <b>${esc(myOwner().name)}</b>${myOwner().role ? ` · ${esc(myOwner().role)}` : ''}</div>` : `<div class="um-unlinked">Ask an admin to link you to an owner</div>`}</div>
      <div class="um-actions">
        <button class="um-item" id="umCalendar">Add deadlines to Outlook</button>
        <button class="um-item" id="umPassword">Change password</button>
        <button class="um-item" id="umSignOut">Sign out</button>
      </div>
    </div>`;
  const pop = openPopover(anchor, html);
  pop.querySelector('#umSignOut').addEventListener('click', () => { closePopover(); signOutUser(); });
  pop.querySelector('#umPassword').addEventListener('click', () => { closePopover(); openPasswordDialog(); });
  pop.querySelector('#umCalendar').addEventListener('click', () => { closePopover(); openCalendarSheet(); });
}

/* ---------- change password (Supabase Auth) ----------
   Confirms the current password first, then saves the new one with auth.updateUser.
   Rules match the Supabase password policy in AUTH-SETUP.md (12+ chars, upper, lower, number, symbol). */
const PW_RULES = [
  ['At least 12 characters', p => p.length >= 12],
  ['An uppercase letter', p => /[A-Z]/.test(p)],
  ['A lowercase letter', p => /[a-z]/.test(p)],
  ['A number', p => /[0-9]/.test(p)],
  ['A symbol', p => /[^A-Za-z0-9]/.test(p)]
];
function openPasswordDialog() {
  const client = state.sb && state.sb.client, user = state.auth && state.auth.user;
  if (!client || !user) return toast('Sign in to change your password', 'err');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop open'; wrap.id = 'pwBackdrop';
  wrap.innerHTML = `<div class="modal pw-modal" role="dialog" aria-modal="true" aria-labelledby="pwTitle">
    <div class="modal-head"><h3 id="pwTitle">Change password</h3><button class="icon-btn" data-pwclose aria-label="Close"><svg viewBox="0 0 32 32" fill="currentColor" width="20" height="20"><path d="M17.4141 16L24 9.4141 22.5859 8 16 14.5859 9.4143 8 8 9.4141 14.5859 16 8 22.5859 9.4143 24 16 17.4141 22.5859 24 24 22.5859 17.4141 16z"/></svg></button></div>
    <form class="modal-body" id="pwForm" novalidate>
      <input type="email" autocomplete="username" value="${esc(user.email || '')}" hidden>
      <div class="field"><label for="pwCur">Current password</label><input id="pwCur" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="pwNew">New password</label><input id="pwNew" type="password" autocomplete="new-password" required></div>
      <ul class="pw-rules">${PW_RULES.map(([l], i) => `<li data-rule="${i}">${l}</li>`).join('')}<li data-rule="diff">Different from your current password</li></ul>
      <div class="field"><label for="pwNew2">Confirm new password</label><input id="pwNew2" type="password" autocomplete="new-password" required></div>
      <label class="field-check"><input type="checkbox" id="pwShow"> Show passwords</label>
      <div id="pwMsg" role="alert"></div>
    </form>
    <div class="modal-foot"><span></span><div style="display:flex;gap:8px"><button class="btn btn-text" data-pwclose>Cancel</button><button class="btn btn-filled" id="pwSave" type="submit" form="pwForm">Update password</button></div></div>
  </div>`;
  document.body.appendChild(wrap);
  const cur = $('#pwCur', wrap), nw = $('#pwNew', wrap), nw2 = $('#pwNew2', wrap), msg = $('#pwMsg', wrap), btn = $('#pwSave', wrap);
  const close = () => { document.removeEventListener('keydown', onKey, true); wrap.remove(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-pwclose]')) close(); });
  const say = (text, tone) => { msg.className = text ? 'status-note ' + tone : ''; msg.textContent = text || ''; };
  const paint = () => {
    const p = nw.value;
    PW_RULES.forEach(([, test], i) => $(`[data-rule="${i}"]`, wrap).classList.toggle('ok', test(p)));
    $('[data-rule="diff"]', wrap).classList.toggle('ok', !!p && p !== cur.value);
  };
  [cur, nw].forEach(i => i.addEventListener('input', paint));
  $('#pwShow', wrap).addEventListener('change', e => [cur, nw, nw2].forEach(i => { i.type = e.target.checked ? 'text' : 'password'; }));
  $('#pwForm', wrap).addEventListener('submit', async e => {
    e.preventDefault(); say('');
    const p = nw.value;
    if (!cur.value) return say('Enter your current password.', 'err');
    const miss = PW_RULES.filter(([, test]) => !test(p)).map(([l]) => l.toLowerCase());
    if (miss.length) return say('New password needs: ' + miss.join(', ') + '.', 'err');
    if (p === cur.value) return say('New password must be different from your current password.', 'err');
    if (p !== nw2.value) return say("The new passwords don't match.", 'err');
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      // confirm it's really them; the flag stops the auth listener from reloading the board on this re-sign-in
      state.auth.reauth = true;
      const chk = await client.auth.signInWithPassword({ email: user.email, password: cur.value });
      if (chk.error) throw Object.assign(new Error('Your current password is incorrect.'), { friendly: true });
      const { error } = await client.auth.updateUser({ password: p });
      if (error) throw error;
      logActivity('edit', 'Changed account password', {});
      close(); toast('Password updated', 'ok');
    } catch (err) {
      const m = String((err && err.message) || '');
      say(err.friendly ? m : /different from the old/i.test(m) ? 'New password must be different from your current password.'
        : /weak|should contain|at least/i.test(m) ? 'Supabase rejected that password as too weak: ' + m
        : 'Could not update your password: ' + (m || 'unknown error') + '. Please try again.', 'err');
      btn.disabled = false; btn.textContent = 'Update password';
    } finally { state.auth.reauth = false; }
  });
  paint(); cur.focus();
}

async function gateStart() {
  const sc = sbCfg();
  if (!sc || !sc.url || !sc.key) return showAuthConfigNeeded();
  if (!state.sb.connected) await sbConnect(sc.url, sc.key, true);
  if (!state.sb.connected) return showAuthScreen("Can't reach the database right now. Check your connection, then reload the page.");
  // Arrived from an invite or password-reset email: set a password before entering.
  if (state.auth.user && (state.auth.needsPassword || AUTH_LINK.type)) return showAuthScreen(null, 'setpw');
  if (state.auth.user) { state._booted = true; return bootApp(); }
  return showAuthScreen(AUTH_LINK.error);
}
function showAuthConfigNeeded() {
  let g = $('#gateScreen');
  if (!g) { g = document.createElement('div'); g.id = 'gateScreen'; g.className = 'gate-screen'; document.body.appendChild(g); }
  g.innerHTML = `<div class="gate-card auth-card">
      <img class="gate-logo" src="${(document.querySelector('.brand-logo') || {}).src || ''}" alt="KIPP">
      <h1>Setup needed</h1>
      <p>The database connection is missing. Contact the Growth Hub admin.</p>
    </div>`;
}

/* ============================================================
   UNDO STACK - snapshot before each mutation, Cmd+Z to restore
   ============================================================ */
const undoStack = [];
const UNDO_LIMIT = 30;
function snapshotForUndo(label) {
  // Only milestones and schools: shared settings are never rolled back by Undo.
  undoStack.push({ label, snapshot: { milestones: clone(M()), schools: clone(S()) }, ts: Date.now() });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}
function undo() {
  if (!undoStack.length) { toast('Nothing to undo'); return; }
  if (!guardEdit()) return;
  const entry = undoStack.pop();
  // Teammates' changes are copied into every snapshot as they arrive (applyRemoteToUndo),
  // so restoring it reverses only this person's own edits, and only the changed fields are saved.
  state.data.milestones = entry.snapshot.milestones;
  state.data.schools = entry.snapshot.schools;
  autosave();
  rerender();
  toast(`Undone: ${entry.label}`, 'ok');
  logActivity('undo', entry.label);
}

/* ============================================================
   ACTIVITY LOG - local change journal (what changed, when)
   ============================================================ */
function getActivityLog() { try { return JSON.parse(lsGet('ngc_activity') || '[]'); } catch (e) { return []; } }

/* ---- Team activity source ----
   In individual-accounts mode we read the SERVER audit log (growth_audit_v),
   so the feed shows every teammate's changes with their real profile name -
   not just what happened in this browser. Falls back to the local log when
   not in account mode or not connected. */
function activityIsTeam() { return authModeOn() && state.sb && state.sb.connected && Array.isArray(state.auditFeed); }
async function sbFetchAudit(limit) {
  if (!(authModeOn() && state.sb && state.sb.connected && state.sb.client)) return null;
  try {
    const { data, error } = await state.sb.client
      .from('growth_audit_v')
      .select('id,ts,action,entity_type,entity_id,actor_name,actor_email')
      .order('ts', { ascending: false })
      .limit(limit || 50);
    if (error) throw error;
    state.auditFeed = (data || []).filter(a => !(a.entity_type === 'milestone' && wsOtherIds.has(a.entity_id))
      && !(a.entity_type === 'growth_settings' && !settingsIdHere(String(a.entity_id || ''))));
    return state.auditFeed;
  } catch (e) { console.warn('Team activity (audit) fetch failed - using local log:', e.message || e); return null; }
}
function auditDetail(a) {
  const v = a.action === 'insert' ? 'Created' : a.action === 'delete' ? 'Deleted' : 'Updated';
  if (a.entity_type === 'milestone') { const m = findM(a.entity_id); return `${v} ${m ? '"' + m.activity + '"' : 'a milestone'}`; }
  if (a.entity_type === 'school') { const s = schoolById(a.entity_id); return `${v} ${s ? esc(s.display_label) + ' (' + esc(s.market) + ')' : 'a school'}`; }
  if (a.entity_type === 'growth_settings') return `${v} shared settings (${esc(a.entity_id)})`;
  return `${v} ${esc(a.entity_type || 'record')}`;
}
// Unified, newest-first entries: { author, action, detail, ts, itemId }
function activityEntries(limit) {
  const n = limit || 8;
  if (activityIsTeam()) {
    return state.auditFeed.slice(0, n).map(a => ({
      author: a.actor_name || a.actor_email || '',
      action: a.action === 'insert' ? 'create' : a.action === 'delete' ? 'delete' : 'edit',
      detail: auditDetail(a),
      ts: new Date(a.ts).getTime(),
      itemId: a.entity_type === 'milestone' ? a.entity_id : null
    }));
  }
  return getActivityLog().slice().reverse().slice(0, n).map(e => ({ author: e.author, action: e.action, detail: e.detail, ts: e.ts, itemId: e.extra && e.extra.itemId }));
}
// Refetch the server audit (account mode) then repaint the activity panel + dashboard card.
function refreshActivityViews() {
  const done = () => { renderActivityPanel(); if (state.view === 'progress' && $('#viewBody') && !$('#modalBackdrop').classList.contains('open')) refreshBody(); };
  if (authModeOn() && state.sb && state.sb.connected) sbFetchAudit(50).then(done); else done();
}
function logActivity(action, detail, extra) {
  const log = getActivityLog();
  // Attribute to the signed-in identity: Supabase profile name/email in account
  // mode, else the display name the user set on their chip ("Set your name").
  // If nothing is set yet (password mode), ask once per session so the very first
  // change is still attributed instead of showing up as "Someone".
  if (!authModeOn() && !lsGet('ngc_author') && !state._askedAuthor) {
    state._askedAuthor = true;
    nameDialog('', n => { lsSet('ngc_author', n); if (typeof updateUserBadge === 'function') updateUserBadge(); });
  }
  const author = (typeof currentDisplayName === 'function' ? currentDisplayName() : '') || lsGet('ngc_author') || '';
  log.push({ action, detail, author, ts: Date.now(), extra: extra || null });
  if (log.length > 100) log.splice(0, log.length - 100);
  try { lsSet('ngc_activity', JSON.stringify(log)); } catch (e) {}
  renderActivityPanel();
  updateActivityDot();
}
function updateActivityDot() {
  const seen = Number(lsGet('ngc_activity_seen') || 0), me = currentDisplayName() || '';
  const unseen = activityEntries(50).some(e => e.ts > seen && e.author !== me);
  const dot = $('#cbActivityDot'); if (dot) dot.hidden = !unseen;
  const pillDot = $('#cbPillDot'); if (pillDot) pillDot.hidden = !unseen;
}

/* ---------- Floating filter bubble: opens the real filter bar as a panel ---------- */
function updateFilterBubble() {
  renderCtxBar(); renderMasthead(); renderNavCounts();
  const btn = $('#cbPillFilter'); if (!btn) return;
  const n = activeCount();
  const badge = $('#cbPillFilterCount');
  if (badge) { badge.textContent = n; badge.hidden = !n; }
  btn.classList.toggle('on', document.body.classList.contains('filters-open') || n > 0);
}
function closeFilterPanel() {
  if (!document.body.classList.contains('filters-open')) return;
  document.body.classList.remove('filters-open');
  document.removeEventListener('mousedown', filterPanelOutside, true);
  updateFilterBubble();
}
function filterPanelOutside(e) {
  // Keep open while interacting with the panel, the bubble, or a filter menu popover.
  if (e.target.closest('#filterbar') || e.target.closest('#cbPillFilter') || e.target.closest('.popover')) return;
  closeFilterPanel();
}
function toggleFilterPanel() {
  const open = document.body.classList.toggle('filters-open');
  if (open) {
    closePopover();
    setTimeout(() => document.addEventListener('mousedown', filterPanelOutside, true), 0);
  } else {
    document.removeEventListener('mousedown', filterPanelOutside, true);
  }
  updateFilterBubble();
}
/* Material-style single-color glyphs (outlined, 1.75 stroke, 14px). */
function activityIcon(action) {
  const paths = {
    edit:   '<path d="M2 26H30V28H2zM25.4 9c.8-.8.8-2 0-2.8 0 0 0 0 0 0l-3.6-3.6c-.8-.8-2-.8-2.8 0 0 0 0 0 0 0l-15 15V24h6.4L25.4 9zM20.4 4L24 7.6l-3 3L17.4 7 20.4 4zM6 22v-3.6l10-10 3.6 3.6-10 10H6z"/>',
    create: '<path d="M17 15L17 8 15 8 15 15 8 15 8 17 15 17 15 24 17 24 17 17 24 17 24 15z"/>',
    delete: '<path d="M12 12H14V24H12zM18 12H20V24H18z"/><path d="M4 6V8H6V28a2 2 0 002 2H24a2 2 0 002-2V8h2V6zM8 28V8H24V28zM12 2H20V4H12z"/>',
    status: '<path d="M12 10H6.78A11 11 0 0127 16h2A13 13 0 006 7.68V4H4v8h8zM20 22h5.22A11 11 0 015 16H3a13 13 0 0023 8.32V28h2V20H20z"/>',
    undo:   '<path d="M20,10H7.8149l3.5874-3.5859L10,5,4,11,10,17l1.4023-1.4146L7.8179,12H20a6,6,0,0,1,0,12H12v2h8a8,8,0,0,0,0-16Z"/>',
    move:   '<path d="M18 6L16.57 7.393 24.15 15 4 15 4 17 24.15 17 16.57 24.573 18 26 28 16 18 6z"/>'
  };
  const p = paths[action] || '<circle cx="16" cy="16" r="10"/><path d="M16,30A14,14,0,1,1,30,16,14.0158,14.0158,0,0,1,16,30ZM16,4A12,12,0,1,0,28,16,12.0137,12.0137,0,0,0,16,4Z"/>';
  return `<svg class="act-ic" viewBox="0 0 32 32" fill="currentColor" width="14" height="14" aria-hidden="true">${p}</svg>`;
}
function renderActivityPanel() {
  const body = $('#activityBody'); if (!body) return;
  const log = activityEntries(50);
  const scope = activityIsTeam() ? '<div class="activity-scope">Team-wide · all signed-in members</div>' : '';
  if (!log.length) { body.innerHTML = scope + '<div class="activity-empty">No activity yet</div>'; return; }
  body.innerHTML = scope + log.map(e => {
    const when = fmtWhen(e.ts);
    const who = e.author ? `<b>${esc(e.author)}</b> · ` : '';
    const stillExists = e.itemId && findM(e.itemId);
    const cls = stillExists ? 'activity-item activity-clickable' : 'activity-item';
    const attr = stillExists ? ` data-openitem="${esc(e.itemId)}" title="Open this milestone"` : '';
    return `<div class="${cls}"${attr}><span class="activity-ic">${activityIcon(e.action)}</span><div class="activity-detail">${who}<span class="activity-what">${esc(e.detail)}</span><span class="activity-when">${esc(when)}</span></div></div>`;
  }).join('');
  body.onclick = ev => { const it = ev.target.closest('[data-openitem]'); if (it) openModal(it.dataset.openitem); };
}
function toggleActivity() {
  const panel = $('#activityPanel'); if (!panel) return;
  const opening = !panel.classList.contains('open');
  panel.classList.toggle('open');
  renderActivityPanel();
  // In account mode, pull the latest team-wide audit so the panel is fresh on open.
  if (opening && authModeOn() && state.sb && state.sb.connected) sbFetchAudit(50).then(renderActivityPanel);
  if (opening) { try { lsSet('ngc_activity_seen', String(Date.now())); } catch (e) {} updateActivityDot(); }
}

/* ============================================================
   COMMAND PALETTE - Cmd+K to search tasks, jump views, run actions
   ============================================================ */
let cmdkIdx = 0, cmdkItems = [];
function openCmdk() {
  const bg = $('#cmdkBackdrop'); bg.classList.remove('hide');
  const inp = $('#cmdkInput'); inp.value = ''; inp.focus();
  cmdkIdx = 0;
  renderCmdkResults('');
}
function closeCmdk() { $('#cmdkBackdrop').classList.add('hide'); }
function renderCmdkResults(q) {
  const body = $('#cmdkBody');
  cmdkItems = buildCmdkItems(q).filter(x => !x.hide);
  if (cmdkIdx >= cmdkItems.length) cmdkIdx = 0;
  body.innerHTML = cmdkItems.map((item, i) => `<div class="cmdk-item ${i === cmdkIdx ? 'active' : ''}" data-cmdk="${i}"><span class="cmdk-ic">${item.icon}</span><div class="cmdk-label"><span class="cmdk-name">${esc(item.name)}</span>${item.hint ? `<span class="cmdk-hint">${esc(item.hint)}</span>` : ''}</div>${item.kbd ? `<kbd class="cmdk-kbd">${item.kbd}</kbd>` : ''}</div>`).join('') || '<div class="cmdk-empty">No results</div>';
}
function buildCmdkItems(q) {
  // Uniform Material outlined SVG icons (1.75 stroke, 18px). No emojis.
  const ic = (p) => `<svg viewBox="0 0 32 32" fill="currentColor" width="18" height="18">${p}</svg>`;
  const items = [];
  items.push({ icon: ic('<path d="M24 21H26V26H24zM20 16H22V26H20zM11 26a5.0059 5.0059 0 01-5-5H8a3 3 0 103-3V16a5 5 0 010 10z"/><path d="M28,2H4A2.002,2.002,0,0,0,2,4V28a2.0023,2.0023,0,0,0,2,2H28a2.0027,2.0027,0,0,0,2-2V4A2.0023,2.0023,0,0,0,28,2Zm0,9H14V4H28ZM12,4v7H4V4ZM4,28V13H28.0007l.0013,15Z"/>'), name: 'Go to Dashboard', hint: '', kbd: '', action: () => setView('progress') });
  items.push({ icon: ic('<path d="M24 4H26V28H24zM18 6V26H14V6h4m0-2H14a2 2 0 00-2 2V26a2 2 0 002 2h4a2 2 0 002-2V6a2 2 0 00-2-2zM6 4H8V28H6z"/>'), name: 'Go to Milestones', hint: '', kbd: '', action: () => setView('plan') });
  items.push({ icon: ic('<path d="M26,4h-4V2h-2v2h-8V2h-2v2H6C4.9,4,4,4.9,4,6v20c0,1.1,0.9,2,2,2h20c1.1,0,2-0.9,2-2V6C28,4.9,27.1,4,26,4z M26,26H6V12h20	V26z M26,10H6V6h4v2h2V6h8v2h2V6h4V10z"/>'), name: 'Go to Openings', hide: !hasSchoolWork(), hint: '', kbd: '', action: () => setView('timeline') });
  items.push({ icon: ic('<path d="M17 15L17 8 15 8 15 15 8 15 8 17 15 17 15 24 17 24 17 17 24 17 24 15z"/>'), name: 'New milestone', hint: '', kbd: 'N', action: () => addItem() });
  items.push({ icon: ic('<path d="M16.6123,2.2138a1.01,1.01,0,0,0-1.2427,0L1,13.4194l1.2427,1.5717L4,13.6209V26a2.0041,2.0041,0,0,0,2,2H26a2.0037,2.0037,0,0,0,2-2V13.63L29.7573,15,31,13.4282ZM18,26H14V18h4Zm2,0V18a2.0023,2.0023,0,0,0-2-2H14a2.002,2.002,0,0,0-2,2v8H6V12.0615l10-7.79,10,7.8005V26Z"/>'), name: 'Add school opening', hide: !hasSchoolWork(), hint: '', kbd: '', action: () => openSchoolModal(null) });
  items.push({ icon: ic('<path d="M20,10H7.8149l3.5874-3.5859L10,5,4,11,10,17l1.4023-1.4146L7.8179,12H20a6,6,0,0,1,0,12H12v2h8a8,8,0,0,0,0-16Z"/>'), name: 'Undo last change', hint: undoStack.length ? undoStack[undoStack.length - 1].label : 'nothing to undo', kbd: '⌘Z', action: () => undo() });
  items.push({ icon: ic('<path d="M28,9H25V3H7V9H4a2,2,0,0,0-2,2V21a2,2,0,0,0,2,2H7v6H25V23h3a2,2,0,0,0,2-2V11A2,2,0,0,0,28,9ZM9,5H23V9H9ZM23,27H9V17H23Zm5-6H25V15H7v6H4V11H28Z"/>'), name: 'Print report', hint: 'Dashboard', kbd: '', action: () => { setView('progress'); setTimeout(() => window.print(), 400); } });
  items.push({ icon: ic('<path d="M16 22H30V24H16zM14 19.4L12.6 18 6 24.6 3.4 22 2 23.4 6 27.4zM16 8H30V10H16zM14 5.4L12.6 4 6 10.6 3.4 8 2 9.4 6 13.4z"/>'), name: 'Check in on my milestones', hint: 'Forecast', kbd: '', action: () => openCheckins() });
  items.push({ icon: ic('<circle cx="7" cy="9" r="3"/><circle cx="7" cy="23" r="3"/><path d="M16 22H30V24H16zM16 8H30V10H16z"/>'), name: 'Meeting agenda', hint: 'What changed, off track, missing updates', kbd: '', action: () => openAgenda() });
  items.push({ icon: ic('<path d="M26,4h-4V2h-2v2h-8V2h-2v2H6C4.9,4,4,4.9,4,6v20c0,1.1,0.9,2,2,2h20c1.1,0,2-0.9,2-2V6C28,4.9,27.1,4,26,4z M26,26H6V12h20	V26z M26,10H6V6h4v2h2V6h8v2h2V6h4V10z"/>'), name: 'Add deadlines to Outlook', hint: 'Calendar', kbd: '', action: () => openCalendarSheet() });
  items.push({ icon: ic('<path d="M26 24v4H6V24H4v4H4a2 2 0 002 2H26a2 2 0 002-2h0V24zM26 14L24.59 12.59 17 20.17 17 2 15 2 15 20.17 7.41 12.59 6 14 16 24 26 14z"/>'), name: 'Export milestones (CSV)', hint: 'Current filters', kbd: '', action: () => exportCsv() });
  items.push({ icon: ic('<path d="M27,16.76c0-.25,0-.5,0-.76s0-.51,0-.77l1.92-1.68A2,2,0,0,0,29.3,11L26.94,7a2,2,0,0,0-1.73-1,2,2,0,0,0-.64.1l-2.43.82a11.35,11.35,0,0,0-1.31-.75l-.51-2.52a2,2,0,0,0-2-1.61H13.64a2,2,0,0,0-2,1.61l-.51,2.52a11.48,11.48,0,0,0-1.32.75L7.43,6.06A2,2,0,0,0,6.79,6,2,2,0,0,0,5.06,7L2.7,11a2,2,0,0,0,.41,2.51L5,15.24c0,.25,0,.5,0,.76s0,.51,0,.77L3.11,18.45A2,2,0,0,0,2.7,21L5.06,25a2,2,0,0,0,1.73,1,2,2,0,0,0,.64-.1l2.43-.82a11.35,11.35,0,0,0,1.31.75l.51,2.52a2,2,0,0,0,2,1.61h4.72a2,2,0,0,0,2-1.61l.51-2.52a11.48,11.48,0,0,0,1.32-.75l2.42.82a2,2,0,0,0,.64.1,2,2,0,0,0,1.73-1L29.3,21a2,2,0,0,0-.41-2.51ZM25.21,24l-3.43-1.16a8.86,8.86,0,0,1-2.71,1.57L18.36,28H13.64l-.71-3.55a9.36,9.36,0,0,1-2.7-1.57L6.79,24,4.43,20l2.72-2.4a8.9,8.9,0,0,1,0-3.13L4.43,12,6.79,8l3.43,1.16a8.86,8.86,0,0,1,2.71-1.57L13.64,4h4.72l.71,3.55a9.36,9.36,0,0,1,2.7,1.57L25.21,8,27.57,12l-2.72,2.4a8.9,8.9,0,0,1,0,3.13L27.57,20Z"/><path d="M16,22a6,6,0,1,1,6-6A5.94,5.94,0,0,1,16,22Zm0-10a3.91,3.91,0,0,0-4,4,3.91,3.91,0,0,0,4,4,3.91,3.91,0,0,0,4-4A3.91,3.91,0,0,0,16,12Z"/>'), name: 'Open settings', hint: '', kbd: '', action: () => { const s = $('#settingsBtn'); if (s) s.click(); } });
  items.push({ icon: ic('<path d="M28.7071,19.293,26,16.5859V13a10.0136,10.0136,0,0,0-9-9.9492V1H15V3.0508A10.0136,10.0136,0,0,0,6,13v3.5859L3.2929,19.293A1,1,0,0,0,3,20v3a1,1,0,0,0,1,1h7v.7768a5.152,5.152,0,0,0,4.5,5.1987A5.0057,5.0057,0,0,0,21,25V24h7a1,1,0,0,0,1-1V20A1,1,0,0,0,28.7071,19.293ZM19,25a3,3,0,0,1-6,0V24h6Zm8-3H5V20.4141L7.707,17.707A1,1,0,0,0,8,17V13a8,8,0,0,1,16,0v4a1,1,0,0,0,.293.707L27,20.4141Z"/>'), name: 'Activity log', hint: '', kbd: '⌃⇧A', action: () => toggleActivity() });

  // Nav/action commands filter on the query text; search results are matched separately.
  const ql = (q || '').toLowerCase();
  const nav = !q ? items : items.filter(it => it.name.toLowerCase().includes(ql) || (it.hint || '').toLowerCase().includes(ql));
  if (ql.length < 2 || !state.data) return nav;

  // ---- Universal search: milestones, school openings, and owners ----
  const results = [];
  const mIc = ic('<path d="M16,30A14,14,0,1,1,30,16,14,14,0,0,1,16,30ZM16,4A12,12,0,1,0,28,16,12,12,0,0,0,16,4Z"/><path d="M20.59 22L15 16.41 15 7 17 7 17 15.58 22 20.59 20.59 22z"/>');
  const sIc = ic('<path d="M16.6123,2.2138a1.01,1.01,0,0,0-1.2427,0L1,13.4194l1.2427,1.5717L4,13.6209V26a2.0041,2.0041,0,0,0,2,2H26a2.0037,2.0037,0,0,0,2-2V13.63L29.7573,15,31,13.4282ZM18,26H14V18h4Zm2,0V18a2.0023,2.0023,0,0,0-2-2H14a2.002,2.002,0,0,0-2,2v8H6V12.0615l10-7.79,10,7.8005V26Z"/>');
  const oIc = ic('<path d="M16 4a5 5 0 11-5 5 5 5 0 015-5m0-2a7 7 0 107 7A7 7 0 0016 2zM26 30H24V25a5 5 0 00-5-5H13a5 5 0 00-5 5v5H6V25a7 7 0 017-7h6a7 7 0 017 7z"/>');
  const mils = (state.data.milestones ? M() : []);
  const words = ql.split(/\s+/).filter(Boolean), hit = txt => { const t = txt.toLowerCase(); return words.every(w => t.includes(w)); };
  (state.data.schools || []).filter(s => hit(`${s.display_label || ''} ${s.code || ''} ${s.market || ''} ${s.state || ''} fall ${s.openingFY - 1} ${fyLabel(s.openingFY)}`))
    .slice(0, 4).forEach(s => results.push({ icon: sIc, name: `${s.market} ${s.display_label}`, hint: `School opening · Fall ${s.openingFY - 1}`, kbd: '', action: () => openSchoolModal(s.id) }));
  mils.filter(m => hit(`${m.activity} ${ownersOf(m).join(' ')} ${m.market} ${m.functional_area} ${m.workstream || ''} ${(m.tags || []).join(' ')} ${m.notes || ''}`))
    .slice(0, 8).forEach(m => results.push({ icon: mIc, name: m.activity, hint: `${m.market || 'Network'} · ${m.functional_area}${m.due_date ? ' · Due ' + fmtDate(m.due_date) : ''}${ownersOf(m).length ? ' · ' + ownersOf(m).join(' / ') : ''}`, kbd: '', action: () => openModal(m.id) }));
  [...new Set(mils.flatMap(ownersOf))].filter(o => o.toLowerCase().includes(ql)).slice(0, 5).forEach(o => {
    const n = mils.filter(m => ownsM(m, o)).length;
    results.push({ icon: oIc, name: o, hint: `Owner · ${n} milestone${n === 1 ? '' : 's'}`, kbd: '', action: () => { clearFilters(); state.filters.search = o; const cb = $('#cbSearch'); if (cb) cb.value = o; setView('plan'); } });
  });
  return [...nav, ...results];
}
function execCmdk() {
  if (cmdkItems[cmdkIdx]) { cmdkItems[cmdkIdx].action(); closeCmdk(); }
}
function wireCmdk() {
  const bg = $('#cmdkBackdrop'), inp = $('#cmdkInput');
  bg.addEventListener('click', e => { if (e.target === bg) closeCmdk(); });
  bg.addEventListener('mousedown', e => { const item = e.target.closest('[data-cmdk]'); if (item) { cmdkIdx = +item.dataset.cmdk; execCmdk(); } });
  inp.addEventListener('input', () => renderCmdkResults(inp.value));
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkIdx = Math.min(cmdkIdx + 1, cmdkItems.length - 1); renderCmdkResults(inp.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkIdx = Math.max(cmdkIdx - 1, 0); renderCmdkResults(inp.value); }
    else if (e.key === 'Enter') { e.preventDefault(); execCmdk(); }
    else if (e.key === 'Escape') { closeCmdk(); }
  });
}

/* ============================================================
   KEYBOARD SHORTCUTS
   ============================================================ */
function wireKeyboard() {
  document.addEventListener('keydown', e => {
    const inInput = (e.target.matches ? e.target.matches('input, textarea, select, [contenteditable]') : false);
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openCmdk(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { if (!inInput) { e.preventDefault(); undo(); } return; }
    if (e.ctrlKey && e.shiftKey && e.key === 'A') { e.preventDefault(); toggleActivity(); return; }
    if (inInput) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); addItem(); return; }
    if (e.key === '1') { setView('progress'); return; }
    if (e.key === '2') { setView('timeline'); return; }
    if (e.key === '3') { setView('plan'); return; }
    if (e.key === '/') { e.preventDefault(); openCmdk(); return; }
    if (e.key === '?') { e.preventDefault(); openCmdk(); return; }
  });
}

/* ============================================================
   ENHANCED SAVE - hooks into autosave for undo + activity logging
   ============================================================ */
const _origAutosave = autosave;
let _lastSaveLabel = '';

function flagEmpty(el) { if (!el) return; el.setAttribute('aria-invalid', 'true'); el.focus(); el.addEventListener('input', () => el.removeAttribute('aria-invalid'), { once: true }); }
function markInvalid(el, msg) {   // Carbon invalid state: red outline and a message under the field
  if (!el) return; el.setAttribute('aria-invalid', 'true'); el.focus();
  const wrap = el.closest('.field') || el.parentElement; let m = wrap.querySelector('.field-err');
  if (!m) { m = document.createElement('div'); m.className = 'field-err'; m.id = (el.id || 'fld') + 'Err'; m.setAttribute('role', 'alert'); wrap.appendChild(m); el.setAttribute('aria-describedby', m.id); }
  m.textContent = msg;
  el.addEventListener('input', () => { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); m.remove(); }, { once: true });
}
function syncNavTitles() {   // labels are visible when the nav is open, so tooltips only help on the collapsed rail
  const rail = document.body.classList.contains('nav-collapsed');
  document.querySelectorAll('.nav-tab, .app-header .ws-home, #settingsBtn').forEach(el => { const t = (el.querySelector('span') || el).textContent.trim(); if (rail) el.title = t; else el.removeAttribute('title'); });
}
function initDialogFocus() {   // focus moves into a dialog, Tab stays inside it, and focus returns on close
  const SEL = ['#confirmBackdrop .confirm-box', '.sheet-backdrop .sheet', '#cmdkBackdrop:not(.hide) .cmdk', '.modal-backdrop.open .modal', '#drawer.open'];
  const top = () => { for (const s of SEL) { const all = document.querySelectorAll(s); if (all.length) return all[all.length - 1]; } return null; };
  const items = r => [...r.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])')].filter(e => e.offsetParent !== null);
  let cur = null, ret = null, t = 0;
  const sync = () => {
    const d = top(); if (d === cur) return;
    if (d && !cur) ret = document.activeElement;
    cur = d;
    if (d) {
      if (d.contains(document.activeElement)) return;
      const first = matchMedia('(pointer: coarse)').matches ? null : (items(d).find(e => e.matches('input, select, textarea')) || items(d)[0]);
      if (first) first.focus({ preventScroll: true }); else { d.tabIndex = -1; d.focus({ preventScroll: true }); }
    } else if (ret && document.contains(ret)) { ret.focus({ preventScroll: true }); ret = null; }
  };
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(sync, 40); }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return; const d = top(); if (!d) return; const f = items(d); if (!f.length) return;
    const i = f.indexOf(document.activeElement), last = f.length - 1;
    if (i < 0) { e.preventDefault(); f[0].focus(); } else if (e.shiftKey && i === 0) { e.preventDefault(); f[last].focus(); } else if (!e.shiftKey && i === last) { e.preventDefault(); f[0].focus(); }
  });
}
function initA11yLabels() {   // every control gets a programmatic name, including ones rendered later
  let n = 0;
  const NAMES = { 'cz-new': 'New entry', 'cz-name': 'Name', 'cz-role': 'Role', 'cz-email': 'Email', 'cz-state': 'State', 'fb-select': 'Filter' };
  const run = root => {
    root.querySelectorAll('.field > label, .field label:first-child').forEach(l => {
      if (l.htmlFor) return; const c = l.parentElement.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea'); if (!c) return;
      if (!c.id) c.id = 'ctl' + (++n); l.htmlFor = c.id;
    });
    root.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea').forEach(c => {
      const lab = c.labels && c.labels[0]; if (lab && /\*\s*$/.test(lab.textContent)) c.setAttribute('aria-required', 'true');
      if (c.getAttribute('aria-label') || (c.labels && c.labels.length)) return;
      const k = Object.keys(NAMES).find(x => c.classList.contains(x));
      const name = c.placeholder || c.title || (k && NAMES[k]) || c.name || (c.id === 'czNewState' ? 'State' : ''); if (name) c.setAttribute('aria-label', name);
    });
  };
  const makeKeyboard = root => {
    root.querySelectorAll('.kcard, .ot-card, .plan-group-head, .kcol-head, .al-row, tbody tr').forEach(el => {
      if (el.matches('tr') && !Object.keys(el.dataset).length) return;
      if (!el.hasAttribute('tabindex')) { el.tabIndex = 0; el.setAttribute('role', 'button'); el.dataset.kbd = '1'; }
      if (el.matches('.plan-group-head')) el.setAttribute('aria-expanded', el.querySelector('.chev.open') ? 'true' : 'false');
      if (el.matches('.kcol-head')) el.setAttribute('aria-expanded', el.parentElement.classList.contains('collapsed') ? 'false' : 'true');
    });
    root.querySelectorAll('.fb-menu, #cbUser, .kc-status').forEach(b => b.setAttribute('aria-haspopup', 'true'));
  };
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.kbd) { e.preventDefault(); e.target.click(); }
  });
  run(document.body); makeKeyboard(document.body);
  let t = 0; new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { run(document.body); makeKeyboard(document.body); }, 60); }).observe(document.body, { childList: true, subtree: true });
}
function initShellMenu() {   // Carbon UI shell: off-canvas side nav below 1056px
  const skip = document.createElement('a'); skip.href = '#'; skip.className = 'skip-link'; skip.textContent = 'Skip to main content';
  skip.addEventListener('click', e => { e.preventDefault(); const m = $('main.container'); m.tabIndex = -1; m.focus(); });
  document.body.insertBefore(skip, document.body.firstChild);
  const btn = $('#cdsMenu'), scrim = $('#cdsScrim'); if (!btn) return;
  const set = open => { document.body.classList.toggle('nav-open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); };
  btn.addEventListener('click', () => set(!document.body.classList.contains('nav-open')));
  if (scrim) scrim.addEventListener('click', () => set(false));
  $('#appNav').addEventListener('click', e => { if (e.target.closest('.nav-tab, a')) set(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') set(false); });
}
async function init() {
  initShellMenu(); initA11yLabels(); initDialogFocus(); syncNavTitles();
  document.documentElement.setAttribute('data-theme', 'light');
  if (lsGet('ngc_nav') === '1') { document.body.classList.add('nav-collapsed'); const nt = $('#navToggle'); if (nt) { nt.title = 'Expand menu'; const lbl = nt.querySelector('.nav-util-lbl'); if (lbl) lbl.textContent = 'Expand'; } }
  const data = await loadData(); if (!data) return; state.data = data;
  ['gateEnabled', 'gateHash', 'adminEnabled', 'adminHash', 'authMode'].forEach(k => { delete state.data.meta[k]; });
  [LS.gh, LS.gate].forEach(k => lsDel(k));
  state.data.schools.forEach(s => { if (!s.id) s.id = uid(); });
  try { captureTrend(); } catch (e) {}
  gateStart();
}
function initContentBar() {
  const btn = $('#cbUser');
  if (btn) {
    updateUserBadge();   // populates initials + title based on auth state (or legacy ngc_author)
    btn.addEventListener('click', ev => {
      // Signed-in user → show account menu (name / role / sign out)
      if (btn.dataset.authed === '1') return openUserMenu(btn);
      // Legacy: prompt for display name (only in password mode)
      nameDialog(lsGet('ngc_author') || '', name => { lsSet('ngc_author', name); updateUserBadge(); });
    });
  }
  const cbSearch = $('#cbSearch');
  if (cbSearch) {
    let searchTimer = null;
    cbSearch.addEventListener('input', e => {
      const v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (state.filters.search === v) return;
        state.filters.search = v;
        if (v && state.view !== 'plan') { setView('plan'); if (typeof updateFilterBubble === 'function') updateFilterBubble(); return; }   // results live on Milestones
        // Dashboard's applied-chip row and filter-bubble both depend on search state.
        state.view === 'progress' ? rerender() : refreshBody();
        if (typeof updateFilterBubble === 'function') updateFilterBubble();
      }, 180);   // debounce: 156 milestones × complex render = noticeable per-keystroke lag
    });
    // Enter fires immediately (no wait); Escape clears
    cbSearch.addEventListener('keydown', e => {
      if (e.key === 'Enter') { clearTimeout(searchTimer); state.filters.search = e.target.value; state.view === 'progress' ? rerender() : refreshBody(); updateFilterBubble && updateFilterBubble(); }
      else if (e.key === 'Escape' && e.target.value) { e.target.value = ''; clearTimeout(searchTimer); state.filters.search = ''; state.view === 'progress' ? rerender() : refreshBody(); updateFilterBubble && updateFilterBubble(); }
    });
  }
  // Once the in-flow header scrolls past, reveal the floating control pill.
  let ticking = false;
  const onScroll = () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        updateSticky();   // pins the context bar and floating tools once the filters scroll away
        ticking = false;
      });
      ticking = true;
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Floating bubbles: search (universal ⌘K), filters, alerts.
  const ctxT = $('#ctxTitle'); if (ctxT) ctxT.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  const pillSearch = $('#cbPillSearch'); if (pillSearch) pillSearch.addEventListener('click', () => openCmdk());
  const pillAct = $('#cbPillActivity'); if (pillAct) pillAct.addEventListener('click', toggleActivity);
  const pillFilter = $('#cbPillFilter'); if (pillFilter) pillFilter.addEventListener('click', e => { e.stopPropagation(); toggleFilterPanel(); });
  const cbApp = document.querySelector('.cb-app');
  if (cbApp) { cbApp.style.cursor = 'pointer'; cbApp.title = 'Return to Dashboard (clears filters)'; cbApp.addEventListener('click', () => { clearFilters(); setView('progress'); }); }
}
function bootApp() {
  // Personalize for whoever is signed in (drops any prior account's "Mine" scope first)
  state.filters.owners.clear(); applyMyDefaults();
  // Clear any loading skeleton painted by index.html or a prior boot attempt.
  const sk = document.getElementById('bootSkeleton'); if (sk) sk.remove();
  wireEvents();
  wireCmdk();
  wireKeyboard();
  wireCollab();
  initContentBar();
  const cbAb = $('#cbActivityBtn'); if (cbAb) cbAb.addEventListener('click', toggleActivity);
  updateGreeting();
  const ac = $('#activityClose'); if (ac) ac.addEventListener('click', toggleActivity);
  renderActivityPanel();
  updateActivityDot();
  window.addEventListener('popstate', () => { closePopover(); if ($('#drawer.open')) closeDrawer(); if ($('#modalBackdrop').classList.contains('open')) attemptCloseModal(); setView((location.hash || '').replace('#', '') || 'progress', true); });
  // Direct hash edits and in-page #links fire 'hashchange', not 'popstate'. setView's own
  // pushState doesn't fire either, so this routes deep links without double-rendering.
  window.addEventListener('hashchange', () => { const v = (location.hash || '').replace('#', '') || 'progress'; if (v !== state.view) setView(v, true); });
  restoreTeamScope();
  const initial = (location.hash || '').replace('#', '');
  setView(VIEWS.includes(initial) ? initial : 'progress', true);
  if (!location.hash) { try { history.replaceState({ v: state.view }, '', '#' + state.view); } catch (e) {} }
  const sc = sbCfg();
  // In auth mode, gateStart already connected via sbConnect. Avoid a second connect that would recreate the client.
  if (sc && sc.url && sc.key && !state.sb.connected) sbConnect(sc.url, sc.key, true);
  openDeepLink();
}
document.addEventListener('DOMContentLoaded', init);

/* ============================================================
   FORECASTING (Nov 2026): check-ins, checkpoints, pace checks,
   deadline history, "says on track, but" flags, forecast accuracy,
   meeting agenda and reminder text. Fixes "on track until it's late."
   ============================================================ */
const CI_MAP = { yes: 'on_track', probably: 'at_risk', unlikely: 'behind' };
const CI_REV = { on_track: 'yes', at_risk: 'probably', behind: 'unlikely' };
const CI_LABEL = { yes: 'Yes, on time', probably: 'Probably', unlikely: 'Unlikely' };
const CHECKIN_DAYS = 14, STALE_DAYS = 21, HORIZON_DAYS = 180;
const FLAG_LABEL = { stale: 'Update missing', watermelon: 'Needs a look', slipped: 'Deadline moved (30 days)' };

function lastCheckin(m) { const c = m.checkins; return Array.isArray(c) && c.length ? c[c.length - 1] : null; }
function daysSince(t) { return t ? Math.floor((Date.now() - new Date(t).getTime()) / 86400000) : null; }
function missedCheckpoints(m) { const t = todayISO(); return (m.checkpoints || []).filter(c => !c.done && c.due && c.due < t); }
function cpProgress(m) { const c = m.checkpoints || []; return c.length ? Math.round(100 * c.filter(x => x.done).length / c.length) : null; }
function curProgress(m) { const p = cpProgress(m); return p == null ? (+m.progress_percent || 0) : p; }

// Open milestones due within 6 months need a check-in every 2 weeks (the committee's meeting rhythm)
function needsCheckin(m) {
  if (m.status === 'complete' || !m.due_date) return false;
  if (daysUntil(m.due_date) > HORIZON_DAYS) return false;
  const lc = lastCheckin(m), ds = lc ? daysSince(lc.t) : null;
  return ds == null || ds >= cadenceDays();
}
// Where progress should be by now, assuming steady work from the start date to the due date
function paceGap(m) {
  const start = m.startDate || (m.createdAt || '').slice(0, 10);
  if (!start || !m.due_date || start >= m.due_date) return null;
  const total = daysBetween(parseDate(start), parseDate(m.due_date)), el = daysBetween(parseDate(start), today());
  if (el <= 0 || total <= 0) return null;
  const expected = Math.min(100, Math.round(100 * el / total)), actual = curProgress(m);
  return { expected, actual, gap: expected - actual };
}
// Soft signals that contradict an "on track" label. Shown as flags; the owner confirms or changes.
function watermelonReasons(m) {
  if (m.status === 'complete' || m.status === 'blocked') return [];
  const es = effectiveStatus(m); if (es !== 'on_track' && es !== 'not_started') return [];
  const r = [], pg = paceGap(m), lc = lastCheckin(m), d = daysUntil(m.due_date), p = curProgress(m);
  if (pg && pg.expected >= 30 && pg.gap > 25) r.push(`Behind pace: ${pg.actual}% done, ${pg.expected}% expected by now`);
  if (lc && d != null && d <= 90) { const ds = daysSince(lc.t); if (ds >= cadenceDays() + 7) r.push(`No check-in in ${ds} days`); }
  const moves = (m.dateHistory || []).length; if (moves >= 2) r.push(`Deadline moved ${moves === 2 ? 'twice' : moves + ' times'}`);
  if (d != null && d >= 0 && d <= 30 && p < 50) r.push(`Due in ${d} day${d === 1 ? '' : 's'} at ${p}% done`);
  r.push(...waitingReasons(m));
  return r;
}
function flagPass(m, f) {
  if (f === 'stale') return needsCheckin(m);
  if (f === 'watermelon') return watermelonReasons(m).length > 0;
  if (f === 'slipped') return (m.dateHistory || []).some(h => daysSince(h.t) <= 30);
  return true;
}
function logDateMove(m, from, to, reason) {
  if (!from || !to || from === to) return;
  (m.dateHistory = m.dateHistory || []).push({ t: new Date().toISOString(), by: currentDisplayName() || '', from, to, reason: reason || '' });
}
function slipSummary(m) {
  const h = m.dateHistory || []; if (!h.length || !m.due_date) return '';
  const days = daysBetween(parseDate(h[0].from), parseDate(m.due_date)), mo = Math.round(days / 30), n = h.length;
  const times = n === 1 ? 'once' : n === 2 ? 'twice' : n + ' times';
  const later = days > 0 ? (mo >= 1 ? `${mo} month${mo === 1 ? '' : 's'} later` : `${days} day${days === 1 ? '' : 's'} later`) : days < 0 ? 'earlier' : '';
  return `Moved ${times}` + (later ? `, ${later}` : '');
}
function recordCheckin(m, answer, forecast, note) {
  (m.checkins = m.checkins || []).push({ t: new Date().toISOString(), by: currentDisplayName() || '', answer, forecast: answer === 'yes' ? null : (forecast || null), note: (note || '').trim() });
}
function forecastChip(m) {
  if (m.status === 'complete') return '';
  const w = watermelonReasons(m), parts = [];
  if (w.length) parts.push(`<span class="fc-chip fc-warn" title="${esc(w.join('\n'))}">Check: ${esc(w[0].split(':')[0].toLowerCase())}</span>`);
  else if (needsCheckin(m)) parts.push('<span class="fc-chip fc-stale" title="No check-in in the last 2 weeks">Update missing</span>');
  const sl = slipSummary(m);
  if (sl) parts.push(`<span class="fc-chip fc-slip" title="${esc((m.dateHistory || []).map(h => `${fmtDate(h.from)} → ${fmtDate(h.to)}${h.reason ? ': ' + h.reason : ''}`).join('\n'))}">${esc(sl)}</span>`);
  return parts.length ? `<div class="fc-chips">${parts.join('')}</div>` : '';
}

// Forecast accuracy: of milestones someone called "on time" 30+ days before the due date, how many landed on time
function calibration(list) {
  const t = todayISO(), out = { n: 0, k: 0 };
  list.filter(m => m.due_date && m.due_date < t).forEach(m => {
    const cut = new Date(parseDate(m.due_date).getTime() - 30 * 86400000).toISOString();
    const ci = (m.checkins || []).filter(c => c.t <= cut).pop(); if (!ci || ci.answer !== 'yes') return;
    out.n++; if (m.completedAt && m.completedAt.slice(0, 10) <= m.due_date) out.k++;
  });
  return out;
}
function calibrationByTeam(list) {
  const by = {}; list.forEach(m => { const k = m.functional_area || 'Other'; (by[k] = by[k] || []).push(m); });
  return Object.entries(by).map(([team, ms]) => ({ team, ...calibration(ms) })).filter(r => r.n).map(r => ({ ...r, pct: Math.round(100 * r.k / r.n) })).sort((a, b) => a.pct - b.pct);
}

/* ---------- Dashboard card ---------- */
function forecastCard(list) {
  const open = list.filter(m => m.status !== 'complete');
  const stale = open.filter(needsCheckin).length, wm = open.filter(m => watermelonReasons(m).length).length, sl = list.filter(m => flagPass(m, 'slipped')).length;
  const tile = (n, label, flag, help) => `<button class="fc-tile ${n ? 'has' : ''}" data-drilldim="flag" data-drillval="${flag}" title="${help}"><span class="fc-n">${n}</span><span class="fc-l">${label}</span></button>`;
  const rows = calibrationByTeam(list);
  const cal = rows.length ? `<table class="fc-cal"><thead><tr><th>Team</th><th>Called "on time" 30+ days out</th><th>Landed on time</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.team)}</td><td>${r.n}</td><td><b>${r.pct}%</b> <span class="muted">(${r.k} of ${r.n})</span></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted fc-empty">No completed forecasts yet</p>';
  return `<section class="ex-card fc-card">
    <div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('check')}<h3>Forecast check</h3></div><div class="fc-actions"><button class="btn btn-ghost btn-sm" data-open-checkins>Check-ins</button><button class="btn btn-ghost btn-sm" data-open-agenda>Meeting agenda</button></div></div>
    <div class="fc-tiles">${tile(stale, 'Update missing', 'stale', 'Open milestones due within 6 months with no check-in in 2 weeks')}${tile(wm, 'Needs a look', 'watermelon', 'Marked on track, but pace, check-ins, or deadline moves disagree')}${tile(sl, 'Deadlines moved', 'slipped', 'Due dates changed in the last 30 days')}</div>
    <div class="fc-sub"><h4>Forecast accuracy by team</h4>${cal}</div>
  </section>`;
}

/* ---------- Milestone editor: check-in, checkpoints, deadline reason ---------- */
function checkinBlock(m) {
  const lc = lastCheckin(m), hist = (m.checkins || []).slice().reverse(), wm = watermelonReasons(m);
  const q = m.due_date ? `Will this land by <b>${esc(fmtDate(m.due_date))}</b>?` : 'Set a due date, then check in.';
  return `<div class="ci-block" id="ciBlock">
    <div class="ci-q">${q}</div>
    <div class="ci-seg" role="radiogroup" aria-label="Forecast">${['yes', 'probably', 'unlikely'].map(a => `<button type="button" class="ci-opt ci-${a}" data-ci="${a}" role="radio" aria-checked="false">${CI_LABEL[a]}</button>`).join('')}</div>
    <div class="ci-more" id="ciMore" hidden>
      <div class="field" id="ciFcWrap"><label>Expected finish <span class="req">*</span></label><input type="date" id="ciForecast" value="${esc((lc && lc.forecast) || '')}"></div>
      <div class="field"><label id="ciNoteLbl">Note</label><input id="ciNote"></div>
    </div>
    ${lc ? `<div class="ci-last">Last check-in ${esc(fmtWhen(lc.t))}${lc.by ? ' by ' + esc(lc.by) : ''}: <b>${esc(CI_LABEL[lc.answer] || lc.answer)}</b>${lc.forecast ? ` · expects ${esc(fmtDate(lc.forecast))}` : ''}${lc.note ? ` · "${esc(lc.note)}"` : ''}</div>` : ''}
    ${hist.length > 1 ? `<details class="ci-hist"><summary>History (${hist.length})</summary>${hist.map(c => `<div class="ci-h">${esc(fmtWhen(c.t))} · <b>${esc(CI_LABEL[c.answer] || c.answer)}</b>${c.forecast ? ' · expects ' + esc(fmtDate(c.forecast)) : ''}${c.by ? ' · ' + esc(c.by) : ''}${c.note ? ' · ' + esc(c.note) : ''}</div>`).join('')}</details>` : ''}
    ${wm.length ? `<div class="ci-flag"><b>Needs a look</b><br>Marked on track, but ${wm.map(x => esc(x.charAt(0).toLowerCase() + x.slice(1))).join('; ')}</div>` : ''}
  </div>`;
}
function cpRow(c) {
  return `<div class="cp-row" data-cpid="${esc(c.id || uid())}"><input type="checkbox" class="cp-done" ${c.done ? 'checked' : ''} aria-label="Done"><input class="cp-title" value="${esc(c.title || '')}" placeholder="Step"><input type="date" class="cp-due" value="${esc(c.due || '')}" aria-label="Checkpoint date"><button type="button" class="cp-del" aria-label="Remove checkpoint">${CI('close')}</button></div>`;
}
function checkpointsBlock(m) {
  const cps = m.checkpoints || [];
  return `<div class="field"><label>Checkpoints</label>
      <div class="cp-list" id="cpList">${cps.map(cpRow).join('')}</div>
      <div class="cp-actions"><button type="button" class="btn btn-tonal btn-sm" id="cpAdd">+ Add checkpoint</button>${cps.length ? '' : '<button type="button" class="btn btn-ghost btn-sm" id="cpSuggest">Suggest 3</button>'}</div></div>
    <div class="field" id="mDueWhyWrap" hidden><label>Why is the deadline moving? <span class="req">*</span></label><input id="mDueWhy" placeholder="Reason"></div>`;
}
let ciAnswer = null;
function wireForecastUI(m) {
  ciAnswer = null;
  const seg = $$('#ciBlock .ci-opt');
  seg.forEach(b => b.addEventListener('click', () => {
    ciAnswer = b.dataset.ci;
    seg.forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    $('#ciMore').hidden = false; $('#ciFcWrap').hidden = ciAnswer === 'yes';
    $('#ciNoteLbl').textContent = ciAnswer === 'yes' ? 'Note' : 'Risk or ask';
    const sel = $('#mStatus'); if (sel && sel.value !== 'blocked') sel.value = CI_MAP[ciAnswer];
    modalDirty = true;
  }));
  const due = $('#mDue'), orig = m.due_date || '';
  if (due) due.addEventListener('change', () => { $('#mDueWhyWrap').hidden = !!m._draft || !(orig && due.value && due.value !== orig); });
  const list = $('#cpList');
  $('#cpAdd').addEventListener('click', () => { list.insertAdjacentHTML('beforeend', cpRow({})); list.lastElementChild.querySelector('.cp-title').focus(); modalDirty = true; });
  const sg = $('#cpSuggest');
  if (sg) sg.addEventListener('click', () => {
    const dueV = ($('#mDue') || {}).value; if (!dueV) { toast('Set a due date first', 'err'); return; }
    const t0 = today().getTime(), t1 = parseDate(dueV).getTime(); if (t1 <= t0) { toast('The due date has passed. Add checkpoints by hand.', 'err'); return; }
    const at = f => { const d = new Date(t0 + (t1 - t0) * f); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    [['Plan, owners, and inputs confirmed', 0.25], ['Draft or first version done', 0.6], ['Final review complete', 0.9]].forEach(([title, f]) => list.insertAdjacentHTML('beforeend', cpRow({ title, due: at(f) })));
    sg.remove(); modalDirty = true;
  });
  list.addEventListener('click', e => { const d = e.target.closest('.cp-del'); if (d) { d.closest('.cp-row').remove(); modalDirty = true; } });
}
function readForecastUI(m) {
  const answer = ciAnswer, fc = ($('#ciForecast') || {}).value || '', note = ($('#ciNote') || {}).value || '';
  if (answer && answer !== 'yes' && !fc) { markInvalid($('#ciForecast'), 'Add the expected finish date'); return false; }
  const newDue = ($('#mDue') || {}).value || null, oldDue = m.due_date || null, why = (($('#mDueWhy') || {}).value || '').trim();
  const moved = !m._draft && !!oldDue && !!newDue && newDue !== oldDue;
  if (moved && !why) { $('#mDueWhyWrap').hidden = false; markInvalid($('#mDueWhy'), 'Add a reason for moving the deadline'); return false; }
  const cps = $$('#cpList .cp-row').map(r => ({ id: r.dataset.cpid, title: r.querySelector('.cp-title').value.trim(), due: r.querySelector('.cp-due').value || null, done: r.querySelector('.cp-done').checked })).filter(c => c.title);
  return { answer, fc, note, moved, oldDue, newDue, why, cps };
}
function applyForecastUI(m, fx, prevStatus) {
  if (fx.moved) logDateMove(m, fx.oldDue, fx.newDue, fx.why);
  const prev = m.checkpoints || [];
  m.checkpoints = fx.cps.map(c => { const p = prev.find(x => x.id === c.id); return { ...c, doneAt: c.done ? ((p && p.doneAt) || new Date().toISOString()) : null }; });
  if (m.checkpoints.length && m.status !== 'complete') m.progress_percent = cpProgress(m);
  if (fx.answer) recordCheckin(m, fx.answer, fx.fc, fx.note);
  else if (m.status !== prevStatus && CI_REV[m.status]) recordCheckin(m, CI_REV[m.status], null, '');   // a status change counts as a check-in
}

/* ---------- Sheets: My check-ins, Meeting agenda ---------- */
function closeSheet() { const w = $('#sheetBackdrop'); if (w) w.remove(); document.body.classList.remove('print-agenda'); }
function openSheet(title, body, foot) {
  closeSheet();
  const w = document.createElement('div'); w.className = 'modal-backdrop open sheet-backdrop'; w.id = 'sheetBackdrop';
  w.innerHTML = `<div class="modal sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-sheet-close aria-label="Close"><svg viewBox="0 0 32 32" fill="currentColor" width="20" height="20"><path d="M17.4141 16L24 9.4141 22.5859 8 16 14.5859 9.4143 8 8 9.4141 14.5859 16 8 22.5859 9.4143 24 16 17.4141 22.5859 24 24 22.5859 17.4141 16z"/></svg></button></div><div class="modal-body">${body}</div><div class="modal-foot"><div></div><div style="display:flex;gap:8px">${foot || ''}</div></div></div>`;
  document.body.appendChild(w);
  w.addEventListener('click', e => { if (e.target === w || e.target.closest('[data-sheet-close]')) closeSheet(); });
  const onKey = e => { if (e.key === 'Escape') { closeSheet(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  return w;
}
function openCheckins() {
  if (!guardEdit()) return;
  const me = myOwnerName();
  const pool = M().filter(m => m.status !== 'complete' && m.due_date && daysUntil(m.due_date) <= HORIZON_DAYS);
  const list = (me ? pool.filter(m => ownsM(m, me)) : pool.filter(needsCheckin)).sort((a, b) => (needsCheckin(b) - needsCheckin(a)) || (a.due_date < b.due_date ? -1 : 1));
  const cal = me ? calibration(M().filter(m => ownsM(m, me))) : null;
  const rows = list.map(m => { const lc = lastCheckin(m); return `<div class="ck-row ${needsCheckin(m) ? 'due' : ''}" data-ckid="${esc(m.id)}">
      <div class="ck-main"><div class="ck-t">${esc(m.activity)}</div><div class="ck-m">Due ${esc(fmtDate(m.due_date))}${me ? '' : ' · ' + esc(ownersOf(m).join(' / ') || 'Unassigned')} · ${lc ? 'last: ' + esc(CI_LABEL[lc.answer] || lc.answer) + ', ' + esc(fmtWhen(lc.t)) : 'no check-in yet'}</div></div>
      <div class="ci-seg">${['yes', 'probably', 'unlikely'].map(a => `<button type="button" class="ci-opt ci-${a}" data-ck="${a}">${CI_LABEL[a]}</button>`).join('')}</div>
      <div class="ck-more" hidden><input type="date" class="ck-fc" aria-label="Expected finish date" title="Expected finish date"><input class="ck-note" placeholder="Risk or ask"></div></div>`; }).join('');
  const lede = `<p class="modal-lede">Will each milestone land by its due date?</p>`;
  const calHtml = cal && cal.n ? `<p class="ck-cal">Your forecast accuracy: ${cal.k} of ${cal.n} on time</p>` : '';
  const w = openSheet(me ? 'Your check-ins' : 'Check-ins needed', lede + calHtml + (rows || '<p class="muted">No check-ins due</p>'),
    `<button class="btn btn-text" data-sheet-close>Cancel</button><button class="btn btn-filled" id="ckSave">Save check-ins</button>`);
  w.addEventListener('click', e => {
    const b = e.target.closest('[data-ck]'); if (!b) return;
    const row = b.closest('.ck-row'); row.querySelectorAll('[data-ck]').forEach(x => x.classList.toggle('on', x === b));
    row.dataset.answer = b.dataset.ck; row.querySelector('.ck-more').hidden = false; row.querySelector('.ck-fc').hidden = b.dataset.ck === 'yes';
  });
  $('#ckSave').addEventListener('click', () => {
    const picked = $$('#sheetBackdrop .ck-row').filter(r => r.dataset.answer);
    const bad = picked.find(r => r.dataset.answer !== 'yes' && !r.querySelector('.ck-fc').value);
    if (bad) { markInvalid(bad.querySelector('.ck-fc'), 'Add the expected finish date'); return; }
    if (!picked.length) return closeSheet();
    snapshotForUndo(`Check-ins (${picked.length})`);
    picked.forEach(r => {
      const m = findM(r.dataset.ckid); if (!m) return; const a = r.dataset.answer;
      recordCheckin(m, a, r.querySelector('.ck-fc').value, r.querySelector('.ck-note').value);
      if (m.status !== 'blocked') m.status = CI_MAP[a];
      if (m.stage === 'complete') m.stage = 'in_progress';
      touch(m);
    });
    logActivity('status', `Checked in on ${picked.length} milestone${picked.length === 1 ? '' : 's'}`);
    autosave(); closeSheet(); rerender(); toastAction(`Saved ${picked.length} check-in${picked.length === 1 ? '' : 's'}`, 'Undo', undo);
  });
}
function reminderText(stale) {
  const by = {}; stale.forEach(m => (ownersOf(m).length ? ownersOf(m) : ['Unassigned']).forEach(o => (by[o] = by[o] || []).push(m)));
  return Object.entries(by).map(([o, ms]) => `${o}: please check in on ${ms.length} milestone${ms.length === 1 ? '' : 's'} in Growth Hub before our next meeting:\n` + ms.map(m => `  - ${m.activity} (due ${fmtDate(m.due_date)})`).join('\n')).join('\n\n') + `\n\n${location.origin}${location.pathname}#plan`;
}
function copyText(txt, msg) {
  const done = () => toast(msg || 'Copied', 'ok');
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt).then(done, () => fallback());
  fallback();
  function fallback() { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast("Couldn't copy", 'err'); } ta.remove(); }
}
function openAgenda() {
  const list = filtered(), open = list.filter(m => m.status !== 'complete');
  const off = open.filter(m => m.status !== 'blocked' && effectiveStatus(m) === 'behind'), risk = open.filter(m => effectiveStatus(m) === 'at_risk'), blocked = open.filter(m => m.status === 'blocked');
  const wm = open.filter(m => watermelonReasons(m).length), moved = list.filter(m => (m.dateHistory || []).some(h => daysSince(h.t) <= 14)), stale = open.filter(needsCheckin);
  const meta1 = m => esc([m.market, ownersOf(m).join(' / ') || 'Unassigned', m.due_date ? 'due ' + fmtDate(m.due_date) : ''].filter(Boolean).join(' · '));
  const li = (m, extra) => `<li><b>${esc(m.activity)}</b> <span class="muted">${meta1(m)}</span>${extra ? `<div class="ag-x">${extra}</div>` : ''}</li>`;
  const ciX = m => { const c = lastCheckin(m); return c ? [c.forecast ? 'Expects ' + esc(fmtDate(c.forecast)) : '', c.note ? 'Ask: ' + esc(c.note) : ''].filter(Boolean).join(' · ') : ''; };
  const sec = (title, items, fn) => items.length ? `<section class="ag-sec"><h4>${title} <span class="muted">(${items.length})</span></h4><ul>${items.map(fn).join('')}</ul></section>` : '';
  const byOwner = {}; stale.forEach(m => (ownersOf(m).length ? ownersOf(m) : ['Unassigned']).forEach(o => (byOwner[o] = byOwner[o] || 0, byOwner[o]++)));
  const body = `<p class="modal-lede">${esc(new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))} · current filters</p>`
    + `<div id="agSince"><p class="muted">Loading what changed since the last meeting</p></div><h3 class="ag-h">Open issues</h3>`
    + sec('Behind', off, m => li(m, ciX(m)))
    + sec('Blocked', blocked, m => li(m, m.dependency ? 'Blocked by: ' + esc(m.dependency) : ''))
    + sec('At risk', risk, m => li(m, ciX(m)))
    + sec('Needs a look', wm, m => li(m, watermelonReasons(m).map(esc).join('; ')))
    + sec('Deadlines moved in the last 2 weeks', moved, m => { const h = (m.dateHistory || []).slice(-1)[0]; return li(m, `${esc(fmtDate(h.from))} → ${esc(fmtDate(h.to))}${h.reason ? ': ' + esc(h.reason) : ''}`); })
    + (stale.length ? `<section class="ag-sec"><h4>Update missing <span class="muted">(${stale.length})</span></h4><ul>${Object.entries(byOwner).sort((a, b) => b[1] - a[1]).map(([o, n]) => `<li><b>${esc(o)}</b> <span class="muted">${n} milestone${n === 1 ? '' : 's'}</span></li>`).join('')}</ul></section>` : '')
    + ((off.length + blocked.length + risk.length + wm.length + moved.length + stale.length) ? '' : '<p class="muted">Nothing to raise</p>');
  const w = openSheet('Meeting agenda', body, `${stale.length ? '<button class="btn btn-ghost" id="agEmail">Email reminders</button><button class="btn btn-ghost" id="agCopy">Copy reminder text</button>' : ''}<button class="btn btn-filled" id="agPrint">Print agenda</button>`);
  $('#agPrint').addEventListener('click', () => { document.body.classList.add('print-agenda'); window.addEventListener('afterprint', () => document.body.classList.remove('print-agenda'), { once: true }); window.print(); });
  const cp = $('#agCopy'); if (cp) cp.addEventListener('click', () => copyText(reminderText(stale)));
  const em = $('#agEmail'); if (em) em.addEventListener('click', () => openMail([...new Set(stale.flatMap(ownersOf))].map(ownerEmail).filter(Boolean), 'Growth Hub check-ins before our next meeting', reminderText(stale)));
  fillSinceLastMeeting(list);
}
document.addEventListener('scroll', e => { const t = e.target; if (t && t.classList && t.classList.contains('modal-body')) t.classList.toggle('is-scrolled', t.scrollTop > 0); }, true);

/* ============================================================
   COMMITTEE RHYTHM (Nov 2026): monthly meetings, team updates every
   2 weeks, and a chair-only "Between meetings" card that says when to
   touch base with a team or call a meeting early. Rules compare against
   the last meeting so the chair sees what changed, not everything late.
   ============================================================ */
function mtg() { const m = meta(); m.meeting = m.meeting || {}; return m.meeting; }
function cadenceDays() { return +mtg().cadenceDays || 14; }
function lastMeetingISO() { return mtg().last || offsetDateISO(todayISO(), -1); }
function isCritical(m) { return !!(m.keyMilestone || m.greenlight || m.transition || m.priority === 'high'); }
// Was this milestone already off track at the last meeting? (overdue then, or its owner already said "Unlikely")
function wasOffAtLastMeeting(m) {
  const lm = lastMeetingISO();
  if (m.due_date && m.due_date < lm) return true;
  const before = (m.checkins || []).filter(c => c.t.slice(0, 10) <= lm).pop();
  return !!(before && (before.answer === 'unlikely' || (before.forecast && m.due_date && before.forecast > m.due_date)));
}
function newlyOffTrack(m) { return m.status !== 'complete' && effectiveStatus(m) === 'behind' && !wasOffAtLastMeeting(m); }

function committeeSignals() {
  const open = M().filter(m => m.status !== 'complete'), next = mtg().next || null;
  const daysToNext = next ? daysUntil(next) : null, byTeam = {};
  open.forEach(m => { const t = m.functional_area || 'Other'; (byTeam[t] = byTeam[t] || []).push(m); });
  const teams = Object.entries(byTeam).map(([team, ms]) => {
    const newly = ms.filter(newlyOffTrack), risk = ms.filter(m => effectiveStatus(m) === 'at_risk'), blocked = ms.filter(m => m.status === 'blocked');
    const due = ms.filter(m => m.due_date && daysUntil(m.due_date) <= HORIZON_DAYS), stale = due.filter(needsCheckin);
    const reasons = [];
    if (newly.length) reasons.push(`${newly.length} newly off track`);
    if (blocked.length) reasons.push(`${blocked.length} blocked`);
    if (risk.length >= 2) reasons.push(`${risk.length} at risk`);
    if (stale.length >= 3 || (due.length && stale.length >= Math.ceil(due.length / 2) && stale.length >= 2)) reasons.push(`${stale.length} updates missing`);
    const people = [...new Set([...newly, ...blocked, ...risk, ...stale].flatMap(ownersOf))];
    return { team, reasons, people, substantive: !!(newly.length || blocked.length || risk.length >= 2), items: [...new Set([...newly, ...blocked, ...risk, ...stale])] };
  }).filter(t => t.reasons.length).sort((a, b) => b.reasons.length - a.reasons.length);
  const early = [];
  const farOff = daysToNext == null || daysToNext >= 7;
  const offBefore = open.filter(m => effectiveStatus(m) === 'behind' && next && m.due_date && m.due_date <= next && m.due_date >= todayISO());
  const critOff = open.filter(m => isCritical(m) && effectiveStatus(m) === 'behind');
  if (farOff && offBefore.length) early.push(`${offBefore.length} off-track milestone${offBefore.length === 1 ? ' is' : 's are'} due before the meeting`);
  if (farOff && critOff.length) early.push(`${critOff.length} key milestone${critOff.length === 1 ? ' is' : 's are'} off track`);
  const serious = teams.filter(t => t.substantive).length;
  if (serious >= 3) early.push(`${serious} teams have items newly off track, blocked, or at risk`);
  const started = M().some(m => (m.checkins || []).length);
  return { next, daysToNext, teams, early, started, level: early.length ? 'early' : !started ? 'start' : teams.length ? 'touch' : 'ok' };
}

function committeeCard() {
  const s = committeeSignals(), mt = mtg();
  const when = s.next ? `Next meeting ${esc(fmtDate(s.next))} · ${s.daysToNext === 0 ? 'today' : s.daysToNext < 0 ? `${Math.abs(s.daysToNext)} days ago` : `in ${s.daysToNext} day${s.daysToNext === 1 ? '' : 's'}`}` : '<button class="btn btn-text btn-sm" data-open-settings>Set the next meeting date</button>';
  const head = { start: 'No team updates yet', ok: 'On track for the next meeting', touch: `Touch base with ${s.teams.length} team${s.teams.length === 1 ? '' : 's'}`, early: 'Consider an early meeting' }[s.level];
  const rows = s.teams.map(t => `<div class="cm-row"><div class="cm-main"><div class="cm-team">${esc(t.team)}</div><div class="cm-why">${esc(t.reasons.join(' · '))}${t.people.length ? ' · ' + esc(t.people.join(', ')) : ''}</div></div><span class="cm-row-acts"><button class="btn btn-ghost btn-sm" data-email-team="${esc(t.team)}">Email</button><button class="btn btn-ghost btn-sm" data-copy-team="${esc(t.team)}">Copy note</button></span></div>`).join('');
  return `<section class="ex-card cm-card cm-${s.level}">
    <div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('people')}<h3>Between meetings</h3></div><div class="cm-when">${when}</div></div>
    <div class="cm-status"><span class="cm-dot"></span><b>${head}</b></div>
    ${s.early.length ? `<ul class="cm-early">${s.early.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${s.level === 'start' ? `<div class="cm-first"><span>Ask team leads for their first check-in</span><button class="btn btn-tonal btn-sm" data-copy-all>Copy reminder for everyone</button></div>` : rows ? `<div class="cm-list">${rows}</div>` : ''}
    <div class="cm-counts">${[['stale', 'Updates missing', M().filter(needsCheckin).length], ['watermelon', 'Needs a look', M().filter(m => m.status !== 'complete' && watermelonReasons(m).length).length], ['slipped', 'Deadlines moved', M().filter(m => flagPass(m, 'slipped')).length]].map(([fl, l, n]) => `<button class="cm-count" data-drilldim="flag" data-drillval="${fl}"><b>${n}</b> ${l}</button>`).join('')}</div>
    <div class="cm-foot"><span class="muted">Updates every ${cadenceDays() === 7 ? 'week' : '2 weeks'}${mt.last ? ` · last meeting ${esc(fmtDate(mt.last))}` : ''}</span><span class="cm-actions"><button class="btn btn-ghost btn-sm" data-open-agenda>Meeting agenda</button><button class="btn btn-tonal btn-sm" data-mtg-held>Mark meeting held</button></span></div>
  </section>`;
}
function teamNote(team) {
  const t = committeeSignals().teams.find(x => x.team === team); if (!t) return '';
  const nx = mtg().next ? ` before the ${fmtDate(mtg().next)} committee meeting` : '';
  return `${t.people.join(', ') || team}: a quick ${team} update${nx}, please.\n` + t.items.slice(0, 8).map(m => `  - ${m.activity} (${SM(effectiveStatus(m)).label.toLowerCase()}${m.due_date ? ', due ' + fmtDate(m.due_date) : ''})`).join('\n')
    + `\nCheck in at ${location.origin}${location.pathname}#plan`;
}
function markMeetingHeld() {
  if (!guardAdmin()) return;
  const mt = mtg(), t = todayISO(); mt.last = t; mt.next = offsetDateISO(t, 1);
  logActivity('edit', 'Marked committee meeting held'); autosave(); rerender();
  toast(`Meeting marked as held. Next meeting set to ${fmtDate(mt.next)}`, 'ok');
}
function meetingSettingsHtml() {
  const mt = mtg();
  return `<details class="dw-sec dw-fold" open><summary>Committee meetings</summary>
    <div class="field-row"><div class="field"><label>Next meeting</label><input type="date" id="mtgNext" value="${esc(mt.next || '')}"></div>
    <div class="field"><label>Team updates</label><select id="mtgCadence"><option value="14" ${cadenceDays() === 14 ? 'selected' : ''}>Every 2 weeks</option><option value="7" ${cadenceDays() === 7 ? 'selected' : ''}>Every week</option></select></div></div>
  </details>`;
}
document.addEventListener('change', e => {
  const id = e.target && e.target.id; if (id !== 'mtgNext' && id !== 'mtgCadence') return;
  if (!guardAdmin()) { renderDrawer(); return; }
  if (id === 'mtgNext') mtg().next = e.target.value || null; else mtg().cadenceDays = +e.target.value;
  autosave(); rerender(); toast('Meeting settings saved', 'ok');
});

/* Sticky section headings: pinned while their group is on screen, then they scroll away with it.
   --sticky-top keeps them below the Carbon header; --ctx-left starts the context bar at the side nav's edge. */
function updateSticky() {
  const h = document.querySelector('.app-header'); const top = 48; let left = 0;   // 48 = Carbon header
  if (h) {
    const r = h.getBoundingClientRect(), pos = getComputedStyle(h).position;
    if (r.left >= 0 && r.left <= 1 && r.width < innerWidth * 0.6) left = Math.max(0, Math.round(r.right));   // sidebar nav: the bar starts where it ends
  }
  // Context bar: shown once the page title and filters have scrolled under it. While the
  // filter panel is open the filter bar floats, so keep whatever state we were in.
  const bar = $('#ctxBar'), barH = bar ? bar.offsetHeight : 0, body = document.body;
  if (!body.classList.contains('filters-open')) {
    const fbar = document.querySelector('.view.active .filterbar');
    body.classList.toggle('header-pinned', fbar ? fbar.getBoundingClientRect().bottom < top + barH : window.scrollY > 60);
  }
  const pinned = body.classList.contains('header-pinned');
  if (bar) bar.setAttribute('aria-hidden', pinned ? 'false' : 'true');
  const ctxH = pinned ? barH : 0;
  document.documentElement.style.setProperty('--sticky-top', top + 'px');
  document.documentElement.style.setProperty('--ctx-left', left + 'px');
  document.documentElement.style.setProperty('--ctx-h', ctxH + 'px');
  // Dashboard cards: column headings pin just under their card's title row
  document.querySelectorAll('.view.active .dash .ex-card').forEach(c => { const hd = c.querySelector(':scope > .ex-card-head'); c.style.setProperty('--hd-h', (hd ? hd.offsetHeight : 0) + 'px'); });
  document.querySelectorAll('.view.active .plan-group-head, .view.active .ot-term-h, .view.active .kcol-head, .view.active .dt thead th, .view.active .dash .ex-card-head').forEach(el => {
    const want = parseFloat(getComputedStyle(el).top) || 0;
    el.classList.toggle('is-stuck', window.scrollY > 0 && getComputedStyle(el).position === 'sticky' && Math.abs(el.getBoundingClientRect().top - want) < 1.5);
  });
}
/* Dashboard masthead: three facts that answer "where do we stand?" plus how much of the quarter is left.
   Every fact is a link to the place that explains it. */
function renderMasthead() {
  const brief = $('#cbBrief'), qt = $('#cbQuarter'); if (!brief || !qt) return;
  if (state.view !== 'progress' || !state.data) { brief.innerHTML = ''; qt.innerHTML = ''; return; }
  const items = [];
  try {
    const schools = hasSchoolWork() ? schoolsInView() : [];
    const sMs = s => state.filters.areas.size ? schoolMs(s).filter(m => state.filters.areas.has(m.functional_area)) : schoolMs(s);
    if (schools.length) {
      const keys = schools.map(s => ragReady(sMs(s)).key), onT = keys.filter(k => k === 'green' || k === 'blue').length;
      const tone = onT === schools.length ? 'ok' : keys.includes('red') ? 'bad' : 'warn';
      items.push(`<button class="mb-fact" data-mb="openings"><i class="mb-dot mb-${tone}"></i><b>${onT} of ${schools.length}</b> openings on track</button>`);
    }
    const att = attentionItems(filtered()).length;
    items.push(`<button class="mb-fact" data-mb="attention"><i class="mb-dot mb-${att ? 'warn' : 'ok'}"></i>${att ? `<b>${att}</b> need${att === 1 ? 's' : ''} attention` : 'Nothing needs attention'}</button>`);
    const sig = committeeSignals();
    if (sig.next) {
      const d = sig.daysToNext, when = d === 0 ? 'today' : d < 0 ? `was ${fmtDate(sig.next)}` : d === 1 ? 'tomorrow' : `in ${d} days`;
      items.push(`<button class="mb-fact" data-mb="meeting"><i class="mb-dot mb-info"></i>Next meeting <b>${esc(when)}</b></button>`);
    } else if (isAdmin()) items.push(`<button class="mb-fact" data-mb="setmeeting"><i class="mb-dot mb-none"></i>Next meeting not set</button>`);
  } catch (e) {}
  brief.innerHTML = items.join('');
  const gr = $('#msGreet');
  if (gr) { const first = (currentDisplayName() || '').split(/\s+/)[0]; gr.innerHTML = first ? `${esc(timeGreeting())}, <b>${esc(first)}</b>` : 'Dashboard'; }
  const fq = fiscalQuarter(), total = Math.max(1, daysBetween(fq.start, fq.end) + 1), done = Math.min(total, Math.max(0, total - fq.daysLeft - 1));
  const pctQ = Math.round(100 * done / total), md = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const todayL = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  qt.innerHTML = `<div class="mq-top"><span><b>${fqLabel(fq)}</b> · ${esc(todayL)}</span><span>${fq.daysLeft === 0 ? 'Last day' : fq.daysLeft + ' day' + (fq.daysLeft === 1 ? '' : 's') + ' left'}</span></div>
    <div class="mq-track" role="img" aria-label="${pctQ}% of ${fqLabel(fq)} has passed"><span style="width:${pctQ}%"></span></div>
    <div class="mq-ends"><span>${md(fq.start)}</span><span>${md(fq.end)}</span></div>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-mb]'); if (!b) return;
  const go = sel => { const el = document.querySelector(sel); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.remove('mb-flash'); void el.offsetWidth; el.classList.add('mb-flash'); } };
  const k = b.dataset.mb;
  if (k === 'openings') go('#view-progress .dt-card');
  else if (k === 'attention') go('#view-progress .al-card');
  else if (k === 'meeting') go('#view-progress .cm-card');
  else if (k === 'setmeeting') { const s = document.querySelector('[data-open-settings]'); if (s) s.click(); else go('#view-progress .cm-card'); }
});
/* Sidebar counts: only what needs action. Openings off track or at risk; milestones needing attention. */
function renderNavCounts() {
  const set = (id, n, tone, tip) => { const b = $(id); if (!b) return; b.hidden = !n; b.textContent = n || ''; b.className = 'nav-badge nb-' + tone; b.title = n ? tip : ''; };
  try {
    const off = state.data.schools.filter(s => s.openingFY && ['red', 'yellow'].includes(ragReady(schoolMs(s)).key)).length;
    set('#navBadgeOpen', off, 'danger', off + ' opening' + (off === 1 ? '' : 's') + ' at risk or behind');
    const att = attentionItems(M()).length;
    set('#navBadgePlan', att, 'warn', att + ' milestone' + (att === 1 ? '' : 's') + ' need attention');
  } catch (e) {}
}
/* Context bar text: page name, then the active filters and how many results they leave */
function ctxScopeParts() {
  const f = state.filters, p = [];
  if (mineOn()) p.push('Assigned to you'); else f.owners.forEach(v => p.push(v === '__none__' ? 'Unassigned' : v));
  f.states.forEach(v => p.push(fbValueLabel('states', v))); f.markets.forEach(v => p.push(v)); f.areas.forEach(v => p.push(v));
  f.openingFYs.forEach(v => p.push('Fall ' + (v - 1)));
  f.fys.forEach(v => p.push('Due ' + fyLabel(+v)));
  f.types.forEach(v => p.push(v));
  f.statuses.forEach(v => p.push(SM(v).label));
  f.priorities.forEach(v => p.push((PRIORITY[v] ? PRIORITY[v].label : v) + ' priority'));
  if (f.timing) p.push(f.timing === 'overdue' ? 'Overdue' : f.timing === 'this_month' ? 'Due within 2 weeks' : f.timing === 'due30' ? 'Due in 30 days' : f.timing === 'dueQ' ? 'Due by end of ' + fiscalQuarter().q : 'Due soon');
  if (f.flag) p.push(FLAG_LABEL[f.flag] || f.flag);
  if (f.schoolId) { const sc = schoolById(f.schoolId); if (sc) p.push(sc.market + ' ' + sc.display_label); }
  if (f.search) p.push('“' + f.search.slice(0, 24) + (f.search.length > 24 ? '…' : '') + '”');
  return p;
}
function renderCtxBar() {
  const t = $('#ctxTitle'), sc = $('#ctxScope'); if (!t || !sc) return;
  const v = state.view, parts = ctxScopeParts();
  t.textContent = v === 'timeline' ? 'Openings' : v === 'plan' ? 'Milestones' : 'Dashboard';
  let count = '';
  try {
    if (v === 'plan') { const n = filtered().length; count = n + ' milestone' + (n === 1 ? '' : 's'); }
    else if (v === 'timeline') { const n = ganttSchools().filter(s => s.openingFY).length; count = n + ' school' + (n === 1 ? '' : 's'); }
  } catch (e) {}
  const scope = parts.length ? parts.join(' · ') : (v === 'progress' ? 'All markets and teams' : '');
  sc.textContent = [scope, count].filter(Boolean).join(' · ');
  sc.title = sc.textContent;
}
let stickyRaf = 0;
window.addEventListener('scroll', () => { if (!stickyRaf) stickyRaf = requestAnimationFrame(() => { stickyRaf = 0; updateSticky(); }); }, { passive: true });
window.addEventListener('resize', updateSticky);

/* ============================================================
   COLLABORATION (Nov 2026): comments with @mentions (viewers too),
   documents and "waiting on" links on milestones, email buttons,
   Slack settings, Outlook calendar, "since the last meeting" and
   ?m=<id> links that open a milestone. Database side:
   supabase-collab-integrations.sql. Setup: INTEGRATIONS-SETUP.md.
   ============================================================ */
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
function commentLive() { return !!(state.sb && state.sb.connected && sbLoaded && state.auth && state.auth.user); }
// Signed-in people can comment whatever their role; offline, only editors can add notes
function canComment() { return commentLive() || guardEdit(); }
function safeUrl(u) { try { const x = new URL(String(u || '').trim()); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; } }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
function taskLink(id) { return `${location.origin}${location.pathname}?m=${encodeURIComponent(id)}`; }

/* ---------- comments and @mentions ---------- */
function mentionsIn(text) { const t = String(text || ''); return rosterNames().filter(n => t.includes('@' + n)); }
function renderNoteText(nt) {
  let h = esc(nt.text || '');
  const keep = [];
  const hold = html => { keep.push(html); return `\u0000${keep.length - 1}\u0000`; };
  h = h.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, u => hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`));
  [...new Set([...(nt.mentions || []), ...rosterNames()])].sort((a, b) => b.length - a.length).forEach(n => {
    const en = '@' + esc(n); if (h.includes(en)) h = h.split(en).join(hold(`<span class="mention">${en}</span>`));
  });
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}
let mentionState = null;
function mentionMenuOpen() { return !!(mentionState && $('#mentionMenu')); }
function closeMentionMenu() { const el = $('#mentionMenu'); if (el) el.remove(); mentionState = null; }
function updateMentionMenu(inp) {
  const pos = inp.selectionStart || 0, mt = /(^|\s)@([^@\n]{0,30})$/.exec(inp.value.slice(0, pos));
  if (!mt) return closeMentionMenu();
  const q = normName(mt[2]);
  const names = rosterNames().filter(n => { const nn = normName(n); return !q || nn.startsWith(q) || nn.split(' ').some(w => w.startsWith(q)); }).slice(0, 6);
  if (!names.length) return closeMentionMenu();
  const keepIdx = mentionState && mentionState.items.join('|') === names.join('|') ? mentionState.idx : 0;
  mentionState = { start: pos - mt[2].length - 1, end: pos, items: names, idx: keepIdx };
  let el = $('#mentionMenu');
  if (!el) { el = document.createElement('div'); el.id = 'mentionMenu'; el.className = 'mention-menu'; el.setAttribute('role', 'listbox'); inp.closest('.note-add').appendChild(el); }
  el.innerHTML = names.map((n, i) => `<button type="button" role="option" class="mention-opt ${i === mentionState.idx ? 'on' : ''}" aria-selected="${i === mentionState.idx}" data-mention="${esc(n)}">${personChip(n)}<span>${esc(n)}</span></button>`).join('');
}
function pickMention(inp, name) {
  if (!mentionState) return;
  const { start, end } = mentionState, ins = '@' + name + ' ';
  inp.value = inp.value.slice(0, start) + ins + inp.value.slice(end);
  const c = start + ins.length; inp.setSelectionRange(c, c); inp.focus();
  closeMentionMenu();
}
function myMentions(days) {
  const p = currentProfile(), names = [...new Set([myOwnerName(), p && p.full_name].filter(Boolean))];
  if (!names.length) return [];
  const cut = Date.now() - (days || 14) * 864e5, mine = currentDisplayName(), out = [];
  M().forEach(m => (m.noteLog || []).forEach(nt => {
    if (+nt.t < cut || (mine && nt.by === mine)) return;
    if (names.some(n => (nt.mentions || []).includes(n) || String(nt.text || '').includes('@' + n))) out.push({ m, nt });
  }));
  return out.sort((a, b) => b.nt.t - a.nt.t);
}
function mentionsCard() {
  const items = myMentions(14); if (!items.length) return '';
  return `<section class="ex-card mn-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('people')}<h3>Mentions for you</h3></div><span class="dt-sum">${items.length}</span></div>
    <div class="al-list">${items.slice(0, 4).map(({ m, nt }) => `<div class="al-row" data-expand="${esc(m.id)}"><div class="al-main"><div class="al-t">${esc(m.activity)}</div><div class="al-m"><b>${esc(nt.by || 'Someone')}</b> · ${esc(fmtWhen(nt.t))} · ${esc(clip(nt.text, 140))}</div></div></div>`).join('')}</div></section>`;
}

/* ---------- documents and "waiting on" ---------- */
const CLIP_IC = '<svg viewBox="0 0 32 32" fill="currentColor" width="13" height="13"><path d="M28.1,18.9L13.1,3.9c-2.5-2.6-6.6-2.6-9.2-0.1S1.3,10.5,3.9,13c0,0,0.1,0.1,0.1,0.1L6.8,16l1.4-1.4l-2.9-2.9	C3.6,10,3.6,7.1,5.3,5.4s4.6-1.8,6.3-0.1c0,0,0,0,0.1,0.1l14.9,14.9c1.8,1.7,1.8,4.6,0.1,6.3c-1.7,1.8-4.6,1.8-6.3,0.1	c0,0,0,0-0.1-0.1l-7.4-7.4c-1-1-0.9-2.6,0-3.5c1-0.9,2.5-0.9,3.5,0l4.1,4.1l1.4-1.4c0,0-4.2-4.2-4.2-4.2c-1.8-1.7-4.6-1.6-6.3,0.2	c-1.6,1.7-1.6,4.4,0,6.2l7.5,7.5c2.5,2.6,6.6,2.6,9.2,0.1S30.7,21.5,28.1,18.9C28.1,19,28.1,18.9,28.1,18.9L28.1,18.9z"/></svg>';
function linksBadge(m) { const n = (m.links || []).length; return n ? `<span class="kc-notes" title="${n} document${n === 1 ? '' : 's'}">${CLIP_IC}${n}</span>` : ''; }
function depIssue(m, d) {
  if (!d || d.status === 'complete') return '';
  if (d.status === 'blocked') return 'blocked';
  if (effectiveStatus(d) === 'behind') return 'behind';
  if (d.due_date && m.due_date && d.due_date > m.due_date) return 'due after this one';
  return '';
}
function waitingReasons(m) {
  return (m.blockedBy || []).map(findM).filter(Boolean).map(d => { const i = depIssue(m, d); return i ? `Waits on "${clip(d.activity, 48)}", which is ${i}` : ''; }).filter(Boolean);
}
function depRowHtml(m, d) {
  const issue = depIssue(m, d);
  return `<div class="dep-row" data-depid="${esc(d.id)}">${statusDot(effectiveStatus(d))}<button type="button" class="dep-name" data-expand="${esc(d.id)}" title="Open">${esc(d.activity)}</button>
    <span class="dep-info"><span class="dep-meta">${d.status === 'complete' ? 'Done' : d.due_date ? 'Due ' + esc(fmtDate(d.due_date)) : 'No due date'}</span>${issue ? `<span class="dep-warn">${esc(issue.charAt(0).toUpperCase() + issue.slice(1))}</span>` : ''}</span>
    <button type="button" class="dep-x" data-dep-x aria-label="Stop waiting on ${esc(d.activity)}">${CI('close')}</button></div>`;
}
function depOptions(m, taken) {
  const waitsOnMe = x => { const seen = new Set(); const walk = id => { if (id === m.id) return true; if (seen.has(id)) return false; seen.add(id); const n = findM(id); return !!n && (n.blockedBy || []).some(walk); }; return walk(x.id); };   // adding one of these would create a loop
  const pool = M().filter(x => x.id !== m.id && !x._draft && x.status !== 'complete' && !taken.includes(x.id) && !waitsOnMe(x));
  const byTeam = {}; pool.forEach(x => (byTeam[x.functional_area || 'Other'] = byTeam[x.functional_area || 'Other'] || []).push(x));
  return Object.keys(byTeam).sort().map(t => `<optgroup label="${esc(t)}">${byTeam[t].sort((a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1).map(x => `<option value="${esc(x.id)}">${esc(clip(x.activity, 70))}${x.market ? ' · ' + esc(x.market) : ''}</option>`).join('')}</optgroup>`).join('');
}
function linkRowHtml(l) {
  const url = safeUrl(l.url); if (!url) return '';
  return `<div class="lk-row" data-url="${esc(url)}" data-label="${esc(l.label || '')}">${CLIP_IC}<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(l.label || hostOf(url) || url)}</a><span class="lk-host">${esc(hostOf(url))}</span><button type="button" class="lk-x" aria-label="Remove link">${CI('close')}</button></div>`;
}
function linksDepsBlock(m) {
  const deps = (m.blockedBy || []).map(findM).filter(Boolean), needed = M().filter(x => (x.blockedBy || []).includes(m.id));
  return `<div class="m-sec-h">Waiting on</div>
    <div class="field"><div id="depList">${deps.map(d => depRowHtml(m, d)).join('')}</div>
      <select id="depAdd" aria-label="Add a milestone this waits on"><option value="">Add a milestone this waits on</option>${depOptions(m, deps.map(d => d.id))}</select>
      </div>
    ${needed.length ? `<div class="field"><label>Needed by</label><div class="dep-needed">${needed.map(n => `<div class="dep-row">${statusDot(effectiveStatus(n))}<button type="button" class="dep-name" data-expand="${esc(n.id)}">${esc(n.activity)}</button><span class="dep-meta">${n.due_date ? 'Due ' + esc(fmtDate(n.due_date)) : ''}</span></div>`).join('')}</div></div>` : ''}
    <div class="m-sec-h">Documents</div>
    <div class="field"><div id="lkList">${(m.links || []).map(linkRowHtml).join('')}</div>
      <div class="lk-add"><input id="lkUrl" type="url" placeholder="Paste a link to a document or folder" aria-label="Document link"><input id="lkLabel" placeholder="Name" aria-label="Document name"><button type="button" class="btn btn-sm" id="lkAdd">Add</button></div></div>`;
}
function addLinkFromInputs() {
  const u = $('#lkUrl'), l = $('#lkLabel'); if (!u || !u.value.trim()) return true;
  const url = safeUrl(u.value.trim().match(/^https?:\/\//i) ? u.value.trim() : 'https://' + u.value.trim());
  if (!url) { markInvalid(u, 'Paste a full link that starts with https://'); return false; }
  $('#lkList').insertAdjacentHTML('beforeend', linkRowHtml({ url, label: l.value.trim() }));
  u.value = ''; l.value = ''; modalDirty = true; return true;
}
function readLinksDeps(m) {
  if (!$('#depList')) return;
  addLinkFromInputs();
  const deps = $$('#depList .dep-row').map(r => r.dataset.depid).filter(Boolean);
  const links = $$('#lkList .lk-row').map(r => ({ url: r.dataset.url, label: r.dataset.label || '' }));
  if (deps.length || m.blockedBy) m.blockedBy = deps;
  if (links.length || m.links) m.links = links;
}

/* ---------- email (opens Outlook or the default mail app) ---------- */
function ownerEmail(name) {
  const o = (meta().owners || []).find(x => x.name === name); if (o && validEmail(o.email)) return o.email.trim();
  const p = currentProfile(); return p && p.full_name === name && validEmail(p.email) ? p.email : '';
}
function openMail(to, subject, body) {
  const href = `mailto:${to.join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(String(body || '').slice(0, 1800))}`;
  if (!to.length && isAdmin()) toast('Add owner emails in Settings to fill in the To line', 'warn');
  location.href = href;
}
function emailOwnersLink(m) {
  const owners = ownersOf(m); if (!owners.length) return '';
  return `<button type="button" class="m-mail" data-mail-owners="${esc(m.id)}">Email ${owners.length > 1 ? 'owners' : esc(owners[0].split(' ')[0])}</button>`;
}
function emailOwners(id) {
  const m = findM(id); if (!m) return;
  const owners = ownersOf(m), first = owners.map(o => o.split(' ')[0]).join(' and ');
  openMail(owners.map(ownerEmail).filter(Boolean), 'Growth Hub: ' + clip(m.activity, 90),
    `Hi ${first},\n\nChecking in on "${m.activity}"${m.due_date ? `, due ${fmtDate(m.due_date)}` : ''}. Growth Hub shows it as ${SM(effectiveStatus(m)).label.toLowerCase()}.\n\n${taskLink(m.id)}`);
}
function emailTeam(team) {
  const t = committeeSignals().teams.find(x => x.team === team); if (!t) return;
  openMail(t.people.map(ownerEmail).filter(Boolean), `Growth Hub: ${team} update`, teamNote(team));
}

/* ---------- since the last meeting (agenda) ---------- */
async function fillSinceLastMeeting(list) {
  const box = $('#agSince'); if (!box) return;
  const lm = lastMeetingISO(), since = new Date(lm + 'T23:59:59').getTime();
  const head = mtg().last ? `Since the last meeting, ${fmtDate(lm)}` : 'In the last month';
  let was = null;
  if (commentLive()) {
    try { const r = await state.sb.client.rpc('growth_changes_since', { p_since: new Date(since).toISOString() }); if (!r.error) was = new Map((r.data || []).map(x => [x.id, x])); } catch (e) {}
  }
  if (!$('#agSince')) return;
  const BAD = ['at_risk', 'behind', 'blocked'], prev = m => was && was.get(m.id) && was.get(m.id).was;
  const done = list.filter(m => m.status === 'complete' && m.completedAt && new Date(m.completedAt).getTime() > since);
  const added = list.filter(m => was ? !!(was.get(m.id) || {}).is_new : (m.createdAt && new Date(m.createdAt).getTime() > since));
  const worse = list.filter(m => {
    if (m.status === 'complete') return false;
    const w = prev(m);
    if (w && w.status && w.status !== m.status && w.status !== 'complete' && BAD.includes(m.status) && (SEV[m.status] || 0) > (SEV[w.status] || 0)) return true;
    return newlyOffTrack(m);
  });
  const better = was ? list.filter(m => { const w = prev(m); return w && BAD.includes(w.status) && ['on_track', 'not_started'].includes(m.status) && effectiveStatus(m) !== 'behind'; }) : [];
  const moved = list.filter(m => (m.dateHistory || []).some(h => new Date(h.t).getTime() > since));
  const talk = list.filter(m => (m.noteLog || []).some(n => +n.t > since));
  const meta1 = m => esc([m.market, ownersOf(m).join(' / ') || 'Unassigned'].filter(Boolean).join(' · '));
  const li = (m, extra) => `<li><button type="button" class="ag-link" data-expand="${esc(m.id)}">${esc(m.activity)}</button> <span class="muted">${meta1(m)}</span>${extra ? `<div class="ag-x">${extra}</div>` : ''}</li>`;
  const sec = (title, items, fn) => items.length ? `<section class="ag-sec"><h4>${title} <span class="muted">(${items.length})</span></h4><ul>${items.slice(0, 12).map(fn).join('')}</ul>${items.length > 12 ? `<p class="muted">and ${items.length - 12} more</p>` : ''}</section>` : '';
  const html = sec('Newly off track or at risk', worse, m => { const w = prev(m); return li(m, w && w.status !== m.status ? `${esc(SM(w.status).label)} → ${esc(SM(m.status).label)}` : 'Now overdue'); })
    + sec('Completed', done, m => li(m, ''))
    + sec('Back on track', better, m => li(m, `${esc(SM(prev(m).status).label)} → ${esc(SM(m.status).label)}`))
    + sec('Deadlines moved', moved, m => { const h = (m.dateHistory || []).filter(x => new Date(x.t).getTime() > since); return li(m, `${esc(fmtDate(h[0].from))} → ${esc(fmtDate(m.due_date))}${h[h.length - 1].reason ? ': ' + esc(h[h.length - 1].reason) : ''}`); })
    + sec('New milestones', added, m => li(m, m.due_date ? 'Due ' + esc(fmtDate(m.due_date)) : ''))
    + sec('New comments', talk, m => { const n = (m.noteLog || []).filter(x => +x.t > since).length; return li(m, `${n} new comment${n === 1 ? '' : 's'}`); });
  const out = $('#agSince');
  out.innerHTML = `<h3 class="ag-h">${esc(head)}</h3>${html || '<p class="muted">No changes</p>'}`;
  out.onclick = e => { const x = e.target.closest('[data-expand]'); if (x) { e.stopPropagation(); closeSheet(); openModal(x.dataset.expand); } };
}

/* ---------- Outlook calendar ---------- */
function icsEsc(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line) {
  const enc = new TextEncoder(); if (enc.encode(line).length <= 75) return line;
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) { const b = enc.encode(ch).length; if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; } cur += ch; bytes += b; }
  out.push(cur); return out.join('\r\n ');
}
function buildIcs(name, items, schools) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'), d8 = s => s.slice(0, 10).replace(/-/g, '');
  const next = s => { const d = new Date(s.slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10).replace(/-/g, ''); };
  const ev = (uid, date, summary, desc, url) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d8(date)}`, `DTEND;VALUE=DATE:${next(date)}`, `SUMMARY:${icsEsc(summary)}`, `DESCRIPTION:${icsEsc(desc)}`, `URL:${url}`, 'TRANSP:TRANSPARENT', 'END:VEVENT'];
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//KIPP NGC//Growth Hub//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEsc(name)}`];
  items.filter(m => m.due_date && !m._draft).forEach(m => L.push(...ev(`m-${m.id}@growth-hub`, m.due_date, `${m.status === 'complete' ? 'Done' : 'Due'}: ${m.activity}`,
    [`Status: ${SM(effectiveStatus(m)).label}`, `Owner: ${ownersOf(m).join(', ') || 'Unassigned'}`, m.market ? `Market: ${m.market}` : '', m.functional_area ? `Team: ${m.functional_area}` : '', '', `Open in Growth Hub: ${taskLink(m.id)}`].filter((x, i) => x || i === 4).join('\n'), taskLink(m.id))));
  schools.filter(s => s.opening_date).forEach(s => L.push(...ev(`s-${s.id}@growth-hub`, s.opening_date, `Opens: ${[s.market, s.display_label].filter(Boolean).join(' ')}`, 'School opening', location.origin + location.pathname)));
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}
function downloadIcs(scope) {
  const me = myOwnerName(), items = scope === 'mine' ? M().filter(m => ownsM(m, me)) : filtered();
  const txt = buildIcs(scope === 'mine' ? 'Growth Hub: my milestones' : 'Growth Hub milestones', items, state.data.schools || []);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/calendar' }));
  a.download = scope === 'mine' ? 'growth-hub-my-milestones.ics' : 'growth-hub-milestones.ics';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast(`Downloaded ${items.filter(m => m.due_date).length} due dates. Open the file to add them to Outlook`, 'ok');
}
function calFeedBase() { const c = sbCfg(); return c && c.url ? c.url.replace(/\/$/, '') + '/functions/v1/growth-calendar' : ''; }
async function fillCalSub(reset) {
  const box = $('#calSub'); if (!box) return;
  const notReady = isAdmin() ? 'Calendar links are not set up yet' : 'Calendar links are not turned on yet. Ask an admin, or download a file below';
  if (!commentLive()) { box.innerHTML = '<p class="muted">Sign in to get your link</p>'; return; }
  let tk = null, up = false;
  try { const r = await state.sb.client.rpc('growth_calendar_token', { p_owner: myOwnerName() || null, p_reset: !!reset }); if (r.error) throw r.error; tk = r.data; } catch (e) { box.innerHTML = `<p class="muted">${esc(notReady)}</p>`; return; }
  try { const pr = await fetch(calFeedBase() + '?ping=1'); up = pr.ok && (await pr.text()).trim() === 'ok'; } catch (e) {}
  if (!$('#calSub')) return;
  if (!up) { box.innerHTML = `<p class="muted">${esc(notReady)}</p>`; return; }
  const me = myOwnerName(), link = sc => `${calFeedBase()}?t=${tk}&scope=${sc}`;
  const row = (sc, label) => `<div class="cal-row"><div class="cal-l">${label}</div><div class="cal-ctl"><input readonly class="cal-url" value="${esc(link(sc))}" aria-label="${label} calendar link"><button type="button" class="btn btn-sm" data-calcopy="${esc(link(sc))}">Copy</button></div></div>`;
  box.innerHTML = `${me ? row('mine', 'My milestones') : ''}${row('all', 'All milestones')}
    <ol class="cal-steps"><li>In Outlook, go to Calendar</li><li>Choose Add calendar, then Subscribe from web</li><li>Paste the link, name it, and choose Import</li></ol>
    <p class="muted cal-note">Keep this link private</p>
    <button type="button" class="btn btn-text btn-sm" data-calreset>Get a new link</button>`;
}
function openCalendarSheet() {
  const me = myOwnerName();
  const body = `
    <section class="ag-sec"><h4>Subscribe in Outlook</h4><div id="calSub"><p class="muted">Getting your link</p></div></section>
    <section class="ag-sec"><h4>Or download a file</h4><p class="muted cal-note">One-time copy</p>
      <div class="dw-btns">${me ? '<button type="button" class="btn" data-calfile="mine">My milestones</button>' : ''}<button type="button" class="btn" data-calfile="view">Milestones in the current view</button></div></section>`;
  const w = openSheet('Add deadlines to Outlook', body, '<button class="btn btn-filled" data-sheet-close>Done</button>');
  w.addEventListener('click', e => {
    const f = e.target.closest('[data-calfile]'); if (f) return downloadIcs(f.dataset.calfile);
    const c = e.target.closest('[data-calcopy]'); if (c) return copyText(c.dataset.calcopy, 'Link copied. Paste it in Outlook under Subscribe from web');
    if (e.target.closest('[data-calreset]')) confirmDialog({ title: 'Get a new calendar link?', message: 'Your current link stops working', confirmLabel: 'Get a new link', onConfirm: () => { $('#calSub').innerHTML = '<p class="muted">Getting your link</p>'; fillCalSub(true); } });
  });
  fillCalSub(false);
}

/* ---------- Slack settings (admins) ---------- */
function integrationsSettingsHtml() {
  setTimeout(loadIntegrations, 0);
  return `<details class="dw-sec dw-fold" id="intSec"><summary>Slack alerts and digest</summary><div id="intBody"><p class="dw-help">Loading</p></div></details>`;
}
async function loadIntegrations(info) {
  const box = $('#intBody'); if (!box) return;
  if (!commentLive()) { box.innerHTML = '<p class="dw-help">Sign in to set up Slack</p>'; return; }
  let st = info;
  if (!st) {
    try { const r = await state.sb.client.rpc('growth_integrations_get'); if (r.error) throw r.error; st = r.data || {}; }
    catch (e) { box.innerHTML = '<div class="status-note warn">Slack is not available yet. Contact your Growth Hub admin</div>'; return; }
  }
  if (!$('#intBody')) return;
  box.innerHTML = st.slack ? `<div class="status-note ok">Posting to Slack · link ends in ${esc(st.slack_hint || '')}</div>
      <label class="field-check"><input type="checkbox" id="intAlerts" ${st.alerts ? 'checked' : ''}> Instant alerts</label>
      <div class="help-text">Status changes, mentions, and moved openings</div>
      <label class="field-check"><input type="checkbox" id="intDigest" ${st.digest ? 'checked' : ''}> Monday digest at 8am</label>
      
      <div class="dw-btns"><button class="btn" id="intTest">Send a test message</button><button class="btn" id="intDigestNow">Send the digest now</button><button class="btn btn-text" id="intClear">Disconnect</button></div>`
    : `
      <div class="field"><label for="intUrl">Slack webhook link</label><input id="intUrl" type="url" placeholder="https://hooks.slack.com/services/…" autocomplete="off"></div>
      <div class="dw-btns"><button class="btn btn-filled" id="intSave">Connect Slack</button></div>`;
}
async function intCall(fn, args, okMsg) {
  if (!guardAdmin()) return null;
  try { const r = await state.sb.client.rpc(fn, args || {}); if (r.error) throw r.error; if (okMsg) toast(okMsg, 'ok'); return r.data; }
  catch (e) { toast(String((e && e.message) || e), 'err'); return null; }
}

/* ---------- ?m=<id> opens a milestone (links in Slack, email and calendars) ---------- */
function openDeepLink() {
  let id = null; try { id = new URLSearchParams(location.search).get('m'); } catch (e) {}
  if (!id) return;
  let tries = 0;
  const go = () => {
    if (findM(id)) {
      try { const u = new URL(location.href); u.searchParams.delete('m'); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch (e) {}
      return openModal(id);
    }
    const ows = wsOtherIds.get(id);   // the link points at another workstream's board
    if (ows && WS_PAGE[ows]) return location.replace(WS_PAGE[ows] + location.search);
    if (++tries < (sbLoaded ? 3 : 30)) setTimeout(go, 500); else toast("That milestone wasn't found. It may have been deleted", 'warn');
  };
  setTimeout(go, 300);
}

function wireCollab() {
  const mb = $('#modalBody');
  // Don't jump to another milestone with unsaved edits
  mb.addEventListener('click', e => { if (e.target.closest('.dep-name, .ag-link') && modalDirty) { e.stopPropagation(); e.preventDefault(); toast('Save or cancel your changes first', 'warn'); } }, true);
  mb.addEventListener('click', e => {
    const mo = e.target.closest('[data-mail-owners]'); if (mo) return emailOwners(mo.dataset.mailOwners);
    if (e.target.closest('.dep-x')) { e.target.closest('.dep-row').remove(); modalDirty = true; return; }
    if (e.target.closest('.lk-x')) { e.target.closest('.lk-row').remove(); modalDirty = true; return; }
    if (e.target.closest('#lkAdd')) return addLinkFromInputs();
  });
  mb.addEventListener('change', e => {
    if (e.target.id !== 'depAdd' || !e.target.value) return;
    const m = findM(modalId), d = findM(e.target.value); if (!m || !d) return;
    $('#depList').insertAdjacentHTML('beforeend', depRowHtml(m, d));
    const opt = e.target.querySelector(`option[value="${CSS.escape(d.id)}"]`); if (opt) opt.remove();
    e.target.value = ''; modalDirty = true;
  });
  mb.addEventListener('input', e => { if (e.target.id === 'noteInput') updateMentionMenu(e.target); });
  mb.addEventListener('keydown', e => {
    if ((e.target.id === 'lkUrl' || e.target.id === 'lkLabel') && e.key === 'Enter') { e.preventDefault(); return addLinkFromInputs(); }
    if (e.target.id !== 'noteInput' || !mentionMenuOpen()) return;
    const n = mentionState.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mentionState.idx = (mentionState.idx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; updateMentionMenu(e.target); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(e.target, mentionState.items[mentionState.idx]); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeMentionMenu(); }
  });
  mb.addEventListener('mousedown', e => { const o = e.target.closest('[data-mention]'); if (o) { e.preventDefault(); pickMention($('#noteInput'), o.dataset.mention); } });
  mb.addEventListener('focusout', e => { if (e.target.id === 'noteInput') setTimeout(() => { if (document.activeElement !== e.target) closeMentionMenu(); }, 150); });
  // Slack settings in the drawer
  const db = $('#drawerBody');
  db.addEventListener('click', async e => {
    const id = e.target.id;
    if (id === 'intSave') {
      const v = ($('#intUrl').value || '').trim(); if (!v) return flagEmpty($('#intUrl'));
      const st = await intCall('growth_integrations_set', { p_slack_webhook: v }, 'Slack connected'); if (st) loadIntegrations(st);
    } else if (id === 'intTest') intCall('growth_slack_test', {}, 'Test message sent');
    else if (id === 'intDigestNow') intCall('growth_slack_digest_now', {}, 'Digest sent to Slack');
    else if (id === 'intClear') confirmDialog({ title: 'Disconnect Slack?', message: 'Alerts and the Monday digest stop', confirmLabel: 'Disconnect', onConfirm: async () => { const st = await intCall('growth_integrations_set', { p_clear_slack: true }, 'Slack disconnected'); if (st) loadIntegrations(st); } });
  });
  db.addEventListener('change', async e => {
    if (e.target.id !== 'intAlerts' && e.target.id !== 'intDigest') return;
    const st = await intCall('growth_integrations_set', e.target.id === 'intAlerts' ? { p_alerts: e.target.checked } : { p_digest: e.target.checked }, 'Saved');
    if (st) loadIntegrations(st); else loadIntegrations();
  });
}
