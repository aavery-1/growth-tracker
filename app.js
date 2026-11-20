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
const WS_OWN_SETTINGS = ['teams', 'templates', 'campaigns', 'seeded', 'meetbook'];
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
  filters: { states: new Set(), fys: new Set(), types: new Set(), areas: new Set(), owners: new Set(), markets: new Set(), statuses: new Set(), priorities: new Set(), openingFYs: new Set(), schools: new Set(), schoolId: '', search: '', timing: '' },
  sb: { connected: false, client: null },
  auth: { user: null, profile: null, wired: false },
};

/* ---------- palette (spec colors) ---------- */
const STATE_COLOR = { NJ: '#002D9C', FL: '#005D5D' }; // Carbon categorical: Blue 80, Teal 70
// IBM Carbon throughout: Blue 60 for primary actions, support colors for status (see RAG), categorical palette for categories.
// Market palette: distinct hues, deliberately non-overlapping with status colors
// Category colors follow Carbon's data visualization palette (carbondesignsystem.com). Reds are skipped: red means "behind".
const MARKET_COLOR = { Newark: '#72C1EA', Camden: '#C8D651', Paterson: '#DB5139', 'Miami-Dade': '#EEA641', Broward: '#EEA641', Orange: '#1D2C5E', Orlando: '#1D2C5E' };   // KIPP brand colors by region (Nov 19 2026); Orange County uses KIPP navy
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
async function postNote(wrap, okAll) {
  if (!wrap || !canComment()) return;
  const draftTxt = (wrap.querySelector('#noteInput') || {}).value || '';
  if (hasAtAll(draftTxt) && !okAll) return confirmDialog({ title: `Notify everyone on ${boardName()}?`, message: '@all puts this comment in everyone\'s "Comments for you" and lights their bell. Use it for things the whole team needs to see.', confirmLabel: 'Post to everyone', onConfirm: () => postNote(wrap, true) });
  const kind = wrap.dataset.notekind, id = wrap.dataset.noteid;
  const inp = wrap.querySelector('#noteInput'), au = wrap.querySelector('#noteAuthor'), btn = wrap.querySelector('#noteAdd');
  const rs = resolveMentions((inp.value || '').trim()), text = rs.text; if (!text) { inp.focus(); return; }
  if (rs.unknown.length) toast(`Couldn't tag ${rs.unknown.join(', ')}: no single person matches. Pick names from the list as you type`, 'warn');
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
      if (!r.data || typeof r.data !== 'object') throw Object.assign(new Error('missing'), { code: 'GH_GONE' });
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
  const nN = (ent.noteLog || []).length, lb = wrap.querySelector('.notes-label'); if (lb) lb.textContent = `Comments (${nN})`;
  const tb = $('#mdTab-act'); if (tb) tb.textContent = `Comments (${nN})`;
  toast(nt.mentions && nt.mentions.includes('@all') ? `Posted. Everyone on ${boardName()} will see it` : nt.mentions && nt.mentions.length ? `Posted. ${nt.mentions.join(', ')} will see it on their dashboard` : 'Comment posted', 'ok');
}
function notesSection(kind, id, log) {
  const items = (log || []).slice().sort((a, b) => a.t - b.t).map(noteItemHtml).join('') || '<div class="note-empty muted">No comments yet</div>';
  return `<div class="notes-field" data-notekind="${kind}" data-noteid="${esc(id)}"><label class="notes-label" for="noteInput">Comments${(log || []).length ? ` (${(log || []).length})` : ''}</label>
    <div class="note-thread">${items}</div>
    <div class="note-add"><input id="noteAuthor" type="hidden" value="${esc(currentDisplayName())}"><input id="noteInput" maxlength="4000" class="note-input" placeholder="Add a comment" autocomplete="off" aria-label="Add a comment"><button class="btn btn-filled btn-sm" id="noteAdd">Post</button></div></div>`;
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
const CI_PATHS = { overflow: '<circle cx="16" cy="8" r="2"/><circle cx="16" cy="16" r="2"/><circle cx="16" cy="24" r="2"/>', chevron: '<path d="M16 22L6 12l1.4-1.4 8.6 8.6 8.6-8.6L26 12z"/>', add: '<path d="M17 15V8h-2v7H8v2h7v7h2v-7h7v-2z"/>', edit: '<path d="M2 26H30V28H2zM25.4 9c.8-.8.8-2 0-2.8 0 0 0 0 0 0l-3.6-3.6c-.8-.8-2-.8-2.8 0 0 0 0 0 0 0l-15 15V24h6.4L25.4 9zM20.4 4L24 7.6l-3 3L17.4 7 20.4 4zM6 22v-3.6l10-10 3.6 3.6-10 10H6z"/>', 'arrow-up': '<path d="M16 4L6 14 7.41 15.41 15 7.83 15 28 17 28 17 7.83 24.59 15.41 26 14 16 4z"/>', 'arrow-down': '<path d="M24.59 16.59L17 24.17 17 4 15 4 15 24.17 7.41 16.59 6 18 16 28 26 18 24.59 16.59z"/>', close: '<path d="M17.4141 16L24 9.4141 22.5859 8 16 14.5859 9.4143 8 8 9.4141 14.5859 16 8 22.5859 9.4143 24 16 17.4141 22.5859 24 24 22.5859 17.4141 16z"/>', flag: '<path d="M6,30H4V2H28l-5.8,9L28,20H6ZM6,18H24.33L19.8,11l4.53-7H6Z"/>', arrow: '<path d="M18 6L16.57 7.393 24.15 15 4 15 4 17 24.15 17 16.57 24.573 18 26 28 16 18 6z"/>', check: '<path d="M13 24L4 15 5.414 13.586 13 21.171 26.586 7.586 28 9 13 24z"/>' };
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
  if (missedCheckpoints(m).length || targetPace(m).behind) s = worseStatus(s, 'at_risk');
  if (targetPace(m).far) s = worseStatus(s, 'behind');
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

// Empty starting shape. Milestones, schools, owners and settings come from the database after sign-in,
// so the public site never serves staff or project data. Sample files load only on a local test server.
const LOCAL_DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const BASE_DATA = {"meta":{"brand":"KIPP Team & Family","title":"School Opening Timeline & Project Management","states":[{"code":"NJ","name":"New Jersey","markets":["Paterson","Newark","Camden"]},{"code":"FL","name":"Florida","markets":["Miami-Dade","Broward","Orange"]}],"markets":["Paterson","Newark","Camden","Miami-Dade","Broward","Orange"],"teams":["Regulatory","Real Estate","Finance","Fundraising","Talent","Marketing & Recruitment"],"statuses":["not_started","on_track","at_risk","behind","blocked","complete"],"version":20,"authMode":"supabase","statusMeta":{"not_started":{"label":"Not started","color":"#C7CCD6","text":"#4A4A4A"},"on_track":{"label":"On track","color":"#43B0E6","text":"#08324A"},"at_risk":{"label":"At risk","color":"#F6A11C","text":"#3A2A00"},"behind":{"label":"Behind","color":"#E63E2F","text":"#FFFFFF"},"complete":{"label":"Complete","color":"#4A8C1F","text":"#FFFFFF"},"blocked":{"label":"Blocked","color":"#B3261E","text":"#FFFFFF"}},"stages":[["to_do","To Do"],["in_progress","In Progress"],["in_review","In Review"],["complete","Complete"]],"priorities":["high","medium","low"],"functionalAreas":["Regulatory","Real Estate","Finance","Fundraising","Talent","Marketing & Recruitment"],"owners":[],"milestoneTemplates":[]},"schools":[],"campaigns":[],"milestones":[]};
async function loadData() {
  let base;
  if (window.__EMBEDDED_DATA__) base = JSON.parse(JSON.stringify(window.__EMBEDDED_DATA__));
  else if (!LOCAL_DEV) base = JSON.parse(JSON.stringify(BASE_DATA));   // live site: no data ships with the page; it all loads after sign-in
  else { try { base = await (await fetch('data.json', { cache: 'no-store' })).json(); } catch (e) { base = JSON.parse(JSON.stringify(BASE_DATA)); } }   // local testing only
  if (WS !== 'readiness') {   // another board: shared schools/owners/statuses, its own tasks and teams
    const cfg = WS_SEED[WS] || {};
    let seed = null;
    if (cfg.url && LOCAL_DEV) { try { seed = await (await fetch(cfg.url, { cache: 'no-store' })).json(); } catch (e) { console.warn('Board starting data not found:', e); } }
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
let saveWarned = false;
function autosave() {
  const b = $('#saveState'), live = state.sb && state.sb.connected;
  if (b) { b.textContent = live ? 'Syncing…' : 'Saving…'; b.className = 'save-state saving'; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { const ok = autosaveWriteLocal(); if (!ok && !saveWarned) { saveWarned = true; toast(live ? "This browser's storage is full. Changes still save for everyone" : "This browser's storage is full, so changes may not be kept. Download a backup in Settings", 'warn'); } if (live) sbPushDebounced(); if (b) { b.textContent = ok ? (live ? 'Synced • live' : 'All changes saved') : 'Save failed'; b.className = 'save-state ' + (ok ? 'saved' : 'err'); } }, 250);
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
/* ---------- Object model (Nov 19 2026) ----------
   School = principal object (region, type ES/MS/HS, county in FL or city in NJ, number, August opening).
   Milestone = team, deadline, owner; can count toward several schools. m.schoolDone = { schoolId: { by, t } }
   records each school's copy as done. Tasks (m.checkpoints) drive progress. When everything is checked off,
   the milestone is NOT completed silently: the user confirms it. */
const sdPending = m => (m.schoolIds || []).length > 1 ? m.schoolIds.filter(id => !(m.schoolDone || {})[id] && schoolById(id)) : [];
const doneForSchool = (m, s) => m.status === 'complete' || ((m.schoolIds || []).length > 1 && !!(m.schoolDone || {})[s.id]);
const msForSchool = (m, s) => m.status !== 'complete' && doneForSchool(m, s) ? Object.assign({}, m, { status: 'complete', progress_percent: 100, stage: 'complete' }) : m;
const schoolMsView = s => schoolMs(s).map(m => msForSchool(m, s));
function readyToComplete(m) {   // every part that can be checked off is checked off
  if (!m || m.status === 'complete') return '';
  const cps = (m.checkpoints || []).filter(c => c.title), sids = (m.schoolIds || []).filter(schoolById), tp = m.teamParts || [];
  const parts = [];
  if (cps.length) { if (cps.some(c => !c.done)) return ''; parts.push(cps.length === 1 ? 'its task is done' : `all ${cps.length} tasks are done`); }
  if (sids.length > 1) { if (sdPending(m).length) return ''; parts.push(`all ${sids.length} schools are checked off`); }
  if (tp.length) { if (teamsPending(m).length) return ''; parts.push('every team checked off its part'); }
  return parts.length ? parts.join(', ').replace(/^./, c => c.toUpperCase()) : '';
}
function completeMilestone(m, quiet) {
  if (blockIfTeamsOpen(m)) return false;
  snapshotForUndo('Complete: ' + (m.activity || '').slice(0, 30));
  m.status = 'complete'; m.progress_percent = 100; m.stage = 'complete'; touch(m);
  logActivity('status', `Marked "${m.activity}" complete`, { itemId: m.id });
  autosave(); rerender(); if (!quiet) toastAction('Marked complete' + unblockNote(m), 'Undo', undo);
  return true;
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-rc-done]'); if (!b) return;
  const m = findM(b.dataset.rcDone); if (!m || !guardEdit()) return;
  if (modalDirty) return toast('Save your changes first, then mark it complete', 'warn');
  if (completeMilestone(m)) closeModal();
});
function askToComplete(m, why) {
  confirmDialog({ title: 'Mark this milestone complete?', message: `${esc(why)} for <b>${esc(m.activity)}</b>. Confirm it is finished before it counts as complete.`, confirmLabel: 'Mark complete', onConfirm: () => completeMilestone(m) });
}

function passFilters(m) {
  const f = state.filters;
  if (f.states.size && !f.states.has(m.state)) return false;
  if (f.fys.size && !f.fys.has(m.targetFY)) return false;
  if (f.areas.size && !involvedTeams(m).some(t => f.areas.has(t))) return false;
  if (f.owners.size && !ownersOf(m).some(o => f.owners.has(o)) && !(f.owners.has('__none__') && !ownersOf(m).length)) return false;
  if (f.markets.size && !f.markets.has(m.market)) return false;
  if (f.statuses.size && !f.statuses.has(effectiveStatus(m))) return false;
  if (f.priorities.size && !f.priorities.has(m.priority)) return false;
  if (f.timing === 'due30') { if (!dueWithin30(m)) return false; }
  else if (f.timing === 'dueQ') { if (!dueThisQuarter(m)) return false; }
  else if (f.timing && timingLevel(m) !== f.timing) return false;
  if (f.flag && !flagPass(m, f.flag)) return false;
  if (f.openingFYs.size && m.openingFY && !f.openingFYs.has(m.openingFY)) return false;
  if (f.schools.size && ![...f.schools].some(id => { const sc = schoolById(id); return sc && taskInSchool(m, sc); })) return false;   // any of the picked schools
  if (f.search) { const hay = `${m.activity} ${m.workstream} ${m.functional_area} ${m.market} ${ownersOf(m).join(' ')} ${(m.tags || []).join(' ')} ${m.notes || ''} ${whereLabel(m)}`.toLowerCase(); if (!f.search.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))) return false; }   // every word must match, in any order
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
  if (key === 'states' || key === 'markets') [...state.filters.schools].forEach(id => { const sc = schoolById(id); if (!sc || !schoolFacetPass(sc, null)) state.filters.schools.delete(id); });
  if (key === 'areas') saveTeamScope();
}
function clearFilters() { ['states', 'fys', 'types', 'areas', 'owners', 'markets', 'statuses', 'priorities', 'openingFYs', 'schools'].forEach(k => state.filters[k].clear()); state.filters.schoolId = ''; state.filters.search = ''; state.filters.timing = ''; state.filters.flag = ''; const cb = $('#cbSearch'); if (cb) cb.value = ''; saveTeamScope(); }
// The Team lens is the one filter that follows a leader across pages (their "my function" scope),
// so it survives tab navigation and reloads. Everything else is transient to the current view.
function clearTransientFilters() { ['states', 'fys', 'types', 'owners', 'markets', 'statuses', 'priorities', 'openingFYs', 'schools'].forEach(k => state.filters[k].clear()); state.filters.schoolId = ''; state.filters.search = ''; state.filters.timing = ''; state.filters.flag = ''; const cb = $('#cbSearch'); if (cb) cb.value = ''; }
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
const FILTER_LABEL = { openingFYs: 'Opening year', states: 'State', types: 'Type', markets: 'Market', fys: 'Due year', areas: 'Team', owners: 'Owner', statuses: 'Status', priorities: 'Priority', schools: 'School' };
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
  if (key === 'openingFYs') return openingYears().map(fy => [String(fy), 'August ' + (fy - 1)]);
  if (key === 'schools') return state.data.schools.filter(s => s.openingFY && schoolFacetPass(s, null) && (!state.filters.fys.size || state.filters.fys.has(s.openingFY))).sort((a, b) => (a.openingFY - b.openingFY) || a.market.localeCompare(b.market) || String(a.display_label).localeCompare(String(b.display_label))).map(s => [s.id, `${s.market} · ${schLbl(s)}`, mkColor(s.market)]);
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
    const me = myOwnerName(), rest = [...present].filter(o => o !== me).sort((a, b) => a.localeCompare(b)).map(o => [o, o]);
    return [...(me && present.has(me) ? [[me, me + ' (me)']] : []), ['__none__', 'Unassigned'], ...rest];
  }
  if (key === 'statuses') return meta().statuses.map(s => [s, SM(s).label, SM(s).color]);
  if (key === 'priorities') return ['high', 'medium', 'low'].map(p => [p, PRIORITY[p].label, PRIORITY[p].color]);
  return [];
}
function activeCount() { let n = 0; ['states', 'types', 'markets', 'fys', 'areas', 'owners', 'statuses', 'priorities', 'openingFYs', 'schools'].forEach(k => n += state.filters[k].size); if (state.filters.search) n++; if (state.filters.timing) n++; if (state.filters.flag) n++; return n; }
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
  const school = opts.school ? (k => { const n = state.filters[k].size, val = n ? fbValueLabel(k) : ''; return `<button class="fb-menu ${n ? 'on' : ''}" data-fmenu="${k}"${val ? ` title="${esc('School: ' + [...state.filters[k]].map(v => fbValueLabel(k, v)).join(', '))}"` : ''}><span class="fb-name">School</span>${val ? `<span class="fb-val">${esc(val)}</span>` : ''}${n > 1 ? `<span class="fb-count">+${n - 1}</span>` : ''}</button>`; })('schools') : '';   // pick several schools (Nov 19 2026)
  const me = menus.includes('owners') ? myOwnerName() : '';
  const mine = me ? `<button class="fb-mine ${mineOn() ? 'on' : ''}" id="mineToggle" aria-pressed="${mineOn()}" title="Show only milestones owned by ${esc(me)}">${mineOn() ? CI('check') : ''}Assigned to you</button>` : '';
  return `<div class="filterbar" id="filterbar"><span class="fb-label">Filters</span>${search}${mine}${btns}${school}<button class="fb-clear ${activeCount() ? '' : 'is-empty'}" id="clearFilters"${activeCount() ? '' : ' disabled'}>Clear all</button><span class="fb-spacer"></span>${opts.right || ''}</div>`;
}
/* toggle chips to show / hide opening-year cohorts */
function openFilterMenu(anchor, key) {
  const set = state.filters[key];
  const fo = filterOpts(key), isOn = v => set.has(key === 'fys' || key === 'openingFYs' ? Number(v) : v), ordered = state._fmOrder && state._fmOrder.key === key ? state._fmOrder.list : (state._fmOrder = { key, list: fo.filter(o => isOn(o[0])).concat(fo.filter(o => !isOn(o[0]))) }).list;
  const html = `<div class="pop-list pop-checks" role="group" aria-label="${esc(FILTER_LABEL[key] || '')}">${ordered.map(([v, l, color]) => { const on = set.has(key === 'fys' || key === 'openingFYs' ? Number(v) : v); return `<label class="pop-check"><input type="checkbox" data-fkey="${key}" data-fval="${esc(v)}" ${on ? 'checked' : ''}>${color ? `<i class="fdot" style="background:${color}"></i>` : ''}${esc(l)}</label>`; }).join('')}</div>`;
  const p = openPopover(anchor, (fo.length > 10 ? `<input type="search" class="pop-find" placeholder="Find" aria-label="Find ${esc(FILTER_LABEL[key] || '')}">` : '') + html + (set.size ? `<button type="button" class="pop-clear" data-fclear="${key}">Clear selection</button>` : ''));
  p.classList.add('fm-pop'); p.style.minWidth = Math.max(256, anchor.offsetWidth) + 'px';
  const clr = p.querySelector('[data-fclear]'); if (clr) clr.addEventListener('click', () => { state.filters[key].clear(); closePopover(); rerender(); });
  const find = p.querySelector('.pop-find');
  if (find) { find.addEventListener('input', () => { const q = find.value.trim().toLowerCase(); p.querySelectorAll('.pop-check').forEach(r => { r.hidden = !!q && !r.textContent.toLowerCase().includes(q); }); }); setTimeout(() => find.focus(), 0); }
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
function refreshBody() { const kb0 = document.querySelector('.bd'), kbX = kb0 ? kb0.scrollLeft : 0; if (kbX) requestAnimationFrame(() => { const k = document.querySelector('.bd'); if (k) k.scrollLeft = kbX; }); const sec = $('#view-' + state.view); const b = sec ? sec.querySelector('#viewBody') : $('#viewBody'); if (state.view === 'meetings') return renderMeetings(); if (!b) return rerender(); if (state.view === 'progress') b.innerHTML = progressBodyHtml(); else if (state.view === 'timeline') b.innerHTML = ganttBodyHtml(); else b.innerHTML = planBodyHtml(); if (typeof paintAvatars === 'function') requestAnimationFrame(() => paintAvatars(b)); if (typeof updateFilterBubble === 'function') updateFilterBubble(); }
function otCard(s) {
  const sm = schoolMsView(s), r = ragReady(sm), n = sm.length;
  const done = sm.filter(m => effectiveStatus(m) === 'complete').length;
  const pct = avgProgress(sm);
  const mk = mkColor(s.market);
  const opens = s.opening_date ? parseDate(s.opening_date) : null;
  const mo = opens ? Math.max(0, monthsBetween(today(), opens)) : null;
  // Group header already announces "Fall YYYY · N months out" - only surface a card-level date when unscheduled.
  const when = s.openingFY ? '' : 'Opening not scheduled';
  const openDue = sm.filter(m => m.due_date && effectiveStatus(m) !== 'complete'), late = openDue.filter(m => daysUntil(m.due_date) < 0).length;
  const nextM = openDue.slice().sort((a, b) => a.due_date.localeCompare(b.due_date))[0], nextDue = nextM && nextM.due_date;
  const nextLbl = nextDue ? parseDate(nextDue).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const statusLbl = n === 0 ? 'Not yet scoped' : r.label.split(' · ')[0];   // "On track" / "At risk" / "Behind" / "Complete" / "Not started"
  return `<article class="ot-card" data-drillschool="${esc(s.id)}" style="--mk:${mk}">
      <div class="ot-head">
        <h4 class="ot-title">${esc(schLbl(s))}<small>${esc(schoolFacts(s))}</small></h4>
        ${n ? statusLozenge(rollupStatus(sm)) : `<span class="stpill st-not_started"><i></i>Not yet scoped</span>`}
      </div>
      ${when ? `<p class="ot-when">${esc(when)}</p>` : ''}
      ${n ? `<div class="ot-prog">
        <div class="ot-prog-lbl"><b>${done} of ${n}</b> ${n === 1 ? "milestone" : "milestones"} done<span class="ot-prog-pct" title="Average progress across this school's milestones">${pct}%</span></div>
        <div class="ot-prog-bar"><span style="width:${pct}%"></span></div>
        ${late ? `<div class="ot-late">${late} past due</div>` : nextLbl ? `<div class="ot-next" title="${esc(nextM ? nextM.activity : '')}">Next due ${esc(nextLbl)}</div>` : ''}
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
        <div class="ot-term-h"><h3><button type="button" class="ot-year" data-drilldim="openingFY" data-drillval="${fy}" title="Open August ${fy - 1} milestones">August ${fy - 1}</button></h3><span class="ot-when">${when} · ${cs.length} school${cs.length === 1 ? '' : 's'}${((k) => k ? ` · <span class="ot-when-bad">${k} at risk or behind</span>` : '')(cs.filter(sc => ['red', 'yellow'].includes(ragReady(schoolMs(sc)).key)).length)}</span></div>
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
      ${isAdmin() ? `<button class="btn btn-filled" id="addSchool"><svg viewBox="0 0 32 32" fill="currentColor" width="16" height="16"><path d="M17 15L17 8 15 8 15 15 8 15 8 17 15 17 15 24 17 24 17 17 24 17 24 15z"/></svg>Add school opening</button>` : ''}
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
// Dashboard filters (Nov 19 2026): collapsed by default behind one Filter button; active filters still show as chips.
function dashFiltersHtml(printBtn) {
  const open = state.dashFOpen === true, n = activeCount();
  const ic = '<svg viewBox="0 0 32 32" fill="currentColor" width="16" height="16" aria-hidden="true"><path d="M18,28H14a2,2,0,0,1-2-2V18.41L4.59,11A2,2,0,0,1,4,9.59V6A2,2,0,0,1,6,4H26a2,2,0,0,1,2,2V9.59A2,2,0,0,1,27.41,11L20,18.41V26A2,2,0,0,1,18,28ZM6,6V9.59l8,8V26h4V17.59l8-8V6Z"/></svg>';
  return `<div class="dash-filters ${open ? 'is-open' : 'is-collapsed'}" id="dashFilters">
    <div class="df-bar"><button type="button" class="btn btn-ghost btn-sm df-toggle" id="dashFiltToggle" aria-expanded="${open}" aria-controls="filterbar">${ic}${open ? 'Hide filters' : 'Filter'}${n ? `<span class="df-n">${n}</span>` : ''}</button>${open ? '' : appliedFilterChips()}<span class="fb-spacer"></span>${printBtn}</div>
    ${open ? filterBar(hasSchoolWork() ? ['openingFYs', 'states', 'markets', 'areas', 'owners'] : ['states', 'markets', 'areas', 'owners'], { right: appliedFilterChips({ hiddenOnly: true }) }) : ''}</div>`;
}
document.addEventListener('click', e => { if (!e.target.closest || !e.target.closest('#dashFiltToggle')) return; state.dashFOpen = !state.dashFOpen; rerender(); setTimeout(() => { const b = $('#dashFiltToggle'); if (b) b.focus(); }, 0); });
function renderProgress() {
  const printBtn = `<button class="btn btn-ghost btn-sm" id="planLink">Copy link</button><button class="btn btn-ghost btn-sm" id="dashPrint"><svg viewBox="0 0 32 32" fill="currentColor" width="16" height="16"><path d="M28,9H25V3H7V9H4a2,2,0,0,0-2,2V21a2,2,0,0,0,2,2H7v6H25V23h3a2,2,0,0,0,2-2V11A2,2,0,0,0,28,9ZM9,5H23V9H9ZM23,27H9V17H23Zm5-6H25V15H7v6H4V11H28Z"/></svg><span class="pr-l">Print report</span></button>`;
  // Filter bar is always visible on the dashboard: it's a primary scoping control, not an occasional detour.
  // Menus kept to what changes the STATUS picture: State, Market, Workstream. Opening year lives on the cohort strip;
  // status/priority filters belong to the Project Plan (the dashboard IS the status/priority view).
  $('#view-progress').innerHTML = `
    ${dashFiltersHtml(printBtn)}
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
  if (!opts.hiddenOnly) f.openingFYs.forEach(v => push('August ' + (v - 1), 'openingFYs:' + v));
  f.statuses.forEach(v => push(SM(v).label, 'statuses:' + v));
  if (f.timing) push(f.timing === 'overdue' ? 'Overdue' : f.timing === 'this_month' ? 'Due within 2 weeks' : f.timing === 'due30' ? 'Due in 30 days' : f.timing === 'dueQ' ? 'Due by end of ' + fiscalQuarter().q : 'Due soon', 'timing:');
  if (f.flag) push(FLAG_LABEL[f.flag] || f.flag, 'flag:');
  if (f.search && state.view !== 'plan') push('“' + f.search.slice(0, 24) + (f.search.length > 24 ? '…' : '') + '”', 'search:');
  f.schools.forEach(id => { const sc = schoolById(id); if (sc) push(sc.market + ' · ' + schLbl(sc), 'schools:' + id); });
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
/* Board (Nov 20 2026 overhaul): Carbon tiles on Carbon layer-01 columns. Card reads top to bottom:
   tags, title, where (market · school · team), when (due date, tasks, comments), progress, then status and owners.
   One overflow menu per card holds Open, Mark complete and Move to, so keyboard and touch users never need to drag. */
const BD_IC = {
  cal: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M26,4h-4V2h-2v2h-8V2h-2v2H6C4.9,4,4,4.9,4,6v20c0,1.1,.9,2,2,2h20c1.1,0,2-.9,2-2V6C28,4.9,27.1,4,26,4z M26,26H6V12h20V26z M26,10H6V6h4v2h2V6h8v2h2V6h4V10z"/></svg>',
  warn: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16,2A14,14,0,1,0,30,16,14,14,0,0,0,16,2Zm-1.1,6h2.2V19H14.9ZM16,25a1.5,1.5,0,1,1,1.5-1.5A1.5,1.5,0,0,1,16,25Z"/></svg>',
  chat: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M17.74,30,16,29l4-7h6a2,2,0,0,0,2-2V8a2,2,0,0,0-2-2H6A2,2,0,0,0,4,8V20a2,2,0,0,0,2,2h9v2H6a4,4,0,0,1-4-4V8A4,4,0,0,1,6,4H26a4,4,0,0,1,4,4V20a4,4,0,0,1-4,4H21.16Z"/><path d="M8 10H24V12H8zM8 16H18V18H8z"/></svg>',
  team: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M31 30H29V27a3 3 0 00-3-3H22a3 3 0 00-3 3v3H17V27a5 5 0 015-5h4a5 5 0 015 5zM24 12a3 3 0 11-3 3 3 3 0 013-3m0-2a5 5 0 105 5A5 5 0 0024 10zM15 22H13V19a3 3 0 00-3-3H6a3 3 0 00-3 3v3H1V19a5 5 0 015-5h4a5 5 0 015 5zM8 4A3 3 0 115 7 3 3 0 018 4M8 2a5 5 0 105 5A5 5 0 008 2z"/></svg>',
  time: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16,30A14,14,0,1,1,30,16,14,14,0,0,1,16,30ZM16,4A12,12,0,1,0,28,16,12,12,0,0,0,16,4Z"/><path d="M20.59 22L15 16.41 15 7 17 7 17 15.58 22 20.59 20.59 22z"/></svg>',
  task: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M14 20.18L10.41 16.59 9 18 14 23 23 14 21.59 12.58 14 20.18z"/><path d="M25,5H22V4a2,2,0,0,0-2-2H12a2,2,0,0,0-2,2V5H7A2,2,0,0,0,5,7V28a2,2,0,0,0,2,2H25a2,2,0,0,0,2-2V7A2,2,0,0,0,25,5ZM12,4h8V8H12ZM25,28H7V7h3v3H22V7h3Z"/></svg>'
};
function boardCard(m) {
  const es = effectiveStatus(m), done = es === 'complete', p = curProgress(m), d = m.due_date ? daysUntil(m.due_date) : null, late = !done && d != null && d < 0, soon = !done && d != null && d >= 0 && d <= 14;
  const sch = (m.schoolIds || []).map(schoolById).filter(Boolean), mk = sch.length ? sch[0].market : m.market;
  const whereTip = sch.length > 1 ? sch.map(x => x.market + ' · ' + schLbl(x)).join(', ') : '';
  const reasons = watermelonReasons(m), nc = (m.noteLog || []).length, own = ownersOf(m);
  const dueTxt = done ? (m.completedAt ? 'Completed ' + fmtDate(m.completedAt.slice(0, 10)) : 'Completed') : m.due_date ? (late ? `${-d} day${d === -1 ? '' : 's'} late` : d === 0 ? 'Due today' : 'Due ' + fmtDate(m.due_date)) : 'No due date';
  const cps = m.checkpoints || [], tasks = !done && cps.length ? `${cps.filter(c => c.done).length}/${cps.length}` : '';
  const tags = (m.keyMilestone ? '<span class="bd-tag is-blue">Key</span>' : '')
    + (reasons.length ? `<span class="bd-tag is-red" title="${esc(reasons.join('\n'))}">Needs attention</span>` : '')
    + (m.dueRequest ? `<span class="bd-tag is-purple" title="Requested ${esc(fmtDate(m.dueRequest.to))}">Date change pending</span>` : '');
  // 2 x 2 grid: where, team, when, who. Labels are quiet; values carry the weight.
  const cell = (lbl, val, cls, tip) => `<div class="bd-cell ${cls || ''}"${tip ? ` title="${esc(tip)}"` : ''}><dt>${lbl}</dt><dd>${val}</dd></div>`;
  const place = sch.length ? `${esc(schLbl(sch[0]))}${sch.length > 1 ? ` +${sch.length - 1}` : ''}` : esc(mk || 'Network-wide');
  const dueVal = done ? (m.completedAt ? fmtDate(m.completedAt.slice(0, 10)) : 'Yes') : m.due_date ? (late ? `${-d} day${d === -1 ? '' : 's'} late` : d === 0 ? 'Today' : fmtDate(m.due_date)) : 'None';
  const grid = cell('School', `${mk ? `<i class="bd-dot" style="background:${mkColor(mk)}" aria-hidden="true"></i>` : ''}<span>${place}</span>`, 'is-wide', whereTip || (sch.length ? sch[0].market : ''))
    + cell('Team', `<span>${esc(m.functional_area || 'None')}</span>`)
    + cell(done ? 'Completed' : 'Due', `<span>${esc(dueVal)}</span>`, late ? 'is-late' : soon ? 'is-soon' : '', m.due_date && !done ? 'Due ' + fmtDate(m.due_date) : '');
  const countEl = (tasks ? `<span title="Tasks done">${BD_IC.task}${tasks}</span>` : '') + (nc ? `<span title="${nc} comment${nc === 1 ? '' : 's'}">${BD_IC.chat}${nc}</span>` : '');
  const label = `${m.activity}. ${SM(es).label}. ${dueTxt}${own.length ? '. Owner ' + own.join(', ') : ''}`;
  return `<article class="bd-card ${done ? 'is-done' : ''} ${state.sel && state.sel.has(m.id) ? 'is-sel' : ''}" draggable="${canEdit()}" data-id="${m.id}" data-expand="${m.id}" tabindex="0" aria-label="${esc(label)}">
    ${tags ? `<div class="bd-tags">${tags}</div>` : ''}
    <div class="bd-title">${esc(m.activity)}</div>
    <dl class="bd-grid">${grid}</dl>
    ${!done && p > 0 ? `<div class="bd-prog"><div class="bd-bar" role="progressbar" aria-label="Progress" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div><span>${p}%</span></div>` : ''}
    <div class="bd-foot">
      ${canEdit() ? `<button type="button" class="bd-status" data-qstatus="${m.id}" aria-haspopup="true" aria-label="Status: ${esc(SM(es).label)}. Change status">${statusDot(es)}<span>${esc(SM(es).label)}</span>${CI('chevron')}</button>` : `<span class="bd-status is-ro">${statusDot(es)}<span>${esc(SM(es).label)}</span></span>`}
      <span class="bd-own" title="${esc(own.join(', ') || 'No owner')}">${own.length ? `${personChip(own[0])}<span class="bd-ownn">${esc(own[0].split(/\s+/)[0])}${own.length > 1 ? ` +${own.length - 1}` : ''}</span>` : '<span class="bd-none">No owner</span>'}</span>
      <span class="bd-counts">${countEl}</span>
    </div>
    <button type="button" class="bd-menu" data-bdmenu="${m.id}" aria-haspopup="true" aria-expanded="false" aria-label="Actions for ${esc(m.activity)}" title="Actions">${CI('overflow')}</button>
  </article>`;
}
const BD_DONE_SHOW = 8;
const BD_COL_IC = {
  to_do: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2.2"/></svg>',
  in_progress: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor"/></svg>',
  in_review: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M30.94,15.66A16.69,16.69,0,0,0,16,5,16.69,16.69,0,0,0,1.06,15.66a1,1,0,0,0,0,.68A16.69,16.69,0,0,0,16,27,16.69,16.69,0,0,0,30.94,16.34,1,1,0,0,0,30.94,15.66ZM16,25c-5.3,0-10.9-3.93-12.93-9C5.1,10.93,10.7,7,16,7s10.9,3.93,12.93,9C26.9,21.07,21.3,25,16,25Z"/><path d="M16,10a6,6,0,1,0,6,6A6,6,0,0,0,16,10Zm0,10a4,4,0,1,1,4-4A4,4,0,0,1,16,20Z"/></svg>',
  complete: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M14 21.414L9 16.413 10.413 15 14 18.586 21.585 11 23 12.415 14 21.414z"/><path d="M16,2A14,14,0,1,0,30,16,14,14,0,0,0,16,2Zm0,26A12,12,0,1,1,28,16,12,12,0,0,1,16,28Z"/></svg>'
};
function planKanbanHtml() {
  const list = filtered(), stages = meta().stages, edit = canEdit();
  const none = !list.length && M().length ? '<div class="empty-state">No milestones match these filters<button class="btn btn-tonal btn-sm" data-clearfilters>Clear filters</button></div>' : '';
  const byStage = sk => list.filter(m => (m.stage || 'to_do') === sk).sort(sk === 'complete' ? (a, b) => (b.completedAt || '').localeCompare(a.completedAt || '') : (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  const tabs = `<div class="bd-tabs" role="tablist" aria-label="Board columns">${stages.map(([sk, label], i) => `<button type="button" role="tab" class="bd-tab ${i === (state.kbCol || 0) ? 'on' : ''}" aria-selected="${i === (state.kbCol || 0)}" data-kbjump="${i}">${esc(label)}<span class="bd-count">${byStage(sk).length}</span></button>`).join('')}</div>`;
  return none + tabs + '<div class="bd" role="list" aria-label="Milestones board">' + stages.map(([sk, label]) => {
    const all = byStage(sk), ck = 'kc:' + sk, open = !state.expanded[ck], late = all.filter(m => effectiveStatus(m) !== 'complete' && m.due_date && daysUntil(m.due_date) < 0).length;
    const capped = sk === 'complete' && !state.expanded['kcall:' + sk] && all.length > BD_DONE_SHOW, cards = capped ? all.slice(0, BD_DONE_SHOW) : all;
    return `<section class="bd-col ${open ? '' : 'is-collapsed'}" role="listitem" aria-label="${esc(label)}, ${all.length} milestone${all.length === 1 ? '' : 's'}">
      <header class="bd-head">
        <button type="button" class="bd-collapse" data-toggle="${esc(ck)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(label)}" title="${open ? 'Collapse' : 'Expand'}">${CI('chevron')}</button>
        <span class="bd-colic bd-colic-${esc(sk)}" aria-hidden="true">${BD_COL_IC[sk] || BD_COL_IC.to_do}</span><h3 class="bd-name">${esc(label)}</h3><span class="bd-count">${all.length}</span>${late ? `<span class="bd-late" title="${late} overdue">${late} late</span>` : ''}
        ${edit ? `<button type="button" class="bd-add" data-addstage="${esc(sk)}" aria-label="Add milestone to ${esc(label)}" title="Add milestone">${CI('add')}</button>` : ''}
      </header>
      <div class="bd-body" data-kstage="${sk}">${cards.map(boardCard).join('')}${all.length ? '' : `<p class="bd-empty">No milestones</p>`}${capped ? `<button type="button" class="bd-showall" data-toggle="kcall:${esc(sk)}">Show all ${all.length}</button>` : sk === 'complete' && all.length > BD_DONE_SHOW ? `<button type="button" class="bd-showall" data-toggle="kcall:${esc(sk)}">Show fewer</button>` : ''}<div class="bd-drop" aria-hidden="true">Drop here</div></div>
    </section>`;
  }).join('') + '</div>';
}
function openBoardMenu(btn) {
  const m = findM(btn.dataset.bdmenu); if (!m) return;
  const edit = canEdit(), done = effectiveStatus(m) === 'complete', cur = m.stage || 'to_do';
  const html = `<div class="pop-list" role="menu"><button type="button" class="pop-item" role="menuitem" data-bdact="open">Open</button>${edit && !done ? '<button type="button" class="pop-item" role="menuitem" data-bdact="done">Mark complete</button>' : ''}</div>${edit ? `<div class="pop-title">Move to</div><div class="pop-list" role="menu">${meta().stages.filter(([k]) => k !== cur).map(([k, l]) => `<button type="button" class="pop-item" role="menuitem" data-kmoveto="${esc(k)}">${esc(l)}</button>`).join('')}</div>` : ''}`;
  const p = openPopover(btn, html); btn.setAttribute('aria-expanded', 'true');
  p.addEventListener('click', e => {
    const it = e.target.closest('[data-bdact], [data-kmoveto]'); if (!it) return; closePopover(); btn.setAttribute('aria-expanded', 'false');
    if (it.dataset.kmoveto) { if (guardEdit()) moveToStage(m, it.dataset.kmoveto); return; }
    if (it.dataset.bdact === 'open') return openModal(m.id);
    if (!guardEdit()) return; const card = btn.closest('.bd-card'); moOut(card, 140).then(() => { if (!completeMilestone(m) && card) card.style.opacity = ''; });
  });
  const f = p.querySelector('.pop-item'); if (f) f.focus();
}
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-bdmenu]'); if (!b) return; e.stopPropagation(); e.preventDefault(); openBoardMenu(b); }, true);
document.addEventListener('keydown', e => { const c = e.target.classList && e.target.classList.contains('bd-card') ? e.target : null; if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openModal(c.dataset.id); } });
/* Milestones list (Nov 20 2026): a Carbon data table per section. One row per milestone:
   name with where it applies, due, progress, status (click to change), owner. Click a row to open it. */
function mlWhere(m, hideTeam) {
  const sch = (m.schoolIds || []).map(schoolById).filter(Boolean);
  const names = sch.length ? (sch.length <= 2 ? sch.map(schLbl).join(', ') : `${sch.length} schools`) : (m.market || 'Network-wide');
  return [names, hideTeam ? '' : m.functional_area].filter(Boolean).join(' · ');
}
function mlRow(m, opts = {}) {
  const es = effectiveStatus(m), done = es === 'complete', p = curProgress(m), d = m.due_date ? daysUntil(m.due_date) : null, late = !done && d != null && d < 0;
  const sch = (m.schoolIds || []).map(schoolById).filter(Boolean), tip = sch.length > 2 ? sch.map(x => x.market + ' · ' + schLbl(x)).join(', ') : '';
  const reasons = watermelonReasons(m), own = ownersOf(m);
  const tags = (m.keyMilestone ? '<span class="bd-tag is-blue">Key</span>' : '')
    + (reasons.length ? `<span class="bd-tag is-red" title="${esc(reasons.join('\n'))}">Needs attention</span>` : '')
    + (m.dueRequest ? `<span class="bd-tag is-purple" title="Requested ${esc(fmtDate(m.dueRequest.to))}">Date change pending</span>` : '');
  const due = done ? (m.completedAt ? fmtDate(m.completedAt.slice(0, 10)) : 'Done') : m.due_date ? fmtDate(m.due_date) : '';
  return `<tr class="ml-row ${done ? 'is-done' : ''} ${state.sel && state.sel.has(m.id) ? 'is-sel' : ''}" data-id="${m.id}" data-expand="${m.id}" tabindex="0" aria-label="${esc(m.activity)}">
    <td class="ml-name"><div class="ml-t">${esc(m.activity)}</div><div class="ml-sub"${tip ? ` title="${esc(tip)}"` : ''}>${esc(mlWhere(m, opts.hideTeam))}${tags ? `<span class="ml-tags">${tags}</span>` : ''}</div></td>
    <td class="ml-due ${late ? 'is-late' : ''}">${due ? `<span>${esc(due)}</span>${late ? `<small>${-d} day${d === -1 ? '' : 's'} late</small>` : done ? '<small>Completed</small>' : ''}` : '<span class="ml-muted">No date</span>'}</td>
    <td class="ml-prog">${done || measureOf(m) === 'binary' ? '' : `<div class="bd-prog"><div class="bd-bar" role="progressbar" aria-label="Progress" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div><span>${p}%</span></div>`}</td>
    <td class="ml-st">${canEdit() ? `<button type="button" class="bd-status" data-qstatus="${m.id}" aria-haspopup="true" aria-label="Status: ${esc(SM(es).label)}. Change status">${statusDot(es)}<span>${esc(SM(es).label)}</span>${CI('chevron')}</button>` : `<span class="bd-status is-ro">${statusDot(es)}<span>${esc(SM(es).label)}</span></span>`}</td>
    <td class="ml-own"><span class="bd-own">${own.length ? personChip(own[0]) + `<span class="ml-owner">${esc(own[0])}${own.length > 1 ? ` +${own.length - 1}` : ''}</span>` : '<span class="bd-none">Unassigned</span>'}</span></td>
  </tr>`;
}
function mlTable(list, opts = {}) {
  return `<table class="ml"><thead><tr><th scope="col" class="ml-name">Milestone</th><th scope="col" class="ml-due">Due</th><th scope="col" class="ml-prog">Progress</th><th scope="col" class="ml-st">Status</th><th scope="col" class="ml-own">Owner</th></tr></thead><tbody>${list.map(m => mlRow(m, opts)).join('')}</tbody></table>`;
}
document.addEventListener('keydown', e => { const r = e.target.classList && e.target.classList.contains('ml-row') ? e.target : null; if (r && (e.key === 'Enter' || e.key === ' ') && !state.sel) { e.preventDefault(); openModal(r.dataset.id); } });
function planFocusHtml() {
  const list = attentionItems(filtered());   // already most urgent first
  if (!list.length) return '<div class="empty-state">Nothing needs attention in this view</div>';
  return `<div class="plan-focus-note">${list.length} need${list.length === 1 ? 's' : ''} attention, most urgent first</div><div class="ml-wrap">${mlTable(list)}</div>`;
}
/* ---- Teams involved: each team checks off its part ---- */
function involvedTeams(m) { const p = m.teamParts || []; return p.length ? p.map(x => x.team) : [m.functional_area]; }
function teamsPending(m) { return (m.teamParts || []).filter(x => !x.done); }
function blockIfTeamsOpen(m) { const sp = sdPending(m); if (sp.length) { toast(`${sp.map(id => { const sc = schoolById(id); return sc.market + ' · ' + schLbl(sc); }).join(', ')} still need${sp.length === 1 ? 's' : ''} to be checked off`, 'err'); return true; } const o = teamsPending(m); if (!o.length) return false; toast(`${o.map(x => x.team).join(', ')} still need${o.length === 1 ? 's' : ''} to check off ${o.length === 1 ? 'its' : 'their'} part`, 'err'); return true; }
function tpRow(team, p, lead) { return `<div class="tp-row" data-team="${esc(team)}"><label class="field-check"><input type="checkbox" class="tp-done" ${p && p.done ? 'checked' : ''}> ${esc(team)}${lead ? ' <span class="muted">(lead team)</span>' : ''}</label>${p && p.done && p.by ? `<span class="tp-by">${esc(p.by)}</span>` : ''}${lead ? '' : `<button type="button" class="tp-del" aria-label="Remove ${esc(team)}">&times;</button>`}</div>`; }
function schoolDoneBlock(m) {
  const sids = (m.schoolIds || []).filter(schoolById); if (sids.length < 2 || m._draft) return '';
  const done = m.schoolDone || {};
  return `<div class="field" id="sdWrap"><div class="sd-list">${sids.map(id => { const sc = schoolById(id), d = done[id]; return `<label class="field-check sd-row"><input type="checkbox" class="sd-done" value="${esc(id)}" ${d ? 'checked' : ''}><span>${schoolChip(sc.market, [schLbl(sc)])}${d ? `<small class="muted"> · done${d.by ? ' by ' + esc(d.by) : ''}, ${esc(fmtDate(d.t.slice(0, 10)))}</small>` : ''}</span></label>`; }).join('')}</div></div>`;
}
function teamPartsBlock(m) {
  const parts = m.teamParts || [];
  return `<div class="field" id="tpWrap"><label for="tpAdd">Teams involved</label><div id="tpList">${parts.map(p => tpRow(p.team, p, p.team === m.functional_area)).join('')}</div><select id="tpAdd"><option value="">Add another team</option>${teams().filter(t => t !== m.functional_area && !parts.some(p => p.team === t)).map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></div>`;
}
/* ---- Date changes: owners propose, an admin approves ---- */
function dueReq(from, to, why) { return { from, to, why: why || '', by: currentDisplayName() || '', t: new Date().toISOString() }; }
function dueRequests() { return M().filter(m => m.dueRequest && !m._draft); }
// Date change request card (Nov 20 2026): who asked, when, from and to, why, and what approving changes.
function drFq(iso) { const d = /^(\d{4})-(\d{2})/.exec(iso || ''); return d ? `${fqOfMonth(+d[2] - 1)} FY${String(fyOfMonth(+d[1], +d[2] - 1)).slice(2)}` : ''; }
function drImpact(m, r) {
  const out = [], t = todayISO(), shift = daysBetween(parseDate(r.from), parseDate(r.to));
  out.push(`The due date becomes <b>${esc(fmtDate(r.to))}</b>, ${Math.abs(shift)} day${Math.abs(shift) === 1 ? '' : 's'} ${shift >= 0 ? 'later' : 'earlier'}.`);
  if (r.from < t && r.to >= t && m.status !== 'complete') out.push('It is no longer overdue.');
  else if (r.to < t && m.status !== 'complete') out.push('It stays overdue: the new date has already passed.');
  if (drFq(r.from) !== drFq(r.to)) out.push(`It moves from ${esc(drFq(r.from))} to ${esc(drFq(r.to))} in reports.`);
  (m.schoolIds || []).map(schoolById).filter(sc => sc && sc.opening_date && r.to > sc.opening_date && !(r.from > sc.opening_date)).forEach(sc => out.push(`<span class="dr-warn">It lands after ${esc(sc.market)} · ${esc(schLbl(sc))} opens on ${esc(fmtDate(sc.opening_date))}.</span>`));
  const deps = M().filter(x => (x.blockedBy || []).includes(m.id) && x.status !== 'complete' && x.due_date && x.due_date < r.to);
  if (deps.length) out.push(`<span class="dr-warn">${deps.length === 1 ? '1 milestone that waits on this is' : `${deps.length} milestones that wait on this are`} due before then: ${deps.slice(0, 3).map(x => esc(clip(x.activity, 60))).join('; ').replace(/[.…]$/, '')}${deps.length > 3 ? ', and more' : ''}.</span>`);
  const late = (m.checkpoints || []).filter(c => !c.done && c.due && c.due > r.to);
  if (late.length) out.push(`${late.length} task${late.length === 1 ? ' is' : 's are'} dated after the new date.`);
  out.push('The move is recorded in its history.');
  return out;
}
function dueReqBanner(m, withName) {
  const r = m.dueRequest; if (!r) return '';
  const shift = daysBetween(parseDate(r.from), parseDate(r.to)), admin = isAdmin();
  return `<section class="dr-card" data-mo="dr-${esc(m.id)}" aria-label="Due date change request${withName ? ' for ' + esc(m.activity) : ''}">
    <div class="dr-h"><span class="dr-h-t">${CAL_IC}<b>Due date change requested</b></span><span class="dr-tag">${admin ? 'Needs your decision' : 'Waiting for an admin'}</span></div>
    ${withName ? `<button type="button" class="dr-name ag-link" data-expand="${esc(m.id)}">${esc(m.activity)}</button>` : ''}
    <dl class="dr-dl">
      <div><dt>Requested by</dt><dd>${esc(r.by || 'Someone')}${r.t ? ` <span class="dr-muted">· ${esc(fmtWhen(r.t))}</span>` : ''}</dd></div>
      <div><dt>Change</dt><dd><span class="dr-old">${esc(fmtDate(r.from))}</span> <span aria-hidden="true">→</span><span class="sr-only">to</span> <b>${esc(fmtDate(r.to))}</b> <span class="dr-shift">${shift >= 0 ? '+' : '−'}${Math.abs(shift)} day${Math.abs(shift) === 1 ? '' : 's'}</span></dd></div>
      <div><dt>Reason</dt><dd>${r.why ? esc(r.why) : '<span class="dr-muted">No reason given</span>'}</dd></div>
    </dl>
    ${admin ? `<div class="dr-acts"><button type="button" class="btn btn-tonal btn-sm" data-due-decide="${esc(m.id)}|0">Decline, keep ${esc(fmtDate(r.from))}</button><button type="button" class="btn btn-filled btn-sm" data-due-decide="${esc(m.id)}|1">Approve ${esc(fmtDate(r.to))}</button></div>` : `<p class="dr-note">The due date stays ${esc(fmtDate(r.from))} until an admin decides.</p>`}
  </section>`;
}
function decideDue(id, ok) {
  if (!isAdmin()) { toast('Only admins approve date changes', 'err'); return; }
  const m = findM(id); if (!m || !m.dueRequest) return; const r = m.dueRequest;
  snapshotForUndo((ok ? 'Approve' : 'Decline') + ' date: ' + (m.activity || '').slice(0, 30));
  if (ok && r.to !== m.due_date) { (m.dateHistory = m.dateHistory || []).push({ t: new Date().toISOString(), by: r.by, from: m.due_date || r.from, to: r.to, reason: r.why, approvedBy: currentDisplayName() || '' }); m.due_date = r.to; syncFiscal(m); }
  delete m.dueRequest; touch(m);
  logActivity('edit', `${ok ? 'Approved' : 'Declined'} new date for "${m.activity}"`, { itemId: m.id });
  autosave(); rerender(); toast(ok ? `Due date moved to ${fmtDate(r.to)}` : 'Request declined. The date stays the same');
  if (modalId === id && $('#modalBody')) { closeModal(); openModal(id); }
  if ($('#sheetBackdrop .dr-list')) openDueRequests();
}
document.addEventListener('click', e => { const d = e.target.closest('[data-due-decide]'); if (!d) return; e.preventDefault(); e.stopPropagation(); const [id, ok] = d.dataset.dueDecide.split('|'); decideDue(id, ok === '1'); }, true);
function openDueRequests() {
  const rows = dueRequests().sort((a, b) => a.dueRequest.t.localeCompare(b.dueRequest.t)).map(m => dueReqBanner(m, true)).join('');
  const w = openSheet('Date change requests', `<div class="dr-list">${rows || '<p class="muted">No requests waiting</p>'}</div>`, '<button class="btn btn-filled" data-sheet-close>Done</button>');
  if (w) w.addEventListener('click', e => { const x = e.target.closest('[data-expand]'); if (x) { closeSheet(); openModal(x.dataset.expand); } });
}
/* ---- Definitions (draft wording, pending NGC sign-off) ---- */
document.addEventListener('click', e => {   // Milestones "More" menu (Nov 19 2026)
  const b = e.target.closest && e.target.closest('#planMore'); if (!b) return;
  const items = [['planLink', 'Copy link to this view'], ['planCsv', 'Export to Excel'], ['defs', 'Definitions']];
  const p = openPopover(b, `<div class="pop-list" role="menu">${items.map(([k, l]) => `<button type="button" class="pop-item" role="menuitem" data-pm="${k}">${l}</button>`).join('')}</div>`);
  b.setAttribute('aria-expanded', 'true');
  p.addEventListener('click', ev => { const it = ev.target.closest('[data-pm]'); if (!it) return; closePopover(); b.setAttribute('aria-expanded', 'false'); const src = document.querySelector('#view-plan .plan-more-src'); const t = it.dataset.pm === 'defs' ? src && src.querySelector('[data-open-defs]') : src && src.querySelector('#' + it.dataset.pm); if (t) t.click(); });
  const f = p.querySelector('[data-pm]'); if (f) f.focus();
});
function openDefinitions() {
  const sec = (h, rows) => `<h4 class="def-h">${h}</h4><dl class="def-list">${rows.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl>`;
  openSheet('Definitions', `
    ${sec('Status', [['Not started', 'Work has not begun.'], ['On track', 'Will finish by the due date.'], ['At risk', 'May miss the due date without help.'], ['Behind', 'Will miss, or has missed, the due date.'], ['Blocked', 'Cannot move until something outside the team happens. Say what.'], ['Complete', 'Done, and every team involved has checked off its part.']])}
    <p class="help-text">The Hub raises a status on its own: past due shows Behind, due within 2 weeks shows At risk.</p>
    ${sec('Board columns', [['To do', 'Not begun.'], ['In progress', 'Being worked on.'], ['In review', 'Done by the team, waiting for sign-off.'], ['Complete', 'Signed off.']])}
    ${sec('Other terms', [['Priority', 'High: blocks an opening or another team. Medium: the default. Low: helpful, not required.'], ['Key milestone', 'One leaders track on the dashboard and in meetings.'], ['Group', 'A section inside a team\'s list, such as Devices or Network.'], ['Teams involved', 'Teams that each own part of a milestone. Each checks off its part.'], ['Check-in', 'Every 2 weeks, owners confirm their milestones will finish on time.'], ['Date change', 'Owners request a new due date with a reason. An admin approves it. Every move is kept in the history.']])}`,
    '<button class="btn btn-filled" data-sheet-close>Done</button>');
}
function groupOf(m) { const w = String(m.workstream || '').trim(); return w && w !== 'General' ? w : ''; }
function teamGroups(team) { return [...new Set(M().filter(m => m.functional_area === team).map(groupOf).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
// Inside a team, split cards into the team's own groups (collapsible), ungrouped last.
function teamGroupsHtml(team, list) {
  const gk = m => m.functional_area === team ? groupOf(m) : 'Shared from ' + m.functional_area;
  if (!list.some(gk)) return `<div class="ml-wrap">${mlTable(list, { hideTeam: true })}</div>`;
  const sg = {}; list.forEach(m => { const k = gk(m); (sg[k] = sg[k] || []).push(m); });
  const keys = Object.keys(sg).filter(Boolean).sort((a, b) => a.localeCompare(b)); if (sg['']) keys.push('');
  return keys.map(k => { const ck = 'sg:' + team + '|' + k, open = !!state.expanded[ck] || (state.flashId && sg[k].some(m => m.id === state.flashId));
    return `<div class="plan-subgroup ${open ? '' : 'is-collapsed'}"><div class="plan-group-head plan-subgroup-head" data-toggle="${esc(ck)}">${chev(open)}<span class="pg-name">${esc(k || 'Ungrouped')}</span><span class="pm-gcount">${sg[k].length}</span></div>${open ? `<div class="ml-wrap">${mlTable(sg[k], { hideTeam: true })}</div>` : ''}</div>`; }).join('');
}
function planListHtml() {
  const list = filtered(), gb = state.planGroup, g = {}, order = {};
  const keyOf = m => {
    if (gb === 'team') return m.functional_area;
    if (gb === 'priority') return (PRIORITY[m.priority] || {}).label;
    if (gb === 'market') return m.market || 'Network (CMO)';
    if (gb === 'state') { const st = (statesMeta().find(x => x.code === m.state) || {}).name || m.state || 'Network-wide'; order[st] = m.state === 'FL' ? 0 : m.state === 'NJ' ? 1 : 2; return st; }
    if (gb === 'year') { order['FY ' + fyLabel(m.targetFY)] = m.targetFY || 9999; return m.targetFY ? 'FY ' + fyLabel(m.targetFY) : 'No date'; }
    if (gb === 'school') { const s = state.data.schools.find(x => taskInSchool(m, x)); return s ? s.market + ' · ' + schLbl(s) : 'Not tied to a school'; }
    return m.functional_area;
  };
  (state.hideDone ? list.filter(m => m.status !== 'complete') : list).forEach(m => (gb === 'team' ? involvedTeams(m) : [keyOf(m) || '-']).forEach(k => { if (gb === 'team' && state.filters.areas.size && !state.filters.areas.has(k)) return; (g[k] = g[k] || []).push(m); }));
  const byDue = (a, b) => (effectiveStatus(a) === 'complete') - (effectiveStatus(b) === 'complete') || (a.due_date || '9999').localeCompare(b.due_date || '9999');
  Object.values(g).forEach(a => a.sort(byDue));
  const keys = Object.keys(g).sort((a, b) => gb === 'year' ? (order[a] || 9999) - (order[b] || 9999) : gb === 'state' ? (order[a] ?? 9) - (order[b] ?? 9) : a.localeCompare(b));
  const fs = state.filters.schools.size === 1 && schoolById([...state.filters.schools][0]);
  if (!keys.length && fs && !schoolMs(fs).length) return `<div class="empty-state">No milestones for ${esc(fs.market)} · ${esc(schLbl(fs))} yet<button class="btn btn-tonal btn-sm" data-drillschool="${esc(fs.id)}">Add milestones</button></div>`;
  if (!keys.length) return (M().length ? '<div class="empty-state">No milestones match these filters<button class="btn btn-tonal btn-sm" data-clearfilters>Clear filters</button></div>' : '<div class="empty-state">No milestones yet</div>');
  state._planKeys = keys.map(k => 'pg:' + k);
  if (state._expandAllOnce) { state._planKeys.forEach(k => state.expanded[k] = true); state._expandAllOnce = false; }
  // groups default COLLAPSED so the page opens as a scannable outline, not 132 cards
  return keys.map(k => {
    const ck = 'pg:' + k, open = !!state.expanded[ck] || (state.flashId && g[k].some(m => m.id === state.flashId));
    const risk = attentionItems(g[k]).length, late = g[k].filter(m => timingLevel(m) === 'overdue').length;
    const flag = (late ? `<span class="pm-gflag">${late} overdue</span>` : '') + (risk > late ? `<span class="pm-gflag pm-gflag-warn">${risk - late} more need${risk - late === 1 ? 's' : ''} attention</span>` : '');
    return `<div class="plan-group ${open ? '' : 'is-collapsed'}"><div class="plan-group-head" data-toggle="${esc(ck)}">${chev(open)}<span class="pg-name">${esc(k)}</span>${flag}<span class="pm-gcount" title="${g[k].length} milestone${g[k].length === 1 ? '' : 's'}">${g[k].length}</span>${state.planGroup === 'team' && canEdit() ? `<button type="button" class="pg-add" data-addteam="${esc(k)}" aria-label="Add a ${esc(k)} milestone" title="Add a ${esc(k)} milestone">+</button>` : ''}</div>${gb === 'team' && g[k].some(m => groupOf(m) || m.functional_area !== k) ? `<div class="plan-subgroups ${open ? '' : 'hide'}">${open ? teamGroupsHtml(k, g[k]) : ''}</div>` : `<div class="ml-wrap ${open ? '' : 'hide'}">${open ? mlTable(g[k], { hideTeam: gb === 'team' }) : ''}</div>`}</div>`;
  }).join('');
}
function planBodyHtml() {
  if (state.planFocus) return planFocusHtml();
  return state.planGroup === 'stage' ? planKanbanHtml() : planListHtml();
}
function renderPlan() {
  const list = filtered();
  const focusN = attentionItems(list).length;   // same rule as the Dashboard's Needs attention
  const focusBtn = `<button class="btn btn-focus ${state.planFocus ? 'on' : ''}" id="planFocus">Needs attention${focusN ? ` <span class="focus-n">${focusN}</span>` : ''}</button>`;
  const isBoard = state.planGroup === 'stage';
  const viewToggle = `<div class="plan-view-toggle"><button class="pvt ${!isBoard ? 'on' : ''}" data-planview="list" title="List view" aria-label="List view"><svg viewBox="0 0 32 32" fill="currentColor" width="18" height="18"><circle cx="7" cy="9" r="3"/><circle cx="7" cy="23" r="3"/><path d="M16 22H30V24H16zM16 8H30V10H16z"/></svg><span class="pvt-l">List</span></button><button class="pvt ${isBoard ? 'on' : ''}" data-planview="board" title="Board view" aria-label="Board view"><svg viewBox="0 0 32 32" fill="currentColor" width="18" height="18"><path d="M24 4H26V28H24zM18 6V26H14V6h4m0-2H14a2 2 0 00-2 2V26a2 2 0 002 2h4a2 2 0 002-2V6a2 2 0 00-2-2zM6 4H8V28H6z"/></svg><span class="pvt-l">Board</span></button></div>`;
  const viewSel = isBoard ? '' : `<label class="tb-group ${state.planFocus ? 'is-dim' : ''}" title="Splits the list into sections. Hides nothing.">Sections by
    <select id="planGroupSel" ${state.planFocus ? 'disabled' : ''}>${[['team', 'Team'], ['state', 'State, Florida first'], ['school', 'School opening'], ['market', 'Market'], ['year', 'Due year']].map(([v, l]) => `<option value="${v}" ${state.planGroup === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const allOpen = (state._planKeys || []).length > 0 && state._planKeys.every(k => state.expanded[k]);
  const expandBtns = (!state.planFocus && !isBoard) ? `<button class="btn btn-ghost btn-sm" id="planToggleAll">${allOpen ? 'Collapse all' : 'Expand all'}</button>` : '';
  const doneN = filtered().filter(m => m.status === 'complete').length;
  const selBtn = canEdit() && !isBoard ? `<button class="btn btn-ghost btn-sm" id="planSelect" aria-pressed="${!!state.sel}" title="Change several milestones at once">${state.sel ? 'Done selecting' : 'Select'}</button>` : '';
  const nReq = isAdmin() ? dueRequests().length : 0;
  const dueSel = `<label class="tb-group" title="Shows only milestones due in this window.">Due
    <select id="planDue"><option value="">Any time</option>${[['overdue', 'Overdue'], ['this_month', 'Next 2 weeks'], ['due30', 'Next 30 days'], ['dueQ', 'This quarter']].map(([v, l]) => `<option value="${v}" ${state.filters.timing === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const csvBtn = `${myOwnerName() ? '<button class="btn btn-tonal btn-sm" data-open-checkins>My check-ins</button>' : ''}${nReq ? `<button class="btn btn-tonal btn-sm" data-open-duereq>Date requests <span class="focus-n">${nReq}</span></button>` : ''}${selBtn}${!isBoard && doneN ? `<button class="btn btn-ghost btn-sm" id="planHideDone" aria-pressed="${!!state.hideDone}">${state.hideDone ? `Show ${doneN} done` : 'Hide done'}</button>` : ''}<button class="btn btn-ghost btn-sm" id="planViews" aria-haspopup="true" aria-expanded="false">Saved views</button><button type="button" class="btn btn-ghost btn-sm" id="planMore" aria-haspopup="menu" aria-expanded="false" title="More actions">More<svg viewBox="0 0 32 32" fill="currentColor" width="16" height="16" aria-hidden="true"><circle cx="8" cy="16" r="2"/><circle cx="16" cy="16" r="2"/><circle cx="24" cy="16" r="2"/></svg></button><span class="plan-more-src" hidden><button class="btn btn-ghost btn-sm" id="planLink">Copy link</button><button class="btn btn-ghost btn-sm" id="planCsv">Export to Excel</button><button class="btn btn-ghost btn-sm" data-open-defs>Definitions</button></span>`;
  const searchBox = `<div class="fb-searchwrap"><input type="search" id="planSearch" class="fb-search" placeholder="Filter by name, owner or note" aria-label="Filter milestones" value="${esc(state.filters.search || '')}"></div>`;
  const right = `${searchBox}${appliedFilterChips({ hiddenOnly: true })}${viewToggle}${focusBtn}${dueSel}${viewSel}${expandBtns}${csvBtn}<button class="btn btn-filled" id="newItem"><svg viewBox="0 0 32 32" fill="currentColor" width="16" height="16"><path d="M17 15L17 8 15 8 15 15 8 15 8 17 15 17 15 24 17 24 17 17 24 17 24 15z"/></svg>New milestone</button>`;
  // No H2 - all actions live in the filter bar's right slot.
  $('#view-plan').innerHTML = `
    ${filterBar(['states', 'markets', 'fys', 'areas', 'owners'], { school: true, right })}
    <div id="viewBody">${planBodyHtml()}</div>`;
}

/* ============================================================
   EDIT ENGINE + cross-tab
   ============================================================ */
function hasSchoolWork() { return WS === 'readiness' || M().some(m => (m.schoolIds || []).length); }   // Enabling Work is network-wide, so school views stay hidden until a task names a school
function rerender() { const kb0 = document.querySelector('.bd'), kbX = kb0 ? kb0.scrollLeft : 0; if (kbX) requestAnimationFrame(() => { const k = document.querySelector('.bd'); if (k) k.scrollLeft = kbX; }); document.body.classList.toggle('no-school-work', !hasSchoolWork()); requestAnimationFrame(() => { if (typeof updateSticky === 'function') updateSticky(); }); if (state.view === 'progress') renderProgress(); else if (state.view === 'timeline') renderTimeline(); else if (state.view === 'meetings') renderMeetings(); else renderPlan(); requestAnimationFrame(() => paintAvatars()); if (typeof updateFilterBubble === 'function') updateFilterBubble(); mvRefreshIfIdle(); }
function mvRefreshIfIdle() { if (state.mvSkip || typeof mvOn !== 'function' || !mvOn() || $('#popover') || $('#mvEd')) return; const a = document.activeElement; if (a && $('#modalBody').contains(a) && a.matches('input, textarea, select')) return; mvRender(); }

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
// fmtMoney is defined once, near the top
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
// Breakdown card with a By workstream / By school toggle.



// Owners with slipping work — the charter frames commitments per owner (attend YOUR block,
// speak for YOUR function), and Aden's between-meetings job is to chase follow-ups. This card
// answers "who do I need to unblock?" — the primary question at a biweekly stand-up.

function dashboardHtml(list) {
  // Dashboard = the questions people bring: what do I do before the meeting (chair), how is each
  // opening doing, what needs attention, what's coming up, how is each team doing. Each answered once.
  const schools = schoolsInView();
  const sMs = s => state.filters.areas.size ? schoolMsView(s).filter(m => state.filters.areas.has(m.functional_area)) : schoolMsView(s);
  const f = state.filters, scopeParts = [...[...f.openingFYs].map(v => 'August ' + (v - 1)), ...f.states, ...f.markets, ...f.areas, ...[...f.owners].map(o => o === '__none__' ? 'Unassigned' : 'Owner: ' + o)];
  const asOf = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const rptHead = `<header class="print-only rpt-head"><div class="rpt-kicker">KIPP Team &amp; Family · Network Growth Committee</div><h1>Growth status report</h1><div class="rpt-meta">As of ${asOf} · ${esc(scopeParts.length ? scopeParts.join(', ') : 'All openings and teams')}</div></header>`;
  // Nov 20 2026 overhaul (decision-first, Carbon presentation dashboard): the answer up top, then the readiness
  // matrix (every opening against every team), then what needs action, what's coming, and what changed.
  return `<div class="dash dash-v3">
    ${rptHead}
    ${dashSummary(list, schools, sMs)}
    ${hasSchoolWork() ? readinessMatrix(schools, sMs) : teamsCard(list)}
    <div class="dash-pair dash-pair-ar">${attentionCard(list)}${comingUpCard(list)}</div>
    ${changesCard(list)}
    ${hiringCard(list)}
    ${MEETINGS_ON && isAdmin() ? `<div class="dash-pair dash-pair-prep">${forYouCard()}${committeeCard()}</div>` : forYouCard()}
  </div>`;
}
/* ---------- Dashboard charts (Nov 20 2026) ----------
   Each chart card has a Carbon content switcher between the table or list view and a chart view.
   Status colors only (they are states, not series), 2px gaps between segments, status shapes in the legend,
   and a tooltip on every mark, so color is never the only cue. Every mark is a button that opens the milestones behind it. */
const CH_ST = [['complete', 'Complete'], ['on_track', 'On track'], ['at_risk', 'At risk'], ['behind', 'Behind or blocked'], ['not_started', 'Not started']];
const chSt = m => { const s = effectiveStatus(m); return s === 'blocked' ? 'behind' : CH_ST.some(x => x[0] === s) ? s : 'not_started'; };
const chCount = ms => { const c = {}; CH_ST.forEach(([k]) => c[k] = 0); ms.forEach(m => c[chSt(m)]++); return c; };
function chSwitch(key, opts, cur) { return `<div class="gh-switch" role="group" aria-label="View">${opts.map(([v, l]) => `<button type="button" class="gh-sw ${cur === v ? 'is-on' : ''}" aria-pressed="${cur === v}" data-chsw="${key}|${v}">${l}</button>`).join('')}</div>`; }
function chLegend() { return `<div class="ch-legend" aria-hidden="true">${CH_ST.map(([k, l]) => `<span>${statusDot(k === 'behind' ? 'behind' : k)}${l}</span>`).join('')}</div>`; }
// On-pace bars (bullet chart): the bar is the share done; the tick is the share that should be done by today
// (everything due on or before today). A red stretch between them is how far behind pace. One hue, one marker.
function chPaceRows(rows) {
  const t = todayISO();
  const lg = `<div class="ch-legend" aria-hidden="true"><span><i class="pc-key pc-done"></i>Done</span><span><i class="pc-key pc-tick"></i>Due by today</span><span><i class="pc-key pc-gap"></i>Behind pace</span></div>`;
  return `${lg}<div class="ch-rows" role="list">${rows.map(r => {
    const n = r.ms.length, done = r.ms.filter(m => m.status === 'complete').length, due = r.ms.filter(m => m.due_date && m.due_date <= t).length, late = r.ms.filter(m => m.status !== 'complete' && m.due_date && m.due_date < t).length;
    const pd = n ? 100 * done / n : 0, pe = n ? 100 * due / n : 0, gap = Math.max(0, pe - pd);
    const tip = `${r.label}: ${done} of ${n} done, ${due} due by today${late ? `, ${late} overdue` : ''}`;
    return `<div class="ch-row" role="listitem"><div class="ch-lbl" title="${esc(r.label)}">${r.dot ? `<i class="ch-mk" style="background:${r.dot}" aria-hidden="true"></i>` : ''}<span>${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></div>
      <button type="button" class="pc-track" data-chdrill="${esc(r.drill)}|all" data-tip="${esc(tip)}" aria-label="${esc(tip)}"><i class="pc-done" style="width:${pd.toFixed(1)}%"></i>${gap > 0.5 ? `<i class="pc-gap" style="left:${pd.toFixed(1)}%;width:${gap.toFixed(1)}%"></i>` : ''}${due ? `<i class="pc-tick" style="left:${pe.toFixed(1)}%"></i>` : ''}</button>
      <div class="ch-n"><b>${done}</b>/${n}${late ? `<span class="pc-late">${late} overdue</span>` : ''}</div></div>`; }).join('')}</div>
    <div class="ch-axis" aria-hidden="true"><span></span><div><i style="left:0">0%</i><i style="left:50%">50%</i><i style="left:100%">100%</i></div><span></span></div>`;
}
// Column chart: milestones due per month for the next 6 months, stacked by status
function chMonths(list) {
  const t = today(), months = [...Array(6)].map((_, i) => { const d = new Date(t.getFullYear(), t.getMonth() + i, 1); return { ym: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-US', { month: 'short' }) + (d.getFullYear() !== t.getFullYear() ? ` '${String(d.getFullYear()).slice(2)}` : '') }; });
  months.forEach(mo => { mo.ms = list.filter(m => m.due_date && m.due_date.slice(0, 7) === mo.ym); });
  const max = Math.max(1, ...months.map(m => m.ms.length)), step = Math.max(1, Math.ceil(max / 4)), top = step * Math.ceil(max / step), ticks = [...Array(Math.floor(top / step) + 1)].map((_, i) => i * step);
  return `${chLegend()}<div class="ch-cols"><div class="ch-yaxis" aria-hidden="true">${ticks.slice().reverse().map(v => `<span>${v}</span>`).join('')}</div>
    <div class="ch-plot">${ticks.map(v => `<i class="ch-grid" style="bottom:${(100 * v / top).toFixed(2)}%"></i>`).join('')}
      <div class="ch-colset">${months.map(mo => { const c = chCount(mo.ms);
        return `<div class="ch-colw"><div class="ch-col" style="height:${(100 * mo.ms.length / top).toFixed(2)}%">${CH_ST.slice().reverse().filter(([k]) => c[k]).map(([k, l]) => `<button type="button" class="ch-seg sg-${k}" style="flex:${c[k]}" data-chmonth="${mo.ym}|${k}" data-tip="${esc(mo.label)}: ${c[k]} ${esc(l.toLowerCase())}" aria-label="${esc(mo.label)}: ${c[k]} ${esc(l.toLowerCase())}"></button>`).join('')}</div><span class="ch-xl">${esc(mo.label)}</span><span class="ch-cn">${mo.ms.length || ''}</span></div>`; }).join('')}</div></div></div>`;
}
document.addEventListener('change', e => { const s = e.target.closest && e.target.closest('[data-mxfy]'); if (!s) return; state.filters.openingFYs = s.value ? new Set([Number(s.value)]) : new Set(); rerender(); });
document.addEventListener('click', e => {
  const sw = e.target.closest && e.target.closest('[data-chsw]');
  if (sw) { const [k, v] = sw.dataset.chsw.split('|'); state[k] = v; refreshBody(); const b = document.querySelector(`[data-chsw="${k}|${v}"]`), card = b && b.closest('.ex-card'); if (card && moOK()) [...card.children].slice(1).forEach(el => el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 150, easing: 'cubic-bezier(0, 0, .38, .9)' })); if (b) b.focus(); return; }
  const d = e.target.closest && e.target.closest('[data-chdrill]');
  if (d) { const [kind, val, st] = d.dataset.chdrill.split('|'); clearTransientFilters(); if (kind === 'team') state.filters.areas = new Set([val]); else state.filters.schools = new Set([val]);
    if (st !== 'all') state.filters.statuses = new Set(st === 'behind' ? ['behind', 'blocked'] : [st]); state._expandAllOnce = true; setView('plan'); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const mo = e.target.closest && e.target.closest('[data-chmonth]');
  if (mo) { const [ym, st] = mo.dataset.chmonth.split('|'), ms = filtered().filter(m => m.due_date && m.due_date.slice(0, 7) === ym && chSt(m) === st);
    const lbl = parseDate(ym + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const w = openSheet(`${CH_ST.find(x => x[0] === st)[1]}, due ${lbl}`, `<div class="ml-wrap">${mlTable(ms)}</div>`, '<button class="btn btn-filled" data-sheet-close>Done</button>');
    if (w) w.addEventListener('click', ev => { const r = ev.target.closest('[data-expand]'); if (r && !ev.target.closest('[data-qstatus]')) { closeSheet(); openModal(r.dataset.expand); } }); }
});
// Chart tooltip: one floating label for every [data-tip] mark (mouse and keyboard focus)
(function () {
  let tip = null; const show = (el, x, y) => { if (!tip) { tip = document.createElement('div'); tip.className = 'ch-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); } tip.textContent = el.dataset.tip; tip.hidden = false; const r = tip.getBoundingClientRect(); tip.style.left = Math.min(innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + 'px'; tip.style.top = Math.max(8, y - r.height - 12) + 'px'; };
  const hide = () => { if (tip) tip.hidden = true; };
  document.addEventListener('mousemove', e => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) show(el, e.clientX, e.clientY); else hide(); });
  document.addEventListener('focusin', e => { const el = e.target.closest && e.target.closest('[data-tip]'); if (!el) return; const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); });
  document.addEventListener('focusout', hide); document.addEventListener('scroll', hide, true);
})();
/* ---------- Dashboard v3 (Nov 20 2026) ---------- */
function dashSummary(list, schools, sMs) {
  const open = list.filter(m => m.status !== 'complete' && !m._draft), t = todayISO();
  const rk = schools.map(s => ragReady(sMs(s)).key), onT = rk.filter(k => k === 'green' || k === 'blue').length, offT = rk.filter(k => k === 'red' || k === 'yellow').length;
  const attn = attentionItems(list).length, overdue = open.filter(m => timingLevel(m) === 'overdue').length;
  const due30 = open.filter(m => m.due_date && m.due_date >= t && daysUntil(m.due_date) <= 30).length;
  const done14 = list.filter(m => m.status === 'complete' && m.completedAt && daysSince(m.completedAt) <= 14).length;
  const head = hasSchoolWork() && schools.length
    ? `${onT} of ${schools.length} openings on track${attn ? `, ${attn} milestone${attn === 1 ? '' : 's'} need${attn === 1 ? 's' : ''} attention` : ', nothing needs attention'}`
    : attn ? `${attn} milestone${attn === 1 ? '' : 's'} need${attn === 1 ? 's' : ''} attention` : 'Nothing needs attention';
  const tile = (k, label, val, sub, tone) => `<button type="button" class="ds-tile ${tone ? 'is-' + tone : ''}" data-dsum="${k}"><span class="ds-l">${label}</span><span class="ds-v">${val}</span><span class="ds-s">${sub}</span></button>`;
  return `<section class="ds" aria-label="Summary"><p class="ds-head">${esc(head)}</p><div class="ds-tiles">
    ${hasSchoolWork() && schools.length ? tile('openings', 'Openings on track', `${onT}<small> of ${schools.length}</small>`, offT ? `${offT} at risk or behind` : schools.length - onT ? `${schools.length - onT} not scoped yet` : 'All on track', offT ? 'warn' : '') : ''}
    ${tile('overdue', 'Overdue', String(overdue), overdue ? 'Past their due date' : 'None past due', overdue ? 'bad' : '')}
    ${tile('due30', 'Due in 30 days', String(due30), 'Open milestones', '')}
    ${tile('done14', 'Completed', String(done14), 'In the last 2 weeks', done14 ? 'ok' : '')}
  </div></section>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-dsum]'); if (!b) return; const k = b.dataset.dsum;
  if (k === 'openings') { const x = $('#view-progress .mx-card'); if (x) x.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (k === 'overdue') return applyDrill('timing', 'overdue');
  if (k === 'due30') return applyDrill('timing', 'due30');
  if (k === 'done14') { state.filters.statuses = new Set(['complete']); return applyDrill('all'); }
});
// Readiness matrix: rows are openings (grouped by opening date), columns are teams. Each cell rolls up that team's
// milestones for that school: status shape plus done of total. Click a cell to see those milestones.
function readinessMatrix(schools, sMs) {
  if (!schools.length) return '';
  const all = schools.flatMap(s => sMs(s)), tms = teams().filter(tm => all.some(m => m.functional_area === tm));
  const byFy = {}; schools.forEach(s => (byFy[s.openingFY || 0] = byFy[s.openingFY || 0] || []).push(s));
  const t = todayISO();
  const row = s => {
    const ms = sMs(s), st = ms.length ? rollupStatus(ms) : 'not_started', open = ms.filter(m => m.status !== 'complete');
    const next = open.filter(m => m.due_date && m.due_date >= t).sort((a, b) => a.due_date < b.due_date ? -1 : 1)[0];
    const cells = tms.map(tm => {
      const x = ms.filter(m => m.functional_area === tm); if (!x.length) return `<td class="mx-c mx-empty"><span aria-label="No ${esc(tm)} milestones">–</span></td>`;
      const xs = rollupStatus(x), d = x.filter(m => m.status === 'complete').length;
      return `<td class="mx-c mx-${xs}"><button type="button" class="mx-btn" data-mx="${esc(s.id)}|${esc(tm)}" title="${esc(tm)} at ${esc(schLbl(s))}: ${esc(SM(xs).label)}, ${d} of ${x.length} done">${statusDot(xs)}<span>${d}<small>/${x.length}</small></span></button></td>`;
    }).join('');
    return `<tr><th scope="row" class="mx-s"><button type="button" class="mx-name" data-drillschool="${esc(s.id)}"><i class="mx-mk" style="background:${mkColor(s.market)}" aria-hidden="true"></i><span>${esc(schLbl(s))}</span></button><small>${esc(schoolFacts(s))}</small></th>
      <td class="mx-all">${ms.length ? `<span class="mx-st">${statusDot(st)}${esc(SM(st).label)}</span>` : '<span class="mx-muted">Not scoped</span>'}</td>${cells}
      <td class="mx-next">${next ? `<span title="${esc(next.activity)}">${esc(fmtDate(next.due_date))}</span>` : '<span class="mx-muted">None</span>'}</td></tr>`;
  };
  const groups = Object.keys(byFy).map(Number).sort((a, b) => a - b).map(fy => `<tbody><tr class="mx-g"><th colspan="${tms.length + 3}" scope="rowgroup">${fy ? `August ${fy - 1}` : 'Not scheduled'}<span>${byFy[fy].length} opening${byFy[fy].length === 1 ? '' : 's'}</span></th></tr>${byFy[fy].map(row).join('')}</tbody>`).join('');
  const legend = ['on_track', 'at_risk', 'behind', 'complete', 'not_started'].map(k => `<span>${statusDot(k)}${esc(SM(k).label)}</span>`).join('');
  const view = state.mxView || 'matrix', sw = chSwitch('mxView', [['matrix', 'Matrix'], ['team', 'By team'], ['opening', 'By opening']], view);
  const fyAll = [...new Set(state.data.schools.map(x => x.openingFY).filter(Boolean))].sort(), fyCur = state.filters.openingFYs.size === 1 ? [...state.filters.openingFYs][0] : '';
  const fySel = fyAll.length > 1 ? `<label class="mx-fy"><span class="sr-only">Opening</span><select data-mxfy aria-label="Opening">${[['', 'All openings'], ...fyAll.map(fy => [fy, `August ${fy - 1}`])].map(([v, l]) => `<option value="${v}" ${String(fyCur) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : '';
  if (view !== 'matrix') {
    const rows = view === 'team' ? tms.map(tm => ({ label: tm, ms: all.filter(m => m.functional_area === tm), drill: 'team|' + tm }))
      : schools.map(sc => ({ label: schLbl(sc), sub: `Opens August ${sc.openingFY - 1}`, dot: mkColor(sc.market), ms: sMs(sc), drill: 'school|' + sc.id }));
    return `<section class="ex-card mx-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('table')}<h3>Readiness by opening and team</h3></div><div class="mx-tools">${fySel}${sw}</div></div>${chPaceRows(rows)}</section>`;
  }
  return `<section class="ex-card mx-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('table')}<h3>Readiness by opening and team</h3></div><div class="mx-tools">${fySel}${sw}</div></div>
    <div class="mx-wrap"><table class="mx"><thead><tr><th scope="col" class="mx-s">Opening</th><th scope="col">Overall</th>${tms.map(tm => `<th scope="col" class="mx-c" title="${esc(tm)}">${esc(tm)}</th>`).join('')}<th scope="col">Next due</th></tr></thead>${groups}</table></div>
    <div class="mx-legend" aria-label="Legend">${legend}<span class="mx-key"><b>3</b>/5 = done of total</span></div></section>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-mx]'); if (!b) return;
  const [sid, tm] = b.dataset.mx.split('|'); clearTransientFilters(); state.filters.schools = new Set([sid]); state.filters.areas = new Set([tm]);
  state._expandAllOnce = true; setView('plan'); window.scrollTo({ top: 0, behavior: 'smooth' });
});
// What changed in the last 2 weeks: finished, dates moved, newly behind
function changesCard(list) {
  const done = list.filter(m => m.status === 'complete' && m.completedAt && daysSince(m.completedAt) <= 14).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const moved = list.map(m => ({ m, h: (m.dateHistory || []).filter(h => daysSince(h.t) <= 14).slice(-1)[0] })).filter(x => x.h).sort((a, b) => b.h.t.localeCompare(a.h.t));
  const off = list.filter(m => m.status !== 'complete' && effectiveStatus(m) === 'behind' && typeof newlyOffTrack === 'function' && newlyOffTrack(m));
  const col = (h, n, items, empty) => `<div class="cg-col"><h4>${h}<span class="cg-n">${n}</span></h4>${items.length ? `<ul>${items.slice(0, 4).join('')}</ul>${n > 4 ? `<span class="cg-more">${n - 4} more</span>` : ''}` : `<p class="cg-empty">${empty}</p>`}</div>`;
  const li = (m, sub) => `<li><button type="button" class="cg-t" data-expand="${esc(m.id)}">${esc(m.activity)}</button><span class="cg-s">${sub}</span></li>`;
  return `<section class="ex-card cg-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('check')}<h3>Last 2 weeks</h3></div></div><div class="cg">
    ${col('Completed', done.length, done.map(m => li(m, esc(fmtDate(m.completedAt.slice(0, 10))))), 'None')}
    ${col('Due dates moved', moved.length, moved.map(x => li(x.m, `${esc(fmtDate(x.h.from))} → ${esc(fmtDate(x.h.to))}`)), 'None')}
    ${col('Newly behind', off.length, off.map(m => li(m, m.due_date ? 'Due ' + esc(fmtDate(m.due_date)) : 'No due date')), 'None')}
  </div></section>`;
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
  return sc.length ? (sc.length <= 2 ? sc.map(x => `${x.market} · ${schLbl(x)}`).join(', ') : `${sc.length} openings`) : (m.market || 'Network-wide');
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
    return `<tr data-drillschool="${esc(s.id)}" title="Open ${esc(s.market)} · ${esc(schLbl(s))}">
      <td>${schoolChip(s.market, [schLbl(s)])}</td>
      <td>${fallLbl(s.openingFY)}</td>
      <td>${statusPill(ms.length ? r.label.split(' · ')[0] : 'Not yet scoped', r.color)}</td>
      <td class="num">${pctChip(p, p + '%', r.color, 'Average progress')}</td>
      <td>${issues}</td>
      <td class="dt-next" title="${next ? esc(next.activity) : ''}">${next ? `<div class="dt-next-in">${dueChip(next)}<span class="dt-next-t">${esc(next.activity)}</span></div>` : '<span class="muted">Nothing scheduled</span>'}</td></tr>`;
  }).join('');
  const rk = schools.map(s => ragReady(sMs(s)).key), onT = rk.filter(k => k === 'green' || k === 'blue').length;
  return `<section class="ex-card dt-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('flag')}<h3>School openings</h3></div><span class="dt-sum"><b>${onT} of ${schools.length}</b> on track</span></div>
    <div class="dt-wrap"><table class="dt"><thead><tr><th>Opening</th><th>Opens</th><th>Status</th><th class="num" title="Average progress across milestones">Progress</th><th>Issues</th><th>Next due</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function attentionItems(list) {
  const rank = m => m.status === 'blocked' ? 0 : effectiveStatus(m) === 'behind' ? 1 : effectiveStatus(m) === 'at_risk' ? 2 : 3;
  return list.filter(m => m.status !== 'complete' && (['behind', 'at_risk', 'blocked'].includes(effectiveStatus(m)) || watermelonReasons(m).length))
    .sort((a, b) => rank(a) - rank(b) || ((a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1));
}
function listRow(m) {
  const es = effectiveStatus(m), look = !['behind', 'at_risk', 'blocked'].includes(es) && watermelonReasons(m).length;
  const label = m.status === 'blocked' ? 'Blocked' : look ? 'Needs attention' : SM(es).label;
  const color = look ? 'var(--status-at-risk)' : SM(m.status === 'blocked' ? 'blocked' : es).color;
  return `<div class="al-row" data-expand="${esc(m.id)}">${statusPill(label, color)}<div class="al-main"><div class="al-t">${esc(m.activity)}</div>${alWhy(m) ? `<div class="al-why">${esc(alWhy(m))}</div>` : ''}<div class="al-m">${schoolChips(m)}${dueChip(m)}<span class="al-own">${esc(ownersOf(m).join(', ') || 'Unassigned')}</span></div></div></div>`;
}
/* ============================================================
   DASHBOARD v3 (Nov 19 2026): ordered by what people act on.
   1. For you: everything waiting on you in one list, with filter chips
      (your overdue, blocked and due-soon milestones, check-ins, next steps, comments).
   2. Check-in status (admins).  3. Needs attention | Coming up.  4. Openings, hiring, teams, capital.
   ============================================================ */
const DI = {
  overdue: '<path d="M16 2a14 14 0 1014 14A14 14 0 0016 2zm0 26a12 12 0 1112-12 12 12 0 01-12 12z"/><path d="M15 8h2v11h-2zM16 22a1.5 1.5 0 101.5 1.5A1.5 1.5 0 0016 22z"/>',
  blocked: '<path d="M16 2a14 14 0 1014 14A14 14 0 0016 2zm0 2a11.9 11.9 0 017.53 2.69L6.69 23.53A11.9 11.9 0 014 16 12 12 0 0116 4zm0 24a11.9 11.9 0 01-7.53-2.69L25.31 8.47A11.9 11.9 0 0128 16a12 12 0 01-12 12z"/>',
  due: '<path d="M16 30a14 14 0 1114-14 14 14 0 01-14 14zm0-26a12 12 0 1012 12A12 12 0 0016 4z"/><path d="M20.59 22L15 16.41V7h2v8.58l5 5.01L20.59 22z"/>',
  checkin: '<path d="M2 26H30V28H2zM25.4 9c.8-.8.8-2 0-2.8l-3.6-3.6c-.8-.8-2-.8-2.8 0l-15 15V24h6.4L25.4 9zM20.4 4L24 7.6l-3 3L17.4 7 20.4 4zM6 22v-3.6l10-10 3.6 3.6-10 10H6z"/>',
  steps: '<path d="M14 20.18l-3.59-3.59L9 18l5 5 9-9-1.41-1.42L14 20.18z"/><path d="M25 5h-3V4a2 2 0 00-2-2h-8a2 2 0 00-2 2v1H7a2 2 0 00-2 2v21a2 2 0 002 2h18a2 2 0 002-2V7a2 2 0 00-2-2zM12 4h8v4h-8zm13 24H7V7h3v3h12V7h3z"/>',
  comments: '<path d="M17.74 30L16 29l4-7h6a2 2 0 002-2V8a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2h9v2H6a4 4 0 01-4-4V8a4 4 0 014-4h20a4 4 0 014 4v12a4 4 0 01-4 4h-4.84z"/><path d="M8 10h16v2H8zM8 16h10v2H8z"/>',
  done: '<path d="M16 2a14 14 0 1014 14A14 14 0 0016 2zm-2 19.59l-5-5L10.59 15 14 18.41 21.41 11l1.6 1.59z"/>',
  cal: '<path d="M26 4h-4V2h-2v2h-8V2h-2v2H6a2 2 0 00-2 2v20a2 2 0 002 2h20a2 2 0 002-2V6a2 2 0 00-2-2zm0 22H6V12h20zm0-16H6V6h4v2h2V6h8v2h2V6h4z"/>',
  user: '<path d="M16 4a5 5 0 11-5 5 5 5 0 015-5m0-2a7 7 0 107 7 7 7 0 00-7-7zM26 30h-2v-5a5 5 0 00-5-5h-6a5 5 0 00-5 5v5H6v-5a7 7 0 017-7h6a7 7 0 017 7z"/>',
  arrow: '<path d="M18 6L16.57 7.393 24.15 15 4 15 4 17 24.15 17 16.57 24.573 18 26 28 16 18 6z"/>'
};
const di = (k, s) => `<svg class="di di-${k}" viewBox="0 0 32 32" width="${s || 16}" height="${s || 16}" fill="currentColor" aria-hidden="true">${DI[k]}</svg>`;

/* ---------- 1. For you ---------- */
function forYouItems() {
  const me = myOwnerName(), t = todayISO(), out = [];
  if (me) myOpenTasks(me).forEach(m => {
    const tags = [], es = effectiveStatus(m), late = timingLevel(m) === 'overdue';
    if (late) tags.push('overdue'); if (es === 'blocked') tags.push('blocked'); if (!late && dueWithin30(m)) tags.push('due'); if (needsCheckin(m)) tags.push('checkin');
    if (tags.length) out.push({ kind: 'ms', m, tags, rank: late ? 0 : es === 'blocked' ? 1 : tags.includes('due') ? 4 : 5, sort: m.due_date || '9999' });
  });
  if (MEETINGS_ON && me) openActions().filter(a => a.owner === me).forEach(a => out.push({ kind: 'step', a, tags: ['steps'], rank: a.due && a.due < t ? 2 : 4, sort: a.due || '9999' }));
  const seen = cmtSeen(); myMentions(14).forEach(x => out.push({ kind: 'cmt', x, tags: ['comments'], isNew: +x.nt.t > seen, rank: +x.nt.t > seen ? 3 : 6, sort: String(9e15 - x.nt.t) }));
  return out.sort((a, b) => a.rank - b.rank || a.sort.localeCompare(b.sort));
}
function fyRow(it) {
  if (it.kind === 'ms') {
    const m = it.m, d = daysUntil(m.due_date), chips = [];
    if (it.tags.includes('overdue')) chips.push(`<span class="fy-chip is-bad">${di('overdue', 12)}${-d} day${d === -1 ? '' : 's'} overdue</span>`);
    if (it.tags.includes('blocked')) chips.push(`<span class="fy-chip is-bad">${di('blocked', 12)}Blocked</span>`);
    if (it.tags.includes('due')) chips.push(`<span class="fy-chip">${di('due', 12)}${d === 0 ? 'Due today' : `Due in ${d} day${d === 1 ? '' : 's'}`}</span>`);
    const why = m.status === 'blocked' && m.dependency ? `Waiting on ${m.dependency}` : alWhy(m);
    return `<li class="fy-row" data-expand="${esc(m.id)}"><span class="fy-ic ${it.tags.includes('overdue') || it.tags.includes('blocked') ? 'is-bad' : it.tags.includes('checkin') && it.tags.length === 1 ? 'is-warn' : ''}">${di(it.tags[0], 20)}</span>
      <div class="fy-main"><div class="fy-t">${esc(m.activity)}</div><div class="fy-chips">${chips.join('')}${schoolChips(m)}</div>${why && !/^Past the due date$|^Due within a month$/.test(why) ? `<ul class="fy-why"><li>${esc(why)}</li></ul>` : ''}</div>
      <span class="fy-go" aria-hidden="true">${di('arrow')}</span></li>`;
  }
  if (it.kind === 'step') {
    const a = it.a, late = a.due && a.due < todayISO();
    return `<li class="fy-row fy-step"><span class="fy-ic ${late ? 'is-bad' : ''}">${di('steps', 20)}</span>
      <div class="fy-main"><div class="fy-t"><label class="fy-check"><input type="checkbox" data-mm-stepdone="${esc(a.id)}" ${a.meetingId ? '' : 'disabled'} aria-label="Mark done: ${esc(a.text)}"><span>${esc(a.text)}</span></label></div>
      <div class="fy-chips"><span class="fy-chip ${late ? 'is-bad' : ''}">${di(late ? 'overdue' : 'due', 12)}${a.due ? (late ? 'Overdue, was due ' : 'Due ') + esc(fmtDate(a.due)) : 'No due date'}</span>${a.meeting ? `<span class="fy-where">From ${a.meetingId ? `<button type="button" class="ag-link" data-mm-open="${esc(a.meetingId)}" data-mm-tab-to="notes">${esc(a.item || 'meeting')}</button>` : esc(a.item || 'meeting')}, ${esc(fmtDate(a.meeting))}</span>` : ''}</div></div></li>`;
  }
  const { m, nt, why } = it.x, verb = { 'Mentioned you': 'mentioned you', 'Mentioned everyone': 'mentioned everyone', 'On your milestone': 'commented on your milestone' }[why] || 'commented';
  return `<li class="fy-row fy-cmt ${it.isNew ? 'is-new' : ''}" data-expand="${esc(m.id)}" data-cmt-open><span class="fy-ic is-info">${di('comments', 20)}</span>
    <div class="fy-main"><div class="fy-t"><b>${esc(nt.by || 'Someone')}</b> <span class="fy-verb">${verb}</span>${it.isNew ? '<span class="fy-new">New</span>' : ''}</div>
    <div class="fy-quote">${renderNoteText(Object.assign({}, nt, { text: clip(nt.text, 160) }))}</div><div class="fy-chips"><span class="fy-where">On ${esc(clip(m.activity, 80))} · ${esc(fmtWhen(nt.t))}</span></div></div>
    <span class="fy-go" aria-hidden="true">${di('arrow')}</span></li>`;
}
function forYouCard() {
  const me = myOwnerName(), p = currentProfile(), items = forYouItems();
  const F = [['all', 'All', ''], ['overdue', 'Overdue', 'overdue'], ['blocked', 'Blocked', 'blocked'], ['due', 'Due in 30 days', 'due'], ['checkin', 'Check-ins due', 'checkin'], ['steps', 'Next steps', 'steps'], ['comments', 'Comments', 'comments']];
  const count = k => k === 'all' ? items.length : items.filter(i => i.tags.includes(k)).length;
  let f = state.fyF || 'all'; if (f !== 'all' && !count(f)) f = 'all';
  const list = f === 'all' ? items : items.filter(i => i.tags.includes(f)), show = state.fyAll ? list : list.slice(0, 6);
  const nCi = me ? myOpenTasks(me).filter(needsCheckin).length : 0, nNew = items.filter(i => i.isNew).length;
  const chips = F.filter(([k]) => k === 'all' || count(k)).map(([k, l, ic]) => `<button type="button" class="fy-filter ${f === k ? 'is-on' : ''} ${k === 'overdue' || k === 'blocked' ? 'is-bad' : ''}" aria-pressed="${f === k}" data-fyf="${k}">${ic ? di(ic, 14) : ''}${l}<span class="fy-n">${count(k)}</span></button>`).join('');
  const empty = me || items.length ? `<div class="fy-empty">${di('done', 24)}<div><b>You're all caught up</b><span>Nothing overdue, due soon or waiting on you.</span></div></div>`
    : `<div class="fy-empty">${di('user', 24)}<div><b>Your account isn't linked to the board yet</b><span>${isAdmin() ? `Add ${esc((p && p.email) || 'your email')} in Account and settings, Owners.` : `Ask an admin to add ${esc((p && p.email) || 'your email')} to your name on the Owners list.`} Then your milestones and next steps show here.</span></div></div>`;
  return `<section class="ex-card fy-card" aria-labelledby="fyH"><div class="ex-card-head"><div class="ex-cardhead-l">${di('user', 20)}<h3 id="fyH">For you</h3>${nNew ? `<span class="cm4-badge">${nNew} new comment${nNew === 1 ? '' : 's'}</span>` : ''}</div>
      <div class="fy-acts">${nNew ? '<button type="button" class="btn btn-ghost btn-sm" data-cmt-read>Mark comments read</button>' : ''}${me ? `<button type="button" class="btn ${nCi ? 'btn-filled' : 'btn-tonal'} btn-sm" data-open-checkins>${di('checkin', 14)} Check in${nCi ? ` (${nCi})` : ''}</button>` : ''}</div></div>
    ${items.length ? `<div class="fy-filters" role="group" aria-label="Show">${chips}</div><ul class="fy-list">${show.map(fyRow).join('')}</ul>
      ${list.length > show.length ? `<button type="button" class="card-more fy-more" data-fyall>Show all ${list.length}</button>` : ''}` : empty}
    <div class="fy-foot">${me ? `<button type="button" class="btn btn-text btn-sm" data-fymine>All my milestones ${di('arrow', 14)}</button>` : ''}${MEETINGS_ON ? `<button type="button" class="btn btn-text btn-sm" data-fysteps>Everyone's next steps ${di('arrow', 14)}</button>` : ''}</div>
  </section>`;
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-fyf],[data-fyall],[data-fymine],[data-fysteps]'); if (!t) return;
  if (t.dataset.fyf) { state.fyF = t.dataset.fyf; state.fyAll = false; rerender(); const b = document.querySelector(`[data-fyf="${t.dataset.fyf}"]`); if (b) b.focus(); return; }
  if (t.dataset.fyall !== undefined) { state.fyAll = true; return rerender(); }
  if (t.dataset.fymine !== undefined) { clearFilters(); state.filters.owners = new Set([myOwnerName()]); setView('plan'); return rerender(); }
  if (t.dataset.fysteps !== undefined) { const keep = state.nsTab; state.nsTab = 'all'; const html = nextStepsCard(); state.nsTab = keep; const tmp = document.createElement('div'); tmp.innerHTML = html; tmp.querySelectorAll('.ex-card-head').forEach(x => x.remove()); return openSheet('Next steps from meetings', tmp.innerHTML); }
});

/* ---------- 3. Needs attention (filters, clearer rows) and Coming up (next meeting + by week) ---------- */
function attnKind(m) { const es = effectiveStatus(m); return m.status === 'blocked' ? 'blocked' : es === 'behind' ? 'behind' : es === 'at_risk' ? 'at_risk' : 'look'; }
function attnRow(m) {
  const k = attnKind(m), lbl = { blocked: 'Blocked', behind: 'Behind', at_risk: 'At risk', look: 'Needs attention' }[k], w0 = alWhy(m), why = /^(Past the due date|No due date|Due within a month)$/.test(w0) ? '' : w0, owner = ownersOf(m)[0];
  return `<li class="lr ar-${k}" data-expand="${esc(m.id)}" tabindex="0">
    <div class="lr-top"><span class="lr-st"><i class="stdot st-${k === 'look' ? 'at_risk' : k}"></i>${lbl}</span>${dueChip(m)}</div>
    <div class="lr-t">${esc(m.activity)}</div>${why ? `<div class="lr-why">${esc(why)}</div>` : ''}
    <div class="lr-meta">${schoolChips(m)}<span class="lr-own" title="${esc(ownersOf(m).join(', ') || 'Unassigned')}">${owner ? personChip(owner) : ''}<span>${esc(owner || 'Unassigned')}${ownersOf(m).length > 1 ? ` +${ownersOf(m).length - 1}` : ''}</span></span></div></li>`;
}
document.addEventListener('keydown', e => { const r = e.target.classList && e.target.classList.contains('lr') && e.target.dataset.expand ? e.target : null; if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openModal(r.dataset.expand); } });
function attentionCard(list) {
  const items = attentionItems(list), F = [['all', 'All'], ['behind', 'Behind'], ['blocked', 'Blocked'], ['at_risk', 'At risk'], ['look', 'Needs attention']];
  const count = k => k === 'all' ? items.length : items.filter(m => attnKind(m) === k).length;
  let f = state.arF || 'all'; if (f !== 'all' && !count(f)) f = 'all';
  const fl = f === 'all' ? items : items.filter(m => attnKind(m) === f), show = fl.slice(0, 6);
  return `<section class="ex-card ar-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('warning')}<h3>Needs attention</h3></div><span class="dt-sum">${items.length} milestone${items.length === 1 ? '' : 's'}</span></div>
    ${items.length ? `<div class="fy-filters" role="group" aria-label="Show">${F.filter(([k]) => k === 'all' || count(k)).map(([k, l]) => `<button type="button" class="fy-filter ${f === k ? 'is-on' : ''}" aria-pressed="${f === k}" data-arf="${k}">${k !== 'all' ? `<i class="stdot st-${k === 'look' ? 'at_risk' : k}"></i>` : ''}${l}<span class="fy-n">${count(k)}</span></button>`).join('')}</div>
      <ul class="lr-list">${show.map(attnRow).join('')}</ul>${fl.length > show.length ? `<button class="card-more" data-showmore="focus">View all ${fl.length} in Milestones</button>` : ''}`
    : `<div class="fy-empty">${di('done', 24)}<div><b>Nothing needs attention</b><span>No milestones are behind, blocked or at risk in this view.</span></div></div>`}</section>`;
}
document.addEventListener('click', e => { const b = e.target.closest('[data-arf]'); if (!b) return; state.arF = b.dataset.arf; rerender(); const n = document.querySelector(`[data-arf="${b.dataset.arf}"]`); if (n) n.focus(); });
function comingUpCard(list) {
  const att = new Set(attentionItems(list).map(m => m.id)), t = today();
  const items = list.filter(m => dueWithin30(m) && !att.has(m.id)).sort((a, b) => a.due_date < b.due_date ? -1 : 1);
  const wk = m => { const d = daysUntil(m.due_date), endWk = 6 - t.getDay(); return d <= endWk ? 'This week' : d <= endWk + 7 ? 'Next week' : 'Later this month'; };
  const groups = {}; items.forEach(m => (groups[wk(m)] = groups[wk(m)] || []).push(m));
  const later = items.length ? [] : list.filter(m => m.status !== 'complete' && m.due_date && daysUntil(m.due_date) > 30 && !att.has(m.id)).sort((a, b) => a.due_date < b.due_date ? -1 : 1).slice(0, 3);   // fill the card when the month is quiet
  const nx = MEETINGS_ON ? mmNext()[0] : null;
  const meet = nx ? `<button type="button" class="cu-meet ${mmRgCls(nx.region)}" data-mm-open="${esc(nx.id)}">${di('cal', 20)}<span class="cu-meet-main"><span class="cu-k">Upcoming meeting · ${esc(relDays(nx.date))}</span><b>${esc(nx.title)}</b><span>${esc(mmWhen(nx, true))}</span></span>${nx.region ? mmRgTag(nx.region, true) : ''}</button>` : '';
  const row = m => `<li class="cu-row" data-expand="${esc(m.id)}"><span class="cu-date"><b>${parseDate(m.due_date).getDate()}</b><small>${parseDate(m.due_date).toLocaleDateString('en-US', { month: 'short' })}</small></span><span class="cu-main"><span class="cu-t">${esc(m.activity)}</span><span class="lr-meta">${schoolChips(m)}<span class="lr-own">${ownersOf(m)[0] ? personChip(ownersOf(m)[0]) : ''}<span>${esc(ownersOf(m)[0] || 'Unassigned')}</span></span></span></span></li>`;
  const cuv = state.cuView || 'list', csw = chSwitch('cuView', [['list', 'List'], ['month', 'By month']], cuv);
  if (cuv === 'month') return `<section class="ex-card cu-card"><div class="ex-card-head"><div class="ex-cardhead-l">${di('cal', 20)}<h3>Coming up</h3></div>${csw}</div>${chMonths(list)}</section>`;
  return `<section class="ex-card cu-card"><div class="ex-card-head"><div class="ex-cardhead-l">${di('cal', 20)}<h3>Coming up</h3></div>${csw}</div>
    ${meet}
    ${items.length ? ['This week', 'Next week', 'Later this month'].filter(g => groups[g]).map(g => `<div class="cu-group"><h4>${g}<span>${groups[g].length}</span></h4><ul class="cu-list">${groups[g].slice(0, 5).map(row).join('')}</ul></div>`).join('')
      + (items.length > 15 ? `<button class="card-more" data-drilldim="timing" data-drillval="due30">View all ${items.length} in Milestones</button>` : '')
      : (later.length ? `<div class="cu-group"><h4>Due next<span class="cu-h-note">Nothing ${nx ? 'else ' : ''}due in the next 30 days</span></h4><ul class="cu-list">${later.map(row).join('')}</ul></div>` : `<p class="cu-none">Nothing ${nx ? 'else ' : ''}due in the next 30 days</p>`)}</section>`;
}

/* ---------- Team health (Nov 19 2026) ----------
   Replaces the Teams table. Two views of one table:
   By team: health bar, on pace (done vs due so far), slipping, next key milestone.
   By month: how many milestones each team has due per month, tinted by how they are tracking. */
const TH_SEG = [['complete', 'Done', RAG.green], ['on_track', 'On track', RAG.blue], ['at_risk', 'At risk', RAG.yellow], ['behind', 'Behind or blocked', RAG.red], ['not_started', 'Not started', RAG.none]];
const thSeg = m => { const s = effectiveStatus(m); return s === 'blocked' ? 'behind' : TH_SEG.some(x => x[0] === s) ? s : 'not_started'; };
const thYM = d => d.slice(0, 7);
const thMonthLabel = ym => parseDate(ym + '-01').toLocaleDateString('en-US', { month: 'short' }) + (ym.slice(0, 4) !== todayISO().slice(0, 4) ? " '" + ym.slice(2, 4) : '');
function thByTeam(list) {
  const t = todayISO();
  const rows = teams().map(team => {
    const ms = list.filter(m => m.functional_area === team); if (!ms.length) return null;
    const open = ms.filter(m => m.status !== 'complete'), seg = {}; ms.forEach(m => { const k = thSeg(m); seg[k] = (seg[k] || 0) + 1; });
    const dueSoFar = ms.filter(m => m.due_date && m.due_date <= t), doneSoFar = dueSoFar.filter(m => m.status === 'complete').length;
    const off = (seg.behind || 0), risk = (seg.at_risk || 0), moved = ms.filter(m => flagPass(m, 'slipped')).length, fresh = ms.filter(newlyOffTrack).length;
    const nextList = open.filter(m => m.due_date).sort((a, b) => a.due_date < b.due_date ? -1 : 1), nk = nextList.find(isCritical) || nextList[0];
    return { team, ms, open, seg, dueSoFar: dueSoFar.length, doneSoFar, off, risk, moved, fresh, nk, score: 1e6 * off + 1e4 * (dueSoFar.length - doneSoFar) + 100 * risk + moved };
  }).filter(Boolean).sort((a, b) => b.score - a.score || (b.open.length - a.open.length));
  if (!rows.length) return '<p class="muted ex-empty">No milestones in this view</p>';
  const bar = r => `<span class="th-bar" role="img" aria-label="${TH_SEG.filter(([k]) => r.seg[k]).map(([k, l]) => `${r.seg[k]} ${l.toLowerCase()}`).join(', ')}">${TH_SEG.filter(([k]) => r.seg[k]).map(([k, l, c]) => `<i style="flex:${r.seg[k]};background:${c}" title="${r.seg[k]} ${esc(l.toLowerCase())}"></i>`).join('')}</span><span class="th-bar-n">${r.seg.complete || 0} of ${r.ms.length} done</span>`;
  const pace = r => !r.dueSoFar ? '<span class="muted">Nothing due yet</span>' : `<span class="${r.doneSoFar === r.dueSoFar ? 'th-ok' : 'th-bad'}">${r.doneSoFar} of ${r.dueSoFar}</span> <span class="muted">due so far done</span>`;
  const slip = r => { const p = [r.off ? `<span class="th-bad">${r.off} behind</span>` : '', r.risk ? `<span class="th-warn">${r.risk} at risk</span>` : '', r.moved ? `${r.moved} date${r.moved === 1 ? '' : 's'} moved` : '', r.fresh ? `<span class="th-bad">${r.fresh} newly off track</span>` : ''].filter(Boolean); return p.length ? p.join(' · ') : '<span class="th-ok">Nothing slipping</span>'; };
  const next = r => { if (!r.nk) return '<span class="muted">All done</span>'; const late = r.nk.due_date < t; return `<button type="button" class="ag-link th-next" data-expand="${esc(r.nk.id)}">${esc(clip(r.nk.activity, 60))}</button><span class="${late ? 'th-bad' : 'muted'}"> · ${esc(fmtDate(r.nk.due_date))}${late ? ' (late)' : ''}</span>`; };
  return `<div class="dt-wrap"><table class="dt th-table"><thead><tr><th>Team</th><th>Health</th><th>On pace</th><th>Slipping</th><th>Next key milestone</th></tr></thead><tbody>${rows.map(r => `<tr data-drilldim="team" data-drillval="${esc(r.team)}" title="Open ${esc(r.team)} in Milestones" class="${r.open.length ? '' : 'is-finished'}"><td><b>${esc(r.team)}</b></td><td class="th-health">${bar(r)}</td><td>${pace(r)}</td><td class="th-slip">${slip(r)}</td><td class="th-nk">${next(r)}</td></tr>`).join('')}</tbody></table></div>
    <div class="th-legend" aria-hidden="true">${TH_SEG.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>`;
}
function thMonths() { const d0 = today(), out = []; for (let i = 0; i < 6; i++) { const d = new Date(d0.getFullYear(), d0.getMonth() + i, 1); out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); } return out; }
function thByMonth(list) {
  const t = todayISO(), months = thMonths();
  const last = months[months.length - 1];
  const cols = [['late', 'Overdue'], ...months.map(ym => [ym, thMonthLabel(ym)]), ['later', 'Later']];
  const colOf = m => !m.due_date ? null : m.status !== 'complete' && m.due_date < t ? 'late' : thYM(m.due_date) > last ? 'later' : thYM(m.due_date) < months[0] ? null : thYM(m.due_date);
  const rows = teams().map(team => { const ms = list.filter(m => m.functional_area === team && m.due_date); return ms.length ? { team, ms } : null; }).filter(Boolean);
  if (!rows.length) return '<p class="muted ex-empty">No milestones with due dates in this view</p>';
  const cell = (team, ms, key) => {
    const c = ms.filter(m => colOf(m) === key); if (!c.length) return '<td class="num th-c th-c-0" aria-label="None"></td>';
    const off = c.filter(m => thSeg(m) === 'behind').length, risk = c.filter(m => thSeg(m) === 'at_risk').length, done = c.filter(m => m.status === 'complete').length;
    const tone = key === 'late' || off ? 'bad' : risk ? 'warn' : done === c.length ? 'ok' : 'n';
    const tip = `${c.length} due${done ? `, ${done} done` : ''}${off ? `, ${off} behind` : ''}${risk ? `, ${risk} at risk` : ''}`;
    const mark = tone === 'bad' ? `<i class="th-ic" aria-hidden="true">${off || key === 'late' ? '!' : ''}</i>` : tone === 'warn' ? '<i class="th-ic" aria-hidden="true">!</i>' : tone === 'ok' ? `<i class="th-ic" aria-hidden="true">${CI('check')}</i>` : '';
    return `<td class="num th-c th-${tone}"><button type="button" data-th-cell="${esc(team)}|${key}" title="${tip}. Select to see them" aria-label="${esc(team)}, ${esc(cols.find(x => x[0] === key)[1])}: ${tip}">${mark}<span>${c.length}</span></button></td>`;
  };
  const totals = cols.map(([k]) => list.filter(m => m.due_date && colOf(m) === k).length);
  return `<div class="dt-wrap"><table class="dt th-table th-month"><thead><tr><th>Team</th>${cols.map(([k, l]) => `<th class="num ${k === 'late' ? 'th-late-h' : ''}">${l}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr><td><b>${esc(r.team)}</b></td>${cols.map(([k]) => cell(r.team, r.ms, k)).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr><td>All teams</td>${totals.map(n => `<td class="num">${n || '<span class="muted">0</span>'}</td>`).join('')}</tr></tfoot></table></div>
    <div class="th-legend" aria-hidden="true"><span><i class="th-sw th-bad"></i>Overdue or behind</span><span><i class="th-sw th-warn"></i>At risk</span><span><i class="th-sw th-ok"></i>All done</span><span><i class="th-sw th-none"></i>On track or not started</span></div>`;
}
function teamsCard(list) {
  let v = state.thView || lsGet('ngc_th_view') || 'team'; if (!['team', 'month'].includes(v)) v = 'team';
  const sw = [['team', 'Status by team'], ['month', 'Deadlines by month']].map(([k, l]) => `<button type="button" class="th-sw-b ${v === k ? 'is-on' : ''}" aria-pressed="${v === k}" data-th-view="${k}">${l}</button>`).join('');
  return `<section class="ex-card dt-card th-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('people')}<h3>Team progress</h3></div><div class="th-switch" role="group" aria-label="View">${sw}</div></div>
    ${v === 'month' ? thByMonth(list) : thByTeam(list)}</section>`;
}
document.addEventListener('click', e => {
  const nk = e.target.closest('.th-next'); if (nk) { e.stopPropagation(); return openModal(nk.dataset.expand); }
  const b = e.target.closest('[data-th-view]'); if (b) { state.thView = b.dataset.thView; lsSet('ngc_th_view', state.thView); return rerender(); }
  const c = e.target.closest('[data-th-cell]'); if (!c) return; e.stopPropagation();
  const [team, key] = c.dataset.thCell.split('|'), t = todayISO(), list = filtered().filter(m => m.functional_area === team && m.due_date);
  const pick = list.filter(m => key === 'late' ? m.status !== 'complete' && m.due_date < t : key === 'later' ? thYM(m.due_date) > thMonths()[5] : thYM(m.due_date) === key && !(m.status !== 'complete' && m.due_date < t)).sort((a, b) => a.due_date < b.due_date ? -1 : 1);
  const label = key === 'late' ? 'overdue' : key === 'later' ? 'due later' : 'due in ' + parseDate(key + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const w = openSheet(`${team}: ${pick.length} ${label}`, `<ul class="th-sheet">${pick.map(m => { const s = thSeg(m), seg = TH_SEG.find(x => x[0] === s); return `<li><button type="button" data-expand="${esc(m.id)}"><i style="background:${seg[2]}"></i><span><b>${esc(m.activity)}</b><small>${esc(seg[1])} · ${esc(fmtDate(m.due_date))} · ${esc(ownersOf(m)[0] || 'No owner')}</small></span></button></li>`; }).join('')}</ul>`);
  const host = w && w.addEventListener ? w : $('#sheetBackdrop');
  if (host) host.addEventListener('click', ev => { const x = ev.target.closest('[data-expand]'); if (x) { closeSheet(); openModal(x.dataset.expand); } });
}, true);

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
  else if (dim === 'openingFY') state.filters.openingFYs = new Set([Number(val)]);
  else if (dim === 'school') state.filters.schools = new Set([val]);
  else if (dim === 'status') { state.filters.statuses = new Set([val]); state.filters.timing = ''; }
  else if (dim === 'timing') { state.filters.timing = val; state.filters.statuses.clear(); }
  else if (dim === 'riskbehind') { state.filters.statuses = new Set(['at_risk', 'behind']); state.filters.timing = ''; }
  else if (dim === 'flag') { state.filters.flag = val; }
  else if (dim === 'all') { /* just show the detailed list */ }
  state._expandAllOnce = true;
  setView('plan'); window.scrollTo({ top: 0, behavior: 'smooth' });   // dashboard = status; drilling opens the Project Plan, filtered
}
function refreshResults() { refreshBody(); }

function milestoneUrl(id) { return taskLink(id); }
function duplicateMilestone(id) {
  if (!guardEdit()) return;
  if (modalDirty) return toast('Save or discard your changes first', 'warn');
  const src = findM(id); if (!src) return;
  closeModal();
  const m = clone(src);
  Object.assign(m, { id: uid(), _draft: true, status: 'not_started', progress_percent: 0, stage: 'to_do', noteLog: [], dateHistory: [], checkins: [], completedAt: null, updatedAt: null, updatedBy: null, createdAt: new Date().toISOString() });
  delete m.statusBeforeBlock;
  (m.checkpoints || []).forEach(c => { c.done = false; });
  M().push(m); openModal(m.id);
  toast('Copy ready. Change what differs, then Save', 'ok');
}
// Link to the current page with its filters, to share in Slack or email
function viewLink() {
  const f = state.filters, o = {};
  Object.keys(f).forEach(k => { const v = f[k]; if (v instanceof Set) { if (v.size) o[k] = [...v]; } else if (v) o[k] = v; });
  const u = new URL(location.href); u.search = ''; u.hash = '';
  if (Object.keys(o).length) u.searchParams.set('f', JSON.stringify(o));
  return u.toString() + '#' + state.view;
}
function applyViewLink(raw) {
  let o; try { o = JSON.parse(raw); } catch (e) { return false; }
  if (!o || typeof o !== 'object') return false;
  Object.keys(o).forEach(k => {
    if (!(k in state.filters)) return;
    const cur = state.filters[k], v = o[k];
    if (cur instanceof Set && Array.isArray(v)) state.filters[k] = new Set(v.filter(x => typeof x === 'string' || typeof x === 'number').map(x => typeof cur.values().next().value === 'number' || /FYs$/.test(k) || k === 'fys' ? +x : x));
    else if (typeof v === 'string') state.filters[k] = v.slice(0, 80);
  });
  if (state.filters.schoolId) { state.filters.schools.add(state.filters.schoolId); state.filters.schoolId = ''; }   // links made before multi-school
  return true;
}
// Each person's Group by and List/Board choice sticks between visits
const PLAN_KEY = 'ngc_plan_' + WS;
function savePlanGroup() { lsSet(PLAN_KEY, JSON.stringify({ g: state.planGroup, l: state._lastListGroup || '' })); }
function restorePlanGroup() { try { const v = JSON.parse(lsGet(PLAN_KEY) || 'null'); if (v && typeof v.g === 'string' && /^(team|stage|market|year|school|state|fy)$/.test(v.g)) { state.planGroup = v.g; if (v.l) state._lastListGroup = v.l; } } catch (e) {} }
function moveToStage(m, stage) {
  if (stage === 'complete' && m.stage !== 'complete' && blockIfTeamsOpen(m)) { refreshResults(); return; }
  snapshotForUndo('Move milestone: ' + (m.activity || '').slice(0, 30)); logActivity('move', `Moved "${m.activity}" to ${((meta().stages || []).find(x => x[0] === stage) || [stage, stage])[1]}`, { itemId: m.id }); const was = m.stage; m.stage = stage; touch(m);
      if (m.stage === 'complete') { m.status = 'complete'; m.progress_percent = 100; }
      else if (m.status === 'complete' && m.stage === 'to_do') { m.status = 'not_started'; m.progress_percent = 0; }
      else { if (m.status === 'complete') { m.status = 'on_track'; if (m.progress_percent === 100) m.progress_percent = 95; } if (m.status === 'not_started' && m.stage !== 'to_do') m.status = 'on_track'; }
      touch(m); autosave(); refreshResults(); const col = (meta().stageMeta && meta().stageMeta[m.stage] && meta().stageMeta[m.stage].label) || (m.stage.charAt(0).toUpperCase() + m.stage.slice(1)).replace(/_/g, ' '); toastAction(`Moved to ${col}`, 'Undo', undo);
}
// Board on phones and for keyboard users: move a card with a menu instead of dragging
function openMoveMenu(btn) {
  if (!guardEdit()) return;
  const m = findM(btn.dataset.kmove); if (!m) return;
  const html = `<div class="pop-title">Move to</div><div class="pop-list">${meta().stages.filter(([k]) => k !== (m.stage || 'to_do')).map(([k, l]) => `<button class="pop-item" data-kmoveto="${esc(k)}">${esc(l)}</button>`).join('')}</div>`;
  const p = openPopover(btn, html);
  p.addEventListener('click', e => { const o = e.target.closest('[data-kmoveto]'); if (!o) return; closePopover(); moveToStage(m, o.dataset.kmoveto); });
  const first = p.querySelector('.pop-item'); if (first) first.focus();
}
function addItem(stage, team) {
  if (!guardEdit()) return;
  const st = stage || 'to_do', done = st === 'complete';
  const dm = state.filters.markets.size === 1 ? [...state.filters.markets][0] : '', dt = team || defaultTeam();
  const m = { id: uid(), state: stateOfMarket(dm) || '', market: dm, team: dt, functional_area: dt, workstream: 'General', activity: '', schools: [], schoolIds: [], targetFY: currentFY(), targetQuarter: '', openingFY: null, due_date: null, status: done ? 'complete' : 'not_started', stage: st, progress_percent: done ? 100 : 0, priority: 'medium', owner: myOwnerName(), dependency: '', keyMilestone: false, greenlight: false, transition: false, notes: '', tags: [] };
  m._draft = true; m.createdAt = new Date().toISOString();
  if (!m.owner && state.filters.owners.size === 1 && !state.filters.owners.has('__none__')) m.owner = [...state.filters.owners][0];
  if (!m.owner) m.owner = myOwnerName();
  const fsch = state.filters.schools.size === 1 && schoolById([...state.filters.schools][0]); if (fsch) { m.schoolIds = [fsch.id]; m.schools = [fsch.code]; m.market = fsch.market; m.state = fsch.state; }
  M().push(m); openModal(m.id);   // draft: saved (and synced) only when the person clicks Save
}

/* popovers */
let popAnchor = null;
/* ---------- Carbon dropdown menus (Nov 19 2026) ----------
   Every single-choice <select> opens a Carbon list instead of the operating system's menu (mouse and keyboard).
   The real <select> stays in the page, so values, change events and forms work as before. Touch screens keep
   the native picker, which is easier to use there. Add data-native to a select to opt out. */
const cdsDdOk = s => s && s.tagName === 'SELECT' && !s.multiple && !s.disabled && !s.hasAttribute('data-native') && window.matchMedia('(pointer: fine)').matches;
function cdsDdOpen(sel) {
  const lbl = (sel.labels && sel.labels[0] && sel.labels[0].textContent.trim()) || sel.getAttribute('aria-label') || sel.title || 'Options';
  const item = o => `<button type="button" class="cds-dd-opt" role="option" aria-selected="${o.selected}" data-v="${esc(o.value)}" ${o.disabled ? 'disabled' : ''}><span>${esc(o.textContent.trim())}</span>${o.selected ? CI('check') : ''}</button>`;
  const html = [...sel.children].map(n => n.tagName === 'OPTGROUP' ? `<div class="cds-dd-grp" role="presentation">${esc(n.label)}</div>${[...n.children].filter(o => !o.hidden).map(item).join('')}` : n.hidden ? '' : item(n)).join('');
  const p = openPopover(sel, `<div class="cds-dd-list" role="listbox" aria-label="${esc(lbl)}">${html}</div>`);
  p.classList.add('cds-dd-pop'); p.style.minWidth = sel.getBoundingClientRect().width + 'px';
  const opts = () => [...p.querySelectorAll('.cds-dd-opt:not([disabled])')];
  (p.querySelector('.cds-dd-opt[aria-selected="true"]') || opts()[0] || p).focus({ preventScroll: false });
  const choose = b => { const changed = sel.value !== b.dataset.v; sel.value = b.dataset.v; closePopover(); sel.focus({ preventScroll: true }); if (changed) { sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); } };
  p.addEventListener('click', e => { const b = e.target.closest('.cds-dd-opt'); if (b && !b.disabled) choose(b); });
  p.addEventListener('keydown', e => {
    const list = opts(), i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]; if (n) n.focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); const n = e.key === 'Home' ? list[0] : list[list.length - 1]; if (n) n.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); sel.focus(); }
    else if (e.key === 'Tab') { closePopover(); }
    else if (e.key.length === 1 && /\S/.test(e.key)) { const k = e.key.toLowerCase(), from = i + 1; const n = [...list.slice(from), ...list.slice(0, from)].find(b => b.textContent.trim().toLowerCase().startsWith(k)); if (n) n.focus(); }
  });
}
document.addEventListener('mousedown', e => {
  const s = e.target.closest && e.target.closest('select'); if (!cdsDdOk(s) || e.button !== 0) return;
  e.preventDefault(); s.focus({ preventScroll: true });
  if (document.getElementById('popover') && popAnchor === s) return closePopover();
  cdsDdOpen(s);
}, true);
document.addEventListener('keydown', e => {
  const s = e.target; if (!cdsDdOk(s)) return;
  if ([' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(e.key) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); cdsDdOpen(s); }
}, true);
/* Exit motion (Nov 20 2026): a closing popup leaves with a short fade instead of vanishing. The live element is
   removed (or hidden) at once so app state never waits; a detached copy plays the 110 to 150ms exit. */
function moGhost(el, kind) {
  try {
    if (!el || !moOK() || !el.animate || !document.contains(el)) return;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
    const g = el.cloneNode(true); g.removeAttribute('id'); g.querySelectorAll('[id]').forEach(x => x.removeAttribute('id'));
    g.setAttribute('aria-hidden', 'true'); g.inert = true;
    Object.assign(g.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: '0', pointerEvents: 'none', zIndex: 10000, transition: 'none', animation: 'none' });
    document.body.appendChild(g);
    const frames = kind === 'drop' ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px)' }] : kind === 'dialog' ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px) scale(.985)' }] : [{ opacity: 1 }, { opacity: 0 }];
    const a = g.animate(frames, { duration: kind === 'drop' ? 110 : 150, easing: 'cubic-bezier(.2, 0, 1, .9)', fill: 'forwards' });
    a.onfinish = a.oncancel = () => g.remove(); setTimeout(() => g.remove(), 400);
  } catch (e) {}
}
function closePopover() { document.querySelectorAll('[aria-expanded="true"][aria-haspopup]').forEach(a => a.setAttribute('aria-expanded', 'false')); const p = $('#popover'); if (p) { const back = p.contains(document.activeElement) ? popAnchor : null; moGhost(p, 'drop'); p.remove(); if (back && document.contains(back)) back.focus({ preventScroll: true }); } document.removeEventListener('mousedown', outsidePop, true); }
function outsidePop(e) { if (!e.target.closest('#popover')) closePopover(); }
function openPopover(anchor, html) {
  closePopover();
  const p = document.createElement('div'); p.className = 'popover'; p.id = 'popover'; p.innerHTML = html; document.body.appendChild(p);
  if (anchor && anchor.setAttribute) { anchor.setAttribute('aria-expanded', 'true'); if (!anchor.getAttribute('aria-haspopup')) anchor.setAttribute('aria-haspopup', 'true'); }
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
function rememberRecent(id) { try { const k = 'ngc_recent_' + WS, r = JSON.parse(lsGet(k) || '[]').filter(x => x !== id); r.unshift(id); lsSet(k, JSON.stringify(r.slice(0, 6))); } catch (e) {} }
function recentIds() { try { return JSON.parse(lsGet('ngc_recent_' + WS) || '[]'); } catch (e) { return []; } }
function openModal(id) {
  closePopover();
  modalMode = 'task'; modalId = id; modalDirty = false; const m = findM(id); if (!m) return; if (!m._draft) rememberRecent(id);
  $('#modalBackdrop').classList.remove('sd-readonly'); applyRoleUI();   // undo the school dialog's read-only footer
  modalOpenDoc = clone(m); requestAnimationFrame(() => { const b = $('#modalBody'); if (b) b.scrollTop = 0; });
  $('#modalTitle').textContent = m._draft ? 'New milestone' : 'Milestone details';
  const seq = state.view === 'plan' ? filtered().slice().sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999')) : [], at = seq.findIndex(x => x.id === m.id);
  let nav = $('#modalNav'); if (!nav) { nav = document.createElement('span'); nav.id = 'modalNav'; nav.className = 'modal-nav'; $('#modalTitle').after(nav); }
  nav.innerHTML = !m._draft && at >= 0 && seq.length > 1 ? `<span class="muted">${at + 1} of ${seq.length}</span><button type="button" class="icon-btn" data-mnav="${esc((seq[at - 1] || {}).id || '')}" ${at === 0 ? 'disabled' : ''} aria-label="Previous milestone" title="Previous">${CI('arrow-up')}</button><button type="button" class="icon-btn" data-mnav="${esc((seq[at + 1] || {}).id || '')}" ${at === seq.length - 1 ? 'disabled' : ''} aria-label="Next milestone" title="Next">${CI('arrow-down')}</button>` : '';
  $('#modalDelete').style.display = m._draft ? 'none' : '';
  $('#modalBackdrop').classList.remove('mv');
  if (!m._draft && !state.mvFull) return mvOpen(m);   // saved milestones open the in-place view (Nov 20 2026)
  state.mvFull = false;
  const opt = (arr, val) => arr.map(x => Array.isArray(x) ? `<option value="${x[0]}" ${x[0] === val ? 'selected' : ''}>${esc(x[1])}</option>` : `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const schoolChecks = state.data.schools.filter(s => s.market === m.market).map(s => `<label class="field-check"><input type="checkbox" class="m-school" value="${esc(s.id)}" ${(m.schoolIds || []).includes(s.id) ? 'checked' : ''}> ${esc(schLbl(s))} <span class="muted">${esc(fyLabel(s.openingFY))}</span></label>`).join('') || '<span class="muted">No schools in this market</span>';
  const linked = (m.schoolIds || []).map(id => schoolById(id)).filter(Boolean);
  const schoolLinks = linked.length ? `<div class="sm-school-links">Linked schools: ${linked.map(s => `<button class="sm-school-link" data-openschool="${esc(s.id)}" title="Open ${esc(s.market)} · ${esc(schLbl(s))}">${schoolChip(s.market, [schLbl(s)])} ${CI('arrow')}</button>`).join('')}</div>` : '';
  const soLinked = (m.schoolIds || []).map(schoolById).filter(Boolean);
  const soNow = soLinked.length ? `${schoolChips(m)}<span class="muted so-opens">Opens ${esc([...new Set(soLinked.map(x => fallLbl(x.openingFY)))].join(', '))}</span>` : `${schoolChips(m)}<span class="muted so-opens">Not tied to a school</span>`;
  const soSec = `
    <div class="m-sec-h">School openings</div>
    ${m._draft ? '' : `<div class="so-sum" id="soSum"><span class="so-now">${soNow}</span>${canEdit() ? '<button type="button" class="btn btn-ghost btn-sm" id="soChange">Change</button>' : ''}</div>`}
    <div id="soEdit" ${m._draft ? '' : 'hidden'}>

    <div class="field"><div class="so-pick" id="mSchools">${schoolPicker(m)}</div></div>
    <div class="so-derived" id="mMarketDerived" ${(m.schoolIds || []).length ? '' : 'hidden'}>Market: <b id="mMarketName">${esc(m.market || '')}</b></div>
    <div class="field" id="mMarketWrap" ${(m.schoolIds || []).length ? 'hidden' : ''}><label for="mMarket">Market</label><select id="mMarket">${opt([['', 'Network-wide'], ...markets().map(x => [x, x])], (m.schoolIds || []).length ? '' : (m.market || ''))}</select></div>
    </div>
`;
  $('#modalBody').innerHTML = `
    <div class="m-top"><div class="m-top-meta">${m.status === 'complete' && m.completedAt ? `<div class="m-updated">Completed ${esc(fmtDate(m.completedAt.slice(0, 10)))}${m.due_date ? (m.completedAt.slice(0, 10) <= m.due_date ? ', on time' : `, ${daysBetween(parseDate(m.due_date), parseDate(m.completedAt.slice(0, 10)))} days after the due date`) : ''}</div>` : ''}${m.updatedAt ? `<div class="m-updated">Last updated ${esc(fmtWhen(m.updatedAt))}${m.updatedBy ? ' by ' + esc(m.updatedBy) : ''}${m.createdAt && !m._draft ? ` · added ${esc(fmtDate(m.createdAt.slice(0, 10)))}` : ''}</div>` : ''}</div>${m._draft ? '' : `<div class="m-acts"><button type="button" class="btn btn-ghost btn-sm" data-copylink="${esc(m.id)}">Copy link</button><button type="button" class="btn btn-ghost btn-sm" data-dupe="${esc(m.id)}">Duplicate</button></div>`}</div>
    ${m.keyMilestone || m.transition ? `<div class="m-tags">${m.keyMilestone ? '<span class="mt-tag mt-tag-blue">Key milestone</span>' : ''}${m.transition ? '<span class="mt-tag">Transition to Regional Ops</span>' : ''}</div>` : ''}
    <div class="field"><label for="mAct">Milestone <span class="req">*</span></label><textarea id="mAct" maxlength="300" placeholder="What needs to happen?">${esc(m.activity)}</textarea></div>
    ${m._draft ? soSec : ''}
    <div class="m-sec-h">Status and progress</div>
    ${m._draft ? '' : checkinBlock(m)}
    <div class="field-row"><div class="field"><label for="mStatus">Status</label><select id="mStatus">${opt(meta().statuses.map(s => [s, SM(s).label]), m.status)}</select><div class="help-text" id="mStatusHelp"></div></div>
      <div class="field" id="mProgWrap"><label for="mProg">Percent complete</label><input id="mProg" type="number" min="0" max="100" step="5" inputmode="numeric" value="${m.progress_percent || 0}"></div></div>
    <div class="field" id="mPb"></div>
    <div class="block-flag ${m.status === 'blocked' ? 'on' : ''}" id="mBlockWrap">
      <div class="block-flag-row"><button type="button" class="btn-block" id="mBlockBtn" aria-pressed="${m.status === 'blocked'}">${CI('flag')} <span>${m.status === 'blocked' ? 'Blocked' : 'Flag as blocked'}</span></button></div>
      <div class="field block-reason"><label for="mBlockWhy">What's blocking it?</label><input id="mBlockWhy" value="${esc(m.dependency)}" ></div>
    </div>
    <div class="m-sec-h">Owner and timing</div>
    <div class="field-row"><div class="field"><label for="mOwner">Owner</label><select id="mOwner">${ownerOptions(m.owner)}</select>${!m.owner && myOwnerName() ? '<button type="button" class="btn btn-text btn-sm" id="mAssignMe">Assign to me</button>' : ''}${m._draft ? '' : emailOwnersLink(m)}</div><div class="field"><label for="mDue">Due date</label><input id="mDue" type="date" aria-describedby="mDueHint" value="${esc(m.due_date || '')}"><div class="field mdw" id="mDueWhyWrap" hidden><label for="mDueWhy">Why is it moving? <span class="req">*</span></label><input id="mDueWhy" >${isAdmin() ? '' : ''}</div>${m.dueRequest ? dueReqBanner(m) : ''}</div></div>
    <div class="field"><label>Co-owners</label>${coOwnerPicker(m)}</div>
    <div class="field-row"><div class="field"><label for="mTeam">Team</label><select id="mTeam">${opt(teams(), m.functional_area)}</select></div><div class="field"><label for="mWs">Group <span class="muted">(optional)</span></label><input id="mWs" list="mWsList" autocomplete="off" value="${esc(groupOf(m))}"><datalist id="mWsList">${teamGroups(m.functional_area).map(g => `<option value="${esc(g)}">`).join('')}</datalist></div></div>
    ${teamPartsBlock(m)}
    ${schoolDoneBlock(m)}
    ${targetBlock(m)}
    ${checkpointsBlock(m)}
    ${linksDepsBlock(m)}
    ${m._draft ? '' : soSec}
    <div class="m-sec-h">Notes</div>
    <div class="field"><label for="mNotes">Notes and next steps</label><textarea id="mNotes" data-autogrow>${esc(m.notes)}</textarea></div>
    <details class="sm-details"><summary>More options${((n) => n ? ` <span class="muted">(${n} set)</span>` : '')([m.priority && m.priority !== 'medium', m.startDate, m.keyMilestone, m.transition].filter(Boolean).length)}</summary>
      <div class="field-row"><div class="field"><label>Priority</label><select id="mPri">${opt([['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], m.priority)}</select></div></div>
      <div class="field-row"><div class="field"><label>Target fiscal year</label><select id="mFy" ${m.due_date ? 'disabled title="Set from the due date"' : ''}><option value="">-</option>${fyList().map(fy => `<option value="${fy}" ${m.targetFY === fy ? 'selected' : ''}>${fyLabel(fy)}</option>`).join('')}</select></div><div class="field"><label>Quarter</label><select id="mQ" ${m.due_date ? 'disabled title="Set from the due date"' : ''}>${opt(['', 'Q1', 'Q2', 'Q3', 'Q4'], m.targetQuarter)}</select></div></div>
      <div class="field"><label>Start date</label><input type="date" id="mStart" value="${esc(m.startDate || '')}"></div>
      <div class="field"><label>Board column</label><select id="mStage">${opt(meta().stages, m.stage || 'to_do')}</select></div>
      <input type="hidden" id="mDep" value="${esc(m.dependency)}">
      <div class="field-row"><label class="field-check"><input type="checkbox" id="mKey" ${m.keyMilestone ? 'checked' : ''}> Key milestone</label><label class="field-check"><input type="checkbox" id="mTrans" ${m.transition ? 'checked' : ''}> Transition to Regional Ops</label></div>
    </details>
    ${notesSection('task', m.id, m.noteLog)}`;
  // Blocked flag: one obvious toggle that drives the status select and restores the prior status on unflag
  { const tl = $('#tpList'), ta = $('#tpAdd'); if (tl && ta) {
    ta.addEventListener('change', () => { const t = ta.value; if (!t) return; const lead = $('#mTeam').value; if (!tl.children.length && t !== lead) tl.insertAdjacentHTML('beforeend', tpRow(lead, null, true)); tl.insertAdjacentHTML('beforeend', tpRow(t, null, false)); const o = [...ta.options].find(x => x.value === t); if (o) o.remove(); ta.value = ''; modalDirty = true; });
    tl.addEventListener('click', e => { const d = e.target.closest('.tp-del'); if (!d) return; const r = d.closest('.tp-row'); ta.insertAdjacentHTML('beforeend', `<option value="${esc(r.dataset.team)}">${esc(r.dataset.team)}</option>`); r.remove(); if (tl.children.length === 1) tl.innerHTML = ''; modalDirty = true; });
    tl.addEventListener('change', () => { modalDirty = true; }); } }
  { const tm = $('#mTeam'), dl = $('#mWsList'); if (tm && dl) tm.addEventListener('change', () => { dl.innerHTML = teamGroups(tm.value).map(g => `<option value="${esc(g)}">`).join(''); }); }
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
  sel.addEventListener('change', () => { if (sel.value !== 'blocked') prior = sel.value; paintBlock(); const pg = $('#mProg'); if (pg && !pg.disabled && sel.value === 'complete') pg.value = 100; });
  why.addEventListener('input', () => { dep.value = why.value; });
  dep.addEventListener('input', () => { why.value = dep.value; });
  const dueHint = () => { const v = $('#mDue').value, h = $('#mDueHint') || (() => { const d = document.createElement('div'); d.id = 'mDueHint'; d.className = 'help-text'; $('#mDue').after(d); return d; })(); if (!v) { h.textContent = ''; return; } const d = daysUntil(v); h.textContent = sel.value === 'complete' ? '' : d === 0 ? 'Due today' : d > 0 ? `In ${d} day${d === 1 ? '' : 's'}` : `${-d} day${d === -1 ? '' : 's'} ago`; h.classList.toggle('is-late', d < 0 && sel.value !== 'complete'); };
  $('#mDue').addEventListener('change', dueHint); sel.addEventListener('change', dueHint); dueHint();
  $('#mCoBox').addEventListener('change', () => { const v = $$('#mCoBox .m-co').filter(x => x.checked).map(x => x.value); $('#mCoBox .co-sum').textContent = v.length ? v.join(', ') : 'None'; });
  wireForecastUI(m); wireTarget(); layoutMilestoneDialog(m); paintDialogProgress();
  const soCh = $('#soChange'); if (soCh) soCh.addEventListener('click', () => { $('#soEdit').hidden = false; $('#soSum').hidden = true; const f = $('#mSchools input'); if (f) f.focus(); });
  // Openings picker: selected chips highlight; the market follows the selected openings
  $('#mSchools').addEventListener('change', () => {
    $$('#mSchools .so-opt').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
    const mk = derivedMarket($$('#mSchools .m-school').filter(x => x.checked).map(x => x.value));
    syncTargetVisibility();
    $('#mMarketDerived').hidden = !mk; $('#mMarketWrap').hidden = !!mk; if (mk) $('#mMarketName').textContent = mk;
  });
  lockModalIfReadOnly();
  $('#modalBackdrop').classList.add('open');
  if (m._draft) setTimeout(() => $('#mAct').focus(), 50);
}
function saveModal() {
  if ($('#modalBackdrop').classList.contains('mv')) return;   // the in-place view saves each change as it happens
  if (!guardEdit()) return;
  if (modalMode === 'school') return saveSchool();
  const m = findM(modalId); if (!m) { closeModal(); toast('A teammate removed this milestone, so your edits were not saved', 'warn'); return; }
  if (!$('#mAct').value.trim()) { markInvalid($('#mAct'), 'Add a milestone name'); return; }
  if ($('#mStatus').value === 'blocked' && !$('#mBlockWhy').value.trim()) { markInvalid($('#mBlockWhy'), "Say what's blocking it"); return; }
  const startV = ($('#mStart') || {}).value, dueV0 = $('#mDue').value;
  if (startV && dueV0 && startV > dueV0) { const dt = $('#mStart').closest('details'); if (dt) dt.open = true; markInvalid($('#mStart'), 'Start date must be on or before the due date'); return; }
  const tpRows = $$('#tpList .tp-row').map(r => ({ team: r.dataset.team, done: r.querySelector('.tp-done').checked }));
  if ($('#mStatus').value === 'complete' && m.status !== 'complete' && tpRows.some(x => !x.done) && !tpRows.every(x => x.done)) { markInvalid($('#tpAdd'), 'Every team must check off its part first'); return; }
  const sdRows = $$('#sdWrap .sd-done').map(x => ({ id: x.value, done: x.checked }));
  if ($('#mStatus').value === 'complete' && m.status !== 'complete' && sdRows.some(x => !x.done)) { markInvalid($('#sdWrap .sd-done:not(:checked)'), 'Check off every school first'); return; }
  const sdWasReady = !!readyToComplete(m);
  const wasDraft = !!m._draft;
  const fx = readForecastUI(m); if (fx === false) return;
  const tg0 = readTarget(); if (tg0 === false) return;
  const msr = ($('input[name="mMeasure"]:checked') || {}).value; if (msr) m.measure = msr;
  snapshotForUndo((wasDraft ? 'Create milestone: ' : 'Edit milestone: ') + ($('#mAct').value.trim() || m.activity || '').slice(0, 40));
  const current = clone(m), prevStatus = m.status, prevProg = m.progress_percent || 0;
  m.activity = $('#mAct').value.trim() || m.activity; 
  m.team = $('#mTeam').value; m.functional_area = m.team; m.workstream = $('#mWs').value.trim() || 'General';
  m.schoolIds = $$('#mSchools .m-school').filter(x => x.checked).map(x => x.value);
  { const prevSd = m.schoolDone || {}, nx = {}; sdRows.forEach(r => { if (r.done && m.schoolIds.includes(r.id)) nx[r.id] = prevSd[r.id] || { by: currentDisplayName() || '', t: new Date().toISOString() }; }); m.schoolDone = nx; }
  m.schools = m.schoolIds.map(id => { const sc = schoolById(id); return sc ? sc.code : null; }).filter(Boolean);
  m.market = derivedMarket(m.schoolIds) || $('#mMarket').value || ''; m.state = stateOfMarket(m.market) || '';
  m.targetFY = $('#mFy').value ? +$('#mFy').value : null; m.targetQuarter = $('#mQ').value;
  if ($('#mStatus').value === 'blocked' && m.status !== 'blocked') m.statusBeforeBlock = m.status;
  m.status = $('#mStatus').value; m.stage = $('#mStage').value; m.priority = $('#mPri').value;
  m.progress_percent = Math.max(0, Math.min(100, +$('#mProg').value || 0));
  m.startDate = ($('#mStart') || {}).value || null;
  applyForecastUI(m, fx, prevStatus);
  if (tg0) { const pt = m.target; tg0.log = ((pt && pt.log) || []).slice(-50); if (!pt || +pt.done !== tg0.done) tg0.log.push({ t: new Date().toISOString(), by: currentDisplayName() || '', done: tg0.done, ...(tg0.bySchool ? { bySchool: JSON.parse(JSON.stringify(tg0.bySchool)) } : {}) }); m.target = tg0; } else delete m.target;
  if (activeTarget(m) && m.status !== 'complete') m.progress_percent = tgProgress(m.target);
  { const lead = m.functional_area; let tp = tpRows.slice(); if (tp.length && !tp.some(x => x.team === lead)) tp.unshift({ team: lead, done: false }); if (tp.length === 1) tp = [];
    const prevTp = m.teamParts || []; m.teamParts = tp.map(x => { const p = prevTp.find(y => y.team === x.team && y.done); return x.done ? { team: x.team, done: true, by: (p && p.by) || currentDisplayName() || '', t: (p && p.t) || new Date().toISOString() } : { team: x.team, done: false }; });
  }
  // Keep status, progress and board stage telling the same story
  if (m.status !== 'complete' && measureOf(m) === 'percent' && (m.schoolIds || []).length > 1 && !(m.checkpoints || []).length) m.progress_percent = Math.max(m.progress_percent || 0, Math.round(100 * Object.keys(m.schoolDone || {}).length / m.schoolIds.length));
  const askDone = m.status !== 'complete' && prevStatus !== 'complete' ? (readyToComplete(m) || (m.progress_percent === 100 && prevProg !== 100 ? 'Progress reached 100%' : '')) : '';
  if (m.status === 'complete') { m.progress_percent = 100; m.stage = 'complete'; }
  else { if (m.stage === 'complete') m.stage = 'in_progress'; if (prevStatus === 'complete' && m.progress_percent === 100) m.progress_percent = 95; }
  m.owner = $('#mOwner').value.trim(); m.coOwners = $$('#mCoBox .m-co').filter(x => x.checked).map(x => x.value).filter(x => x && x !== m.owner); m.due_date = $('#mDue').value || null; m.dependency = $('#mDep').value.trim();
  if (fx.req) { m.due_date = fx.oldDue; m.dueRequest = fx.req; }
  syncFiscal(m);
  m.notes = $('#mNotes').value.trim(); m.keyMilestone = $('#mKey').checked; m.transition = $('#mTrans').checked;
  const os = m.schoolIds.length ? schoolById(m.schoolIds[0]) : null; if (os) m.openingFY = os.openingFY;
  readLinksDeps(m);
  if (!wasDraft) keepTeammateEdits(m, modalOpenDoc, current);
  delete m._draft; touch(m);
  logActivity(wasDraft ? 'create' : 'edit', (wasDraft ? 'Created: ' : 'Updated: ') + m.activity, { itemId: m.id });
  autosave(); closeModal(); rerender();
  if (askDone && !sdWasReady) setTimeout(() => askToComplete(m, askDone), 150);
  if (fx.req) toast(`New date sent to an admin for approval. It stays ${fmtDate(fx.oldDue)} until then`);
  const late = m.due_date && (m.schoolIds || []).map(schoolById).filter(sc => sc && sc.opening_date && m.due_date > sc.opening_date);
  if (late && late.length) toast(`Saved. This is due after ${late[0].market} · ${schLbl(late[0])} opens on ${fmtDate(late[0].opening_date)}`, 'warn');
  if (passFilters(m) && state.view === 'plan') { state.flashId = m.id; rerender(); setTimeout(() => { const el = document.querySelector(`.kcard[data-id="${m.id}"], .bd-card[data-id="${m.id}"], .ml-row[data-id="${m.id}"]`); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('kc-flash'); setTimeout(() => el.classList.remove('kc-flash'), 1800); } state.flashId = null; }, 80); }
  if (late && late.length) return;
  if (!passFilters(m)) toastAction(`${wasDraft ? 'Added' : 'Saved'}. Your filters hide it`, 'Clear filters', () => { clearFilters(); rerender(); });
  else toast((wasDraft ? 'Added: ' : 'Saved: ') + clip(m.activity, 40) + (m.status === 'complete' && prevStatus !== 'complete' ? unblockNote(m) : ''), 'ok');
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
  modalDirty = false; const mb = $('#modalBackdrop'); if (mb && mb.classList.contains('open')) { const box = mb.querySelector('.modal'); if (box) { const sh = document.createElement('div'); sh.className = 'mo-scrim'; document.body.appendChild(sh); moGhost(sh, 'fade'); sh.remove(); moGhost(box, 'dialog'); } } $('#modalBackdrop').classList.remove('open', 'mv'); modalId = null; const ret = taskReturnSchool; taskReturnSchool = null; if (ret) setTimeout(() => openSchoolModal(ret), 0); }
function attemptCloseModal() {
  const draft = ($('#noteInput') && $('#noteInput').value.trim()) || '';
  if (!modalDirty && !draft) return closeModal();
  if (!modalDirty) return confirmDialog({ title: 'Discard your comment?', message: 'You typed a comment but did not post it.', confirmLabel: 'Discard', danger: true, undo: false, onConfirm: () => closeModal() });
  confirmDialog({ undo: false,
    title: 'Discard unsaved changes?',
    message: `You have unsaved edits in this ${modalMode === 'school' ? 'school' : 'milestone'}. Close without saving?`,
    confirmLabel: 'Discard',
    danger: true,
    onConfirm: () => closeModal()
  });
}

/* reusable confirmation popup (native confirm() is blocked in sandboxed iframes) */
function closeConfirm() { const w = $('#confirmBackdrop'); if (w) { moGhost(w, 'fade'); w.remove(); } }
// In-app text entry (replaces the browser's prompt(), which looks like a system alert and is blocked in some browsers)
function inputDialog(o, onSave) {
  closeConfirm();
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  w.innerHTML = `<div class="confirm-box"><h3>${esc(o.title)}</h3>
    <div class="confirm-typed field"><label for="cfgName">${esc(o.label || 'Name')}</label><input id="cfgName" type="${esc(o.type || 'text')}" autocomplete="${esc(o.autocomplete || 'off')}" ${o.inputmode ? `inputmode="${esc(o.inputmode)}"` : ''} placeholder="${esc(o.placeholder || '')}" value="${esc(o.value == null ? '' : o.value)}" aria-label="${esc(o.title)}">${o.msg ? `<div class="help-text">${esc(o.msg)}</div>` : ''}</div>
    <div class="confirm-actions"><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn btn-filled" id="cfgOk">Save</button></div></div>`;
  document.body.appendChild(w);
  const inp = w.querySelector('#cfgName');
  const done = ok => { const v = inp.value.trim(); if (ok && o.validate) { const err = o.validate(v); if (err) return markInvalid(inp, err); } closeConfirm(); if (ok && (v || o.allowEmpty)) onSave(v); };
  w.addEventListener('click', e => { if (e.target === w || e.target.id === 'cfgCancel') done(false); else if (e.target.id === 'cfgOk') done(true); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
  setTimeout(() => { inp.focus(); if (inp.select && inp.type !== 'date') inp.select(); }, 30);
}
// "2.5M", "$750,000", "750k" -> number
function parseMoney(v) { const m = String(v).replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)([kKmM]?)$/); if (!m) return null; return Math.round(+m[1] * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1)); }
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
    ${opts.danger && opts.undo !== false ? `<div class="confirm-shared">${shared ? 'This removes it for everyone on the shared board. You can undo right after' : 'You can undo right after'}</div>` : ''}
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
// School display name (Nov 19 2026): South Florida schools read "S. Florida ES #3", shown after the county
// ("Broward · S. Florida ES #3"). The stored label (ES3) stays as is for matching, editing and sorting.
const SOFLO_MARKETS = ['Miami-Dade', 'Broward'];
function schLbl(s) {
  if (!s) return '';
  const raw = String(s.display_label || s.code || '');
  const m = raw.match(/^(ES|MS|HS)\s*#?\s*(\d+)$/i); if (!m) return raw;
  const lv = m[1].toUpperCase(), n = m[2], mk = String(s.market || '');
  if (SOFLO_MARKETS.includes(mk)) return `S. Florida ${lv} #${n}`;
  if (/^newark/i.test(mk)) return `TEAM ${lv} #${n}`;
  if (/^paterson/i.test(mk)) return `Paterson Prep ${lv} #${n}`;
  if (/^orange/i.test(mk)) return `Orange ${lv} #${n}`;
  if (/^camden/i.test(mk)) return `Cooper Norcross ${lv}`;
  return raw;
}
function schoolById(id) { return state.data.schools.find(s => s.id === id); }
function openSchoolModal(id) {
  $('#modalBackdrop').classList.remove('mv');
  if (!id && !guardEdit()) return;
  modalMode = 'school'; schoolId = id; modalDirty = false;
  const isNew = !id;
  const s0 = id ? schoolById(id) : null; modalOpenDoc = s0 ? clone(s0) : null;
  const s = s0 || { id: uid(), display_label: '', code: '', school_type: 'ES', pod_number: null, market: markets()[0], state: stateOfMarket(markets()[0]), openingFY: currentFY() + 1, openingQuarter: 'Q1', priority: false, confirmed: true, _new: true };
  $('#modalTitle').textContent = isNew ? 'Add a school opening' : `${s.market} · ${schLbl(s)}`;
  const opt = (arr, val) => arr.map(x => Array.isArray(x) ? `<option value="${x[0]}" ${x[0] === val ? 'selected' : ''}>${esc(x[1])}</option>` : `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
  let sm = isNew ? [] : schoolMsView(s);
  const roll = sm.length ? rollupStatus(sm) : 'not_started';
  const smRow = (m, showTeam) => `<div class="sm-task" data-expand="${m.id}">${statusDot(effectiveStatus(m))}<span class="sm-t-title">${esc(m.activity)}</span><span class="sm-t-team">${showTeam ? esc(m.functional_area || '') + (ownersOf(m).length ? ' · ' : '') : ''}${ownersOf(m).length ? esc(ownersOf(m)[0]) : ''}</span><span class="sm-t-due">${dueChip(m)}</span></div>`;
  const smSort = (a, b) => ((a.status === 'complete') - (b.status === 'complete')) || (a.due_date || '9999').localeCompare(b.due_date || '9999');
  const smBy = lsGet('ngc_sm_group') === 'due' ? 'due' : 'team';   // school dialog: group by function (default) or one list by due date
  // School dialog filters (Nov 19 2026): due range and show completed; remembered in this browser
  const smDue = ['any', 'overdue', '30', 'custom'].includes(lsGet('ngc_sm_due')) ? lsGet('ngc_sm_due') : 'any', smDone = lsGet('ngc_sm_done') !== '0';
  const smFrom = lsGet('ngc_sm_from') || '', smTo = lsGet('ngc_sm_to') || '', iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fqNow = fiscalQuarter(), fqNext = fiscalQuarter(new Date(fqNow.end.getFullYear(), fqNow.end.getMonth() + 1, 1)), tISO = todayISO();
  const smRange = { overdue: ['', iso(new Date(Date.now() - 864e5))], '30': [tISO, iso(new Date(Date.now() + 30 * 864e5))], q: [iso(fqNow.start), iso(fqNow.end)], nq: [iso(fqNext.start), iso(fqNext.end)], custom: smFrom || smTo ? [smFrom, smTo] : null }[smDue];
  const smQKey = m => { const d = m.due_date && parseDate(m.due_date); if (!d) return ''; const q = fiscalQuarter(d); return `${q.fy}-${q.q}`; };
  const smQs = new Set((lsGet('ngc_sm_qs') || '').split(',').filter(Boolean)), smQList = [...new Set(sm.map(smQKey).filter(Boolean))].sort();
  [...smQs].forEach(k => { if (!smQList.includes(k)) smQs.delete(k); });   // a quarter this school has no milestones in
  const smQLabel = k => { const [fy, q] = k.split('-'), n = +q.slice(1), sm0 = (6 + (n - 1) * 3) % 12, y0 = sm0 >= 6 ? fy - 1 : +fy, mo = i => new Date(y0, sm0 + i, 1).toLocaleDateString('en-US', { month: 'short' }); return [`FY${String(fy).slice(-2)} ${q}`, `${mo(0)} to ${mo(2)} ${new Date(y0, sm0 + 2, 1).getFullYear()}`]; };
  const smMe = myOwnerName(), smMine = !!smMe && lsGet('ngc_sm_mine') === '1';
  const smPass = m => (!smMine || ownsM(m, smMe)) && (!smQs.size || smQs.has(smQKey(m))) && (smDone || m.status !== 'complete') && (!smRange || (m.due_date && (!smRange[0] || m.due_date >= smRange[0]) && (!smRange[1] || m.due_date <= smRange[1]) && (smDue !== 'overdue' || m.status !== 'complete')));
  const smAll = sm; sm = sm.filter(smPass); const smFiltered = sm.length !== smAll.length;
  const taskList = !smAll.length ? '<div class="muted" style="font-size:14px">No milestones yet</div>' : !sm.length ? `<div class="sm-nomatch">No milestones match these filters<button type="button" class="btn btn-ghost btn-sm" data-smreset>Show all</button></div>` : smBy === 'due' ? sm.slice().sort(smSort).map(m => smRow(m, true)).join('') : (() => {
    const g = {}; sm.forEach(m => { const k = m.functional_area || m.team || 'No team'; (g[k] = g[k] || []).push(m); });
    const order = teams() || [], keys = Object.keys(g).sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b); });
    return keys.map(k => { const list = g[k].slice().sort(smSort), done = list.filter(m => m.status === 'complete').length, late = list.filter(m => m.status !== 'complete' && m.due_date && m.due_date < todayISO()).length;
      return `<details class="sm-group" ${done === list.length ? '' : 'open'}><summary><span class="sm-g-name">${esc(k)}</span><span class="sm-g-n">${done} of ${list.length} done${late ? ` · <b class="sm-g-late">${late} late</b>` : ''}</span></summary>${list.map(m => smRow(m, false)).join('')}</details>`; }).join('');
  })();
  const summary = isNew ? '' : `<div class="sm-summary">
    <span class="md-chips"><span class="kc-chip">${esc(schoolFacts(s))}</span><span class="kc-chip">${CAL_IC}Opens ${fallLbl(s.openingFY)}</span></span>
    <span class="sm-summary-r"><button type="button" class="btn btn-text btn-sm" data-copyschool="${esc(s.id)}">Copy link</button></span></div>`;
  const msHead = `<div class="sd-head"><h3 class="sd-title">Milestones <span class="muted">${smAll.filter(x => x.status === 'complete').length} of ${smAll.length} done${smFiltered ? ` · showing ${sm.length}` : ''}</span></h3>${smAll.length ? `<button class="btn btn-text btn-sm sm-openplan" data-openplanschool="${esc(s.id)}">Open in Milestones ${CI('arrow')}</button>` : ''}</div>
    ${smAll.length ? (() => { const nOn = (smDue !== 'any' && smRange ? 1 : 0) + (smDone ? 0 : 1) + (smQs.size ? 1 : 0) + (smMine ? 1 : 0), open = state.smFiltOpen, qOpen = state.smQOpen, curQ = `${fqNow.fy}-${fqNow.q}`;
      return `<div class="sm-ctl" data-nodirty>
      <div class="sm-groupby" role="group" aria-label="Group milestones"><button type="button" class="sm-gb ${smBy === 'team' ? 'is-on' : ''}" aria-pressed="${smBy === 'team'}" data-smgroup="team">By function</button><button type="button" class="sm-gb ${smBy === 'due' ? 'is-on' : ''}" aria-pressed="${smBy === 'due'}" data-smgroup="due">By due date</button></div>
      <button type="button" class="btn btn-ghost btn-sm sm-filt-btn ${nOn ? 'is-active' : ''}" id="smFiltBtn" data-smfilt aria-expanded="${!!open}" aria-controls="smFiltPanel">Filter${nOn ? `<span class="sm-filt-n">${nOn}</span>` : ''}</button>
      ${open ? `<div class="sm-filt-panel" id="smFiltPanel">
        <div class="sm-fp-row"><div class="sm-fp-f sm-qms"><span id="smQLbl">Quarter due</span>
          <button type="button" class="sm-qms-btn" id="smQBtn" data-smq aria-haspopup="listbox" aria-expanded="${!!qOpen}" aria-labelledby="smQLbl smQBtn">${smQs.size ? `<span class="sm-qms-tag">${smQs.size}<span class="sm-qms-x" data-smqclear role="button" aria-label="Clear quarters" tabindex="0">×</span></span>${smQs.size === 1 ? esc(smQLabel([...smQs][0])[0]) : 'quarters'}` : 'All quarters'}</button>
          ${qOpen ? `<ul class="sm-qms-list" role="listbox" aria-multiselectable="true" aria-labelledby="smQLbl">${smQList.map(k => { const [a, b] = smQLabel(k); return `<li role="option" aria-selected="${smQs.has(k)}"><label><input type="checkbox" data-smqv="${k}" ${smQs.has(k) ? 'checked' : ''}><span>${a}${k === curQ ? ' <em>current</em>' : ''}</span><small>${b}</small></label></li>`; }).join('')}</ul>` : ''}</div>
        <label class="sm-fp-f"><span>Due</span><select id="smDue" data-smf="due">${[['any', 'Any time'], ['overdue', 'Overdue'], ['30', 'Next 30 days'], ['custom', 'Date range']].map(([v, l]) => `<option value="${v}" ${smDue === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${smDue === 'custom' ? `<label class="sm-fp-f"><span>From</span><input type="date" id="smFrom" data-smf="from" value="${esc(smFrom)}"></label><label class="sm-fp-f"><span>To</span><input type="date" id="smTo" data-smf="to" value="${esc(smTo)}"></label>` : ''}</div>
        <div class="sm-fp-row sm-fp-foot"><span class="sm-fp-checks">${smMe ? `<label class="sm-fp-check"><input type="checkbox" id="smMine" data-smf="mine" ${smMine ? 'checked' : ''}> Assigned to me</label>` : ''}<label class="sm-fp-check"><input type="checkbox" id="smDone" data-smf="done" ${smDone ? 'checked' : ''}> Show completed</label></span>${nOn ? '<button type="button" class="btn btn-text btn-sm" data-smreset>Clear filters</button>' : ''}</div>
      </div>` : ''}
    </div>`; })() : ''}`;
  // plain calendar year - a school with openingFY=2028 opens in August 2027, so we show "2027"
  const fyField = `<div class="field"><label for="sFy">Opening date <span class="req">*</span></label><select id="sFy">${fyList().filter(fy => fy > currentFY() || fy === s.openingFY).map(fy => `<option value="${fy}" ${s.openingFY === fy ? 'selected' : ''}>August ${fy - 1}</option>`).join('')}</select></div>`;
  const qField = `<input type="hidden" id="sQ" value="${esc(s.openingQuarter || 'Q1')}">`;   // every opening is in August; quarter kept for old data
  const placeLbl = st => st === 'FL' ? 'County' : st === 'NJ' ? 'City' : 'County or city';
  const marketOnly = `<div class="field-row"><div class="field"><label for="sMarket" id="sMarketLbl">${placeLbl(stateOfMarket(s.market || markets()[0]))} <span class="req">*</span></label><select id="sMarket" onchange="schoolPlaceSync()">${opt(markets(), s.market)}</select></div><div class="field"><label>Region</label><div class="s-region" id="sRegion">${esc(schoolRegionName(s.market || markets()[0]))}</div></div></div>`;
  const curNum = s.pod_number || (String(s.display_label || s.code || '').match(/(\d+)\s*$/) || [])[1] || '';
  const labelField = `<div class="field-row"><div class="field"><label for="sType">Type <span class="req">*</span></label><select id="sType" onchange="schoolPlaceSync()">${opt([['ES', 'Elementary (ES)'], ['MS', 'Middle (MS)'], ['HS', 'High (HS)']], s.school_type || s.band || 'ES')}</select></div><div class="field"><label for="sNum">Number <span class="req">*</span></label><input id="sNum" type="number" min="1" inputmode="numeric" value="${esc(curNum)}" placeholder="4" oninput="schoolPlaceSync()"></div></div><input type="hidden" id="sLabel" value="${esc(s.display_label || s.code || '')}"><div class="help-text s-name-prev" id="sNamePrev"></div>`;
  const marketField = `<div class="field-row"><div class="field"><label>Market</label><select id="sMarket">${opt(markets(), s.market)}</select></div><div class="field"><label>Pod</label><input id="sPod" type="number" min="1" value="${s.pod_number || ''}" placeholder="4"></div></div>`;
  $('#modalBody').innerHTML = isNew ? `
    ${labelField}
    ${marketOnly}
    ${fyField}
    ${qField}`
    : `
    ${summary}
    <section class="sd-sec">
      ${msHead}
      <div class="sm-tasks">${taskList}</div>
      <div class="sm-task-actions"><button class="btn btn-tonal btn-sm" id="addTaskForSchool">+ Add milestone</button></div>
    </section>
    ${isAdmin() ? `<section class="sd-sec reschedule">
      ${fyField.replace('<select id="sFy">', `<select id="sFy" onchange="document.getElementById('sShiftWrap').hidden = +this.value === ${s.openingFY}">`)}${qField}
      <label class="field-check" id="sShiftWrap" hidden><input type="checkbox" id="sShift" checked> <span>Also move open milestone deadlines${((k) => k ? ` (${k})` : '')(schoolMs(s).filter(x => x.status !== 'complete' && x.due_date).length)}</span></label>
    </section>
    <details class="sm-details"><summary>More school details</summary>
      ${labelField}
      ${marketOnly}
    </details>` : ''}
    ${notesSection('school', s.id, s.noteLog)}`;
  $('#modalDelete').style.display = isNew ? 'none' : '';
  schoolPlaceSync(); const sdRO = !isNew && !isAdmin();   // only admins change school details (Nov 19 2026); everyone else reads, filters and comments
  $('#modalBackdrop').classList.toggle('sd-readonly', sdRO); if (sdRO) $('#modalCancel').textContent = 'Close';
  lockModalIfReadOnly();
  $('#modalBackdrop').classList.add('open');
}
// "Broward County, FL" / "Newark, NJ": the name already says ES or MS (Nov 20 2026)
function schoolFacts(s) {
  const st = s.state || stateOfMarket(s.market);
  return st === 'FL' ? `${s.market} County, FL` : st ? `${s.market}, ${st}` : s.market;
}
function schoolRegionName(market) { const r = mmRegionOfMarket(market); return r ? mmRgName(r) : (stateOfMarket(market) === 'NJ' ? 'New Jersey (no meeting region)' : 'None'); }
function schoolPlaceSync() {
  const mk = ($('#sMarket') || {}).value, st = stateOfMarket(mk), lbl = $('#sMarketLbl'), rg = $('#sRegion'), pv = $('#sNamePrev');
  if (lbl) lbl.innerHTML = `${st === 'FL' ? 'County' : st === 'NJ' ? 'City' : 'County or city'} <span class="req">*</span>`;
  if (rg) rg.textContent = schoolRegionName(mk);
  const t = ($('#sType') || {}).value, n = ($('#sNum') || {}).value;
  if (pv) pv.textContent = t && n ? `Shows as ${mk} · ${schLbl({ market: mk, display_label: t + n })}` : '';
}
function shiftDateYears(iso, years) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if (!m) return iso;
  const y = Number(m[1]) + years, leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const d = m[2] === '02' && m[3] === '29' && !leap ? '28' : m[3];   // Feb 29 lands on Feb 28 in non-leap years
  return `${y}-${m[2]}-${d}`;
}
function saveSchool() {
  if (!guardEdit()) return;
  if (!isAdmin()) return toast(schoolById(schoolId) ? 'Only admins can change school details' : 'Only admins add school openings', 'err');
  const isNew = !schoolById(schoolId);
  const s = isNew ? { id: schoolId || uid() } : schoolById(schoolId);
  const old = { code: s.code, market: s.market, openingFY: s.openingFY }, current = isNew ? null : clone(s);
  const num = +(($('#sNum') || {}).value || 0);
  if (!(num >= 1)) { markInvalid($('#sNum'), 'Add the school number, like 4'); return; }
  const label = ($('#sType').value + num).toUpperCase();
  const dup = state.data.schools.find(x => x.id !== s.id && x.market === $('#sMarket').value && (x.display_label || '').toUpperCase() === label);
  if (dup) { toast(`${$('#sMarket').value} already has ${label}. Pick a different name`, 'err'); $('#sLabel').focus(); return; }
  snapshotForUndo((isNew ? 'Add school ' : 'Edit school ') + label);
  s.display_label = label; s.code = label; s.school_type = $('#sType').value;
  s.pod_number = num; s.band = s.school_type;
  s.market = $('#sMarket').value; s.location = s.market; s.state = stateOfMarket(s.market); s.region = mmRegionOfMarket(s.market) || '';
  s.openingFY = +$('#sFy').value; s.fiscal_year = s.openingFY; s.openingQuarter = $('#sQ').value;
  s.opening_date = `${s.openingFY - 1}-08-01`; delete s.confirmed;
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
  confirmDialog({ title: `Remove ${s.market} · ${schLbl(s)}?`, message: `This removes it from the opening schedule` + (tasks.length ? ` Milestones that belong only to this school (up to <b>${tasks.length}</b>) are removed too.` : ''), confirmLabel: 'Remove school', danger: true, onConfirm: () => {
    snapshotForUndo('Remove school ' + schLbl(s)); logActivity('delete', 'Removed school ' + s.market + ' · ' + schLbl(s));
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
function fallLbl(fy) { return fy ? `August ${fy - 1}` : 'Not scheduled'; }
function milestoneTemplates() { return (meta().milestoneTemplates || []); }
function templatesButton(s) {
  const tpls = milestoneTemplates(); if (!tpls.length) return '';
  const have = new Set(schoolMs(s).map(m => (m.activity || '').trim().toLowerCase()));
  const n = tpls.filter(t => !have.has((t.activity || '').trim().toLowerCase())).length;
  if (!n) return '';
  return `<button class="btn btn-tonal btn-sm" id="tplToggle" >+ Load starter milestones (${n})</button>`;
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
        const dup = already.has((t.activity || '').trim().toLowerCase());
        const due = s.openingFY ? offsetDateISO(`${s.openingFY - 1}-08-01`, -(t.monthsBefore || 0)) : '';
        const flags = [t.keyMilestone && 'Key', t.greenlight && 'Greenlight', t.transition && 'Transition'].filter(Boolean).join(' ');
        return `<label class="tpl-item ${dup ? 'is-dup' : ''}" title="${dup ? 'Already on this school' : due ? `Due ${due}` : 'Set an opening date to calculate the due date'}">
          <input type="checkbox" class="tpl-check" data-tplid="${esc(t.id)}" ${dup ? 'disabled' : ''}>
          <span class="tpl-act">${esc(t.activity)}${flags ? ` <span class="tpl-flags">${flags}</span>` : ''}</span>
          <span class="tpl-when">${t.monthsBefore || 0} mo before</span>
        </label>`;
      }).join('')}
    </div>`).join('');
  return `<div class="tpl-panel hide" id="tplPanel">
    <div class="tpl-help">${s.openingFY ? `Due dates count back from August ${s.openingFY - 1}.` : 'No opening date yet, so these are added without due dates.'}</div>
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
  snapshotForUndo(`Add ${tpls.length} starter milestone${tpls.length === 1 ? '' : 's'} for ${schLbl(s)}`);
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
  logActivity('create', `Added ${tpls.length} starter milestone${tpls.length === 1 ? '' : 's'} to ${s.market} · ${schLbl(s)}`);
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
function rosterNames() { return (meta().owners || []).map(o => o.name).filter(Boolean).sort((a, b) => a.localeCompare(b)); }   // pickers list people A to Z
// Sign-in helpers: Show password, and a note when Caps Lock is on
document.addEventListener('change', e => {
  if (!e.target.classList || !e.target.classList.contains('pw-show')) return;
  const f = e.target.closest('form') || e.target.closest('.auth-card, .auth-box, .confirm-box') || document;
  f.querySelectorAll('input[type=password], input[data-pw]').forEach(i => { i.dataset.pw = '1'; i.type = e.target.checked ? 'text' : 'password'; });
});
['keydown', 'keyup'].forEach(ev => document.addEventListener(ev, e => {
  const i = e.target; if (!i || i.tagName !== 'INPUT' || !(i.type === 'password' || i.dataset.pw) || !e.getModifierState) return;
  let n = i.parentElement.querySelector('.caps-note');
  const on = e.getModifierState('CapsLock');
  if (on && !n) { n = document.createElement('div'); n.className = 'help-text caps-note'; n.textContent = 'Caps Lock is on'; i.after(n); }
  else if (!on && n) n.remove();
}));
let planSearchT = 0;
document.addEventListener('keydown', e => {
  if (e.target.id === 'planSearch' && e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; state.filters.search = ''; refreshBody(); }
}, true);
document.addEventListener('input', e => {
  if (e.target.id !== 'planSearch') return;
  clearTimeout(planSearchT);
  planSearchT = setTimeout(() => { state.filters.search = e.target.value.trim().slice(0, 80); refreshBody(); }, 200);
});
document.addEventListener('keydown', e => {
  const p = $('#popover'); if (!p || !p.contains(document.activeElement) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  if (document.activeElement.matches('input[type=text], input[type=search], textarea')) return;
  const items = [...p.querySelectorAll('button:not([disabled]), input[type=checkbox], a[href]')].filter(x => x.offsetParent); if (!items.length) return;
  const i = items.indexOf(document.activeElement); e.preventDefault();
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[j].focus();
});
function showShortcuts() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform), k = mac ? 'Cmd' : 'Ctrl';
  const rows = [['N', 'New milestone'], ['/', 'Search'], [k + '+Up / Down', 'Previous or next milestone in the dialog'], ['Shift+click', 'Select a range (Select mode)'], [k + '+A', 'Select all shown (Select mode)'], ['Alt+Left / Right', 'Move between meeting items'], [k + '+K', 'Search'], [k + '+Z', 'Undo'], [k + '+Enter', 'Save a dialog, or mark a meeting item discussed'], ['Esc', 'Close, or clear the Milestones filter'], ['Arrow keys', 'Move through an open menu']];
  openSheet('Keyboard shortcuts', `<table class="dt kb-table" aria-label="Keyboard shortcuts"><tbody>${rows.map(([a, b]) => `<tr><td><kbd>${esc(a)}</kbd></td><td>${esc(b)}</td></tr>`).join('')}</tbody></table>`, '<button class="btn btn-filled" data-sheet-close>Done</button>');
}
function syncSearchHint() { const i = document.querySelector('.cb-search input'); if (i) i.placeholder = hasSchoolWork() ? 'Search openings, milestones, people' : 'Search milestones and people'; }
// Settings > Data checks: gaps that make reminders, filters and dates less reliable
function dataChecksHtml() {
  const open = M().filter(m => m.status !== 'complete' && !m._draft);
  const noOwner = open.filter(m => !ownersOf(m).length).length, noDue = open.filter(m => !m.due_date).length;
  const people = meta().owners || [], noEmail = people.filter(o => !o.email).length;
  const teamLike = people.filter(o => teams().some(t => t.toLowerCase() === o.name.toLowerCase()) || o.name.includes('&')).length;
  const empty = hasSchoolWork() ? (state.data.schools || []).filter(sc => !schoolMs(sc).length).length : 0;
  const row = (n, label, attrs) => `<li class="dc-row ${n ? 'has' : ''}"><span class="dc-n">${n}</span><span class="dc-l">${label}</span>${n && attrs ? `<button type="button" class="btn btn-ghost btn-sm" ${attrs}>Show</button>` : ''}</li>`;
  const lateActs = openActions().filter(a => a.due && a.due < todayISO()).length;
  const total = noOwner + noDue + noEmail + teamLike + empty + (MEETINGS_ON ? lateActs : 0);
  return `<details class="dw-sec dw-fold"><summary>Data checks${total ? ` <span class="dc-badge">${total}</span>` : ''}</summary>
    <ul class="dc-list">${row(noOwner, 'Open milestones with no owner', 'data-dc="noowner"')}${row(noDue, 'Open milestones with no due date', 'data-dc="nodue"')}${row(noEmail, 'People with no email (reminders skip them)', 'data-dc="people"')}${row(teamLike, 'People entries that look like a team', 'data-dc="people"')}${hasSchoolWork() ? row(empty, 'School openings with no milestones', 'data-dc="empty"') : ''}${MEETINGS_ON ? row(lateActs, 'Meeting action items past due', 'data-goview="meetings"') : ''}</ul></details>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-dc]'); if (!b) return;
  const k = b.dataset.dc, close = () => { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); };
  if (k === 'noowner') { close(); clearFilters(); state.filters.owners = new Set(['__none__']); setView('plan'); rerender(); }
  else if (k === 'nodue') { close(); clearFilters(); applyDrill('flag', 'nodue'); }
  else if (k === 'empty') { close(); setView('timeline'); }
  else if (k === 'people') { const d = [...document.querySelectorAll('#drawer details')].find(x => /Customize/.test(x.querySelector('summary').textContent)); if (d) { d.open = true; const h = [...d.querySelectorAll('h4')].find(x => x.textContent === 'Owners'); (h || d).scrollIntoView({ behavior: 'smooth', block: 'start' }); const miss = [...d.querySelectorAll('.cz-email')].find(x => !x.value); if (miss) setTimeout(() => miss.focus(), 300); } }
});
// Saved views: each person keeps named filter sets per board (this browser)
const VIEWS_KEY = 'ngc_views_' + WS;
function savedViews() { try { return JSON.parse(lsGet(VIEWS_KEY) || '[]'); } catch (e) { return []; } }
function filtersSnapshot() { const f = state.filters, o = {}; Object.keys(f).forEach(k => { const v = f[k]; if (v instanceof Set) { if (v.size) o[k] = [...v]; } else if (v) o[k] = v; }); return o; }
function openViewsMenu(anchor) {
  const vs = savedViews();
  const html = `<div class="pop-title">Saved views</div><div class="pop-list">${vs.map((v, i) => `<div class="sv-row"><button class="pop-item" data-sv-apply="${i}">${esc(v.name)}</button><button class="icon-btn" data-sv-del="${i}" aria-label="Delete ${esc(v.name)}" title="Delete">${CI('close')}</button></div>`).join('') || '<div class="pop-empty muted">No saved views yet</div>'}</div>
    <button class="pop-item sv-save" data-sv-save ${Object.keys(filtersSnapshot()).length ? '' : 'disabled title="Set some filters first"'}>Save current filters</button>`;
  const p = openPopover(anchor, html);
  p.addEventListener('click', e => {
    const a = e.target.closest('[data-sv-apply]'), d = e.target.closest('[data-sv-del]'), sv = e.target.closest('[data-sv-save]');
    if (a) { const v = savedViews()[+a.dataset.svApply]; closePopover(); clearFilters(); applyViewLink(JSON.stringify(v.f)); if (v.view) setView(v.view); rerender(); toast(`Showing "${v.name}"`, 'ok'); }
    else if (d) { const list = savedViews(); list.splice(+d.dataset.svDel, 1); lsSet(VIEWS_KEY, JSON.stringify(list)); closePopover(); toast('View deleted', 'ok'); }
    else if (sv && !sv.disabled) { closePopover(); inputDialog({ title: 'Name this view', placeholder: 'For example: Florida, due this year' }, name => { const list = savedViews().filter(x => x.name !== name); list.push({ name: name.slice(0, 60), f: filtersSnapshot(), view: state.view }); lsSet(VIEWS_KEY, JSON.stringify(list.slice(-12))); toast(`Saved "${name}"`, 'ok'); }); }
  });
}
document.addEventListener('click', e => { const b = e.target.closest('#planViews'); if (b) openViewsMenu(b); });
// Keep the column tabs in step with swiping
document.addEventListener('scroll', e => {
  const k = e.target; if (!k.classList || !k.classList.contains('bd')) return;
  clearTimeout(k._t); k._t = setTimeout(() => {
    const cols = [...k.querySelectorAll('.bd-col')], x = k.scrollLeft; let best = 0;
    cols.forEach((c, i) => { if (Math.abs(c.offsetLeft - k.offsetLeft - x) < Math.abs(cols[best].offsetLeft - k.offsetLeft - x)) best = i; });
    state.kbCol = best; document.querySelectorAll('.bd-tab').forEach((t, i) => { t.classList.toggle('on', i === best); t.setAttribute('aria-selected', i === best); });
  }, 80);
}, true);
document.addEventListener('input', e => {
  if (e.target.classList && e.target.classList.contains('co-find')) { const q = e.target.value.trim().toLowerCase(); e.target.parentElement.querySelectorAll('.co-list .field-check').forEach(l => { l.hidden = !!q && !l.textContent.toLowerCase().includes(q); }); return; }
  if (e.target.id !== 'depFind') return;
  const q = e.target.value.trim().toLowerCase(), sel = $('#depAdd'); if (!sel) return;
  let first = null; [...sel.querySelectorAll('option')].forEach(o => { if (!o.value) return; const hit = !q || o.textContent.toLowerCase().includes(q); o.hidden = !hit; if (hit && !first) first = o; });
  [...sel.querySelectorAll('optgroup')].forEach(g => { g.hidden = ![...g.children].some(o => !o.hidden); });
  if (q && first) sel.size = Math.min(8, [...sel.options].filter(o => !o.hidden).length + 1); else sel.removeAttribute('size');
});
// Click a column heading to sort that table (Carbon sortable data table)
document.addEventListener('click', e => {
  const th = e.target.closest('.dt-sortable thead th'); if (!th) return;
  const tbl = th.closest('table'), i = [...th.parentElement.children].indexOf(th), body = tbl.tBodies[0]; if (!body) return;
  const dir = th.getAttribute('aria-sort') === 'descending' ? 'ascending' : 'descending';
  tbl.querySelectorAll('thead th').forEach(x => x.removeAttribute('aria-sort')); th.setAttribute('aria-sort', dir);
  const val = tr => { const t = (tr.children[i] || {}).textContent || ''; const n = parseFloat(t.replace(/[^0-9.-]/g, '')); return isNaN(n) ? t.toLowerCase() : n; };
  [...body.rows].sort((a, b) => { const x = val(a), y = val(b); const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); return dir === 'ascending' ? c : -c; }).forEach(r => body.appendChild(r));
});
function hiMatch(text, q) { const t = esc(text || ''), ws = String(q || '').trim().split(/\s+/).filter(w => w.length > 1).map(w => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); return ws.length ? t.replace(new RegExp('(' + ws.join('|') + ')', 'gi'), '<mark>$1</mark>') : t; }
document.addEventListener('toggle', e => {
  const d = e.target; if (!d.matches || !d.matches('#drawer details.dw-fold')) return;
  const k = (d.querySelector('summary') || {}).textContent; if (!k) return;
  try { const o = JSON.parse(lsGet('ngc_dw_open') || '{}'); o[k.replace(/\d+/g, '').trim()] = d.open; lsSet('ngc_dw_open', JSON.stringify(o)); } catch (x) {}
}, true);
function restoreDrawerFolds() { try { const o = JSON.parse(lsGet('ngc_dw_open') || '{}'); document.querySelectorAll('#drawer details.dw-fold').forEach(d => { const k = ((d.querySelector('summary') || {}).textContent || '').replace(/\d+/g, '').trim(); if (k in o) d.open = o[k]; }); } catch (e) {} }
(function watchVersion() {
  const mine = window.GH_VERSION; if (!mine) return; let told = false;
  const check = () => { if (told || document.visibilityState !== 'visible') return; fetch('version.js?t=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.text() : '').then(t => { const m = /GH_VERSION\s*=\s*'([^']+)'/.exec(t || ''); if (m && m[1] !== mine && !told) { told = true; toastAction(`A newer version (${m[1]}) is ready`, 'Reload', () => location.reload()); } }).catch(() => {}); };
  setInterval(check, 30 * 60000); document.addEventListener('visibilitychange', check);
  fetch('version.js?t=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.text() : '').then(t => {
    const m = /GH_VERSION\s*=\s*'([^']+)'/.exec(t || ''); if (!m || m[1] === mine) return;
    let tried = ''; try { tried = sessionStorage.getItem('gh_reloaded_for') || ''; } catch (e) {}
    if (tried === m[1]) return check();   // reloaded once already; fall back to the Reload notice
    try { sessionStorage.setItem('gh_reloaded_for', m[1]); } catch (e) {}
    if (!document.querySelector('#modalBackdrop.open, .modal-backdrop.open')) location.reload(); else check();
  }).catch(() => {});
})();
// 20 another tab changed this board's saved copy (only matters when not connected to the shared board)
window.addEventListener('storage', e => { if (e.key === LS.data && !(state.sb && state.sb.connected)) toastAction('This board changed in another tab', 'Reload', () => location.reload()); });
document.addEventListener('mouseover', e => {
  const i = e.target.closest && e.target.closest('#drawer .cz-name[data-cztype]'); if (!i || i.title) return;
  const t = i.dataset.cztype, n = czInUse(t === 'owner' ? 'owner' : t, i.dataset.czold || i.value); i.title = `${n} item${n === 1 ? '' : 's'} use this`;
});
function otherBoardLink(q) { const other = WS === 'readiness' ? ['enabling.html', 'Enabling Work'] : ['readiness.html', 'Growth Readiness']; return ` <a class="cmdk-other" href="${other[0]}?q=${encodeURIComponent((q || '').trim())}#plan">Search ${other[1]}</a>`; }
// ---------- bulk edit ----------
function bulkList() { return [...(state.sel || [])].map(findM).filter(Boolean); }
function paintBulkBar() {
  let bar = $('#bulkBar');
  if (!state.sel || state.view !== 'plan') { if (bar) bar.remove(); document.body.classList.remove('bulk-on'); return; }
  document.body.classList.add('bulk-on');
  if (!bar) { bar = document.createElement('div'); bar.id = 'bulkBar'; bar.className = 'bulk-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Selected milestones'); document.body.appendChild(bar); }
  const n = state.sel.size, shown = filtered().filter(m => !(state.hideDone && m.status === 'complete')).length;
  bar.innerHTML = `<span class="bulk-n" aria-live="polite">${n} selected</span>${n < shown ? `<button class="bulk-btn" data-bulk="all">Select all ${shown}</button>` : ''}
    <span class="bulk-acts">${n ? '<button class="bulk-btn" data-bulk="status" aria-haspopup="true">Status</button><button class="bulk-btn" data-bulk="owner" aria-haspopup="true">Owner</button><button class="bulk-btn" data-bulk="team" aria-haspopup="true">Team</button><button class="bulk-btn" data-bulk="due">Due date</button>' + '<button class="bulk-btn" data-bulk="delete">Delete</button>' : ''}<button class="bulk-btn bulk-cancel" data-bulk="cancel" title="Esc">Cancel</button></span>`;
}
function bulkApply(label, fn) {
  const list = bulkList(); if (!list.length || !guardEdit()) return;
  snapshotForUndo(`${label} (${list.length})`);
  list.forEach(m => { fn(m); touch(m); });
  logActivity('edit', `${label} for ${list.length} milestone${list.length === 1 ? '' : 's'}`);
  autosave(); state.sel = new Set(); renderPlan(); paintBulkBar();
  toastAction(`${label}: ${list.length} milestone${list.length === 1 ? '' : 's'}`, 'Undo', undo);
}
function bulkMenu(btn, title, opts, onPick) {
  const p = openPopover(btn, `<div class="pop-title">${esc(title)}</div>${opts.length > 10 ? '<input type="search" class="pop-find" placeholder="Find" aria-label="Find">' : ''}<div class="pop-list">${opts.map(([v, l]) => `<button class="pop-item pop-check" data-bv="${esc(v)}">${esc(l)}</button>`).join('')}</div>`);
  const f = p.querySelector('.pop-find'); if (f) { f.addEventListener('input', () => { const q = f.value.toLowerCase(); p.querySelectorAll('[data-bv]').forEach(b => { b.hidden = !!q && !b.textContent.toLowerCase().includes(q); }); }); setTimeout(() => f.focus(), 0); }
  p.addEventListener('click', e => { const b = e.target.closest('[data-bv]'); if (!b) return; closePopover(); onPick(b.dataset.bv, b.textContent); });
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-bulk]'); if (!b) return;
  const k = b.dataset.bulk;
  if (k === 'cancel') { state.sel = null; renderPlan(); return paintBulkBar(); }
  if (k === 'all') { filtered().filter(m => !(state.hideDone && m.status === 'complete')).forEach(m => state.sel.add(m.id)); state._expandAllOnce = true; renderPlan(); return paintBulkBar(); }
  if (k === 'status') return bulkMenu(b, 'Set status', meta().statuses.filter(x => x !== 'blocked').map(x => [x, SM(x).label]), v => bulkApply(`Status set to ${SM(v).label}`, m => { m.status = v; if (v === 'complete') { m.progress_percent = 100; m.stage = 'complete'; } else { if (m.stage === 'complete') m.stage = 'in_progress'; if (m.progress_percent === 100) m.progress_percent = 95; } }));
  if (k === 'owner') return bulkMenu(b, 'Set owner', [['', 'Unassigned'], ...rosterNames().map(x => [x, x])], v => bulkApply(v ? `Owner set to ${v}` : 'Owner cleared', m => { m.owner = v; m.coOwners = (m.coOwners || []).filter(o => o !== v); }));
  if (k === 'team') return bulkMenu(b, 'Set team', teams().map(x => [x, x]), v => bulkApply(`Team set to ${v}`, m => { m.functional_area = v; m.team = v; }));
  if (k === 'due') {
    closeConfirm(); const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
    w.innerHTML = `<div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="bdH"><h3 id="bdH">Set due date for ${state.sel.size}</h3><div class="field"><label for="bdDate">Due date</label><input id="bdDate" type="date"></div><div class="field"><label for="bdWhy">Why are these moving? <span class="req">*</span></label><input id="bdWhy"></div><div class="confirm-actions"><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn btn-filled" id="cfgOk">Set date</button></div></div>`;
    document.body.appendChild(w); setTimeout(() => $('#bdDate').focus(), 30);
    w.addEventListener('click', ev => { if (ev.target === w || ev.target.id === 'cfgCancel') return closeConfirm(); if (ev.target.id !== 'cfgOk') return; const d = $('#bdDate').value, why = $('#bdWhy').value.trim(); if (!d) return markInvalid($('#bdDate'), 'Pick a date'); if (!why) return markInvalid($('#bdWhy'), 'Say why the dates are moving'); closeConfirm(); bulkApply(`Due date ${isAdmin() ? 'set to' : 'requested for'} ${fmtDate(d)}`, m => { const from = m.due_date; if (!isAdmin() && from && from !== d) { m.dueRequest = dueReq(from, d, why); return; } m.due_date = d; syncFiscal(m); if (from && from !== d) logDateMove(m, from, d, why); }); });
    return;
  }
  if (k === 'meeting') { if (!guardAdmin()) return; const list = bulkList(); if (!list.length) return; const rg = [...new Set(list.map(m => mmRegionOfMarket(m.market)))]; if (mmAddToNext(list.map(m => ({ title: m.activity, lead: m.owner || '', mins: 5, ids: [m.id] })), rg.length === 1 ? rg[0] : '')) { state.sel = new Set(); renderPlan(); paintBulkBar(); } return; }
  if (k === 'delete') { const n = state.sel.size; return confirmDialog({ title: `Delete ${n} milestone${n === 1 ? '' : 's'}?`, message: 'They are removed from the board', confirmLabel: 'Delete', danger: true, onConfirm: () => { const ids = new Set(state.sel); snapshotForUndo(`Delete ${n} milestones`); state.data.milestones = M().filter(m => !ids.has(m.id)); logActivity('delete', `Deleted ${n} milestones`); autosave(); state.sel = new Set(); renderPlan(); paintBulkBar(); toastAction(`Deleted ${n} milestone${n === 1 ? '' : 's'}`, 'Undo', undo); } }); }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return; const w = $('#sheetBackdrop'); if (!w || !w.querySelector('.ck-row') || w.dataset.ok) return;
  const n = [...w.querySelectorAll('.ck-row')].filter(r => r.dataset.answer).length; if (!n || $('#confirmBackdrop')) return;
  e.preventDefault(); e.stopImmediatePropagation(); confirmDialog({ title: `Discard ${n} check-in${n === 1 ? '' : 's'}?`, message: 'Your answers have not been saved', confirmLabel: 'Discard', danger: true, onConfirm: () => { w.dataset.ok = '1'; closeSheet(); } });
}, true);
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'a' && state.sel && state.view === 'plan' && !(e.target.matches && e.target.matches('input, textarea'))) { e.preventDefault(); const b = document.querySelector('[data-bulk="all"]'); if (b) b.click(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.sel && !$('#popover') && !$('#confirmBackdrop') && !$('#modalBackdrop.open')) { state.sel = null; renderPlan(); paintBulkBar(); } });
document.addEventListener('click', e => {
  const b = e.target.closest('[data-mnav]'); if (!b || !b.dataset.mnav) return;
  if (modalDirty) return toast('Save or discard your changes first', 'warn');
  openModal(b.dataset.mnav);
});
document.addEventListener('click', e => {
  if (!e.target.closest('[data-allmentions]')) return;
  const items = myMentions(30), seen = cmtSeen();
  openSheet('Comments for you', `<div class="cm5-list">${items.map(x => cmtRow(x, seen)).join('')}</div>`, '<button class="btn btn-filled" data-sheet-close>Done</button>');
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.id) return;
  const m = /^czNew-(markets|teams|owner)$/.exec(e.target.id) || (['czNewRole', 'czNewEmail'].includes(e.target.id) ? [0, 'owner'] : null);
  if (m) { e.preventDefault(); czAdd(m[1]); }
});
document.addEventListener('mouseover', e => { const q = e.target.closest && e.target.closest('.cb-quarter, .fq-wrap, #fqBar'); if (q && !q.title) { const f = fiscalQuarter(); q.title = `${f.q} of FY${String(currentFY()).slice(2)}. KIPP's fiscal year runs July to June`; } });
document.addEventListener('input', e => { if (e.target.matches && e.target.matches('textarea[data-autogrow]')) { e.target.style.height = 'auto'; e.target.style.height = Math.min(400, e.target.scrollHeight + 2) + 'px'; } });
document.addEventListener('click', e => { const b = e.target.closest('[data-copylink], [data-copyschool], #planLink'); if (!b) return; const t = b.textContent; setTimeout(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1400); }, 0); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.target.matches && e.target.matches('.pop-find, .dep-find, .co-find') && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; e.target.dispatchEvent(new Event('input', { bubbles: true })); return; }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && $('#modalBackdrop.open') && !(e.target.matches && e.target.matches('input, textarea, select'))) { const b = document.querySelectorAll('[data-mnav]')[e.key === 'ArrowUp' ? 0 : 1]; if (b && !b.disabled) { e.preventDefault(); b.click(); } }
}, true);
document.addEventListener('keydown', e => {
  const t = e.target.closest && e.target.closest('.bd-tab'); if (!t || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('.bd-tab')], i = tabs.indexOf(t); e.preventDefault();
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[j].focus(); tabs[j].click();
});
function lockMeetingsNav() {
  if (MEETINGS_ON) return;
  document.querySelectorAll('.nav-tab[data-view="meetings"]').forEach(b => { b.disabled = true; b.setAttribute('aria-disabled', 'true'); b.title = 'Coming soon'; if (!b.querySelector('.nav-lock')) b.insertAdjacentHTML('beforeend', '<svg class="nav-lock" viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M24 14h-2V8a6 6 0 00-12 0v6H8a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V16a2 2 0 00-2-2zM12 8a4 4 0 018 0v6h-8zm12 20H8V16h16z"/></svg><span class="sr-only">, coming soon</span>'); });
}
document.addEventListener('DOMContentLoaded', lockMeetingsNav); setTimeout(lockMeetingsNav, 0);
function boardSlug() { return (WS_SEED[WS] ? WS_SEED[WS].title : 'Growth Readiness').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function ownerOptions(cur) {
  const names = rosterNames(), extra = cur && !names.includes(cur) ? [cur] : [];
  return `<option value="" ${!cur ? 'selected' : ''}>Unassigned</option>` + names.map(n => `<option value="${esc(n)}" ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')
    + extra.map(n => `<option value="${esc(n)}" selected>${esc(n)}, not on team list</option>`).join('');
}
function coOwnerPicker(m) {
  const cur = m.coOwners || [], names = [...rosterNames(), ...cur.filter(c => !rosterNames().includes(c))];
  const sum = cur.length ? cur.join(', ') : 'None';
  return `<details class="co-pick" id="mCoBox"><summary><span class="co-sum">${esc(sum)}</span></summary>${names.length > 10 ? '<input type="search" class="co-find" placeholder="Find a person" aria-label="Find a co-owner">' : ''}<div class="co-list">${names.map(n => `<label class="field-check"><input type="checkbox" class="m-co" value="${esc(n)}" ${cur.includes(n) ? 'checked' : ''}> ${esc(n)}${rosterNames().includes(n) ? '' : ' <span class="muted">· not on team list</span>'}</label>`).join('')}</div></details>`;
}
// School openings are the primary objects; a milestone links to one or more of them
function schoolPicker(m) {
  const sel = new Set(m.schoolIds || []), groups = {};
  state.data.schools.filter(x => x.openingFY).sort((a, b) => (a.market || '').localeCompare(b.market || '') || a.openingFY - b.openingFY || (a.display_label || '').localeCompare(b.display_label || ''))
    .forEach(x => (groups[x.market] = groups[x.market] || []).push(x));
  const html = Object.entries(groups).map(([mk, list]) => `<div class="so-group"><div class="so-mk"><i style="background:${mkColor(mk)}"></i>${esc(mk)}</div><div class="so-opts">${list.map(x => `<label class="so-opt ${sel.has(x.id) ? 'on' : ''}"><input type="checkbox" class="m-school" value="${esc(x.id)}" ${sel.has(x.id) ? 'checked' : ''}><span class="so-name">${esc(schLbl(x))}</span><span class="so-when">${fallLbl(x.openingFY)}</span></label>`).join('')}</div></div>`).join('');
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
  } catch (e) { console.error('Supabase connect failed:', e); state.sb = { connected: false, client: null, lastError: e.message || String(e) }; if (s) s.innerHTML = `<div class="status-note err">Couldn't connect to the shared board. Check your internet connection and try again</div>`; return false; }
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
  meetbook: ['meetBook'],   // agenda topics, a meeting in progress, minutes and action items (per board)
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
function quietRerender() {
  const a = document.activeElement, typing = a && a.matches && a.matches('input, textarea, select') && a.closest('#view-meetings, #view-plan .filterbar, .fb-searchwrap');
  if (typing) { clearTimeout(quietRerender.t); quietRerender.t = setTimeout(quietRerender, 1500); return; }   // try again once they pause
  if (!$('#popover') && !$('#modalBackdrop').classList.contains('open')) rerender();
}
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
  if (e && (e.code === 'PGRST202' || /growth_patch|growth_add_note/.test(msg))) return 'the shared board needs an update. Contact your Causeway admin';
  if (e && (e.code === '42501' || /row-level security|permission/i.test(msg))) return 'your account does not have permission to make that change';
  if (e && e.code === 'GH_GONE') return 'it is no longer on the shared board. Reload to see the latest';
  if (/failed to fetch|network|load failed|timeout|offline/i.test(msg)) return 'the connection dropped. Check your internet and try again';
  return 'something went wrong. Try again, and tell your Causeway admin if it keeps happening';   // raw details go to the console, not the screen
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
window.addEventListener('online', () => { if ($('#syncAlert')) sbPush(); if (state.sb && state.sb.connected) toast('Back online', 'ok'); });
window.addEventListener('offline', () => { if (state.sb && state.sb.connected) toast('Offline. Changes sync when you reconnect', 'warn'); });
window.addEventListener('beforeunload', e => { if ($('#syncAlert') || (modalDirty && $('#modalBackdrop.open'))) { e.preventDefault(); e.returnValue = ''; } });   // unsynced work or an unsaved dialog
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
    ${accountCardHtml(connected)}

    ${admin ? dataChecksHtml() : ''}
    ${admin ? meetingSettingsHtml() : ''}
    ${admin ? integrationsSettingsHtml() : ''}
    ${admin ? `${['Markets', 'Teams', 'Owners'].map(k => `<details class="dw-sec dw-fold"><summary>${k}</summary>
      ${sbSettingsReady ? '' : '<div class="status-note warn">Not shared yet. Changes stay on this device</div>'}
      ${k === 'Markets' ? czSection('State', 'markets', statesMeta().flatMap(s => s.markets.map(mk => ({ mk, st: s.code })))) : k === 'Teams' ? czSection('Team', 'teams', teams().map(t => ({ mk: t }))) : czOwners()}
    </details>`).join('')}

    <details class="dw-sec dw-fold"><summary>School openings</summary>
      ${hasSchoolWork() ? schoolsPanel() : ''}
      <div class="ms-bulk">
        <button class="btn btn-danger-solid" id="msDeleteAll" ${state.data.schools.length ? '' : 'disabled'}>Delete all school openings</button>
      </div>
    </details>` : ''}

    ${admin ? `<details class="dw-sec dw-fold"><summary>Backup and restore</summary>
      
      <div class="dw-btns"><button class="btn" id="expBtn">Download backup</button><button class="btn" id="csvBtn">Export milestones to Excel</button>${admin ? '<button class="btn" id="impBtn">Import</button><input type="file" id="impFile" accept="application/json" class="hide">' : ''}</div>
    </details>` : ''}

    ${admin ? `<div class="dw-about">${WS_SEED[WS] ? WS_SEED[WS].title : 'Growth Readiness'} · ${M().filter(m => !m._draft).length} milestone${M().filter(m => !m._draft).length === 1 ? '' : 's'} · ${state.data.schools.length} school${state.data.schools.length === 1 ? '' : 's'}${state.sb && state.sb.connected ? ' · Saved for everyone' : ' · Saved on this device'}${window.GH_VERSION ? ` · Version ${window.GH_VERSION}` : ''}</div>` : ''}`;
}

/* ---------- your account: profile photo + password (Nov 19 2026) ----------
   Non-admins see only this card in Settings. The photo is a 160px square JPEG kept on the person's own
   profiles row (column "avatar", supabase-profile-photos.sql). Everyone signed in can read profiles,
   so the photo replaces their initials on avatars across the tool. */
const photoByName = {};
// A profile photo must be a plain base64 PNG, JPEG or WebP data URL: no quotes, parentheses or spaces can reach the markup.
const safePhoto = u => typeof u === 'string' && u.length < 200000 && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/.test(u);
const photoOf = name => (name && photoByName[normName(name)]) || '';
async function loadPhotos() {
  const c = state.sb && state.sb.client; if (!c || !state.sb.connected) return;
  try {
    const { data, error } = await c.from('profiles').select('id, full_name, email, avatar'); if (error) throw error;
    state.profileList = (Array.isArray(data) ? data : []).map(p => ({ id: p.id, full_name: p.full_name || '', email: p.email || '' }));
    const owners = meta().owners || []; Object.keys(photoByName).forEach(k => delete photoByName[k]);
    (Array.isArray(data) ? data : []).forEach(p => { if (!safePhoto(p.avatar)) return;   // strict check: the value lands in style attributes
      if (p.full_name) photoByName[normName(p.full_name)] = p.avatar;
      const o = p.email && owners.find(x => x.email && x.email.toLowerCase() === String(p.email).toLowerCase()); if (o) photoByName[normName(o.name)] = p.avatar; });
    paintAvatars();
  } catch (e) { /* no avatar column until the SQL runs */ }
}
function accountCardHtml(connected) {
  const p = currentProfile(), who = p ? (p.full_name || p.email) : (state.auth.user ? state.auth.user.email : ''), ph = photoOf(p && p.full_name) || photoOf(myOwnerName());
  return `<section class="dw-sec dw-me">
      <div class="dw-me-row"><span class="dw-me-pic" style="${ph ? `background-image:url('${ph}')` : `background:${avatarColor(who)}`}" aria-hidden="true">${ph ? '' : esc(initials(who || '?'))}</span>
        <div class="dw-me-txt"><div class="dw-me-name">${esc(who)}</div>${p && p.email && p.email !== who ? `<div class="dw-me-email">${esc(p.email)}</div>` : ''}${p ? `<span class="dw-role">${esc({ admin: 'Admin', editor: 'Editor', viewer: 'View only' }[p.role || 'viewer'] || p.role)}</span>` : ''}</div></div>
      <div class="dw-me-acts"><button type="button" class="btn btn-ghost btn-sm" id="dwPhoto">${ph ? 'Change photo' : 'Add photo'}</button>${ph ? '<button type="button" class="btn btn-ghost btn-sm" id="dwPhotoDel">Remove photo</button>' : ''}</div>${accountActionsHtml()}
      <input type="file" id="dwPhotoFile" accept="image/jpeg,image/png,image/webp,image/heic" class="hide">
      ${connected ? '' : '<p class="dw-help">Not connected. Changes won\'t reach your team</p><div class="dw-btns"><button class="btn btn-filled" id="sbReconnect">Reconnect</button></div>'}
      <div id="sbStatus"></div>
    </section>`;
}
/* ---------- profile photo editor (Nov 20 2026) ----------
   Crop in a circle (drag to move, zoom), rotate 90 degrees, straighten, filters (sepia, black and white, warm,
   cool, vivid, fade) and brightness, contrast, saturation. Pixel math is done by hand so every browser,
   Safari included, saves exactly what the preview shows. Resolves with a JPEG data URL, or null on cancel. */
const PE_FILTERS = [['none', 'Original'], ['sepia', 'Sepia'], ['bw', 'Black and white'], ['warm', 'Warm'], ['cool', 'Cool'], ['vivid', 'Vivid'], ['fade', 'Fade']];
function peDraw(cv, bmp, st, N) {
  const x = cv.getContext('2d'); cv.width = cv.height = N;
  x.fillStyle = '#fff'; x.fillRect(0, 0, N, N); x.imageSmoothingQuality = 'high';
  const a = st.straighten * Math.PI / 180, quarter = ((st.rot % 360) + 360) % 360, sideways = quarter === 90 || quarter === 270;
  const W = bmp.width, H = bmp.height, base = N / Math.min(W, H) * (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a))), sc = base * st.zoom;
  const vw = (sideways ? H : W) * sc, vh = (sideways ? W : H) * sc, mx = Math.max(0, (vw - N) / 2) / N, my = Math.max(0, (vh - N) / 2) / N;
  st.ox = Math.max(-mx, Math.min(mx, st.ox)); st.oy = Math.max(-my, Math.min(my, st.oy));
  x.save(); x.translate(N / 2 + st.ox * N, N / 2 + st.oy * N); x.rotate((quarter * Math.PI / 180) + a); x.scale(sc, sc); x.drawImage(bmp, -W / 2, -H / 2); x.restore();
  peTone(x, N, st);
}
function peTone(x, N, st) {
  const f = st.filter, b = 1 + st.bright / 100, c = 1 + st.contrast / 100, s = 1 + st.sat / 100 + (f === 'vivid' ? .35 : 0), c2 = c * (f === 'vivid' ? 1.1 : 1);
  if (f === 'none' && b === 1 && c === 1 && s === 1) return;
  const img = x.getImageData(0, 0, N, N), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] * b, g = d[i + 1] * b, bl = d[i + 2] * b;
    r = (r - 128) * c2 + 128; g = (g - 128) * c2 + 128; bl = (bl - 128) * c2 + 128;
    let L = .2126 * r + .7152 * g + .0722 * bl;
    r = L + (r - L) * s; g = L + (g - L) * s; bl = L + (bl - L) * s;
    if (f === 'sepia') { const R = .393 * r + .769 * g + .189 * bl, G = .349 * r + .686 * g + .168 * bl, B = .272 * r + .534 * g + .131 * bl; r = R; g = G; bl = B; }
    else if (f === 'bw') { L = .2126 * r + .7152 * g + .0722 * bl; r = g = bl = L; }
    else if (f === 'warm') { r *= 1.08; g *= 1.02; bl *= .88; }
    else if (f === 'cool') { r *= .9; g *= 1.01; bl *= 1.1; }
    else if (f === 'fade') { r = r * .82 + 34; g = g * .82 + 34; bl = bl * .82 + 38; }
    d[i] = r < 0 ? 0 : r > 255 ? 255 : r; d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; d[i + 2] = bl < 0 ? 0 : bl > 255 ? 255 : bl;
  }
  x.putImageData(img, 0, 0);
}
function openPhotoEditor(bmp, who) {
  return new Promise(resolve => {
    const st = { zoom: 1, rot: 0, straighten: 0, ox: 0, oy: 0, filter: 'none', bright: 0, contrast: 0, sat: 0 }, P = 320;
    const rng = (id, label, min, max, val, unit) => `<div class="pe-field"><div class="pe-lbl"><label for="${id}">${label}</label><output for="${id}" id="${id}Out">${val}${unit || ''}</output></div><input type="range" id="${id}" min="${min}" max="${max}" step="1" value="${val}"></div>`;
    const wrap = document.createElement('div'); wrap.className = 'modal-backdrop open'; wrap.id = 'peBackdrop';
    wrap.innerHTML = `<div class="modal pe-modal" role="dialog" aria-modal="true" aria-labelledby="peTitle">
      <div class="modal-head"><h3 id="peTitle">Edit photo${who ? ` for ${esc(who)}` : ''}</h3><button class="icon-btn" data-peclose aria-label="Close">${CI('close')}</button></div>
      <div class="modal-body pe-body">
        <div class="pe-stage" id="peStage" tabindex="0" aria-label="Photo. Drag or use arrow keys to move it, plus and minus to zoom"><canvas id="peCv" width="${P}" height="${P}"></canvas></div>
        <div class="pe-side">
          <div class="pe-tabs" role="tablist" aria-label="Edit">${[['crop', 'Crop'], ['filter', 'Filter'], ['adjust', 'Adjust']].map(([k, l], i) => `<button type="button" role="tab" class="pe-tab ${i ? '' : 'on'}" aria-selected="${!i}" data-petab="${k}">${l}</button>`).join('')}</div>
          <div class="pe-pane" data-pepane="crop">${rng('peZoom', 'Zoom', 100, 400, 100, '%')}${rng('peStr', 'Straighten', -45, 45, 0, '°')}
            <div class="pe-btns"><button type="button" class="btn btn-tonal btn-sm" data-perot="-90">Rotate left</button><button type="button" class="btn btn-tonal btn-sm" data-perot="90">Rotate right</button></div></div>
          <div class="pe-pane" data-pepane="filter" hidden><div class="pe-filters">${PE_FILTERS.map(([k, l]) => `<button type="button" class="pe-flt ${k === 'none' ? 'on' : ''}" data-peflt="${k}" aria-pressed="${k === 'none'}"><canvas width="72" height="72"></canvas><span>${l}</span></button>`).join('')}</div></div>
          <div class="pe-pane" data-pepane="adjust" hidden>${rng('peBri', 'Brightness', -50, 50, 0)}${rng('peCon', 'Contrast', -50, 50, 0)}${rng('peSat', 'Saturation', -100, 100, 0)}</div>
          <button type="button" class="btn btn-ghost btn-sm pe-reset" data-pereset>Reset</button>
        </div>
      </div>
      <div class="modal-foot"><span></span><div style="display:flex;gap:8px"><button class="btn btn-text" data-peclose>Cancel</button><button class="btn btn-filled" id="peSave">Save photo</button></div></div>
    </div>`;
    document.body.appendChild(wrap);
    const cv = wrap.querySelector('#peCv'), stage = wrap.querySelector('#peStage');
    let raf = 0; const paint = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { peDraw(cv, bmp, st, P); if (!wrap.querySelector('[data-pepane="filter"]').hidden) thumbs(); }); };
    const thumbs = () => wrap.querySelectorAll('.pe-flt').forEach(b => { const t = b.querySelector('canvas'); peDraw(t, bmp, Object.assign({}, st, { filter: b.dataset.peflt }), 72); });
    const sync = () => { [['peZoom', st.zoom * 100, '%'], ['peStr', st.straighten, '°'], ['peBri', st.bright, ''], ['peCon', st.contrast, ''], ['peSat', st.sat, '']].forEach(([id, v, u]) => { const el = wrap.querySelector('#' + id); el.value = Math.round(v); wrap.querySelector('#' + id + 'Out').textContent = Math.round(v) + u; }); wrap.querySelectorAll('.pe-flt').forEach(b => { const on = b.dataset.peflt === st.filter; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); };
    const done = v => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('click', e => {
      if (e.target === wrap || e.target.closest('[data-peclose]')) return done(null);
      const tb = e.target.closest('[data-petab]'); if (tb) { wrap.querySelectorAll('.pe-tab').forEach(t => { const on = t === tb; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); }); wrap.querySelectorAll('.pe-pane').forEach(p => p.hidden = p.dataset.pepane !== tb.dataset.petab); if (tb.dataset.petab === 'filter') thumbs(); return; }
      const r = e.target.closest('[data-perot]'); if (r) { st.rot += +r.dataset.perot; return paint(); }
      const f = e.target.closest('[data-peflt]'); if (f) { st.filter = f.dataset.peflt; sync(); return paint(); }
      if (e.target.closest('[data-pereset]')) { Object.assign(st, { zoom: 1, rot: 0, straighten: 0, ox: 0, oy: 0, filter: 'none', bright: 0, contrast: 0, sat: 0 }); sync(); paint(); if (!wrap.querySelector('[data-pepane="filter"]').hidden) thumbs(); return; }
      if (e.target.closest('#peSave')) { const out = document.createElement('canvas'); peDraw(out, bmp, st, 240); let url = ''; for (const q of [0.88, 0.8, 0.7, 0.6]) { url = out.toDataURL('image/jpeg', q); if (url.length < 95000) break; } return done(url); }
    });
    wrap.addEventListener('input', e => {
      const v = +e.target.value, id = e.target.id; if (!id) return;
      if (id === 'peZoom') st.zoom = v / 100; else if (id === 'peStr') st.straighten = v; else if (id === 'peBri') st.bright = v; else if (id === 'peCon') st.contrast = v; else if (id === 'peSat') st.sat = v; else return;
      sync(); paint();
    });
    let drag = null;
    stage.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, ox: st.ox, oy: st.oy }; stage.setPointerCapture(e.pointerId); stage.classList.add('is-drag'); });
    stage.addEventListener('pointermove', e => { if (!drag) return; const k = stage.clientWidth || P; st.ox = drag.ox + (e.clientX - drag.x) / k; st.oy = drag.oy + (e.clientY - drag.y) / k; paint(); });
    const end = () => { drag = null; stage.classList.remove('is-drag'); }; stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', e => { e.preventDefault(); st.zoom = Math.max(1, Math.min(4, st.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06))); sync(); paint(); }, { passive: false });
    stage.addEventListener('keydown', e => { const k = { ArrowLeft: [-.02, 0], ArrowRight: [.02, 0], ArrowUp: [0, -.02], ArrowDown: [0, .02] }[e.key]; if (k) { e.preventDefault(); st.ox += k[0]; st.oy += k[1]; paint(); } else if (e.key === '+' || e.key === '=' || e.key === '-') { e.preventDefault(); st.zoom = Math.max(1, Math.min(4, st.zoom + (e.key === '-' ? -.1 : .1))); sync(); paint(); } });
    paint(); setTimeout(() => stage.focus(), 0);
  });
}
// Photo target: the signed-in person, or (admins, Nov 20 2026) anyone with an account: { id, names, who }.
async function setProfilePhoto(file, target) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic)$/i.test(file.name)) return toast('Pick a JPG or PNG image', 'warn');
  if (file.size > 15 * 1048576) return toast('That image is over 15 MB', 'warn');
  let url;
  // The editor crops to a 240px circle-ready square, applies any filter, and keeps it under the 100 KB column limit.
  // Older Safari rejects the options argument, and only an <img> can decode HEIC, so fall back step by step
  let bmp = null; try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {
    try { bmp = await createImageBitmap(file); } catch (e2) { bmp = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = URL.createObjectURL(file); }); } }
  if (!bmp || !bmp.width) return toast('That image could not be read. Try a JPG or PNG', 'err');
  url = await openPhotoEditor(bmp, target && target.who); if (!url) return;
  return saveProfilePhoto(url, target);
}
async function saveProfilePhoto(url, target) {
  const c = state.sb && state.sb.client, p = currentProfile();
  if (!c || !p || !state.sb.connected) return toast('Not connected. Reconnect and try again', 'warn');
  const t = target || { id: p.id, names: [p.full_name, myOwnerName()] };
  const { data, error } = await c.from('profiles').update({ avatar: url }).eq('id', t.id).select('id');
  if (error) return toast(/avatar|column|schema/i.test(String(error.message || '')) ? 'Profile photos are not set up yet. An admin needs to run supabase-profile-photos.sql' : 'Could not save the photo. Try again', 'err');
  if (Array.isArray(data) && !data.length) return toast('Could not save the photo. Only admins can change other people\'s photos', 'err');
  t.names.filter(Boolean).forEach(n => { if (url) photoByName[normName(n)] = url; else delete photoByName[normName(n)]; });
  document.querySelectorAll('.has-photo').forEach(el => { el.classList.remove('has-photo'); el.style.backgroundImage = ''; });
  renderDrawer(); rerender(); paintAvatars(); if (typeof updateUserBadge === 'function') updateUserBadge(); toast(url ? `Photo saved${t.who ? ' for ' + t.who : ''}` : `Photo removed${t.who ? ' for ' + t.who : ''}`, 'ok');
}
document.addEventListener('click', e => {
  const t = e.target.closest('#dwPhoto, #dwPhotoDel, #dwPassword'); if (!t) return;
  if (t.id === 'dwPhoto') { const f = $('#dwPhotoFile'); if (f) { f.value = ''; f.onchange = () => setProfilePhoto(f.files[0]); f.click(); } }
  else if (t.id === 'dwPhotoDel') saveProfilePhoto(null);
  else { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); openPasswordDialog(); }
});

/* ---------- schools management panel (drawer section 4) ---------- */
function schoolsPanel() {
  const schools = state.data.schools.slice().sort((a, b) => (a.openingFY || 0) - (b.openingFY || 0) || a.market.localeCompare(b.market) || a.display_label.localeCompare(b.display_label));
  if (!schools.length) return '<div class="ms-empty">No school openings yet</div>';
  const rows = schools.map(s => {
    const taskCount = schoolMs(s).length;
    return `<div class="ms-row">
      <span class="ms-badge" style="background:${stColor(s.state)}">${esc(s.state)}</span>
      <div class="ms-info">${schoolChip(s.market, [schLbl(s)])}<span class="muted"> Opens ${fallLbl(s.openingFY)}</span></div>
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
  const noEmail = (meta().owners || []).filter(o => !o.email).length;
  const rows = (meta().owners || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map(o => `<div class="cz-row" title="${czInUse('owner', o.name)} milestone${czInUse('owner', o.name) === 1 ? '' : 's'}">${czPhotoBtn(o)}<input class="cz-name" data-cztype="owner" data-czold="${esc(o.name)}" value="${esc(o.name)}" ${teams().some(t => t.toLowerCase() === o.name.toLowerCase() || o.name.includes('&')) ? 'title="This looks like a team, not a person" aria-invalid="true"' : ''}><input class="cz-role" data-czowner="${esc(o.name)}" value="${esc(o.role || '')}" placeholder="Job title" aria-label="Job title"><input class="cz-email" type="email" data-czowner="${esc(o.name)}" value="${esc(o.email || '')}" placeholder="email" aria-label="Email for ${esc(o.name)}"><button class="cz-del" data-cztype="owner" data-czval="${esc(o.name)}" title="Remove" aria-label="Remove">${CI('close')}</button></div>`).join('');
  return `<div class="cz-block"><h4 style="margin-top:14px">Owners</h4>${noEmail ? `<p class="help-text">${noEmail} ${noEmail === 1 ? 'person has' : 'people have'} no email, so reminders skip them</p>` : ''}<div class="cz-add"><input class="cz-new" id="czNew-owner" placeholder="Add a person"><input class="cz-new" id="czNewRole" placeholder="Job title, optional"><input class="cz-new" id="czNewEmail" type="email" placeholder="Email, optional"><button class="btn btn-tonal btn-sm" data-czadd="owner">Add</button></div>${rows}</div>`;
}
// Admins set anyone's profile photo from their row in Customize > Owners. Saved on that person's account
// (profiles.avatar; admins may update any profile row). Nov 20 2026
function profileForOwner(o) {
  const L = state.profileList || [], em = String(o.email || '').toLowerCase();
  return (em && L.find(p => p.email.toLowerCase() === em)) || L.find(p => p.full_name && normName(p.full_name) === normName(o.name)) || null;
}
function czPhotoBtn(o) {
  const ph = photoOf(o.name);
  return `<button type="button" class="cz-pic ${ph ? 'has-photo' : ''}" data-czphoto="${esc(o.name)}" style="${ph ? `background-image:url('${ph}')` : `background:${avatarColor(o.name)}`}" aria-label="${ph ? 'Change or remove' : 'Add a'} profile photo for ${esc(o.name)}" title="${ph ? 'Change photo' : 'Add photo'}">${ph ? '' : esc(initials(o.name))}</button>`;
}
function czPhotoPick(o, btn) {
  if (!guardAdmin()) return;
  const pr = profileForOwner(o);
  if (!pr) return toast(state.sb && state.sb.connected ? `${o.name} has no Causeway account yet. Photos save to a person's account` : 'Not connected. Reconnect and try again', 'warn');
  const target = { id: pr.id, names: [o.name, pr.full_name], who: o.name };
  const pick = () => { let f = $('#czPhotoFile'); if (!f) { f = document.createElement('input'); f.type = 'file'; f.id = 'czPhotoFile'; f.accept = 'image/jpeg,image/png,image/webp,image/heic'; f.className = 'hide'; document.body.appendChild(f); } f.value = ''; f.onchange = () => setProfilePhoto(f.files[0], target); f.click(); };
  if (!photoOf(o.name)) return pick();
  const p = openPopover(btn, `<div class="cds-dd-list" role="menu" aria-label="Photo for ${esc(o.name)}"><button type="button" class="cds-dd-opt" role="menuitem" data-pp="new">Change photo</button><button type="button" class="cds-dd-opt" role="menuitem" data-pp="del">Remove photo</button></div>`);
  p.classList.add('cds-dd-pop');
  p.addEventListener('click', ev => { const b = ev.target.closest('[data-pp]'); if (!b) return; closePopover(); if (b.dataset.pp === 'new') pick(); else saveProfilePhoto(null, target); });
}
function czInUse(type, val) { if (type === 'owner') return M().filter(m => ownersOf(m).includes(val)).length; return type === 'markets' ? M().filter(m => m.market === val).length + state.data.schools.filter(s => s.market === val).length : M().filter(m => m.functional_area === val).length; }
function czRename(type, oldV, newV) {
  if (!guardAdmin()) return;
  newV = newV.trim(); if (!newV || newV === oldV) return;
  if (type === 'markets') {
    if (markets().some(x => x !== oldV && x.toLowerCase() === newV.toLowerCase())) return toast('That market already exists', 'err');
    meta().markets = markets().map(x => x === oldV ? newV : x);
    statesMeta().forEach(s => s.markets = s.markets.map(x => x === oldV ? newV : x));
    M().forEach(m => { if (m.market === oldV) m.market = newV; if (m.location === oldV) m.location = newV; m.tags = (m.tags || []).map(t => t === oldV ? newV : t); });
    state.data.schools.forEach(s => { if (s.market === oldV) s.market = newV; if (s.location === oldV) s.location = newV; });
  } else if (type === 'teams') {
    if (teams().some(x => x !== oldV && x.toLowerCase() === newV.toLowerCase())) return toast('That team already exists', 'err');
    meta().teams = teams().map(x => x === oldV ? newV : x); meta().functionalAreas = meta().teams;
    M().forEach(m => { if (m.team === oldV) m.team = newV; if (m.functional_area === oldV) m.functional_area = newV; });
  } else if (type === 'owner') {
    if ((meta().owners || []).some(o => o.name !== oldV && o.name.toLowerCase() === newV.toLowerCase())) { toast(`${newV} is already on the team list`, 'err'); renderDrawer(); return; }
    (meta().owners || []).forEach(o => { if (o.name === oldV) o.name = newV; });
    toast(`Renamed. Update ${newV}'s account name to match`, 'warn');
    M().forEach(m => { if (m.owner === oldV) m.owner = newV; if (m.coOwners) m.coOwners = m.coOwners.map(o => o === oldV ? newV : o); });
  }
  autosave(); rerender(); renderDrawer();
}
function czRemove(type, val) {
  if (!guardAdmin()) return;
  const n = czInUse(type, val);
  if (n && type === 'owner') return handOffOwner(val, n);
  if (n && type === 'teams') return handOffTeam(val, n);
  if (n) return toast(type === 'owner' ? `${val} owns ${n} milestone${n === 1 ? '' : 's'}. Reassign ${n === 1 ? 'it' : 'them'} first.` : `${val} is used by ${n} item${n === 1 ? '' : 's'}. Reassign ${n === 1 ? 'it' : 'them'} first.`, 'err');
  confirmDialog({ title: `Remove "${val}"?`, message: `This removes the ${type === 'markets' ? 'market' : type === 'teams' ? 'team' : 'person'} from your lists.`, confirmLabel: 'Remove', danger: true, onConfirm: () => {
    if (type === 'owner') meta().owners = (meta().owners || []).filter(o => o.name !== val);
    else if (type === 'markets') { meta().markets = markets().filter(x => x !== val); statesMeta().forEach(s => s.markets = s.markets.filter(x => x !== val)); }
    else { meta().teams = teams().filter(x => x !== val); meta().functionalAreas = meta().teams; }
    autosave(); rerender(); renderDrawer();
  } });
}
// Someone leaves or changes roles: move all their milestones (owned and co-owned) to one person, then drop them from the list.
function handOffOwner(val, n) {
  const others = (meta().owners || []).map(o => o.name).filter(x => x && x !== val);
  if (!others.length) return toast(`${val} owns ${n} milestone${n === 1 ? '' : 's'}. Add another person first`, 'err');
  let to = others[0];
  confirmDialog({ title: `Hand off ${val}'s milestones`, confirmLabel: 'Hand off and remove',
    message: `<div class="field"><label for="cfgHandoff">Give ${n} milestone${n === 1 ? '' : 's'} to</label><select id="cfgHandoff">${others.map(o => `<option>${esc(o)}</option>`).join('')}</select></div>`,
    onConfirm: () => {
      const prevOwners = clone(meta().owners || []);
      snapshotForUndo(`Hand off ${val} to ${to}`);
      M().forEach(m => {
        let ch = false;
        if (m.owner === val) { m.owner = to; ch = true; }
        if ((m.coOwners || []).includes(val)) { m.coOwners = [...new Set(m.coOwners.map(o => o === val ? to : o))].filter(o => o !== m.owner); ch = true; }
        if (ch) touch(m);
      });
      meta().owners = (meta().owners || []).filter(o => o.name !== val);
      logActivity('edit', `Handed off ${val}'s milestones to ${to}`);
      autosave(); rerender(); renderDrawer();
      toastAction(`${n} milestone${n === 1 ? '' : 's'} moved to ${to}`, 'Undo', () => { undo(); meta().owners = prevOwners; autosave(); rerender(); renderDrawer(); });
    } });
  const sel = $('#cfgHandoff'); if (sel) sel.addEventListener('change', () => { to = sel.value; });
}
function handOffTeam(val, n) {
  const others = teams().filter(t => t !== val);
  if (!others.length) return toast('Add another team first', 'err');
  let to = others[0];
  confirmDialog({ title: `Move ${val}'s milestones`, confirmLabel: 'Move and remove',
    message: `<div class="field"><label for="cfgHandoff">Move ${n} milestone${n === 1 ? '' : 's'} to</label><select id="cfgHandoff">${others.map(o => `<option>${esc(o)}</option>`).join('')}</select></div>`,
    onConfirm: () => {
      const prev = clone(teams());
      snapshotForUndo(`Move team ${val} to ${to}`);
      M().forEach(m => { let ch = false; if (m.functional_area === val) { m.functional_area = to; ch = true; } if (m.team === val) { m.team = to; ch = true; } if (ch) touch(m); });
      meta().teams = teams().filter(t => t !== val); meta().functionalAreas = meta().teams;
      logActivity('edit', `Moved ${val}'s milestones to ${to}`); autosave(); rerender(); renderDrawer();
      toastAction(`${n} milestone${n === 1 ? '' : 's'} moved to ${to}`, 'Undo', () => { undo(); meta().teams = prev; meta().functionalAreas = prev; autosave(); rerender(); renderDrawer(); });
    } });
  const sel = $('#cfgHandoff'); if (sel) sel.addEventListener('change', () => { to = sel.value; });
}
function czAdd(type) {
  if (!guardAdmin()) return;
  const v = ($('#czNew-' + type) || {}).value ? $('#czNew-' + type).value.trim() : '';
  if (!v) return flagEmpty($('#czNew-' + type));
  const has = (list, x) => list.some(y => String(y).toLowerCase() === x.toLowerCase());
  if (type === 'markets') { if (has(markets(), v)) return toast('Already on the list', 'err'); const st = $('#czNewState').value; markets().push(v); const s = statesMeta().find(x => x.code === st); if (s) s.markets.push(v); }
  else if (type === 'teams') { if (has(teams(), v)) return toast('Already on the list', 'err'); teams().push(v); meta().functionalAreas = teams(); }
  else if (type === 'owner') {
    const ex = (meta().owners || []).find(o => o.name.toLowerCase() === v.toLowerCase()); if (ex) return toast(`${ex.name} is already on the team list`, 'err');
    const em = (($('#czNewEmail') || {}).value || '').trim(); if (em && !validEmail(em)) return markInvalid($('#czNewEmail'), 'Check the email address');
    (meta().owners = meta().owners || []).push({ name: v, role: ($('#czNewRole') || {}).value || '', email: (($('#czNewEmail') || {}).value || '').trim() }); }
  autosave(); rerender(); renderDrawer();
}
function exportJson() { const c = clone(state.data); c.milestones = (c.milestones || []).filter(m => !m._draft); c.board = WS; const b = new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `growth-hub-${boardSlug()}-backup-${todayISO()}.json`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); toast('Backup downloaded', 'ok'); }
// Spreadsheet export of what's on screen (current filters), for Excel and Google Sheets users
/* Excel export styled with IBM Carbon. Written directly so the page needs no spreadsheet library. */
function xmlEsc(v) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function zipStore(files) {   // a .xlsx is a zip; stored entries need no compression library
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const u16 = n => [n & 255, n >>> 8 & 255], u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
  files.forEach(([name, text]) => {
    const nm = enc.encode(name), data = enc.encode(text), c = crc(data);
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(c), ...u32(data.length), ...u32(data.length), ...u16(nm.length), ...u16(0)];
    const local = new Uint8Array([0x50, 0x4B, 3, 4, ...common]);
    parts.push(local, nm, data);
    central.push(new Uint8Array([0x50, 0x4B, 1, 2, ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nm);
    offset += local.length + nm.length + data.length;
  });
  const size = central.reduce((a, b) => a + b.length, 0);
  return new Blob([...parts, ...central, new Uint8Array([0x50, 0x4B, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(size), ...u32(offset), 0, 0])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const XL_STATUS = { not_started: 7, on_track: 8, at_risk: 9, behind: 10, blocked: 11, complete: 12 };
function xlsxStyles() {
  const font = (size, color, bold) => `<font>${bold ? '<b/>' : ''}<sz val="${size}"/><color rgb="FF${color}"/><name val="IBM Plex Sans"/><family val="2"/></font>`;
  const fill = c => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`;
  const fonts = [font(11, '161616'), font(20, '161616'), font(11, '525252'), font(11, '161616', true), font(11, '0043CE'), font(11, '684E00'), font(11, 'A2191F'), font(11, '0E6027')];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>', fill('E0E0E0'), fill('D0E2FF'), fill('FCF4D6'), fill('FFD7D9'), fill('A7F0BA')];
  const xf = (f, fl, b, num, al) => `<xf numFmtId="${num}" fontId="${f}" fillId="${fl}" borderId="${b}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment ${al}/></xf>`;
  const top = 'vertical="center" horizontal="left" wrapText="1"', ctr = 'vertical="center" horizontal="left"';
  const xfs = [xf(0, 0, 0, 0, ctr), xf(1, 0, 0, 0, ctr), xf(2, 0, 0, 0, ctr), xf(3, 2, 0, 0, ctr), xf(0, 0, 1, 0, top), xf(0, 0, 1, 164, ctr), xf(0, 0, 1, 9, 'vertical="center" horizontal="right"'),
    xf(0, 2, 1, 0, ctr), xf(4, 3, 1, 0, ctr), xf(5, 4, 1, 0, ctr), xf(6, 5, 1, 0, ctr), xf(6, 5, 1, 0, ctr), xf(7, 6, 1, 0, ctr), xf(2, 0, 1, 0, top)];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="mmm d, yyyy"/></numFmts><fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFE0E0E0"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}
function exportXlsx() {
  const list = filtered();
  if (!list.length) return toast('No milestones to export', 'warn');
  const colName = n => String.fromCharCode(65 + n);
  const txt = (c, r, v, st) => (v === '' || v == null) ? `<c r="${colName(c)}${r}" s="${st}"/>` : `<c r="${colName(c)}${r}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  const num = (c, r, v, st) => v == null ? `<c r="${colName(c)}${r}" s="${st}"/>` : `<c r="${colName(c)}${r}" s="${st}"><v>${v}</v></c>`;
  const serial = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000 : null; };
  const COLS = [['Milestone', 52], ['Status', 14], ['Progress', 11], ['Due date', 14], ['Owner', 22], ['Co-owners', 24], ['Team', 22], ['Market', 14], ['Schools', 18], ['Priority', 10], ['Blocked by', 28], ['Notes', 44], ['Last updated', 14], ['Updated by', 20], ['Waiting on', 32], ['Checkpoints', 14]];
  const board = WS_SEED[WS] ? WS_SEED[WS].title : 'Growth Readiness', n = list.length, last = 4 + n;
  const when = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const rows = [`<row r="1" ht="36" customHeight="1">${txt(0, 1, 'Milestones', 1)}</row>`, `<row r="2" ht="20" customHeight="1">${txt(0, 2, `${board} · ${when} · ${n} milestone${n === 1 ? '' : 's'}`, 2)}</row>`, `<row r="4" ht="32" customHeight="1">${COLS.map((c, i) => txt(i, 4, c[0], 3)).join('')}</row>`];
  list.forEach((m, i) => {
    const r = 5 + i, es = effectiveStatus(m), p = Math.max(0, Math.min(100, m.progress_percent || 0)) / 100;
    rows.push(`<row r="${r}">` + [txt(0, r, m.activity, 4), txt(1, r, SM(es).label, XL_STATUS[es] || 7), num(2, r, p, 6), num(3, r, serial(m.due_date), 5), txt(4, r, m.owner, 4), txt(5, r, (m.coOwners || []).join('; '), 4), txt(6, r, m.functional_area, 4), txt(7, r, m.market, 4),
      txt(8, r, (m.schoolIds || []).map(id => schLbl(schoolById(id))).filter(Boolean).join('; '), 4), txt(9, r, (PRIORITY[m.priority] || {}).label, 4), txt(10, r, m.status === 'blocked' ? m.dependency : '', 4), txt(11, r, m.notes, 13), num(12, r, serial(m.updatedAt), 5), txt(13, r, m.updatedBy, 4), txt(14, r, (m.blockedBy || []).map(findM).filter(Boolean).map(d => d.activity).join('; '), 4), txt(15, r, (m.checkpoints || []).length ? `${m.checkpoints.filter(c => c.done).length} of ${m.checkpoints.length} done` : '', 4)].join('') + '</row>');
  });
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><tabColor rgb="FF0F62FE"/></sheetPr><dimension ref="A1:P${last}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24" customHeight="1"/><cols>${COLS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c[1]}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.join('')}</sheetData><autoFilter ref="A4:P${last}"/><pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToHeight="0"/></worksheet>`;
  const blob = zipStore([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Milestones" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Milestones!$A$4:$N$' + last + '</definedName></definedNames></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', xlsxStyles()],
    ['xl/worksheets/sheet1.xml', sheet]
  ]);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `growth-hub-${boardSlug()}-${todayISO()}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${n} milestone${n === 1 ? '' : 's'}`, 'ok');
}
// Admin only. Adds and updates records from a backup file; never deletes anything, so
// teammates' newer work stays. Shared settings in the file are not changed.
function importJson(file) {
  if (!guardAdmin()) return;
  const r = new FileReader();
  r.onload = () => {
    let d; try { d = JSON.parse(r.result); if (!Array.isArray(d.milestones)) throw 0; } catch (e) { return toast("That file isn't a Causeway backup", 'err'); }
    if (d.board && d.board !== WS) return toast(`That backup is from ${WS_SEED[d.board] ? WS_SEED[d.board].title : 'another board'}. Open that board to import it`, 'err');
    const ms = d.milestones.filter(x => x && x.id && !x._draft), ss = (Array.isArray(d.schools) ? d.schools : []).filter(x => x && x.id);
    if (!ms.length && !ss.length) return toast('That backup has no milestones or schools', 'warn');
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
        autosave(); rerender(); renderDrawer(); toastAction(`Imported ${ms.length} milestone${ms.length === 1 ? '' : 's'}`, 'Undo', () => { undo(); renderDrawer(); });
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
  const p = openPopover(btn, `<div class="pop-list" role="menu" aria-label="Status">${opts.map(k => `<button class="pop-item qs-opt ${m.status === k ? 'on' : ''}" role="menuitemradio" aria-checked="${m.status === k}" data-qs="${k}">${statusDot(k)}<span>${esc(SM(k).label)}</span></button>`).join('')}</div>`); btn.setAttribute('aria-expanded', 'true');
  p.addEventListener('click', e => {
    const o = e.target.closest('[data-qs]'); if (!o) return;
    const v = o.dataset.qs; closePopover(); if (v === m.status) return; if (v === 'complete' && blockIfTeamsOpen(m)) return;
    snapshotForUndo('Status: ' + (m.activity || '').slice(0, 30));
    m.status = v; touch(m); if (CI_REV[v]) recordCheckin(m, CI_REV[v], null, '');
    if (v === 'complete') { m.progress_percent = 100; m.stage = 'complete'; }
    else { if (m.stage === 'complete') m.stage = 'in_progress'; if (m.progress_percent === 100) m.progress_percent = 95; }
    logActivity('status', `Set "${m.activity}" to ${SM(v).label}`, { itemId: m.id });
    autosave(); rerender();
    toastAction(`Marked ${SM(v).label.toLowerCase()}` + (v === 'complete' ? unblockNote(m) : ''), 'Undo', undo);
  });
}
function toastAction(msg, label, fn) {
  const w = $('#toastWrap'); capToasts(w); const t = document.createElement('div'); t.className = 'toast ok toast-act';
  t.innerHTML = `<span>${esc(msg)}</span><button class="toast-btn">${esc(label)}</button>`;
  t.querySelector('button').addEventListener('click', () => { t.remove(); fn(); });
  w.appendChild(t); holdToast(t, 6000);
}
// Fade a toast after ms, but wait while the pointer or keyboard focus is on it
function holdToast(t, ms) {
  let timer; const go = () => { timer = setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, ms); };
  const stop = () => clearTimeout(timer);
  t.addEventListener('mouseenter', stop); t.addEventListener('focusin', stop);
  t.addEventListener('mouseleave', () => { stop(); go(); }); t.addEventListener('focusout', () => { stop(); go(); });
  go();
}
function capToasts(w) { while (w.children.length > 2) w.firstChild.remove(); }
function toast(msg, kind) { const w = $('#toastWrap'); capToasts(w); const t = document.createElement('div'); t.className = 'toast' + (kind ? ' ' + kind : ''); t.textContent = msg; w.appendChild(t); holdToast(t, kind === 'warn' || kind === 'err' ? 6000 : 2400); }
// Meetings is locked while it's being redesigned. Set to true to turn it back on everywhere.
const MEETINGS_ON = WS === 'readiness';   // Growth Readiness only (Nov 19 2026, local build); Enabling Work stays locked
document.documentElement.classList.toggle('mt-locked', !MEETINGS_ON);
const VIEWS = ['progress', 'timeline', 'plan', 'meetings'];
function setView(v, fromPop) {
  if (!VIEWS.includes(v)) v = 'progress';
  if (v === 'meetings' && !MEETINGS_ON) v = 'progress';
  if (v === 'reports') v = 'progress';
  if (v === 'timeline' && !hasSchoolWork()) v = 'progress';
  state.view = v;
  $$('.nav-tab').forEach(t => { const on = t.dataset.view === v; t.classList.toggle('active', on); if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  document.title = 'Causeway · ' + ({ progress: 'Dashboard', timeline: 'Openings', plan: 'Milestones', meetings: 'Meetings' }[v] || 'Dashboard') + ' · ' + (WS_SEED[WS] ? WS_SEED[WS].title : 'Growth Readiness');   // name first so it shows in narrow tabs
  const pg = $('#planGroup'); if (pg) pg.classList.toggle('expanded', v === 'plan');
  $$('.nav-subitem').forEach(x => x.classList.toggle('active', v === 'plan' && (x.dataset.plan === 'focus' ? state.planFocus : (!state.planFocus && state.planGroup === x.dataset.plan))));
  $$('.view').forEach(s => { const on = s.id === 'view-' + v; s.classList.toggle('active', on); if (!on) s.innerHTML = ''; });
  const ve = document.getElementById('view-' + v); if (ve) { ve.classList.remove('view-enter'); void ve.offsetWidth; ve.classList.add('view-enter'); clearTimeout(setView._ve); setView._ve = setTimeout(() => ve.classList.remove('view-enter'), 700); }   // gentle page entrance (Nov 19 2026)
  
  document.body.dataset.view = v; syncSearchHint(); if (v !== 'plan' && state.sel) { state.sel = null; } if (typeof paintBulkBar === 'function') paintBulkBar();
  if (!fromPop && document.activeElement && document.activeElement.closest && document.activeElement.closest('.nav-tab')) setTimeout(() => { const h = document.querySelector(`#view-${v} h1, #view-${v} h2, #ctxTitle`); if (h) { if (!h.hasAttribute('tabindex')) h.tabIndex = -1; h.focus({ preventScroll: true }); } }, 60);
  if (typeof closeFilterPanel === 'function') closeFilterPanel();
  updateGreeting();
  rerender();
  if (typeof updateFilterBubble === 'function') updateFilterBubble();
  try { if (location.hash !== '#' + v) { if (fromPop) history.replaceState({ v }, '', '#' + v); else history.pushState({ v }, '', '#' + v); } } catch (e) {}   // a redirected link shows the page you landed on
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
  const showDrawer = () => { renderDrawer(); restoreDrawerFolds(); $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); };
  window.openDrawer = () => { closePopover(); state.dwView = ''; showDrawer(); const c = $('#drawerClose'); if (c) setTimeout(() => c.focus(), 0); };
  window.closeDrawer = () => { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); };
  const sbt = $('#settingsBtn'); if (sbt) sbt.addEventListener('click', openDrawer); $('#drawerClose').addEventListener('click', closeDrawer); $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('#modalClose').addEventListener('click', attemptCloseModal); $('#modalCancel').addEventListener('click', attemptCloseModal); $('#modalSave').addEventListener('click', saveModal); $('#modalDelete').addEventListener('click', deleteModal);
  $('#modalBackdrop').addEventListener('click', e => { if (e.target.id === 'modalBackdrop') attemptCloseModal(); });
  // any user edit inside the modal marks it dirty; save/close resets
  $('#modalBody').addEventListener('input', e => { if (e.target.closest && e.target.closest('[data-nodirty], .note-add')) return; if ((e.target.matches ? e.target.matches('input, textarea, select') : false)) modalDirty = true; });
  $('#modalBody').addEventListener('change', e => { if (e.target.closest && e.target.closest('[data-nodirty]')) return; if ((e.target.matches ? e.target.matches('input[type="checkbox"], input[type="radio"], select') : false)) modalDirty = true; });
  // the modal lives outside .container, so clicks inside it need their own delegation
  $('#modalBody').addEventListener('click', e => {
    if (e.target.closest('#mAssignMe')) { const o = $('#mOwner'); o.value = myOwnerName(); o.dispatchEvent(new Event('change', { bubbles: true })); e.target.closest('#mAssignMe').remove(); return; }
    const asc = e.target.closest('[data-mt-addschool]'); if (asc) { if (!guardAdmin()) return; const sc = schoolById(asc.dataset.mtAddschool); if (!sc) return; const ids = schoolMs(sc).filter(m => m.status !== 'complete').sort((x, y) => (x.due_date || '9999').localeCompare(y.due_date || '9999')).map(m => m.id); if (mmAddToNext([{ title: `${sc.market} · ${schLbl(sc)} readiness`, mins: 10, ids }], mmRegionOfMarket(sc.market))) asc.textContent = 'On the next agenda'; return; }
    const am = e.target.closest('[data-mt-addms]'); if (am) { if (!guardAdmin()) return; const m = findM(am.dataset.mtAddms); if (!m) return; if (mmAddToNext([{ title: m.activity, lead: m.owner || '', mins: 5, ids: [m.id] }], mmRegionOfMarket(m.market))) am.textContent = 'On the next agenda'; return; }
    const cl = e.target.closest('[data-copylink]'); if (cl) return copyText(milestoneUrl(cl.dataset.copylink), 'Link copied');
    const cs = e.target.closest('[data-copyschool]'); if (cs) { const u = new URL(milestoneUrl('x')); u.searchParams.delete('m'); u.searchParams.set('s', cs.dataset.copyschool); return copyText(u.toString(), 'Link copied'); }
    const dp = e.target.closest('[data-dupe]'); if (dp) return duplicateMilestone(dp.dataset.dupe);
    if (e.target.closest('#noteAdd')) return postNote(e.target.closest('.notes-field'));
    if (e.target.closest('#addTaskForSchool')) { taskReturnSchool = schoolId; return addTaskForSchool(); }
    if (e.target.closest('#tplToggle')) return toggleTemplatesPanel();
    if (e.target.closest('#tplApply')) return applyTemplatesToSchool();
    if (e.target.id === 'tplAll') { const on = e.target.checked; document.querySelectorAll('#tplPanel .tpl-check:not([disabled])').forEach(c => c.checked = on); return updateTplSelection(); }
    if (e.target.classList && e.target.classList.contains('tpl-check')) return updateTplSelection();
    const op = e.target.closest('[data-openplanschool]'); if (op) { closeModal(); clearFilters(); state.filters.schools = new Set([op.dataset.openplanschool]); setView('plan'); return; }
    const os = e.target.closest('[data-openschool]'); if (os) { closeModal(); return openSchoolModal(os.dataset.openschool); }
    const ex = e.target.closest('[data-expand]'); if (ex && !e.target.closest('button:not([data-expand]), a, input, select, textarea, label')) { if (modalMode === 'school') taskReturnSchool = schoolId; return openModal(ex.dataset.expand); }
  });
  $('#modalBody').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'noteInput' && !mentionMenuOpen()) { e.preventDefault(); postNote(e.target.closest('.notes-field')); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCmdk(); if ($('#modalBackdrop').classList.contains('open')) attemptCloseModal(); closeDrawer(); closePopover(); closeConfirm(); } });

  // keep timing colors live vs. the real date (on return-to-tab and within a minute of midnight)
  let _day = new Date().toDateString();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rerender(); });
  setInterval(() => { const t = new Date().toDateString(); if (t !== _day) { _day = t; rerender(); } }, 60000);

  document.addEventListener('dragstart', e => { const c = e.target.closest('.kcard, .bd-card'); if (c && !canEdit()) { e.preventDefault(); return; } if (c) { e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); const k = c.closest('.bd'); if (k) k.classList.add('is-dragging'); } });
  document.addEventListener('dragend', e => { const c = e.target.closest('.kcard, .bd-card'); if (c) c.classList.remove('dragging'); $$('.bd-body.over').forEach(b => b.classList.remove('over')); $$('.bd.is-dragging').forEach(k => k.classList.remove('is-dragging')); });
  document.addEventListener('dragover', e => { const b = e.target.closest('.bd-body'); if (b) { e.preventDefault(); b.classList.add('over'); } });
  document.addEventListener('dragleave', e => { const b = e.target.closest('.bd-body'); if (b && !b.contains(e.relatedTarget)) b.classList.remove('over'); });
  document.addEventListener('drop', e => { const b = e.target.closest('.bd-body'); if (b) { e.preventDefault(); b.classList.remove('over'); const m = findM(e.dataTransfer.getData('text/plain')); if (m && m.stage !== b.dataset.kstage && guardEdit()) { moveToStage(m, b.dataset.kstage); } } });

  $('.container').addEventListener('click', e => {
    const fm = e.target.closest('.fb-menu'); if (fm) { state._fmOrder = null; return openFilterMenu(fm, fm.dataset.fmenu); }
    const oy = e.target.closest('[data-oyear]'); if (oy) { toggleOpeningYear(+oy.dataset.oyear); return rerender(); }
    if (e.target.closest('[data-oyall]')) { state.filters.openingFYs.clear(); return rerender(); }
    if (e.target.closest('#clearFilters, [data-clearfilters]')) { clearFilters(); return rerender(); }
    if (e.target.closest('#clearFilters2')) { clearFilters(); return rerender(); }
    if (e.target.closest('#pmExpandAll')) { (state._pmKeys || []).forEach(k => state.expanded[k] = true); return refreshBody(); }
    if (e.target.closest('#pmCollapseAll')) { state.expanded = {}; return refreshBody(); }
    const plv = e.target.closest('[data-planview]'); if (plv) { state.planGroup = plv.dataset.planview === 'board' ? 'stage' : (state._lastListGroup || 'team'); if (plv.dataset.planview !== 'board') state._lastListGroup = state.planGroup; savePlanGroup(); return renderPlan(); }
    const pv = e.target.closest('[data-progressview]'); if (pv) { state.progressView = pv.dataset.progressview; return renderProgress(); }
    const pd = e.target.closest('[data-progressdim]'); if (pd) { state.progressDim = pd.dataset.progressdim; return refreshBody(); }
    const ch = e.target.closest('[data-cohort]'); if (ch) return setDashCohort(ch.dataset.cohort);
    const bd = e.target.closest('[data-dashbd]'); if (bd) { state.dashBreakdown = bd.dataset.dashbd; return refreshBody(); }
    if (e.target.closest('[data-open-checkins]')) return openCheckins();
    if (e.target.closest('[data-open-duereq]')) return openDueRequests();
    if (e.target.closest('[data-open-defs]')) return openDefinitions();
    if (e.target.closest('[data-open-agenda]')) return setView('meetings');
    if (e.target.closest('[data-mtg-held]')) { if (meta().meetBook && meta().meetBook.live) { toast('A meeting is running. End it on the Meetings page to save the minutes', 'warn'); return setView('meetings'); } return markMeetingHeld(); }
    if (e.target.closest('[data-open-settings]')) { renderDrawer(); $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); return; }
    if (e.target.closest('[data-copy-all]')) return copyText(reminderText(M().filter(needsCheckin)));
    const etm = e.target.closest('[data-email-team]'); if (etm) return emailTeam(etm.dataset.emailTeam);
    const ctm = e.target.closest('[data-copy-team]'); if (ctm) { const txt = teamNote(ctm.dataset.copyTeam); return txt ? copyText(txt) : null; }
    const qs = e.target.closest('[data-qstatus]'); if (qs) { e.stopPropagation(); return openStatusMenu(qs); }
    const oc = e.target.closest('.kc-owners .pchip[title], .bd-card .bd-own .pchip[title]'); if (oc) { e.stopPropagation(); const who = oc.title === 'Unassigned' ? '__none__' : oc.title; state.filters.owners = new Set([who]); rerender(); return toast(`Showing ${who === '__none__' ? 'unassigned' : who + "'s"} milestones`, 'ok'); }
    const km = e.target.closest('[data-kmove]'); if (km) { e.stopPropagation(); return openMoveMenu(km); }
    const kj = e.target.closest('[data-kbjump]'); if (kj) { const cols = document.querySelectorAll('.bd .bd-col'), c = cols[+kj.dataset.kbjump], k = document.querySelector('.bd'); if (c && k) k.scrollTo({ left: c.offsetLeft - k.offsetLeft, behavior: 'smooth' }); return; }
    const dr = e.target.closest('[data-drilldim]'); if (dr) return applyDrill(dr.dataset.drilldim, dr.dataset.drillval);
    const gv = e.target.closest('[data-goview]'); if (gv) { window.scrollTo({ top: 0, behavior: 'smooth' }); return setView(gv.dataset.goview); }
    if (e.target.closest('[data-activityall]')) return toggleActivity();
    const as = e.target.closest('[data-addstage]'); if (as) return addItem(as.dataset.addstage);
    const cp = e.target.closest('[data-complete]'); if (cp) { if (!guardEdit()) { e.preventDefault(); return; } const m = findM(cp.dataset.complete); if (m) { snapshotForUndo('Complete: ' + (m.activity || '').slice(0, 30)); m.status = 'complete'; m.progress_percent = 100; m.stage = 'complete'; touch(m); logActivity('status', `Completed "${m.activity}"`, { itemId: m.id }); autosave(); rerender(); toast('Marked complete' + unblockNote(m), 'ok'); } return; }
    const sm = e.target.closest('[data-showmore]'); if (sm) { const p = sm.dataset.showmore; if (p === 'focus') state.planFocus = true; else { state.planGroup = p; state.planFocus = false; } return setView('plan'); }
    const at = e.target.closest('[data-addteam]'); if (at) { e.stopPropagation(); return addItem(null, at.dataset.addteam); }
    const tg = e.target.closest('[data-toggle]'); if (tg) { const k = tg.dataset.toggle; state.expanded[k] = !state.expanded[k]; return refreshBody(); }
    if (state.sel && state.view === 'plan') { const kc = e.target.closest('.kcard[data-id], .bd-card[data-id], .ml-row[data-id]'); if (kc && !e.target.closest('button, a, input, select, textarea')) { const id = kc.dataset.id;
      if (e.shiftKey && state.lastSel) { const all = [...document.querySelectorAll('.kcard[data-id], .bd-card[data-id], .ml-row[data-id]')].map(x => x.dataset.id), i = all.indexOf(state.lastSel), j = all.indexOf(id); if (i >= 0 && j >= 0) { all.slice(Math.min(i, j), Math.max(i, j) + 1).forEach(x => state.sel.add(x)); document.querySelectorAll('.kcard[data-id], .bd-card[data-id], .ml-row[data-id]').forEach(x => x.classList.toggle('is-sel', state.sel.has(x.dataset.id))); state.lastSel = id; return paintBulkBar(); } }
      state.lastSel = id; state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id); kc.classList.toggle('is-sel', state.sel.has(id)); kc.setAttribute('aria-selected', state.sel.has(id)); return paintBulkBar(); } }
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
    if (e.target.closest('#planCsv')) return exportXlsx();
    if (e.target.closest('#planSelect')) { state.sel = state.sel ? null : new Set(); if (state.sel) { state._expandAllOnce = true; } renderPlan(); paintBulkBar(); const a = $('#toastWrap'); if (a && state.sel) toast('Select mode: click milestones, Shift-click for a range, Esc to stop', 'ok'); return; }
    if (e.target.closest('#planHideDone')) { state.hideDone = !state.hideDone; lsSet('ngc_hide_done_' + WS, state.hideDone ? '1' : ''); return renderPlan(); }
    if (e.target.closest('#planLink')) return copyText(viewLink(), 'Link copied');
    const tAll = e.target.closest('#planToggleAll');
    if (tAll) { const keys = state._planKeys || [], open = keys.length > 0 && keys.every(k => state.expanded[k]); keys.forEach(k => { if (open) delete state.expanded[k]; else state.expanded[k] = true; }); tAll.textContent = open ? 'Expand all' : 'Collapse all'; return refreshBody(); }
    if (e.target.closest('#addSchool')) { if (!isAdmin()) return toast('Only admins add school openings', 'err'); return openSchoolModal(null); }
    if (e.target.closest('#addTaskForSchool')) return addTaskForSchool();
    if (e.target.closest('#newItem')) return addItem();
    if (e.target.closest('#dashPrint')) return window.print();
    const afc = e.target.closest('[data-afclear]'); if (afc) { removeAppliedFilter(afc.dataset.afclear); return rerender(); }
  });
  $('.container').addEventListener('change', e => {
    if (e.target.id === 'planDue') { state.filters.timing = e.target.value; refreshBody(); return; }
    if (e.target.id === 'planGroupSel') { state.planGroup = e.target.value; state._lastListGroup = state.planGroup; savePlanGroup(); refreshBody(); }
    else if (e.target.id === 'dashSchool') { state.filters.schoolId = e.target.value; refreshBody(); const cl = $('#clearFilters'); if (cl) cl.classList.toggle('hide', !activeCount()); }
  });

  $('#drawerBody').addEventListener('click', e => {
    if (e.target.id === 'sbReconnect') { const sc = sbCfg(); if (sc && sc.url && sc.key) sbConnect(sc.url, sc.key); return; }
    if (e.target.id === 'expBtn') return exportJson();
    if (e.target.id === 'csvBtn') return exportXlsx();
    if (e.target.id === 'impBtn') { if (guardAdmin()) $('#impFile').click(); return; }
    if ((e.target.id === 'msDeleteAll' || e.target.closest('[data-msdel], [data-czadd], .cz-del')) && !guardAdmin()) return;
    if (e.target.id === 'msDeleteAll') return bulkDeleteAllSchools();
    const msE = e.target.closest('[data-msedit]'); if (msE) { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); return openSchoolModal(msE.dataset.msedit); }
    const msD = e.target.closest('[data-msdel]'); if (msD) { const sid = msD.dataset.msdel; const s = schoolById(sid); if (!s) return; const tasks = schoolMs(s); confirmDialog({ title: `Remove ${schLbl(s)}?`, message: `Remove <b>${esc(schLbl(s))} (${esc(s.market)})</b>` + (tasks.length ? ` and its <b>${tasks.length} milestone${tasks.length === 1 ? '' : 's'}</b>` : '') + ' from the schedule.', confirmLabel: 'Remove school', danger: true, onConfirm: () => { snapshotForUndo('Remove school: ' + schLbl(s)); const cd = s.code; state.data.schools = state.data.schools.filter(x => x.id !== sid); state.data.milestones = M().filter(m => { if (!(m.schoolIds || []).includes(sid)) return true; m.schoolIds = m.schoolIds.filter(id => id !== sid); m.schools = (m.schools || []).filter(c => c !== cd); return m.schoolIds.length > 0; }); autosave(); rerender(); renderDrawer(); toast('School removed', 'ok'); } }); return; }
    const czp = e.target.closest('[data-czphoto]'); if (czp) { const o = (meta().owners || []).find(x => x.name === czp.dataset.czphoto); return o && czPhotoPick(o, czp); }
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
function applyRoleUI() { const ro = !!(state.auth && state.auth.user) && !canEdit(); document.body.classList.toggle('read-only', ro); const c = $('#modalCancel'); if (c) c.textContent = ro ? 'Close' : 'Cancel'; }

async function loadProfile(userId) {
  const client = state.sb && state.sb.client; if (!client || !userId) return null;
  try {
    const { data, error } = await client.from('profiles').select('id, full_name, email, department, role, mfa_enrolled').eq('id', userId).single();
    if (error) throw error;
    state.auth.profile = data; setTimeout(loadPhotos, 0); return data;
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
/* Set-your-own-password step (Nov 20 2026). Everyone who signs in with a password, or opens Causeway with a saved
   session, sets their own password once before the tool opens. Saving it records pw_set: true on the person's
   Supabase account (user_metadata), so it never asks again on any device. People who sign in another way (Microsoft,
   magic link) are never asked. Changing a password in Account and settings also counts. */
const pwLater = () => { try { return sessionStorage.getItem('cw_pw_later') === '1'; } catch (e) { return false; } };
function needsFirstPw(u) {
  if (!u || pwLater()) return false;
  const prov = (u.app_metadata && u.app_metadata.provider) || 'email';
  return prov === 'email' && !(u.user_metadata && u.user_metadata.pw_set);
}
async function signInEmail(email, password) {
  const client = await ensureSbClient();
  const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) { const m = String(error.message || error.code || ''); throw new Error(/invalid login|invalid_credentials/i.test(m) ? "That email and password don't match. Check them and try again." : /not confirmed/i.test(m) ? "Your account isn't active yet. Ask your admin." : /rate|too many/i.test(m) ? 'Too many tries. Wait a minute, then try again.' : "Couldn't sign in. Check your connection and try again."); }
  state.auth.user = data.user; await loadProfile(data.user.id);
  return data.user;
}
async function signOutUser(force) {
  const client = state.sb && state.sb.client; if (!client) return;
  if (!force && ($('#syncAlert') || (modalDirty && $('#modalBackdrop.open')))) return confirmDialog({ title: 'Sign out with unsaved changes?', message: 'Some of your changes have not reached the shared board yet. Signing out may lose them.', confirmLabel: 'Sign out anyway', danger: true, onConfirm: () => signOutUser(true) });
  await client.auth.signOut();
  state.auth.user = null; state.auth.profile = null;
  showAuthScreen();
}

function showAuthScreen(err, mode, info) {
  mode = mode || 'signin';   // 'signin' | 'forgot' | 'setpw'
  let g = $('#gateScreen');
  if (!g) { g = document.createElement('div'); g.id = 'gateScreen'; g.className = 'gate-screen'; document.body.appendChild(g); }
  const logoSrc = (document.querySelector('.brand-logo') || {}).src || '';
  const intro = { signin: '', forgot: "We'll email you a reset link.", setpw: state.auth.firstPw ? 'Set your display name and your own password.' : 'Choose a password.' }[mode];
  const fields = mode === 'signin' ? `
        <div class="field"><label for="authEmail">Work email</label><input id="authEmail" type="email" autocomplete="username" required></div>
        <div class="field"><label for="authPw">Password</label><input id="authPw" type="password" autocomplete="current-password" required></div>
        <label class="field-check"><input type="checkbox" class="pw-show"> Show password</label>
        <button type="submit" class="btn btn-filled" id="authSubmit">Sign in</button>`
    : mode === 'forgot' ? `
        <div class="field"><label for="authEmail">Work email</label><input id="authEmail" type="email" autocomplete="username" required></div>
        <button type="submit" class="btn btn-filled" id="authSubmit">Send reset link</button>`
    : state.auth.firstPw ? `
        <input type="email" autocomplete="username" value="${esc((state.auth.user && state.auth.user.email) || '')}" hidden>
        <div class="field"><label for="authName">Display name</label><input id="authName" autocomplete="name" maxlength="80" value="${esc((state.auth.profile && state.auth.profile.full_name) || '')}"></div>
        <div class="field"><label for="authPw">New password</label><input id="authPw" type="password" autocomplete="new-password" minlength="12"></div>
        <div class="field"><label for="authPw2">Confirm new password</label><input id="authPw2" type="password" autocomplete="new-password" minlength="12"></div>
        <label class="field-check"><input type="checkbox" class="pw-show"> Show passwords</label>
        <button type="submit" class="btn btn-filled" id="authSubmit">Save and continue</button>`
    : `
        <input type="email" autocomplete="username" value="${esc((state.auth.user && state.auth.user.email) || '')}" hidden>
        <div class="field"><label for="authPw">New password</label><input id="authPw" type="password" autocomplete="new-password" required minlength="12"></div>
        <div class="field"><label for="authPw2">Confirm new password</label><input id="authPw2" type="password" autocomplete="new-password" required minlength="12"></div>
        <label class="field-check"><input type="checkbox" class="pw-show"> Show passwords</label>
        <button type="submit" class="btn btn-filled" id="authSubmit">Save password</button>`;
  const foot = mode === 'signin' ? '<button type="button" class="auth-link" data-authmode="forgot">Forgot password?</button><div>No account? Ask your admin.</div>'
    : mode === 'forgot' ? '<button type="button" class="auth-link" data-authmode="signin">Back to sign in</button>'
    : `<div>12+ characters with upper and lowercase, a number and a symbol</div>${state.auth.firstPw ? '<div class="auth-foot-acts"><button type="button" class="auth-link" data-authlater>No thanks, I\'ll do this later</button><button type="button" class="auth-link" data-authsignout>Sign out</button></div>' : ''}`;
  g.innerHTML = `<div class="gate-card auth-card">
      <img class="gate-logo" src="${logoSrc}" alt="KIPP">
      <div class="cw-hero"><svg class="cw-mark" viewBox="0 0 32 32" width="64" height="64" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="16" fill="#001d6c"/><path fill="#fff" transform="translate(6.5 8.5) scale(.73) translate(-3 -10.5)" d="M3 10.5H29V20H27.5A3.333 3.333 0 0 0 20.833 20H19.333A3.333 3.333 0 0 0 12.667 20H11.167A3.333 3.333 0 0 0 4.5 20H3Z"/><rect x="6.5" y="9.96" width="19" height=".66" fill="#001d6c"/><svg x="5" y="18.4" width="22" height="6" viewBox="0 0 22 6"><path class="cw-wave" fill="none" stroke="#72c1ea" stroke-width="1.5" stroke-linecap="round" d="M-19.2 3 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0"/></svg></svg><span class="cw-hero-name">Causeway</span></div>
      <h1 class="sr-only">Causeway</h1>
      ${intro ? `<p>${intro}</p>` : ''}
      <form id="authForm" autocomplete="on">${fields}</form>
      ${err ? `<div class="gate-err" role="alert">${esc(err)}</div>` : ''}
      ${info ? `<div class="gate-info" role="status">${esc(info)}</div>` : ''}
      <div class="auth-foot">${foot}</div>
    </div>`;
  g.querySelectorAll('[data-authmode]').forEach(b => b.addEventListener('click', () => showAuthScreen(null, b.dataset.authmode)));
  g.querySelectorAll('[data-authlater]').forEach(b => b.addEventListener('click', () => { try { sessionStorage.setItem('cw_pw_later', '1'); } catch (e) {} state.auth.firstPw = false; g.remove(); if (!state._booted) enterApp(''); }));
  g.querySelectorAll('[data-authsignout]').forEach(b => b.addEventListener('click', async () => { state.auth.firstPw = false; try { const c = state.sb && state.sb.client; if (c) await c.auth.signOut(); } catch (e) {} state.auth.user = null; showAuthScreen(null, 'signin'); }));
  const f = $('#authForm'), sub = $('#authSubmit'), label = sub.textContent;
  f.addEventListener('submit', async e => {
    e.preventDefault();
    sub.disabled = true; sub.textContent = 'One moment…';
    try {
      if (mode === 'forgot') {
        await sendPasswordReset($('#authEmail').value);
        return showAuthScreen(null, 'signin', 'If that email has an account, a reset link is on its way. Check your inbox.');
      }
      if (mode === 'setpw' && state.auth.firstPw) {
        const client = await ensureSbClient(), u = state.auth.user, nm = ($('#authName').value || '').trim().replace(/\s+/g, ' '), pw = $('#authPw').value, pw2 = $('#authPw2').value;
        if (pw || pw2) {
          const missing = PW_RULES.filter(([, ok]) => !ok(pw)).map(([t]) => t.toLowerCase());
          if (missing.length) throw new Error('Your password needs: ' + missing.join(', ') + '.');
          if (pw !== pw2) throw new Error('The two passwords do not match.');
        }
        if (nm && u && nm !== ((state.auth.profile && state.auth.profile.full_name) || '')) {
          const { error: ne } = await client.from('profiles').update({ full_name: nm }).eq('id', u.id).select('id');
          if (ne) throw new Error("Couldn't save your name. Try again.");
          if (state.auth.profile) state.auth.profile.full_name = nm;
        }
        if (pw) {
          const { data: ud, error } = await client.auth.updateUser({ password: pw, data: { pw_set: true } });
          if (error) throw new Error(/different from the old|same_password/i.test(String(error.message || error.code)) ? 'Choose a password different from the one you signed in with.' : /reauth|recent/i.test(String(error.message || error.code)) ? 'For security, sign in again, then set your password.' : /weak|pwned|leaked/i.test(String(error.message || error.code)) ? 'That password is too common. Choose another.' : "Couldn't save your password. Check your connection and try again.");
          if (ud && ud.user) state.auth.user = ud.user;
        } else { try { sessionStorage.setItem('cw_pw_later', '1'); } catch (e) {} }
        state.auth.firstPw = false; g.remove(); if (typeof updateUserBadge === 'function') updateUserBadge();
        return enterApp(pw ? 'Welcome to Causeway' : 'Name saved');
      }
      if (mode === 'setpw') {
        const pw = $('#authPw').value, pw2 = $('#authPw2').value;
        const missing = PW_RULES.filter(([, ok]) => !ok(pw)).map(([t]) => t.toLowerCase());
        if (missing.length) throw new Error('Your password needs: ' + missing.join(', ') + '.');
        if (pw !== pw2) throw new Error('The two passwords do not match.');
        const client = await ensureSbClient();
        const { data: ud, error } = await client.auth.updateUser({ password: pw, data: { pw_set: true } });
        if (error) throw new Error(/different from the old|same_password/i.test(String(error.message || error.code)) ? 'Choose a password different from the one you signed in with.' : /reauth|recent/i.test(String(error.message || error.code)) ? 'For security, sign in again, then set your password.' : /weak|pwned|leaked/i.test(String(error.message || error.code)) ? 'That password is too common. Choose another.' : "Couldn't save your password. Check your connection and try again.");
        if (ud && ud.user) state.auth.user = ud.user;
        state.auth.needsPassword = false; state.auth.firstPw = false; AUTH_LINK.type = null;
        try { history.replaceState(null, '', location.pathname + '#progress'); } catch (e2) {}
        g.remove(); return enterApp('Password saved');
      }
      const u = await signInEmail($('#authEmail').value, $('#authPw').value);
      if (needsFirstPw(u)) { state.auth.firstPw = true; return showAuthScreen(null, 'setpw'); }
      g.remove(); enterApp('Signed in');
    } catch (ex) {
      sub.disabled = false; sub.textContent = label;
      const email = $('#authEmail') ? $('#authEmail').value : '', name = $('#authName') ? $('#authName').value : null;
      showAuthScreen(ex.message || 'Something went wrong. Try again.', mode);
      if (email && $('#authEmail')) { $('#authEmail').value = email; setTimeout(() => { const p = $('#authPw'); if (p) p.focus(); }, 40); }
      if (name !== null && $('#authName')) { $('#authName').value = name; setTimeout(() => { const p = $('#authPw'); if (p) p.focus(); }, 40); }   // keep the typed name; passwords are cleared on purpose
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
  (root || document).querySelectorAll('.owner-avatar:not(.unassigned), .dact-avatar, .cb-user-avatar, .pchip:not(.pchip-none)').forEach(el => {
    const seed = el.getAttribute('data-seed') || (el.classList.contains('pchip') ? el.getAttribute('title') : '') || el.textContent || '';
    if (!seed) return;
    const ph = photoOf(seed) || (el.classList.contains('cb-user-avatar') ? photoOf((currentProfile() || {}).full_name) : '');
    if (ph) { el.classList.add('has-photo'); el.style.backgroundImage = `url('${ph}')`; }
    if (!el.classList.contains('painted') && !el.classList.contains('pchip')) { el.style.background = avatarColor(seed); el.style.color = '#fff'; el.classList.add('painted'); if (ph) el.style.backgroundImage = `url('${ph}')`; }
  });
}
// Friendly hello (Nov 20 2026): by time of day, with a little variety that holds steady for the whole day
function timeGreeting() {
  const d = new Date(), h = d.getHours(), day = d.getDay(), seed = d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate();
  const pick = a => a[seed % a.length];
  if (h < 5 || h >= 22) return pick(['Working late', 'Burning the midnight oil', 'Up late']);
  if (h < 12) return day === 1 ? pick(['Happy Monday', 'Good morning']) : pick(['Good morning', 'Morning', 'Rise and shine']);
  if (h < 17) return day === 5 ? 'Happy Friday' : pick(['Good afternoon', 'Howdy', 'Hi there']);
  return pick(['Good evening', 'Evening']);
}
/* ---------- signed-in user -> owner roster ----------
   An account is linked to an owner, in order, by:
   1. its login email matching the owner's roster email
   2. its display name matching the owner name exactly (case, spacing and accents ignored)
   3. KIPP email convention: first initial + last name at a KIPP domain (jsmith@kippnj.org)
   No partial or last-name-only matching: "Pat Lee" must never pick up "Sam Lee"'s milestones. */
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

/* Account and settings panel, drill-in (Nov 20 2026): the panel opens on your account and a short Settings list.
   Each admin section opens on its own page with a Back button, instead of every section stacked in one scroll. */
const DW_CHEV = '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M22 16L12 26 10.6 24.6 19.2 16 10.6 7.4 12 6z"/></svg>';
const DW_GROUPS = [['Lists', ['Markets', 'Teams', 'Owners']], ['Meetings and alerts', ['Committee meetings', 'Slack']], ['Data', ['Data checks', 'School openings', 'Backup and restore']]];
const dwKey = d => (((d.querySelector('summary') || {}).textContent) || '').replace(/\d+/g, '').trim();
function dwDrillify() {
  const body = $('#drawerBody'); if (!body) return;
  const secs = [...body.querySelectorAll(':scope > details.dw-fold')]; if (!secs.length) return;
  const cur = state.dwView ? secs.find(d => dwKey(d) === state.dwView) : null;
  if (!body.querySelector('.dw-setnav')) {
    const nav = document.createElement('nav'); nav.className = 'dw-nav dw-setnav'; nav.setAttribute('aria-label', 'Settings');
    const row = d => { const b = d.querySelector('summary .dc-badge'); return `<button type="button" class="dw-navrow" data-dwgo="${esc(dwKey(d))}"><span>${esc(dwKey(d))}</span>${b ? `<span class="dw-count">${esc(b.textContent)}</span>` : ''}${DW_CHEV}</button>`; };
    nav.innerHTML = DW_GROUPS.map(([g, keys]) => { const ds = secs.filter(d => keys.includes(dwKey(d))); return ds.length ? `<h4 class="dw-nav-h">${g}</h4>${ds.map(row).join('')}` : ''; }).join('')
      + (secs.some(d => !DW_GROUPS.some(([, k]) => k.includes(dwKey(d)))) ? `<h4 class="dw-nav-h">More</h4>${secs.filter(d => !DW_GROUPS.some(([, k]) => k.includes(dwKey(d)))).map(row).join('')}` : '');
    secs[0].before(nav);
    const back = document.createElement('button'); back.type = 'button'; back.className = 'dw-back'; back.dataset.dwgo = ''; back.innerHTML = '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M14 26L15.41 24.59 7.83 17 28 17 28 15 7.83 15 15.41 7.41 14 6 4 16 14 26z"/></svg>Back to settings'; body.prepend(back);
  }
  body.classList.toggle('dw-drilled', !!cur);
  secs.forEach(d => { d.hidden = d !== cur; if (d === cur) d.open = true; });
  body.querySelector('.dw-setnav').hidden = !!cur; body.querySelector('.dw-back').hidden = !cur;
  body.querySelectorAll(':scope > .dw-me, :scope > .dw-about, :scope > .dw-foot').forEach(el => { el.hidden = !!cur; });
  if (!body.querySelector('.dw-foot') && currentProfile()) { const f = document.createElement('div'); f.className = 'dw-foot'; f.innerHTML = '<button type="button" class="btn btn-ghost btn-sm dw-signout" id="umSignOut">Sign out</button>'; body.appendChild(f); f.hidden = !!cur; }
}
(function () { const base = renderDrawer; renderDrawer = function () { const r = base.apply(this, arguments); dwDrillify(); return r; }; })();
document.addEventListener('click', e => {
  const g = e.target.closest && e.target.closest('[data-dwgo]'); if (!g) return;
  const from = state.dwView; state.dwView = g.dataset.dwgo; dwDrillify();
  if (moOK()) { const body = $('#drawerBody'), dx = state.dwView ? 16 : -16; if (body) [...body.children].filter(el => !el.hidden).forEach(el => el.animate([{ opacity: 0, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'none' }], { duration: 150, easing: 'cubic-bezier(0, 0, .38, .9)' })); }
  const body = $('#drawerBody'); if (body) body.scrollTop = 0;
  const f = state.dwView ? body.querySelector('.dw-back') : body.querySelector(`[data-dwgo="${CSS.escape(from || '')}"]`); if (f) f.focus();
});
// The avatar opens the one account and settings panel (Nov 20 2026). The old avatar menu's items live at its top.
function openUserMenu() { if (!currentProfile()) return; openDrawer(); }
function accountActionsHtml() {
  const p = currentProfile(); if (!p) return '';
  const it = (id, l) => `<button type="button" class="dw-navrow" id="${id}"><span>${l}</span>${DW_CHEV}</button>`;
  return `${myOwner() ? '' : `<div class="dw-inline" role="status"><span class="dw-inline-ic" aria-hidden="true">i</span><span>Not linked to an owner name. ${isAdmin() ? 'Add your email in Owners.' : 'Ask an admin to link you.'}</span></div>`}
    <nav class="dw-nav dw-acct" aria-label="Account"><h4 class="dw-nav-h">Account</h4>${myOwner() ? it('umMine', 'My milestones') : ''}${it('umCalendar', 'Add deadlines to Outlook')}${it('umKeys', 'Keyboard shortcuts')}${it('dwPassword', 'Change password')}</nav>`;
}
document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('#umMine, #umCalendar, #umKeys, #umSignOut'); if (!t) return;
  closeDrawer();
  if (t.id === 'umSignOut') return signOutUser();
  if (t.id === 'umCalendar') return openCalendarSheet();
  if (t.id === 'umKeys') return showShortcuts();
  clearFilters(); state.filters.owners = new Set([myOwnerName()]); setView('plan'); rerender();
});

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
      const { error } = await client.auth.updateUser({ password: p, data: { pw_set: true } });
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
  if (state.auth.user && needsFirstPw(state.auth.user)) state.auth.firstPw = true;
  if (state.auth.user && (state.auth.needsPassword || AUTH_LINK.type || state.auth.firstPw)) return showAuthScreen(null, 'setpw');
  if (state.auth.user) { state._booted = true; return bootApp(); }
  return showAuthScreen(AUTH_LINK.error);
}
function showAuthConfigNeeded() {
  let g = $('#gateScreen');
  if (!g) { g = document.createElement('div'); g.id = 'gateScreen'; g.className = 'gate-screen'; document.body.appendChild(g); }
  g.innerHTML = `<div class="gate-card auth-card">
      <img class="gate-logo" src="${(document.querySelector('.brand-logo') || {}).src || ''}" alt="KIPP">
      <h1>Setup needed</h1>
      <p>The database connection is missing. Contact the Causeway admin.</p>
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
  if (a.entity_type === 'school') { const s = schoolById(a.entity_id); return `${v} ${s ? esc(schLbl(s)) + ' (' + esc(s.market) + ')' : 'a school'}`; }
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
  const unseen = activityEntries(50).some(e => e.ts > seen && e.author !== me) || unreadForMe().length > 0;
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
  const scope = activityIsTeam() ? '<div class="activity-scope">Everyone\'s changes</div>' : '';
  const fy = unreadForMe(), fyHtml = fy.length ? `<div class="cm4-bell"><div class="cm4-bell-h"><b>For you</b><button type="button" class="btn btn-text btn-sm" data-cmt-read>Mark all read</button></div><div class="cm5-list">${fy.slice(0, 5).map(x => cmtRow(x, 0)).join('')}</div>${fy.length > 5 ? `<button class="card-more" data-allmentions>View all ${fy.length}</button>` : ''}</div>` : '';
  body.onclick = ev => { const it = ev.target.closest('[data-openitem]'); if (it) openModal(it.dataset.openitem); const ce = ev.target.closest('[data-cmt-open]'); if (ce && !ev.target.closest('[data-cmt-read]')) openModal(ce.dataset.expand); };
  if (!log.length) { body.innerHTML = fyHtml + scope + '<div class="activity-empty">No activity yet</div>'; return; }
  body.innerHTML = fyHtml + scope + log.map(e => {
    const when = fmtWhen(e.ts);
    const who = e.author ? `<b>${esc(e.author)}</b> · ` : '';
    const stillExists = e.itemId && findM(e.itemId);
    const cls = stillExists ? 'activity-item activity-clickable' : 'activity-item';
    const attr = stillExists ? ` data-openitem="${esc(e.itemId)}" title="Open this milestone"` : '';
    return `<div class="${cls}"${attr}><span class="activity-ic">${activityIcon(e.action)}</span><div class="activity-detail">${who}<span class="activity-what">${esc(e.detail)}</span><span class="activity-when">${esc(when)}</span></div></div>`;
  }).join('');

}
// Activity panel closes like every other panel: Esc, or a click outside it (Nov 20 2026)
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; const p = $('#activityPanel'); if (!p || !p.classList.contains('open') || $('#popover') || $('#modalBackdrop.open') || $('#sheetBackdrop') || $('#confirmBackdrop')) return; p.classList.remove('open'); const b = $('#cbActivityBtn'); if (b) b.focus(); });
document.addEventListener('mousedown', e => { const p = $('#activityPanel'); if (!p || !p.classList.contains('open') || p.contains(e.target) || (e.target.closest && e.target.closest('#cbActivityBtn, #popover, .modal-backdrop, .confirm-backdrop'))) return; p.classList.remove('open'); });
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
  cmdkItems = buildCmdkItems(q).filter(x => !x.hide && !/^Start meeting/.test(x.name) && (MEETINGS_ON || !/^(Go to Meetings|Start meeting|Action: |Meeting agenda)/.test(x.name)));
  if (cmdkIdx >= cmdkItems.length) cmdkIdx = 0;
  body.innerHTML = cmdkItems.map((item, i) => `<div class="cmdk-item ${i === cmdkIdx ? 'active' : ''}" data-cmdk="${i}"><span class="cmdk-ic">${item.icon}</span><div class="cmdk-label"><span class="cmdk-name">${hiMatch(item.name, q)}</span>${item.hint ? `<span class="cmdk-hint">${esc(item.hint)}</span>` : ''}</div>${item.kbd ? `<kbd class="cmdk-kbd">${item.kbd}</kbd>` : ''}</div>`).join('') || `<div class="cmdk-empty">No results for “${esc((q || '').trim())}” on this board.${otherBoardLink(q)}</div>`;
}
function buildCmdkItems(q) {
  // Uniform Material outlined SVG icons (1.75 stroke, 18px). No emojis.
  const ic = (p) => `<svg viewBox="0 0 32 32" fill="currentColor" width="18" height="18">${p}</svg>`;
  const items = [];
  items.push({ icon: ic('<path d="M24 21H26V26H24zM20 16H22V26H20zM11 26a5.0059 5.0059 0 01-5-5H8a3 3 0 103-3V16a5 5 0 010 10z"/><path d="M28,2H4A2.002,2.002,0,0,0,2,4V28a2.0023,2.0023,0,0,0,2,2H28a2.0027,2.0027,0,0,0,2-2V4A2.0023,2.0023,0,0,0,28,2Zm0,9H14V4H28ZM12,4v7H4V4ZM4,28V13H28.0007l.0013,15Z"/>'), name: 'Go to Dashboard', hint: '', kbd: '', action: () => setView('progress') });
  items.push({ icon: ic('<path d="M24 4H26V28H24zM18 6V26H14V6h4m0-2H14a2 2 0 00-2 2V26a2 2 0 002 2h4a2 2 0 002-2V6a2 2 0 00-2-2zM6 4H8V28H6z"/>'), name: 'Go to Milestones', hint: '', kbd: '', action: () => setView('plan') });
  items.push({ icon: ic('<path d="M26,4h-4V2h-2v2h-8V2h-2v2H6C4.9,4,4,4.9,4,6v20c0,1.1,0.9,2,2,2h20c1.1,0,2-0.9,2-2V6C28,4.9,27.1,4,26,4z M26,26H6V12h20	V26z M26,10H6V6h4v2h2V6h8v2h2V6h4V10z"/>'), name: 'Go to Openings', hide: !hasSchoolWork(), hint: '', kbd: '', action: () => setView('timeline') });
  items.push({ icon: ic('<path d="M28 26H4a2 2 0 01-2-2V8a2 2 0 012-2h24a2 2 0 012 2v16a2 2 0 01-2 2zM4 8v16h24V8z"/><path d="M6 10h2v2H6zM10 10h2v2h-2zM14 10h2v2h-2zM18 10h2v2h-2zM22 10h4v2h-4zM6 14h4v2H6zM12 14h2v2h-2zM16 14h2v2h-2zM20 14h6v2h-6zM9 20h14v2H9z"/>'), name: 'Keyboard shortcuts', hint: 'N, /, Cmd+K, Cmd+Z, Cmd+Enter', kbd: '', action: showShortcuts });
  if (q && q.trim().length > 1) openActions().filter(a => a.text.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 3).forEach(a => items.push({ icon: ic('<path d="M14 21.414l-5-5.001L10.413 15 14 18.586 21.585 11 23 12.415l-9 8.999z"/><path d="M16 2a14 14 0 1014 14A14 14 0 0016 2zm0 26a12 12 0 1112-12 12 12 0 01-12 12z"/>'), name: 'Action: ' + a.text, hint: `${a.owner || 'No owner'}${a.due ? ' · due ' + fmtDate(a.due) : ''} · meeting ${fmtDate(a.meeting)}`, kbd: '', action: () => setView('meetings') }));
  if ((!q || !q.trim()) && recentIds().length) items.push({ icon: ic('<path d="M12 12h2v12h-2zM18 12h2v12h-2z"/><path d="M4 6v2h2v20a2 2 0 002 2h16a2 2 0 002-2V8h2V6zm4 22V8h16v20zM12 2h8v2h-8z"/>'), name: 'Clear recently opened', hint: 'Only on this browser', kbd: '', action: () => { lsSet('ngc_recent_' + WS, '[]'); toast('Cleared', 'ok'); } });
  if (!q || !q.trim()) recentIds().map(findM).filter(Boolean).slice(0, 4).forEach(m => items.push({ icon: ic('<path d="M16 30a14 14 0 1114-14 14 14 0 01-14 14zm0-26a12 12 0 1012 12A12 12 0 0016 4z"/><path d="M20.59 22L15 16.41V7h2v8.58l5 5.01z"/>'), name: m.activity, hint: 'Recently opened', kbd: '', action: () => openModal(m.id) }));
  savedViews().forEach(v => items.push({ icon: ic('<path d="M18 28H14a2 2 0 01-2-2V18.41L4.59 11A2 2 0 014 9.59V6a2 2 0 012-2H26a2 2 0 012 2V9.59a2 2 0 01-.59 1.41L20 18.41V26a2 2 0 01-2 2zM6 6V9.59l8 8V26h4V17.59l8-8V6z"/>'), name: 'View: ' + v.name, hint: 'Saved filters', kbd: '', action: () => { clearFilters(); applyViewLink(JSON.stringify(v.f)); setView(v.view || 'plan'); rerender(); } }));
  items.push({ icon: ic('<path d="M26 4h-4V2h-2v2h-8V2h-2v2H6a2 2 0 00-2 2v20a2 2 0 002 2h20a2 2 0 002-2V6a2 2 0 00-2-2zm0 22H6V12h20z"/>'), name: 'Go to Meetings', hint: 'Calendar, notes, next steps', kbd: '', action: () => setView('meetings') });
  items.push({ icon: ic('<path d="M17 15L17 8 15 8 15 15 8 15 8 17 15 17 15 24 17 24 17 17 24 17 24 15z"/>'), name: 'New milestone', hint: '', kbd: 'N', action: () => addItem() });
  items.push({ icon: ic('<path d="M16.6123,2.2138a1.01,1.01,0,0,0-1.2427,0L1,13.4194l1.2427,1.5717L4,13.6209V26a2.0041,2.0041,0,0,0,2,2H26a2.0037,2.0037,0,0,0,2-2V13.63L29.7573,15,31,13.4282ZM18,26H14V18h4Zm2,0V18a2.0023,2.0023,0,0,0-2-2H14a2.002,2.002,0,0,0-2,2v8H6V12.0615l10-7.79,10,7.8005V26Z"/>'), name: 'Add school opening', hide: !hasSchoolWork(), hint: '', kbd: '', action: () => openSchoolModal(null) });
  if (undoStack.length) items.push({ icon: ic('<path d="M20,10H7.8149l3.5874-3.5859L10,5,4,11,10,17l1.4023-1.4146L7.8179,12H20a6,6,0,0,1,0,12H12v2h8a8,8,0,0,0,0-16Z"/>'), name: 'Undo last change', hint: undoStack[undoStack.length - 1].label, kbd: '⌘Z', action: () => undo() });
  items.push({ icon: ic('<path d="M28,9H25V3H7V9H4a2,2,0,0,0-2,2V21a2,2,0,0,0,2,2H7v6H25V23h3a2,2,0,0,0,2-2V11A2,2,0,0,0,28,9ZM9,5H23V9H9ZM23,27H9V17H23Zm5-6H25V15H7v6H4V11H28Z"/>'), name: 'Print report', hint: 'Dashboard', kbd: '', action: () => { setView('progress'); setTimeout(() => window.print(), 400); } });
  items.push({ icon: ic('<path d="M16 22H30V24H16zM14 19.4L12.6 18 6 24.6 3.4 22 2 23.4 6 27.4zM16 8H30V10H16zM14 5.4L12.6 4 6 10.6 3.4 8 2 9.4 6 13.4z"/>'), name: 'Check in on my milestones', hint: 'Will each land on time?', kbd: '', action: () => openCheckins() });
  items.push({ icon: ic('<path d="M26,4h-4V2h-2v2h-8V2h-2v2H6C4.9,4,4,4.9,4,6v20c0,1.1,0.9,2,2,2h20c1.1,0,2-0.9,2-2V6C28,4.9,27.1,4,26,4z M26,26H6V12h20	V26z M26,10H6V6h4v2h2V6h8v2h2V6h4V10z"/>'), name: 'Add deadlines to Outlook', hint: 'Calendar', kbd: '', action: () => openCalendarSheet() });
  items.push({ icon: ic('<path d="M29.25 6.76a6 6 0 00-8.5 0l1.42 1.42a4 4 0 115.67 5.67l-8 8a4 4 0 11-5.67-5.66l1.41-1.42-1.41-1.42-1.42 1.42a6 6 0 000 8.5A6 6 0 0017 25a6 6 0 004.27-1.76l8-8a6 6 0 00-.02-8.48zM4.19 24.82a4 4 0 010-5.67l8-8a4 4 0 015.67 0A3.94 3.94 0 0119 14a4 4 0 01-1.17 2.85L15.71 19l1.42 1.42 2.12-2.12a6 6 0 00-8.51-8.51l-8 8a6 6 0 000 8.51A6 6 0 007 28a6.07 6.07 0 004.28-1.76l-1.42-1.42a4 4 0 01-5.67 0z"/>'), name: 'Copy link to this view', hint: 'Current page and filters', kbd: '', action: () => copyText(viewLink(), 'Link copied') });
  items.push({ icon: ic('<path d="M26 24v4H6V24H4v4H4a2 2 0 002 2H26a2 2 0 002-2h0V24zM26 14L24.59 12.59 17 20.17 17 2 15 2 15 20.17 7.41 12.59 6 14 16 24 26 14z"/>'), name: 'Export milestones to Excel', hint: 'Current filters', kbd: '', action: () => exportXlsx() });
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
  (state.data.schools || []).filter(s => hit(`${schLbl(s) || ''} ${s.display_label || ''} ${s.code || ''} ${s.market || ''} ${s.state || ''} fall ${s.openingFY - 1} ${fyLabel(s.openingFY)}`))
    .slice(0, 4).forEach(s => results.push({ icon: sIc, name: `${s.market} · ${schLbl(s)}`, hint: `School opening · ${fallLbl(s.openingFY)}`, kbd: '', action: () => openSchoolModal(s.id) }));
  [...new Set(mils.flatMap(ownersOf))].filter(o => o.toLowerCase().includes(ql)).slice(0, 5).forEach(o => {   // people first: "show me Susie's work"
    const n = mils.filter(m => ownsM(m, o) && m.status !== 'complete').length;
    const late = mils.filter(m => ownsM(m, o) && timingLevel(m) === 'overdue').length;
    results.push({ icon: oIc, name: o, hint: `${n} open milestone${n === 1 ? '' : 's'}${late ? ` · ${late} overdue` : ''}`, kbd: '', action: () => { clearFilters(); state.filters.owners = new Set([o]); setView('plan'); rerender(); } });
  });
  mils.filter(m => hit(`${m.activity} ${ownersOf(m).join(' ')} ${m.market} ${m.functional_area} ${m.workstream || ''} ${(m.tags || []).join(' ')} ${m.notes || ''}`))
    .slice(0, 8).forEach(m => results.push({ icon: mIc, name: m.activity, hint: `${SM(effectiveStatus(m)).label} · ${m.market || 'Network'} · ${m.functional_area}${m.due_date ? ' · Due ' + fmtDate(m.due_date) : ''}${ownersOf(m).length ? ' · ' + ownersOf(m).join(' / ') : ''}`, kbd: '', action: () => openModal(m.id) }));
  docSearch(ql, 6).forEach(d => results.push({ icon: ic(DOC_IC), name: d.name, hint: `${d.kind} · ${d.sub}`, kbd: '', action: d.open }));
  return [...nav, ...results].filter(x => MEETINGS_ON || !/^(Go to Meetings|Start meeting|Action: |Meeting agenda)/.test(x.name));
}
/* ---------- Document search (Nov 20 2026): milestone links, meeting slides and meeting files ----------
   Matches every word against the name, file name, description and where it lives. Opening a result:
   links open in a new tab; slides and files open in the in-tool viewer. */
const DOC_IC = '<path d="M25.7 9.3l-7-7A.9.9 0 0 0 18 2H8a2 2 0 0 0-2 2v24a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V10a.9.9 0 0 0-.3-.7zM18 4.4l5.6 5.6H18zM24 28H8V4h8v6a2 2 0 0 0 2 2h6z"/><path d="M10 22h12v2H10zm0-6h12v2H10z"/>';
function docIndex() {
  const out = [];
  M().filter(m => !m._draft).forEach(m => (m.links || []).forEach(l => { const u = safeUrl(l.url); if (!u) return; const name = l.label || hostOf(u) || u; out.push({ kind: 'Link', name, sub: `Milestone: ${clip(m.activity, 60)}`, hay: `${name} ${hostOf(u)} ${m.activity} ${m.market || ''} ${m.functional_area || ''}`, open: () => { const a = document.createElement('a'); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click(); } }); }));
  if (MEETINGS_ON) (mbook().meetings || []).forEach(mt => {
    const where = `Meeting: ${mt.title}, ${fmtDate(mt.date)}`;
    if (mt.deck) out.push({ kind: 'Slides', name: mt.deck.name, sub: where, hay: `${mt.deck.name} slides deck ${where}`, open: () => openDeck(mt.id, false) });
    (mt.files || []).forEach(f => out.push({ kind: (f.ext || 'file').toUpperCase(), name: f.name, sub: where, hay: `${f.name} ${f.fname || ''} ${f.desc || ''} ${f.ext || ''} ${where}`, open: () => openDeck(mt.id, false, f) }));
  });
  return out;
}
function docSearch(q, n) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean); if (!words.length || q.trim().length < 2) return [];
  return docIndex().filter(d => { const h = d.hay.toLowerCase(); return words.every(w => h.includes(w)); }).sort((a, b) => (b.name.toLowerCase().includes(words[0]) - a.name.toLowerCase().includes(words[0]))).slice(0, n || 6);
}
// Header search typeahead (Nov 20 2026): grouped results you can open directly.
function cbResults(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean), hit = t => { t = String(t || '').toLowerCase(); return words.every(w => t.includes(w)); }, out = [];
  if (!words.length || q.trim().length < 2) return out;
  const ms = M().filter(m => !m._draft && hit(`${m.activity} ${ownersOf(m).join(' ')} ${m.market || ''} ${m.functional_area || ''} ${m.workstream || ''} ${(m.tags || []).join(' ')}`));
  ms.sort((a, b) => (b.activity.toLowerCase().includes(words.join(' ')) - a.activity.toLowerCase().includes(words.join(' '))) || (a.status === 'complete') - (b.status === 'complete') || (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  if (ms.length) out.push({ h: 'Milestones', n: ms.length, rows: ms.slice(0, 5).map(m => ({ icon: statusDot(effectiveStatus(m)), name: m.activity, kind: SM(effectiveStatus(m)).label, sub: [m.market || 'Network', m.functional_area, m.due_date ? 'Due ' + fmtDate(m.due_date) : ''].filter(Boolean).join(' · '), open: () => openModal(m.id) })) });
  if (hasSchoolWork()) { const sc = (state.data.schools || []).filter(x => hit(`${schLbl(x) || ''} ${x.display_label || ''} ${x.code || ''} ${x.market || ''} fall ${x.openingFY - 1}`)).slice(0, 3); if (sc.length) out.push({ h: 'School openings', rows: sc.map(x => ({ icon: `<i class="cb-mk" style="background:${mkColor(x.market)}"></i>`, name: `${x.market} · ${schLbl(x)}`, kind: 'Opening', sub: fallLbl(x.openingFY), open: () => openSchoolModal(x.id) })) }); }
  const ppl = [...new Set(M().flatMap(ownersOf))].filter(o => hit(o)).slice(0, 3);
  if (ppl.length) out.push({ h: 'People', rows: ppl.map(o => { const n = M().filter(m => ownsM(m, o) && m.status !== 'complete').length; return { icon: personChip(o), name: o, kind: 'Person', sub: `${n} open milestone${n === 1 ? '' : 's'}`, open: () => { clearFilters(); state.filters.owners = new Set([o]); setView('plan'); rerender(); } }; }) });
  const docs = docSearch(q, 5); if (docs.length) out.push({ h: 'Documents', rows: docs.map(d => ({ icon: `<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor">${DOC_IC}</svg>`, name: d.name, kind: d.kind, sub: d.sub, open: d.open })) });
  return out;
}
function cbDocsPaint() {
  const inp = $('#cbSearch'); if (!inp) return; let box = $('#cbDocs');
  const q = inp.value.trim(), focused = document.activeElement === inp || (box && box.contains(document.activeElement));
  const groups = focused ? cbResults(q) : [];
  if (!focused || q.length < 2) { if (box) box.hidden = true; return; }
  if (!box) { box = document.createElement('div'); box.id = 'cbDocs'; box.className = 'cb-docs'; box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'Search results'); inp.closest('.cb-search').appendChild(box); }
  const flat = []; groups.forEach(g => g.rows.forEach(r => flat.push(r))); state.cbDocs = flat; let k = 0;
  const msN = (groups.find(g => g.h === 'Milestones') || {}).n || 0;
  box.innerHTML = (groups.length ? groups.map(g => `<div class="cb-docs-h">${g.h}${g.n > g.rows.length ? ` <span>${g.n}</span>` : ''}</div>${g.rows.map(r => `<button type="button" class="cb-doc" data-cbdoc="${k++}"><span class="cb-doc-ic" aria-hidden="true">${r.icon}</span><span class="cb-doc-m"><span class="cb-doc-n">${hiMatch(r.name, q)}</span><span class="cb-doc-s"><span class="cb-doc-k">${esc(r.kind)}</span>${esc(r.sub)}</span></span></button>`).join('')}`).join('') : `<div class="cb-docs-h">No matches for "${esc(q)}"</div>`)
    + (msN ? `<button type="button" class="cb-docs-f" data-cball>See all ${msN} matching milestone${msN === 1 ? '' : 's'}</button>` : '');
  box.hidden = false;
}
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-cball]'); if (!b) return; const v = $('#cbSearch').value; const box = $('#cbDocs'); if (box) box.hidden = true; state.filters.search = v; setView('plan'); rerender(); if (typeof updateFilterBubble === 'function') updateFilterBubble(); });
document.addEventListener('input', e => { if (e.target.id === 'cbSearch') cbDocsPaint(); });
document.addEventListener('focusin', e => { if (e.target.id === 'cbSearch') cbDocsPaint(); });
document.addEventListener('focusout', () => setTimeout(() => { const b = $('#cbDocs'); if (b && !b.contains(document.activeElement) && document.activeElement !== $('#cbSearch')) b.hidden = true; }, 150));
document.addEventListener('mousedown', e => { if (e.target.closest && e.target.closest('#cbDocs')) e.preventDefault(); });
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-cbdoc]'); if (!b) return; const d = (state.cbDocs || [])[+b.dataset.cbdoc]; const box = $('#cbDocs'); if (box) box.hidden = true; if (d) { d.open(); const i = $('#cbSearch'); if (i) i.blur(); } });
document.addEventListener('keydown', e => {
  const box = $('#cbDocs'); if (!box || box.hidden) return; const items = [...box.querySelectorAll('.cb-doc, [data-cball]')]; const i = items.indexOf(document.activeElement);
  if (e.target.id === 'cbSearch' && e.key === 'ArrowDown' && items.length) { e.preventDefault(); items[0].focus(); }
  else if (i >= 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); const j = i + (e.key === 'ArrowDown' ? 1 : -1); if (j < 0) $('#cbSearch').focus(); else if (items[j]) items[j].focus(); }
  else if (e.key === 'Escape' && (i >= 0 || e.target.id === 'cbSearch')) { box.hidden = true; if (i >= 0) $('#cbSearch').focus(); }
});
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
    if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 's') && $('#modalBackdrop.open') && !$('#confirmBackdrop')) { const sv = $('#modalSave'); e.preventDefault(); if (sv && getComputedStyle(sv).display !== 'none') sv.click(); return; }
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
function syncCheckpointProgress() {   // with checkpoints, progress is calculated, so the field shows the result and locks
  const list = $$('#cpList input[type=checkbox]'), p = $('#mProg'); if (!p) return;
  const tv = liveTarget(); if (tv && tv.total) { p.value = tgProgress(tv); p.disabled = true; return; }
  if (list.length) { p.value = Math.round(100 * list.filter(c => c.checked).length / list.length); p.disabled = true; }
  else if (canEdit()) p.disabled = false;
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
      const first = (matchMedia('(pointer: coarse)').matches || d.id === 'drawer') ? null : (items(d).find(e => e.matches('input, select, textarea')) || items(d).find(e => !e.closest('.modal-head') && !e.matches('[data-sheet-close].icon-btn, .icon-btn[aria-label="Close"]')) || items(d)[0]);
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
    root.querySelectorAll('[aria-haspopup]:not([aria-expanded])').forEach(b => b.setAttribute('aria-expanded', 'false'));
    root.querySelectorAll('table:not([aria-label]):not([aria-labelledby])').forEach(t => { const h = t.closest('section, .ex-card'); const hh = h && h.querySelector('h2, h3'); if (hh) t.setAttribute('aria-label', hh.textContent.trim()); });   // tables take their card's title as a name
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
  document.addEventListener('change', e => { if (e.target.closest('#cpList')) syncCheckpointProgress(); });
  new MutationObserver(() => syncCheckpointProgress()).observe($('#modalBody'), { childList: true, subtree: false });
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
        if (state.view !== 'plan') return;   // elsewhere the dropdown shows results; Enter or "See all" opens Milestones (Nov 20 2026)
        state.filters.search = v;
        // Dashboard's applied-chip row and filter-bubble both depend on search state.
        state.view === 'progress' ? rerender() : refreshBody();
        if (typeof updateFilterBubble === 'function') updateFilterBubble();
      }, 180);   // debounce: 156 milestones × complex render = noticeable per-keystroke lag
    });
    // Enter fires immediately (no wait); Escape clears
    cbSearch.addEventListener('keydown', e => {
      if (e.key === 'Enter') { clearTimeout(searchTimer); const bx = $('#cbDocs'); if (bx) bx.hidden = true; state.filters.search = e.target.value; if (e.target.value && state.view !== 'plan') { setView('plan'); updateFilterBubble && updateFilterBubble(); return; } state.view === 'progress' ? rerender() : refreshBody(); updateFilterBubble && updateFilterBubble(); }
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
// Minimum load time (Nov 19 2026): loading screens show for at least 2 seconds. Set LOAD_MIN_MS = 0 to turn off.
const LOAD_MIN_MS = 2000;
function bootApp() { setTimeout(bootAppNow, Math.max(0, LOAD_MIN_MS - performance.now())); }
function bootAppNow() {
  // Personalize for whoever is signed in (drops any prior account's "Mine" scope first)
  if (!state.viewLinkApplied) { state.filters.owners.clear(); applyMyDefaults(); }
  restorePlanGroup(); state.hideDone = lsGet('ngc_hide_done_' + WS) === '1';   // a shared view link keeps its filters
  // Clear any loading skeleton painted by index.html or a prior boot attempt.
  const sk = document.getElementById('bootSkeleton'); if (sk) { sk.classList.add('is-leaving'); setTimeout(() => sk.remove(), 180); }   // fade the loading shimmer out
  addAppFooter();
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
const CI_LABEL = { yes: 'On time', probably: 'Maybe late', unlikely: 'Late' };
const CHECKIN_DAYS = 14, STALE_DAYS = 21, HORIZON_DAYS = 180;
const FLAG_LABEL = { nodue: 'No due date', stale: 'Check-in due', watermelon: 'Needs attention', slipped: 'Deadline moved (30 days)', newly_off: 'Newly off track', completed_recent: 'Completed since last meeting' };

function lastCheckin(m) { const c = m.checkins; return Array.isArray(c) && c.length ? c[c.length - 1] : null; }
function daysSince(t) { return t ? Math.floor((Date.now() - new Date(t).getTime()) / 86400000) : null; }
function missedCheckpoints(m) { const t = todayISO(); if (measureOf(m) !== 'steps') return []; return (m.checkpoints || []).filter(c => !c.done && c.due && c.due < t); }
function cpProgress(m) { if (measureOf(m) !== 'steps') return null; const c = m.checkpoints || []; return c.length ? Math.round(100 * c.filter(x => x.done).length / c.length) : null; }
function curProgress(m) { const tg = activeTarget(m); if (tg) return tgProgress(tg); const p = cpProgress(m); return p == null ? (m.status === 'complete' ? 100 : 0) : p; }

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
  if (!m.due_date) r.push('No due date');
  if (!ownersOf(m).length) r.push('No owner');
  return r;
}
function flagPass(m, f) {
  if (f === 'stale') return needsCheckin(m);
  if (f === 'watermelon') return watermelonReasons(m).length > 0;
  if (f === 'nodue') return m.status !== 'complete' && !m.due_date;
  if (f === 'slipped') return (m.dateHistory || []).some(h => daysSince(h.t) <= 30);
  if (f === 'newly_off') return newlyOffTrack(m);
  if (f === 'completed_recent') return m.status === 'complete' && !!m.completedAt && new Date(m.completedAt).getTime() > new Date(lastMeetingISO() + 'T23:59:59').getTime();
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
    <div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('check')}<h3>Forecast check</h3></div><div class="fc-actions"><button class="btn btn-ghost btn-sm" data-open-checkins>Check-ins</button><button class="btn btn-ghost btn-sm" data-open-agenda>Open meetings</button></div></div>
    <div class="fc-tiles">${tile(wm, 'Needs attention', 'watermelon', 'Marked on track, but pace, check-ins, or deadline moves disagree')}${tile(sl, 'Deadlines moved', 'slipped', 'Due dates changed in the last 30 days')}</div>
    <div class="fc-sub"><h4>Forecast accuracy by team</h4>${cal}</div>
  </section>`;
}

/* ---------- Milestone editor: check-in, checkpoints, deadline reason ---------- */
// Forecast question (Nov 19 2026): a milestone past its due date can't be "on time", so it asks done or new date instead.
const ciPast = m => !!m.due_date && m.status !== 'complete' && m.due_date < todayISO();
const ciOpts = m => ciPast(m) ? [['done', "It's done"], ['unlikely', 'Still in progress']] : [['yes', 'Yes, on time'], ['unlikely', 'No, it will be late']];
const ciQuestion = (m, id) => ciPast(m) ? `<div class="ci-q" id="${id}">It was due ${esc(fmtDate(m.due_date))}, ${-daysUntil(m.due_date)} day${daysUntil(m.due_date) === -1 ? '' : 's'} ago. Where does it stand?</div>` : `<div class="ci-q" id="${id}">Will it be done by ${esc(fmtDate(m.due_date))}?</div>`;
function checkinBlock(m) {
  if (m.status === 'complete') return '';
  const lc = lastCheckin(m), hist = (m.checkins || []).slice().reverse(), wm = watermelonReasons(m);
  if (!m.due_date) return `<div class="ci-block" id="ciBlock"><div class="ci-q" id="ciQ">Add a due date to forecast</div></div>`;
  return `<div class="ci-block" id="ciBlock" role="group" aria-labelledby="ciQ">
    ${ciQuestion(m, 'ciQ')}
    <div class="ci-seg" role="radiogroup" aria-labelledby="ciQ">${ciOpts(m).map(([a, l]) => `<button type="button" class="ci-opt ci-${a}" data-ci="${a}" role="radio" aria-checked="false">${l}</button>`).join('')}</div>
    <div class="ci-more" id="ciMore" hidden>
      <div class="field" id="ciFcWrap"><label for="ciForecast">New expected date <span class="req">*</span></label><input type="date" id="ciForecast" min="${todayISO()}" value="${esc(lc && lc.forecast && lc.forecast >= todayISO() ? lc.forecast : '')}"></div>
      <div class="field"><label for="ciNote" id="ciNoteLbl">Note</label><input id="ciNote"></div>
    </div>
    ${lc ? `<div class="ci-last">Last check-in ${esc(fmtWhen(lc.t))}${lc.by ? ' by ' + esc(lc.by) : ''}: <b>${esc(CI_LABEL[lc.answer] || lc.answer)}</b>${lc.forecast ? ` · expects ${esc(fmtDate(lc.forecast))}` : ''}${lc.note ? ` · "${esc(lc.note)}"` : ''}</div>` : ''}
    ${hist.length > 1 ? `<details class="ci-hist"><summary>History (${hist.length})</summary>${hist.map(c => `<div class="ci-h">${esc(fmtWhen(c.t))} · <b>${esc(CI_LABEL[c.answer] || c.answer)}</b>${c.forecast ? ' · expects ' + esc(fmtDate(c.forecast)) : ''}${c.by ? ' · ' + esc(c.by) : ''}${c.note ? ' · ' + esc(c.note) : ''}</div>`).join('')}</details>` : ''}
    ${wm.length ? `<div class="ci-flag"><b>Needs attention</b><br>Marked on track, but ${wm.map(x => esc(x.charAt(0).toLowerCase() + x.slice(1))).join('; ')}</div>` : ''}
  </div>`;
}
function cpRow(c) {
  return `<div class="cp-row" data-cpid="${esc(c.id || uid())}"><input type="checkbox" class="cp-done" ${c.done ? 'checked' : ''} aria-label="Done"><input class="cp-title" value="${esc(c.title || '')}" placeholder="Step"><input type="date" class="cp-due" value="${esc(c.due || '')}" aria-label="Checkpoint date"><button type="button" class="cp-del" aria-label="Remove checkpoint">${CI('close')}</button></div>`;
}
function checkpointsBlock(m) {
  const cps = m.checkpoints || [];
  return `<div class="m-sec-h">Tasks</div><div class="field">
      <div id="cpNote" hidden></div>
      <div class="cp-list" id="cpList">${cps.map(cpRow).join('')}</div>
      <div class="cp-actions"><button type="button" class="btn btn-tonal btn-sm" id="cpAdd">+ Add task</button></div></div>
`;
}
/* ---------- Targets (Nov 18 2026): a counted goal with a dated pace ladder, only for milestones tied to a new school.
   m.target = { label, total, done, ladder: [{ id, due, goal }] }. Progress = done / total; below a passed checkpoint = At risk. ---------- */
function measureOf(m) { const v = (m && m.measure) || (m && m.target && (m.schoolIds || []).length && +m.target.total > 0 ? 'count' : (m && (m.checkpoints || []).length) ? 'steps' : 'binary'); return v === 'percent' ? 'binary' : v; }
function activeTarget(m) { const t = m && m.target; return t && measureOf(m) === 'count' && (m.schoolIds || []).length && +t.total > 0 ? t : null; }
function tgProgress(t) { return Math.max(0, Math.min(100, Math.round(100 * (+t.done || 0) / (+t.total || 1)))); }
function targetPace(m) {
  const t = activeTarget(m); if (!t) return {};
  const d = todayISO(), lad = (t.ladder || []).filter(r => r.due && +r.goal > 0).sort((a, b) => a.due.localeCompare(b.due));
  const passed = lad.filter(r => r.due <= d).pop() || null, next = lad.find(r => r.due > d) || null;
  const done = +t.done || 0, behind = !!passed && done < +passed.goal;
  return { t, passed, next, behind, far: behind && done < 0.75 * +passed.goal };
}
function targetSummary(t, pace) {
  const done = +t.done || 0, total = +t.total || 0; if (!total) return 'Set a goal to track progress';
  let s = `${done} of ${total} (${tgProgress(t)}%)`;
  if (pace.behind) s += ` · Behind: ${pace.passed.goal} were due by ${fmtDate(pace.passed.due)}`;
  else if (pace.next) s += ` · Next: ${pace.next.goal} by ${fmtDate(pace.next.due)}${+pace.next.goal > done ? `, ${pace.next.goal - done} to go` : ''}`;
  return s;
}
function tgRow(r) {
  return `<div class="tg-row" data-tgid="${esc(r.id || uid())}"><input type="date" class="tg-due" value="${esc(r.due || '')}" aria-label="Checkpoint date"><input type="number" class="tg-goal" min="0" step="1" value="${r.goal == null ? '' : esc(r.goal)}" placeholder="Count" aria-label="Count needed by this date"><button type="button" class="cp-del" aria-label="Remove checkpoint">${CI('close')}</button></div>`;
}
function targetBlock(m) {
  const t = m.target, on = !!t;
  return `<div class="tg-wrap" id="tgWrap" ${(m.schoolIds || []).length ? '' : 'hidden'}><div class="m-sec-h">Target</div>
    <div id="tgOff" ${on ? 'hidden' : ''}><button type="button" class="btn btn-tonal btn-sm" id="tgStart">+ Track a number</button></div>
    <div id="tgOn" ${on ? '' : 'hidden'}>
      <div class="tg-head"><div class="field"><label for="tgLabel">Counting</label><input id="tgLabel" maxlength="40" value="${esc((t && t.label) || 'Seats hired')}"></div>
        <div class="field"><label for="tgDone">So far</label><input id="tgDone" type="number" min="0" step="1" value="${esc((t && t.done) || 0)}"></div>
        <div class="field"><label for="tgTotal">Goal</label><input id="tgTotal" type="number" min="1" step="1" value="${esc((t && t.total) || '')}"></div></div>
      <div id="tgSchoolDone" ${t && t.bySchool ? '' : 'hidden'}>${tgSchoolRows(m, 'done')}</div>
      ${targetHistory(t)}
      ${(m.schoolIds || []).length > 1 ? `<div class="tg-split"><label class="field-check"><input type="checkbox" id="tgSplitOn" ${t && t.bySchool ? 'checked' : ''}> Set a goal for each school</label><div id="tgSchoolGoals" ${t && t.bySchool ? '' : 'hidden'}>${tgSchoolRows(m, 'goal')}</div></div>` : ''}
      <div class="tg-sub">Pace checkpoints</div>
      <div class="tg-cols" aria-hidden="true"><span>Date</span><span>Count needed by then</span></div>
      <div class="tg-list" id="tgList">${((t && t.ladder) || []).map(tgRow).join('')}</div>
      <div class="cp-actions"><button type="button" class="btn btn-tonal btn-sm" id="tgAdd">+ Add date</button><button type="button" class="btn btn-ghost btn-sm" id="tgSpread">Spread evenly to the due date</button><button type="button" class="btn btn-ghost btn-sm" id="tgCopy">Copy to other counts</button><button type="button" class="btn btn-ghost btn-sm tg-stop" id="tgOffBtn">Stop tracking</button></div>
    </div></div>`;
}
function liveTarget() {   // the target as typed in the open dialog, or null when off or hidden
  const w = $('#tgWrap'); if (!w || w.hidden || $('#tgOn').hidden) return null;
  const split = $('#tgSplitOn') && $('#tgSplitOn').checked;
  if (split) {
    const by = {}; $$('#tgSchoolGoals [data-sid]').forEach(r => { const sid = r.dataset.sid, d = $(`#tgSchoolDone [data-sid="${sid}"] input`); by[sid] = { total: Math.max(0, Math.round(+r.querySelector('input').value || 0)), done: Math.max(0, Math.round(+(d && d.value) || 0)) }; });
    const sum = k => Object.values(by).reduce((a, x) => a + x[k], 0);
    $('#tgTotal').value = sum('total'); $('#tgDone').value = sum('done');
  }
  const base = { label: $('#tgLabel').value.trim() || 'Count', total: Math.max(0, Math.round(+$('#tgTotal').value || 0)), done: Math.max(0, Math.round(+$('#tgDone').value || 0)),
    ladder: $$('#tgList .tg-row').map(r => ({ id: r.dataset.tgid, due: r.querySelector('.tg-due').value || null, goal: r.querySelector('.tg-goal').value === '' ? null : Math.max(0, Math.round(+r.querySelector('.tg-goal').value)) })).filter(r => r.due || r.goal != null) };
  if (split) { base.bySchool = {}; $$('#tgSchoolGoals [data-sid]').forEach(r => { const sid = r.dataset.sid, d = $(`#tgSchoolDone [data-sid="${sid}"] input`); base.bySchool[sid] = { total: Math.max(0, Math.round(+r.querySelector('input').value || 0)), done: Math.max(0, Math.round(+(d && d.value) || 0)) }; }); }
  return base;
}
function paintTarget() {
  syncCheckpointProgress(); paintDialogProgress();
}
function syncTargetVisibility() {
  const w = $('#tgWrap'); if (!w) return;
  w.hidden = !$$('#mSchools .m-school').some(x => x.checked); paintTarget();
}
function wireTarget() {
  const w = $('#tgWrap'); if (!w) return;
  const on = v => { $('#tgOn').hidden = !v; $('#tgOff').hidden = v; modalDirty = true; paintTarget(); };
  $('#tgStart').addEventListener('click', () => { on(true); if (!$('#tgList').children.length) $('#tgList').insertAdjacentHTML('beforeend', tgRow({})); $('#tgTotal').focus(); });
  $('#tgOffBtn').addEventListener('click', () => confirmDialog({ title: 'Stop tracking this number?', message: 'The goal, the count, the pace checkpoints and the update history are removed when you save. Cancel the milestone dialog to keep them', confirmLabel: 'Stop tracking', onConfirm: () => on(false) }));
  $('#tgCopy').addEventListener('click', () => copyLadder());
  $('#tgSpread').addEventListener('click', () => {
    const total = Math.round(+$('#tgTotal').value || 0), due = ($('#mDue') || {}).value;
    if (!total) { markInvalid($('#tgTotal'), 'Add the goal first'); return; }
    if (!due || due <= todayISO()) { toast(due ? 'The due date has passed. Add checkpoints by hand' : 'Set a due date first', 'err'); return; }
    const rows = spreadLadder(total, due), go = () => { $('#tgList').innerHTML = rows.map(tgRow).join(''); modalDirty = true; paintTarget(); toast(`Added ${rows.length} checkpoints. Edit any of them`, 'ok'); };
    if ($$('#tgList .tg-row').some(r => r.querySelector('.tg-due').value || r.querySelector('.tg-goal').value)) confirmDialog({ title: 'Replace the checkpoints?', message: `This replaces them with ${rows.length} evenly spaced checkpoints ending ${esc(fmtDate(due))}`, confirmLabel: 'Replace', onConfirm: go });
    else go();
  });
  $('#tgAdd').addEventListener('click', () => { $('#tgList').insertAdjacentHTML('beforeend', tgRow({})); $('#tgList').lastElementChild.querySelector('.tg-due').focus(); modalDirty = true; });
  $('#tgList').addEventListener('click', e => { const d = e.target.closest('.cp-del'); if (d) { d.closest('.tg-row').outerHTML = ''; modalDirty = true; paintTarget(); } });
  w.addEventListener('input', () => { modalDirty = true; paintTarget(); });
  paintTarget();
}
function readTarget() {
  const t = liveTarget(); if (!t) return null;
  if (!t.total) { markInvalid($('#tgTotal'), 'Add a goal, or choose Stop tracking'); return false; }
  const bad = t.ladder.find(r => !r.due || r.goal == null);
  if (bad) { const row = $(`#tgList [data-tgid="${bad.id}"]`); markInvalid(row.querySelector(bad.due ? '.tg-goal' : '.tg-due'), 'Add both a date and a count'); return false; }
  const over = t.ladder.find(r => r.goal > t.total);
  if (over) { markInvalid($(`#tgList [data-tgid="${over.id}"] .tg-goal`), `Can't be more than the goal (${t.total})`); return false; }
  t.ladder.sort((a, b) => a.due.localeCompare(b.due)); return t;
}
let ciAnswer = null;
function wireForecastUI(m) {
  ciAnswer = null;
  const seg = $$('#ciBlock .ci-opt');
  seg.forEach(b => b.addEventListener('click', () => {
    ciAnswer = b.dataset.ci;
    seg.forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    const sel = $('#mStatus');
    if (ciAnswer === 'done') { $('#ciMore').hidden = true; if (sel) { sel.value = 'complete'; sel.dispatchEvent(new Event('change', { bubbles: true })); } modalDirty = true; return; }
    $('#ciMore').hidden = false; $('#ciFcWrap').hidden = ciAnswer === 'yes';
    $('#ciNoteLbl').textContent = ciAnswer === 'yes' ? 'Note' : 'Reason for the delay';
    if (sel && sel.value !== 'blocked') sel.value = CI_MAP[ciAnswer];
    modalDirty = true;
  }));
  const due = $('#mDue'), orig = m.due_date || '';
  if (due) due.addEventListener('change', () => { $('#mDueWhyWrap').hidden = !!m._draft || !(orig && due.value && due.value !== orig); });
  const list = $('#cpList');
  list.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('cp-title') && e.target.value.trim()) { e.preventDefault(); e.stopPropagation(); $('#cpAdd').click(); } });
  $('#cpAdd').addEventListener('click', () => { list.insertAdjacentHTML('beforeend', cpRow({})); list.lastElementChild.querySelector('.cp-title').focus(); modalDirty = true; });
  const sg = $('#cpSuggest');
  if (sg) sg.addEventListener('click', () => {
    const dueV = ($('#mDue') || {}).value; if (!dueV) { toast('Set a due date first', 'err'); return; }
    const t0 = today().getTime(), t1 = parseDate(dueV).getTime(); if (t1 <= t0) { toast('The due date has passed. Add checkpoints by hand', 'err'); return; }
    const at = f => { const d = new Date(t0 + (t1 - t0) * f); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    [['Plan, owners, and inputs confirmed', 0.25], ['Draft or first version done', 0.6], ['Final review complete', 0.9]].forEach(([title, f]) => list.insertAdjacentHTML('beforeend', cpRow({ title, due: at(f) })));
    sg.remove(); modalDirty = true;
  });
  list.addEventListener('click', e => { const d = e.target.closest('.cp-del'); if (d) { d.closest('.cp-row').remove(); modalDirty = true; } });
}
function readForecastUI(m) {
  const answer = ciAnswer === 'done' ? null : ciAnswer, fc = ($('#ciForecast') || {}).value || '', note = ($('#ciNote') || {}).value || '';
  if (answer && answer !== 'yes' && !fc) { markInvalid($('#ciForecast'), 'Add the expected finish date'); return false; }
  if (answer && answer !== 'yes' && fc < todayISO()) { markInvalid($('#ciForecast'), 'Pick today or a later date'); return false; }
  const newDue = ($('#mDue') || {}).value || null, oldDue = m.due_date || null, why = (($('#mDueWhy') || {}).value || '').trim();
  const moved = !m._draft && !!oldDue && !!newDue && newDue !== oldDue;
  if (moved && !why) { $('#mDueWhyWrap').hidden = false; markInvalid($('#mDueWhy'), 'Add a reason for moving the deadline'); return false; }
  const req = moved && !isAdmin() ? dueReq(oldDue, newDue, why) : null;
  const cps = $$('#cpList .cp-row').map(r => ({ id: r.dataset.cpid, title: r.querySelector('.cp-title').value.trim(), due: r.querySelector('.cp-due').value || null, done: r.querySelector('.cp-done').checked })).filter(c => c.title);
  const dueNow = ($('#mDue') || {}).value, lateCp = dueNow && cps.find(c => c.due && c.due > dueNow && !c.done);
  if (lateCp) toast(`"${clip(lateCp.title, 40)}" is dated after the milestone's due date`, 'warn');
  return { answer, fc, note, moved: moved && !req, oldDue, newDue, why, cps, req };
}
function applyForecastUI(m, fx, prevStatus) {
  if (fx.moved) logDateMove(m, fx.oldDue, fx.newDue, fx.why);
  const prev = m.checkpoints || [];
  m.checkpoints = fx.cps.map(c => { const p = prev.find(x => x.id === c.id); return { ...c, doneAt: c.done ? ((p && p.doneAt) || new Date().toISOString()) : null }; });
  if (measureOf(m) === 'steps' && m.checkpoints.length && m.status !== 'complete') m.progress_percent = cpProgress(m);
  if (fx.answer) recordCheckin(m, fx.answer, fx.fc, fx.note);
  else if (m.status !== prevStatus && CI_REV[m.status]) recordCheckin(m, CI_REV[m.status], null, '');   // a status change counts as a check-in
}

/* ---------- Sheets: My check-ins, Meeting agenda ---------- */
function closeSheet() { const w = $('#sheetBackdrop'); if (w) { moGhost(w, 'fade'); w.remove(); } document.body.classList.remove('print-agenda'); }
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
      <div class="ck-main"><div class="ck-t ck-t2"><button type="button" class="ag-link" data-expand="${esc(m.id)}" title="Open">${esc(m.activity)}</button></div><div class="ck-m">${schoolChips(m)}${dueChip(m)}<span class="ck-who">${me ? '' : esc(ownersOf(m).join(' / ') || 'Unassigned') + ' · '}${lc ? 'Last: ' + esc(CI_LABEL[lc.answer] || lc.answer) + ', ' + esc(fmtWhen(lc.t)) : 'No check-in yet'}</span></div></div>
      <div class="ci-seg">${(ciPast(m) ? [['done', 'Done'], ['unlikely', 'New date']] : [['yes', 'On time'], ['unlikely', 'Late']]).map(([a, l]) => `<button type="button" class="ci-opt ci-${a}" data-ck="${a}" aria-pressed="false">${l}</button>`).join('')}</div>
      <div class="ck-more" hidden><input type="date" class="ck-fc" min="${todayISO()}" aria-label="New expected date" title="New expected date"><input class="ck-note" placeholder="Reason for the delay" aria-label="Reason for the delay"></div></div>`; }).join('');
  const lede = `<p class="modal-lede">${list.length > 2 ? ' <button type="button" class="btn btn-ghost btn-sm" data-ck-allyes>Mark all on time</button>' : ''}</p>`;
  const calHtml = cal && cal.n ? `<p class="ck-cal">Your forecast accuracy: ${cal.k} of ${cal.n} on time</p>` : '';
  const w = openSheet(me ? 'Your check-ins' : 'Check-ins needed', lede + calHtml + (rows || '<p class="muted">No check-ins due</p>'),
    `<button class="btn btn-text" data-sheet-close>Cancel</button><button class="btn btn-filled" id="ckSave" disabled>Save check-ins</button>`);
  w.addEventListener('click', e => {   // closing with answers picked asks first
    const leaving = e.target === w || e.target.closest('[data-sheet-close]');
    const n = $$('#sheetBackdrop .ck-row').filter(r => r.dataset.answer).length;
    if (leaving && n && !w.dataset.ok) { e.stopImmediatePropagation(); e.preventDefault(); confirmDialog({ title: `Discard ${n} check-in${n === 1 ? '' : 's'}?`, message: 'Your answers have not been saved', confirmLabel: 'Discard', danger: true, onConfirm: () => { w.dataset.ok = '1'; closeSheet(); } }); }
  }, true);
  w.addEventListener('click', e => {
    if (e.target.closest('[data-ck-allyes]')) { w.querySelectorAll('.ck-row').forEach(r => { const y = r.querySelector('[data-ck="yes"]'); if (y && !r.dataset.answer) y.click(); }); return; }
    const b = e.target.closest('[data-ck]'); if (!b) return;
    const row = b.closest('.ck-row'); row.querySelectorAll('[data-ck]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
    row.dataset.answer = b.dataset.ck; row.querySelector('.ck-more').hidden = b.dataset.ck === 'done'; row.querySelector('.ck-fc').hidden = b.dataset.ck === 'yes';
    const n = $$('#sheetBackdrop .ck-row').filter(r => r.dataset.answer).length; $('#ckSave').textContent = `Save ${n} check-in${n === 1 ? '' : 's'}`; $('#ckSave').disabled = !n;
  });
  $('#ckSave').addEventListener('click', () => {
    const picked = $$('#sheetBackdrop .ck-row').filter(r => r.dataset.answer);
    const bad = picked.find(r => r.dataset.answer === 'unlikely' && !(r.querySelector('.ck-fc').value >= todayISO()));
    if (bad) { markInvalid(bad.querySelector('.ck-fc'), bad.querySelector('.ck-fc').value ? 'Pick today or a later date' : 'Add the expected finish date'); return; }
    if (!picked.length) return closeSheet();
    snapshotForUndo(`Check-ins (${picked.length})`);
    picked.forEach(r => {
      const m = findM(r.dataset.ckid); if (!m) return; const a = r.dataset.answer;
      if (a === 'done') { if (blockIfTeamsOpen(m)) return; m.status = 'complete'; m.progress_percent = 100; m.stage = 'complete'; touch(m); return; }
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
  return Object.entries(by).map(([o, ms]) => `${o}: please check in on ${ms.length} milestone${ms.length === 1 ? '' : 's'} in Causeway before our next meeting:\n` + ms.map(m => `  - ${m.activity} (due ${fmtDate(m.due_date)})`).join('\n')).join('\n\n') + `\n\n${location.origin}${location.pathname}#plan`;
}
function copyText(txt, msg) {
  const done = () => toast(msg || 'Copied', 'ok');
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt).then(done, () => fallback());
  fallback();
  function fallback() { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast("Couldn't copy", 'err'); } ta.remove(); }
}
function openAgenda() { return setView('meetings'); }
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

function committeeCard() {   // admins only: are owners up to date before the next meeting?
  const s = committeeSignals(), nx = mmNext()[0];
  const when = '';   // Nov 19 2026: the meeting (or a prompt to schedule one) lives in the status line
  const due = nx ? `<span class="cm-due">before ${relDays(nx.date) === 'tomorrow' || relDays(nx.date) === 'today' ? relDays(nx.date) + "'s" : 'the'} meeting${relDays(nx.date) === 'tomorrow' || relDays(nx.date) === 'today' ? '' : ', ' + esc(relDays(nx.date))}</span>` : `<span class="cm-due">No meeting scheduled. <button type="button" class="btn btn-text btn-sm cm-sched" data-goview="meetings">Schedule one</button></span>`;
  const head = { start: 'No one has checked in yet', ok: 'Owners are up to date', touch: `${s.teams.length} team${s.teams.length === 1 ? ' needs' : 's need'} a nudge`, early: 'Consider meeting sooner' }[s.level];
  const rows = s.teams.map(t => `<div class="cm-row"><div class="cm-main"><div class="cm-team">${esc(t.team)}</div><div class="cm-why">${esc(t.reasons.join(' · '))}${t.people.length ? ' · ' + esc(t.people.slice(0, 3).join(', ') + (t.people.length > 3 ? ` and ${t.people.length - 3} more` : '')) : ''}</div></div><span class="cm-row-acts"><button class="btn btn-ghost btn-sm" data-email-team="${esc(t.team)}">Email</button><button class="btn btn-ghost btn-sm" data-copy-team="${esc(t.team)}">Copy note</button></span></div>`).join('');
  return `<section class="ex-card cm-card cm-${s.level}">
    <div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('people')}<h3>Check-in status</h3><span class="cm-admin-tag">Admins only</span></div><div class="cm-when">${when}</div></div>
    <div class="cm-status"><span class="cm-dot"></span><b>${head}</b>${due}</div>
    ${s.early.length ? `<ul class="cm-early">${s.early.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${s.level !== 'start' && rows ? `<div class="cm-list">${rows}</div>` : ''}
    <div class="cm-counts">${[['stale', 'check-ins missing', M().filter(needsCheckin).length], ['watermelon', 'need attention', M().filter(m => m.status !== 'complete' && watermelonReasons(m).length).length], ['slipped', 'due dates moved', M().filter(m => flagPass(m, 'slipped')).length]].map(([fl, l, n]) => `<button class="cm-count" data-drilldim="flag" data-drillval="${fl}" title="Show these milestones"><b>${n}</b><span>${l}</span></button>`).join('')}</div>
    ${s.level === 'start' ? `<div class="cm-acts"><button class="btn btn-tonal btn-sm" data-copy-all>Copy reminder</button><button class="btn btn-ghost btn-sm" data-mt="remind">Email everyone</button></div>` : ''}
    <div class="cm-foot" hidden></div>
  </section>`;
}
/* Next steps from meetings, for everyone: yours first, or everyone's grouped by owner */
function nextStepsCard() {
  if (!MEETINGS_ON) return '';
  const me = myOwnerName(), t = todayISO(), all = openActions(), mine = me ? all.filter(a => a.owner === me) : [];
  const tab = state.nsTab || (mine.length || !all.length ? 'mine' : 'all'), late = a => a.due && a.due < t;
  const row = (a, showOwner) => { const can = !!a.meetingId || isAdmin();
    return `<li class="ns-step ${late(a) ? 'is-late' : ''}"><input type="checkbox" data-mm-stepdone="${esc(a.id)}" ${can && !a.milestoneId ? '' : 'disabled'} aria-label="Mark done: ${esc(a.text)}">
      <div class="ns-main"><div class="ns-t">${a.milestoneId && findM(a.milestoneId) ? `<button type="button" class="ag-link" data-expand="${esc(a.milestoneId)}">${esc(a.text)}</button>` : esc(a.text)}</div>
      <div class="ns-m">${showOwner ? `${esc(a.owner || 'No owner')} · ` : ''}<span class="${late(a) ? 'ns-late' : ''}">${a.due ? (late(a) ? 'Overdue, was due ' : 'Due ') + esc(fmtDate(a.due)) : 'No due date'}</span>${a.meeting ? ` · from ${a.meetingId ? `<button type="button" class="ag-link" data-mm-open="${esc(a.meetingId)}" data-mm-tab-to="notes">${esc(a.item || 'meeting')}, ${esc(fmtDate(a.meeting))}</button>` : esc((a.item || 'meeting') + ', ' + fmtDate(a.meeting))}` : ''}</div></div></li>`; };
  let body;
  if (tab === 'mine') body = mine.length ? `<ul class="ns-list">${mine.map(a => row(a, false)).join('')}</ul>` : `<p class="ns-empty">${me ? 'Nothing assigned to you.' : 'Your account is not linked to a person on the board, so steps assigned to you cannot show here.'} Next steps added in meetings show here.</p>`;
  else {
    const g = {}; all.forEach(a => (g[a.owner || ''] = g[a.owner || ''] || []).push(a));
    const keys = Object.keys(g).sort((x, y) => (!x) - (!y) || g[y].filter(late).length - g[x].filter(late).length || x.localeCompare(y));
    body = keys.length ? keys.map(k => { const L = g[k], n = L.filter(late).length;
      return `<div class="ns-group"><div class="ns-gh"><b>${esc(k || 'No owner')}</b><span>${L.length} open${n ? ` · <span class="ns-late">${n} overdue</span>` : ''}</span></div><ul class="ns-list">${L.map(a => row(a, false)).join('')}</ul></div>`; }).join('') : '<p class="ns-empty">No open next steps</p>';
  }
  const lateAll = all.filter(late).length;
  return `<section class="ex-card ns-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('check')}<h3>Next steps from meetings</h3>${lateAll ? `<span class="ns-badge">${lateAll} overdue</span>` : ''}</div>
      <div class="ns-tabs" role="group" aria-label="Whose next steps"><button type="button" class="ns-tab ${tab === 'mine' ? 'is-on' : ''}" aria-pressed="${tab === 'mine'}" data-ns-tab="mine">Yours <span>${mine.length}</span></button><button type="button" class="ns-tab ${tab === 'all' ? 'is-on' : ''}" aria-pressed="${tab === 'all'}" data-ns-tab="all">Everyone <span>${all.length}</span></button></div></div>
    <div class="ns-body">${body}</div></section>`;
}
document.addEventListener('click', e => { const b = e.target.closest('[data-ns-tab]'); if (!b) return; state.nsTab = b.dataset.nsTab; rerender(); const f = document.querySelector(`[data-ns-tab="${b.dataset.nsTab}"]`); if (f) f.focus(); });
function teamNote(team) {
  const t = committeeSignals().teams.find(x => x.team === team); if (!t) return '';
  const nx = mtg().next ? ` before the ${fmtDate(mtg().next)} committee meeting` : '';
  return `${t.people.join(', ') || team}: a quick ${team} update${nx}, please.\n` + t.items.slice(0, 8).map(m => `  - ${m.activity} (${SM(effectiveStatus(m)).label.toLowerCase()}${m.due_date ? ', due ' + fmtDate(m.due_date) : ''})`).join('\n')
    + `\nCheck in at ${location.origin}${location.pathname}#plan`;
}
function markMeetingHeld() {
  if (!guardAdmin()) return;
  const mt = mtg(), t = todayISO(), before = { last: mt.last, next: mt.next };
  mt.last = t; if (!(mt.next && mt.next > t)) mt.next = nextMeetingAfter(t);   // keep a future date someone already set
  logActivity('edit', 'Marked committee meeting held'); autosave(); rerender();
  toastAction(`Meeting held. Next one ${fmtDate(mt.next)}`, 'Undo', () => { const m2 = mtg(); m2.last = before.last; m2.next = before.next; autosave(); rerender(); });
}
function meetingSettingsHtml() {
  const mt = mtg();
  return `<details class="dw-sec dw-fold" open><summary>Committee meetings</summary><button type="button" class="btn btn-text btn-sm dw-golink" data-goview="meetings">Open Meetings</button>
    <div class="field-row"><div class="field"><label>Next meeting</label><input type="date" id="mtgNext" value="${esc(mt.next || '')}"></div>
    <div class="field"><label for="mtgEvery">Committee meets</label><select id="mtgEvery">${[['month', 'Monthly'], ['2weeks', 'Every 2 weeks'], ['week', 'Weekly']].map(([v, l]) => `<option value="${v}" ${(mt.every || 'month') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>Team updates</label><select id="mtgCadence"><option value="14" ${cadenceDays() === 14 ? 'selected' : ''}>Every 2 weeks</option><option value="7" ${cadenceDays() === 7 ? 'selected' : ''}>Every week</option></select></div></div>
  </details>`;
}
document.addEventListener('change', e => {
  const id = e.target && e.target.id; if (id !== 'mtgNext' && id !== 'mtgCadence' && id !== 'mtgEvery') return;
  if (!guardAdmin()) { renderDrawer(); return; }
  if (id === 'mtgNext') mtg().next = e.target.value || null; else if (id === 'mtgEvery') mtg().every = e.target.value; else mtg().cadenceDays = +e.target.value;
  autosave(); rerender(); toast('Meeting settings saved', 'ok');
});

/* Sticky section headings: pinned while their group is on screen, then they scroll away with it.
   --sticky-top keeps them below the Carbon header; --ctx-left starts the context bar at the side nav's edge. */
/* Sticky table headings (Nov 20 2026). A table that fits its card drops its sideways scroll box, so the card
   title and the column headings stick under the page header while you read and peel away when the card ends.
   A table wider than the screen scrolls inside its own frame instead, with its headings and first column pinned. */
function tableFit() {
  document.querySelectorAll('.mx-wrap, .ml-wrap, .dt-card .dt-wrap').forEach(w => {
    const t = w.querySelector('table'); if (!t) return;
    w.classList.remove('is-fit'); const fits = t.scrollWidth <= w.clientWidth + 1; w.classList.toggle('is-fit', fits);
    const card = w.closest('.mx-card, .dt-card'), head = card && card.querySelector(':scope > .ex-card-head');
    if (card) card.style.setProperty('--mx-head-h', (head && getComputedStyle(head).position === 'sticky' ? head.offsetHeight : 0) + 'px');
    const grp = w.closest('.plan-group'), gh = grp && grp.querySelector(':scope > .plan-group-head');
    if (grp) grp.style.setProperty('--pg-head-h', (gh ? gh.offsetHeight : 0) + 'px');
  });
  tableFade();
}
/* Focus on what's in front of you: rows fade as they slide under the pinned headings, and the pinned title and
   headings fade out over the last rows of a table instead of snapping off. */
function tableFade() {
  const line = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-top')) || 48) + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ctx-h')) || 0);
  document.querySelectorAll('.view.active .mx-card, .view.active .dt-card, .view.active .plan-group').forEach(c => {
    const w = c.querySelector('.mx-wrap, .dt-wrap, .ml-wrap'); if (!w) return;
    const th = w.querySelector('thead'), tb = w.querySelector('table'); if (!th || !tb) return;
    const r = c.getBoundingClientRect(), pinned = r.top < line;
    if (!w.classList.contains('is-fit')) {
      /* sideways-scrolling table: the headings can't stick to the page from inside the scroll box, so they slide down with it */
      const hd = c.querySelector(':scope > .ex-card-head, :scope > .plan-group-head'), tr = tb.getBoundingClientRect();
      const hh = hd && getComputedStyle(hd).position === 'sticky' ? hd.offsetHeight : 0;
      const y = Math.max(0, Math.min(line + hh - tr.top, tr.height - th.offsetHeight - 48));
      w.style.setProperty('--th-y', y + 'px');
    } else w.style.removeProperty('--th-y');
    const left = r.bottom - th.getBoundingClientRect().bottom;      // room under the headings before the card ends
    c.style.setProperty('--pin-o', pinned ? Math.max(0, Math.min(1, left / 96)).toFixed(3) : 1);
    c.classList.toggle('is-pinned', pinned && left > 0);
  });
}
window.addEventListener('scroll', () => { if (tableFade._r) return; tableFade._r = requestAnimationFrame(() => { tableFade._r = 0; tableFade(); }); }, { passive: true });
window.addEventListener('resize', () => { clearTimeout(tableFit._t); tableFit._t = setTimeout(tableFit, 120); });
new MutationObserver(() => { cancelAnimationFrame(tableFit._r); tableFit._r = requestAnimationFrame(tableFit); }).observe(document.body, { childList: true, subtree: true });
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
// Dashboard tables (Nov 19 2026): the card title sticks under the top bar and the column headers stick right under the title.
function dtStickyOffsets() { document.querySelectorAll('.dash .dt-card').forEach(c => { const h = c.querySelector('.ex-card-head'); if (h) c.style.setProperty('--dt-head-h', h.offsetHeight + 'px'); }); }
window.addEventListener('resize', () => requestAnimationFrame(dtStickyOffsets));
function renderMasthead() {
  setTimeout(dtStickyOffsets, 0);
  // KPI tiles (Nov 19 2026): the status answer is the biggest thing on the page; the greeting is a quiet line above it.
  const brief = $('#cbBrief'), qt = $('#cbQuarter'); if (!brief || !qt) return;
  if (state.view !== 'progress' || !state.data) { brief.innerHTML = ''; qt.innerHTML = ''; return; }
  const tile = (k, label, value, sub, tone, extra) => `<button type="button" class="kpi kpi-${tone}" ${k ? `data-mb="${k}"` : 'disabled'}><span class="kpi-l">${tone !== 'none' ? `<i class="mb-dot mb-${tone}" aria-hidden="true"></i>` : ''}${label}</span><span class="kpi-v">${value}</span><span class="kpi-s">${sub}</span>${extra || ''}</button>`;
  const tiles = [];   // Nov 19 2026 v2: only signals the cards below don't already show
  try {
    const list = filtered().filter(m => !m._draft), t = todayISO(), fq = fiscalQuarter();
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, qs = iso(fq.start), qe = iso(fq.end);
    // 1. This quarter: done vs due, against how much of the quarter has passed
    const inQ = list.filter(m => m.due_date && m.due_date >= qs && m.due_date <= qe), qDone = inQ.filter(m => m.status === 'complete').length;
    const total = Math.max(1, daysBetween(fq.start, fq.end) + 1), elapsed = Math.min(1, Math.max(0, (total - fq.daysLeft - 1) / total));
    const qTone = !inQ.length ? 'none' : qDone === inQ.length ? 'ok' : qDone / inQ.length >= elapsed ? 'ok' : 'warn';
    tiles.push(tile('dueq', `${esc(fqLabel(fq))} milestones`, inQ.length ? `${qDone}<small> of ${inQ.length} done</small>` : 'None due', `${fq.daysLeft} days left in the quarter`, qTone, inQ.length ? `<span class="kpi-bar" role="img" aria-label="${qDone} of ${inQ.length} done"><span style="width:${Math.round(100 * qDone / inQ.length)}%"></span></span>` : ''));
    // 2. On pace: of everything due by today, how much is done
    const dueSoFar = list.filter(m => m.due_date && m.due_date <= t), doneSoFar = dueSoFar.filter(m => m.status === 'complete').length, pct = dueSoFar.length ? Math.round(100 * doneSoFar / dueSoFar.length) : 100;
    tiles.push(tile('overdue', 'On pace', dueSoFar.length ? `${pct}<small>%</small>` : 'Nothing due yet', dueSoFar.length ? `${doneSoFar} of ${dueSoFar.length} due so far are done` : 'No deadlines have passed', !dueSoFar.length || pct === 100 ? 'ok' : pct >= 80 ? 'warn' : 'bad'));
    // 3. Slipping: deadlines pushed out recently
    const moved = list.filter(m => flagPass(m, 'slipped')).length, fresh = list.filter(newlyOffTrack).length;
    tiles.push(tile('slipped', 'Due dates moved', String(moved), moved || fresh ? `In the last 30 days${fresh ? ` · ${fresh} newly off track` : ''}` : 'None in the last 30 days', moved || fresh ? 'warn' : 'ok'));
    // 4. Next opening: the next school to open and how ready it is
    const next = (hasSchoolWork() ? schoolsInView() : []).filter(sc => sc.opening_date && sc.opening_date >= t).sort((a, b) => a.opening_date.localeCompare(b.opening_date))[0];
    if (next) {
      const ms = schoolMsView(next), r = ragReady(ms), mo = Math.max(0, Math.round(daysUntil(next.opening_date) / 30.4));
      tiles.push(tile('school:' + next.id, 'Next opening', `${mo}<small> months</small>`, `${schoolChip(next.market, [schLbl(next)])} ${avgProgress(ms)}% ready`, r.key === 'red' ? 'bad' : r.key === 'yellow' ? 'warn' : r.key === 'none' ? 'none' : 'ok'));
    }
  } catch (e) {}
  brief.innerHTML = ''; qt.innerHTML = '';   // top cards removed at the user's request (Nov 19 2026); tiles kept above for an easy return
  const gr = $('#msGreet');
  if (gr) { const first = (currentDisplayName() || '').trim().split(/\s+/)[0]; gr.innerHTML = `${esc(timeGreeting())}${first ? `, ${esc(first)}` : ''}<span class="ms-date">${esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</span>`; }
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-mb]'); if (!b) return;
  const go = sel => { const el = document.querySelector(sel); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.remove('mb-flash'); void el.offsetWidth; el.classList.add('mb-flash'); } };
  const k = b.dataset.mb;
  if (k === 'dueq') return applyDrill('timing', 'dueQ');
  if (k === 'overdue') return applyDrill('timing', 'overdue');
  if (k === 'slipped') return applyDrill('flag', 'slipped');
  if (k.startsWith('school:')) return openSchoolModal(k.slice(7));
  if (k === 'openings') go('#view-progress .dt-card');
  else if (k === 'attention') go('#view-progress .ar-card');
  else if (k === 'meeting' || k === 'setmeeting') { if (MEETINGS_ON) setView('meetings'); else if (k === 'setmeeting') { const s2 = document.querySelector('[data-open-settings]'); if (s2) s2.click(); } else go('#view-progress .cm-card'); }
});
/* Sidebar counts: only what needs action. Openings off track or at risk; milestones needing attention. */
function renderNavCounts() {
  const set = (id, n, tone, tip) => { const b = $(id); if (!b) return; b.hidden = !n; b.textContent = n || ''; b.className = 'nav-badge nb-' + tone; b.title = n ? tip : ''; };
  try {
    const off = state.data.schools.filter(s => s.openingFY && ['red', 'yellow'].includes(ragReady(schoolMs(s)).key)).length;
    set('#navBadgeOpen', off, 'danger', off + ' opening' + (off === 1 ? '' : 's') + ' at risk or behind');
    const lv = $('#navBadgeMtg'); if (lv) { const on = !!(meta().meetBook && meta().meetBook.live); lv.hidden = !on; lv.title = on ? 'A meeting is in progress' : ''; }
    const att = attentionItems(M()).length;
    set('#navBadgePlan', att, 'warn', att + ' milestone' + (att === 1 ? '' : 's') + ' need attention');
  } catch (e) {}
}
/* Context bar text: page name, then the active filters and how many results they leave */
function ctxScopeParts() {
  const f = state.filters, p = [];
  if (mineOn()) p.push('Assigned to you'); else f.owners.forEach(v => p.push(v === '__none__' ? 'Unassigned' : v));
  f.states.forEach(v => p.push(fbValueLabel('states', v))); f.markets.forEach(v => p.push(v)); f.areas.forEach(v => p.push(v));
  f.openingFYs.forEach(v => p.push('August ' + (v - 1)));
  f.fys.forEach(v => p.push('Due ' + fyLabel(+v)));
  f.types.forEach(v => p.push(v));
  f.statuses.forEach(v => p.push(SM(v).label));
  f.priorities.forEach(v => p.push((PRIORITY[v] ? PRIORITY[v].label : v) + ' priority'));
  if (f.timing) p.push(f.timing === 'overdue' ? 'Overdue' : f.timing === 'this_month' ? 'Due within 2 weeks' : f.timing === 'due30' ? 'Due in 30 days' : f.timing === 'dueQ' ? 'Due by end of ' + fiscalQuarter().q : 'Due soon');
  if (f.flag) p.push(FLAG_LABEL[f.flag] || f.flag);
  f.schools.forEach(id => { const sc = schoolById(id); if (sc) p.push(sc.market + ' · ' + schLbl(sc)); });
  if (f.search) p.push('“' + f.search.slice(0, 24) + (f.search.length > 24 ? '…' : '') + '”');
  return p;
}
function renderCtxBar() {
  const t = $('#ctxTitle'), sc = $('#ctxScope'); if (!t || !sc) return;
  const v = state.view, parts = ctxScopeParts();
  t.textContent = v === 'timeline' ? 'Openings' : v === 'plan' ? 'Milestones' : v === 'meetings' ? 'Meetings' : 'Dashboard';
  let count = '';
  try {
    if (v === 'plan') { const all = filtered(), n = state.hideDone ? all.filter(m => m.status !== 'complete').length : all.length, hid = all.length - n; count = n + ' milestone' + (n === 1 ? '' : 's') + (hid ? ` · ${hid} done hidden` : ''); }
    else if (v === 'timeline') { const n = ganttSchools().filter(s => s.openingFY).length; count = n + ' school' + (n === 1 ? '' : 's'); }
    else if (v === 'meetings') { const L = mbook().live; count = L ? `Meeting in progress · item ${L.idx + 1} of ${L.items.length}` : (mtg().next ? 'Next meeting ' + fmtDate(mtg().next) : 'No meeting scheduled'); }
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
const boardName = () => (WS_SEED[WS] ? WS_SEED[WS].title : 'Growth Readiness');
const hasAtAll = t => /(^|\s)@all\b/i.test(String(t || ''));   // @all: everyone signed in to this board (Nov 19 2026)
// Version on every page and on the loading screen (Nov 19 2026)
function addAppFooter() {
  if (document.getElementById('appFoot') || !window.GH_VERSION) return; const main = document.querySelector('main.container'); if (!main) return;
  const f = document.createElement('footer'); f.id = 'appFoot'; f.className = 'app-foot';
  f.innerHTML = `<span class="app-credit">Built by the Growth Team, fueled by cafecito ☕ and Miami ☀️</span><span>Version ${esc(window.GH_VERSION)}${window.GH_RELEASED ? ` · Released ${esc(window.GH_RELEASED)}` : ''}</span>`;
  main.appendChild(f);
}
// Loading screen shows no text (Nov 19 2026)
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
function commentLive() { return !!(state.sb && state.sb.connected && sbLoaded && state.auth && state.auth.user); }
// Signed-in people can comment whatever their role; offline, only editors can add notes
function canComment() { return commentLive() || guardEdit(); }
function safeUrl(u) { try { const x = new URL(String(u || '').trim()); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; } }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
function taskLink(id) { return `${location.origin}${location.pathname}?m=${encodeURIComponent(id)}`; }

/* ---------- comments and @mentions ---------- */
// Turn "@susie" or "@doug chu" into the roster name when it matches one person (Nov 19 2026 QA)
function resolveMentions(text) {
  const names = rosterNames(), unknown = [];
  const out = String(text || '').replace(/(^|\s)@([A-Za-z][A-Za-z'’.-]*)(\s+[A-Za-z][A-Za-z'’-]*)?/g, (all, pre, w1, w2) => {
    if (w1.toLowerCase() === 'all') return `${pre}@all${w2 || ''}`;
    if (w2) { const full = names.find(n => normName(n) === normName(w1 + w2)); if (full) return `${pre}@${full}`; }
    const n1 = normName(w1), exact = names.find(n => normName(n) === n1), hits = exact ? [exact] : names.filter(n => normName(n).split(' ').includes(n1));
    if (hits.length === 1) return `${pre}@${hits[0]}${w2 || ''}`;
    unknown.push('@' + w1); return all;
  });
  return { text: out, unknown };
}
function mentionsIn(text) { const t = String(text || ''); return [...(hasAtAll(t) ? ['@all'] : []), ...rosterNames().filter(n => t.includes('@' + n))]; }
function renderNoteText(nt) {
  let h = esc(nt.text || '');
  const keep = [];
  const hold = html => { keep.push(html); return `\u0000${keep.length - 1}\u0000`; };
  h = h.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, u => hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`));
  h = h.replace(/(^|\s)@all\b/gi, (x, pre) => pre + hold('<span class="mention mention-all">@all</span>'));
  [...new Set([...(nt.mentions || []).filter(n => n !== '@all'), ...rosterNames()])].sort((a, b) => b.length - a.length).forEach(n => {
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
  const names = [...('all'.startsWith(q) ? ['@all'] : []), ...rosterNames().filter(n => { const nn = normName(n); return !q || nn.startsWith(q) || nn.split(' ').some(w => w.startsWith(q)); })].slice(0, 7);
  if (!names.length) return closeMentionMenu();
  const keepIdx = mentionState && mentionState.items.join('|') === names.join('|') ? mentionState.idx : 0;
  mentionState = { start: pos - mt[2].length - 1, end: pos, items: names, idx: keepIdx };
  let el = $('#mentionMenu');
  if (!el) { el = document.createElement('div'); el.id = 'mentionMenu'; el.className = 'mention-menu'; el.setAttribute('role', 'listbox'); inp.closest('.note-add').appendChild(el); }
  el.innerHTML = names.map((n, i) => `<button type="button" role="option" class="mention-opt ${i === mentionState.idx ? 'on' : ''}" aria-selected="${i === mentionState.idx}" data-mention="${esc(n)}">${n === '@all' ? `<span class="pchip mention-all-ic" aria-hidden="true">@</span><span><b>all</b> <span class="muted">Everyone on ${esc(boardName())}</span></span>` : `${personChip(n)}<span>${esc(n)}</span>`}</button>`).join('');
}
function pickMention(inp, name) {
  if (!mentionState) return;
  const { start, end } = mentionState, ins = (name === '@all' ? '@all' : '@' + name) + ' ';
  inp.value = inp.value.slice(0, start) + ins + inp.value.slice(end);
  const c = start + ins.length; inp.setSelectionRange(c, c); inp.focus();
  closeMentionMenu();
}
// Comments for you (Nov 19 2026 QA): someone @mentioned you, or commented on a milestone you own or co-own.
// Your own comments never count. "New" = after you last marked them read (this browser).
function myMentions(days) {
  const p = currentProfile(), me = myOwnerName(), names = [...new Set([me, p && p.full_name].filter(Boolean))];
  if (!names.length && !p) return [];
  const cut = Date.now() - (days || 14) * 864e5, mine = currentDisplayName(), out = [];
  M().filter(m => !m._draft).forEach(m => (m.noteLog || []).forEach(nt => {
    if (+nt.t < cut || (mine && nt.by === mine) || (me && nt.by === me)) return;
    const tagged = names.some(n => (nt.mentions || []).includes(n) || String(nt.text || '').includes('@' + n));
    const all = !tagged && ((nt.mentions || []).includes('@all') || hasAtAll(nt.text));
    const owned = !!me && ownsM(m, me);
    if (tagged || all || owned) out.push({ m, nt, why: tagged ? 'Mentioned you' : all ? 'Mentioned everyone' : 'On your milestone' });
  }));
  return out.sort((a, b) => b.nt.t - a.nt.t);
}
const cmtSeen = () => Number(lsGet('ngc_cmt_seen_' + WS) || 0);
const unreadForMe = () => myMentions(14).filter(x => +x.nt.t > cmtSeen());
function cmtRow({ m, nt, why }, seen) {   // notification layout: who did what, the comment, then which milestone (Nov 19 2026)
  const isNew = +nt.t > seen, who = nt.by || 'Someone', verb = { 'Mentioned you': 'mentioned you', 'Mentioned everyone': 'mentioned everyone', 'On your milestone': 'commented on your milestone' }[why] || 'commented';
  return `<div class="cm5 ${isNew ? 'is-new' : ''}" data-expand="${esc(m.id)}" data-cmt-open role="button" tabindex="0" aria-label="${esc(`${who} ${verb}: ${clip(nt.text, 80)}. On ${m.activity}`)}">
    <div class="cm5-top">${personChip(who, 'cm5-av')}<div class="cm5-who"><span><b>${esc(who)}</b> ${verb}</span><span class="cm5-when">${esc(fmtWhen(nt.t))}</span></div>${isNew ? '<span class="cm5-dot" title="New"></span>' : ''}</div>
    <div class="cm5-quote">${renderNoteText(Object.assign({}, nt, { text: clip(nt.text, 220) }))}</div>
    <div class="cm5-on"><span>On</span> ${esc(clip(m.activity, 90))}</div>
  </div>`;
}
function mentionsCard() {
  const items = myMentions(14); if (!items.length) return '';
  const seen = cmtSeen(), nNew = items.filter(x => +x.nt.t > seen).length;
  return `<section class="ex-card mn-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('people')}<h3>Comments for you</h3>${nNew ? `<span class="cm4-badge">${nNew} new</span>` : ''}</div>${nNew ? '<button type="button" class="btn btn-ghost btn-sm" data-cmt-read>Mark all read</button>' : ''}</div>
    <div class="cm5-list">${items.slice(0, 4).map(x => cmtRow(x, seen)).join('')}</div>${items.length > 4 ? `<button class="card-more" data-allmentions>View all ${items.length}</button>` : ''}</section>`;
}
function markCommentsRead() { lsSet('ngc_cmt_seen_' + WS, String(Date.now())); updateActivityDot(); if (state.view === 'progress') rerender(); renderActivityPanel(); }
document.addEventListener('click', e => { if (e.target.closest('[data-cmt-read]')) { e.stopPropagation(); markCommentsRead(); } });
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.cm5[data-cmt-open]')) { e.preventDefault(); e.target.click(); } });
document.addEventListener('click', e => { if (e.target.closest('[data-cmt-open]') && !e.target.closest('[data-cmt-read]')) setTimeout(() => { const t = $('#mdTab-act'); if (t) t.click(); }, 0); });   // land on the comments

/* ---------- documents and "waiting on" ---------- */
const CLIP_IC = '<svg viewBox="0 0 32 32" fill="currentColor" width="13" height="13"><path d="M28.1,18.9L13.1,3.9c-2.5-2.6-6.6-2.6-9.2-0.1S1.3,10.5,3.9,13c0,0,0.1,0.1,0.1,0.1L6.8,16l1.4-1.4l-2.9-2.9	C3.6,10,3.6,7.1,5.3,5.4s4.6-1.8,6.3-0.1c0,0,0,0,0.1,0.1l14.9,14.9c1.8,1.7,1.8,4.6,0.1,6.3c-1.7,1.8-4.6,1.8-6.3,0.1	c0,0,0,0-0.1-0.1l-7.4-7.4c-1-1-0.9-2.6,0-3.5c1-0.9,2.5-0.9,3.5,0l4.1,4.1l1.4-1.4c0,0-4.2-4.2-4.2-4.2c-1.8-1.7-4.6-1.6-6.3,0.2	c-1.6,1.7-1.6,4.4,0,6.2l7.5,7.5c2.5,2.6,6.6,2.6,9.2,0.1S30.7,21.5,28.1,18.9C28.1,19,28.1,18.9,28.1,18.9L28.1,18.9z"/></svg>';
function depIssue(m, d) {
  if (!d || d.status === 'complete') return '';
  if (d.status === 'blocked') return 'blocked';
  if (effectiveStatus(d) === 'behind') return 'behind';
  if (d.due_date && m.due_date && d.due_date > m.due_date) return 'due after this one';
  return '';
}
// After a milestone is completed: say who can now move
function unblockNote(m) {
  const n = M().filter(x => x.status !== 'complete' && (x.blockedBy || []).includes(m.id)).length;
  return n ? `. Unblocks ${n} milestone${n === 1 ? '' : 's'}` : '';
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
      <label for="depAdd" class="dep-lbl">Add a milestone this waits on</label>${M().length > 40 ? '<input type="search" id="depFind" class="dep-find" placeholder="Type to narrow the list" aria-label="Narrow the list of milestones">' : ''}<select id="depAdd"><option value="">Choose a milestone</option>${depOptions(m, deps.map(d => d.id))}</select>
      </div>
    ${needed.length ? `<div class="field"><label>Needed by</label><div class="dep-needed">${needed.map(n => `<div class="dep-row">${statusDot(effectiveStatus(n))}<button type="button" class="dep-name" data-expand="${esc(n.id)}">${esc(n.activity)}</button><span class="dep-meta">${n.due_date ? 'Due ' + esc(fmtDate(n.due_date)) : ''}</span></div>`).join('')}</div></div>` : ''}
    <div class="m-sec-h">Documents</div>
    <div class="field"><div id="lkList">${(m.links || []).map(linkRowHtml).join('')}</div>
      <div class="lk-add"><div class="lk-f"><label for="lkUrl">Link</label><input id="lkUrl" type="url" placeholder="https://"></div><div class="lk-f"><label for="lkLabel">Name</label><input id="lkLabel"></div><button type="button" class="btn btn-sm" id="lkAdd">Add</button></div></div>`;
}
function addLinkFromInputs() {
  const u = $('#lkUrl'), l = $('#lkLabel'); if (!u || !u.value.trim()) return true;
  const url = safeUrl(u.value.trim().match(/^https?:\/\//i) ? u.value.trim() : 'https://' + u.value.trim());
  if (!url) { markInvalid(u, 'Paste a full link that starts with https://'); return false; }
  if ($$('#lkList .lk-row').some(r => r.dataset.url === url)) { markInvalid(u, 'That link is already here'); return false; }
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
  openMail(owners.map(ownerEmail).filter(Boolean), 'Causeway: ' + clip(m.activity, 90),
    `Hi ${first},\n\nChecking in on "${m.activity}"${m.due_date ? `, due ${fmtDate(m.due_date)}` : ''}. Causeway shows it as ${SM(effectiveStatus(m)).label.toLowerCase()}.\n\n${taskLink(m.id)}`);
}
function emailTeam(team) {
  const t = committeeSignals().teams.find(x => x.team === team); if (!t) return;
  openMail(t.people.map(ownerEmail).filter(Boolean), `Causeway: ${team} update`, teamNote(team));
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
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//KIPP NGC//Causeway//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEsc(name)}`];
  items.filter(m => m.due_date && !m._draft).forEach(m => L.push(...ev(`m-${m.id}@growth-hub`, m.due_date, `${m.status === 'complete' ? 'Done' : 'Due'}: ${m.activity}`,
    [`Status: ${SM(effectiveStatus(m)).label}`, `Owner: ${ownersOf(m).join(', ') || 'Unassigned'}`, m.market ? `Market: ${m.market}` : '', m.functional_area ? `Team: ${m.functional_area}` : '', '', `Open in Causeway: ${taskLink(m.id)}`].filter((x, i) => x || i === 4).join('\n'), taskLink(m.id))));
  if (mtg().next && mtg().time) { const d0 = (mtg().next + 'T' + mtg().time).replace(/[-:]/g, '') + '00'; L.push('BEGIN:VEVENT', `UID:mtg-${WS}@growth-hub`, `DTSTAMP:${stamp}`, `DTSTART:${d0}`, `DURATION:PT${Math.max(15, agendaItems().reduce((a, x) => a + (+x.mins || 0), 0))}M`, 'SUMMARY:Growth committee meeting', `DESCRIPTION:${icsEsc('Agenda: ' + location.origin + location.pathname + '#meetings')}`, `URL:${location.origin + location.pathname}#meetings`, 'END:VEVENT'); }
  else if (mtg().next) L.push(...ev(`mtg-${WS}@growth-hub`, mtg().next, 'Growth committee meeting', 'Agenda: ' + location.origin + location.pathname + '#meetings', location.origin + location.pathname + '#meetings'));
  schools.filter(s => s.opening_date).forEach(s => L.push(...ev(`s-${s.id}@growth-hub`, s.opening_date, `Opens: ${[s.market, schLbl(s)].filter(Boolean).join(' · ')}`, 'School opening', location.origin + location.pathname)));
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}
function downloadIcs(scope) {
  const me = myOwnerName(), items = scope === 'mine' ? M().filter(m => ownsM(m, me)) : filtered();
  if (!items.some(m => m.due_date && m.status !== 'complete')) return toast('No open milestones with due dates to add', 'warn');
  const txt = buildIcs(scope === 'mine' ? 'Causeway: my milestones' : 'Causeway milestones', items, state.data.schools || []);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/calendar' }));
  a.download = scope === 'mine' ? `growth-hub-${boardSlug()}-mine.ics` : `growth-hub-${boardSlug()}.ics`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast(`Downloaded ${items.filter(m => m.due_date).length} due dates. Open the file to add them to Outlook`, 'ok');
}
function calFeedBase() { const c = sbCfg(); return c && c.url ? c.url.replace(/\/$/, '') + '/functions/v1/growth-calendar' : ''; }
async function fillCalSub(reset) {
  const box = $('#calSub'); if (!box) return;
  const notReady = isAdmin() ? 'Calendar links are not set up yet. See part 3 of INTEGRATIONS-SETUP.md, or download a file below' : 'Calendar links are not turned on yet. Ask an admin, or download a file below';
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
      <div class="dw-btns">${me ? `<button type="button" class="btn" data-calfile="mine">Download my deadlines (${M().filter(m => ownsM(m, me) && m.due_date && m.status !== 'complete').length})</button>` : ''}<button type="button" class="btn" data-calfile="view">Download this view (${filtered().filter(m => m.due_date && m.status !== 'complete').length})</button></div></section>`;
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
  return `<details class="dw-sec dw-fold" id="intSec"><summary>Slack</summary><div id="intBody"><p class="dw-help">Loading</p></div></details>`;
}
async function loadIntegrations(info) {
  const box = $('#intBody'); if (!box) return;
  if (!commentLive()) { box.innerHTML = '<p class="dw-help">Sign in to set up Slack</p>'; return; }
  let st = info;
  if (!st) {
    try { const r = await state.sb.client.rpc('growth_integrations_get'); if (r.error) throw r.error; st = r.data || {}; }
    catch (e) { box.innerHTML = '<div class="status-note warn">Slack is not available yet. Contact your Causeway admin</div>'; return; }
  }
  if (!$('#intBody')) return;
  box.innerHTML = st.slack ? `<div class="status-note ok">Posting to Slack · link ends in ${esc(st.slack_hint || '')}</div>
      <label class="field-check"><input type="checkbox" id="intAlerts" ${st.alerts ? 'checked' : ''}> Instant alerts</label>
      <label class="field-check"><input type="checkbox" id="intDigest" ${st.digest ? 'checked' : ''}> Monday digest at 8am</label>
      
      <div class="dw-btns"><button class="btn" id="intTest">Send a test message</button><button class="btn" id="intDigestNow">Send the digest now</button><button class="btn btn-text" id="intClear">Disconnect</button></div>`
    : `
      <div class="field"><label for="intUrl">Slack webhook link</label><input id="intUrl" type="url" placeholder="https://hooks.slack.com/services/…" autocomplete="off"></div>
      <div class="dw-btns"><button class="btn btn-filled" id="intSave">Connect Slack</button></div>`;
}
async function intCall(fn, args, okMsg) {
  if (!guardAdmin()) return null;
  try { const r = await state.sb.client.rpc(fn, args || {}); if (r.error) throw r.error; if (okMsg) toast(okMsg, 'ok'); return r.data; }
  catch (e) { console.error(e); const t = String((e && e.message) || ''); toast(/webhook|slack/i.test(t) && t.length < 140 ? t : 'Slack: ' + syncErrorText(e), 'err'); return null; }
}

/* ---------- ?m=<id> opens a milestone (links in Slack, email and calendars) ---------- */
function openDeepLink() {
  let id = null, q = ''; try { const sp = new URLSearchParams(location.search); id = sp.get('m'); q = (sp.get('q') || '').trim().slice(0, 80); } catch (e) {}
  let fl = null; try { fl = new URLSearchParams(location.search).get('f'); } catch (e) {}
  if (fl && applyViewLink(fl)) {
    try { const u = new URL(location.href); u.searchParams.delete('f'); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch (e) {}
    state.viewLinkApplied = true; rerender();
  }
  if (q) {   // ?q=<text> from the home search: open Milestones filtered to it
    try { const u = new URL(location.href); u.searchParams.delete('q'); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch (e) {}
    state.filters.search = q; setView('plan'); rerender();
  }
  let sid = null; try { sid = new URLSearchParams(location.search).get('s'); } catch (e) {}
  if (sid) {   // ?s=<id> opens a school opening
    let st = 0;
    const goS = () => {
      if (schoolById(sid)) { try { const u = new URL(location.href); u.searchParams.delete('s'); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch (e) {} return openSchoolModal(sid); }
      if (++st < (sbLoaded ? 3 : 30)) setTimeout(goS, 500); else toast("That school opening wasn't found", 'warn');
    };
    setTimeout(goS, 300);
  }
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
  mb.addEventListener('click', e => { if (e.target.closest('.dep-name, .ag-link') && modalDirty) { e.stopPropagation(); e.preventDefault(); toast('Save or discard your changes first', 'warn'); } }, true);
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
      if (!/^https:\/\/hooks\.slack\.com\/services\//.test(v)) return markInvalid($('#intUrl'), 'Paste the webhook link from Slack. It starts with https://hooks.slack.com/services/');
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

/* ============================================================
   MEETINGS (Nov 2026): build the agenda, run the meeting, keep minutes.
   Decision: admins build and run meetings. A committee has one chair, and
   shared settings are already admin-written, so no new permissions are
   needed. Everyone signed in can read the agenda, the live item and minutes.
   Stored per board in meta().meetBook (settings row "meetbook@<board>").
   ============================================================ */
function mbook() {
  const m = meta(); m.meetBook = m.meetBook || {}; const b = m.meetBook;
  b.topics = b.topics || []; b.minutes = b.minutes || []; b.mins = b.mins || {};
  b.include = Object.assign({ actions: true, since: true, issues: true, updates: true }, b.include || {});
  return b;
}
function nextMeetingAfter(iso) { const e = mtg().every || 'month'; return e === 'month' ? offsetDateISO(iso, 1) : (() => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + (e === '2weeks' ? 14 : 7)); return d.toISOString().slice(0, 10); })(); }
function topicDialog(tp) {
  closeConfirm();
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  w.innerHTML = `<div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="tdH"><h3 id="tdH">Edit topic</h3>
    <div class="field"><label for="tdTitle">Topic</label><input id="tdTitle" maxlength="140" value="${esc(tp.title)}"></div>
    <div class="field"><label for="tdNote">Details or pre-read</label><textarea id="tdNote" rows="3" maxlength="600" >${esc(tp.note || '')}</textarea></div>
    <div class="field"><label for="tdLead">Lead</label><select id="tdLead">${ownerOptions(tp.owner || '').replace('>Unassigned<', '>No lead<')}</select></div>
    <div class="confirm-actions"><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn btn-filled" id="cfgOk">Save</button></div></div>`;
  document.body.appendChild(w);
  const done = ok => { if (ok) { const t = $('#tdTitle').value.trim(); if (!t) return markInvalid($('#tdTitle'), 'Name the topic'); tp.title = t; tp.note = $('#tdNote').value.trim(); tp.owner = $('#tdLead').value; autosave(); } closeConfirm(); renderMeetings(); };
  w.addEventListener('click', e => { if (e.target === w || e.target.id === 'cfgCancel') done(false); else if (e.target.id === 'cfgOk') done(true); });
  w.addEventListener('keydown', e => { if (e.key === 'Escape') done(false); else if (e.key === 'Enter' && e.target.tagName === 'INPUT') done(true); });
  setTimeout(() => $('#tdTitle').focus(), 30);
}
function fmtTime(hm) { const [h, m] = String(hm || '').split(':').map(Number); if (isNaN(h)) return ''; return `${(h % 12) || 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
function addMins(hm, n) { const [h, m] = hm.split(':').map(Number), t = h * 60 + m + n; return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
function meetingDateDialog() {
  closeConfirm(); const mt = mtg();
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  w.innerHTML = `<div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="mdH"><h3 id="mdH">Next meeting</h3>
    <div class="field-row"><div class="field"><label for="mdDate">Date</label><input id="mdDate" type="date" min="${todayISO()}" value="${esc(mt.next || nextMeetingAfter(todayISO()))}"></div>
    <div class="field"><label for="mdTime">Start time</label><input id="mdTime" type="time" step="300" value="${esc(mt.time || '')}"></div></div>
    <div class="confirm-actions"><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn btn-filled" id="cfgOk">Save</button></div></div>`;
  document.body.appendChild(w);
  const done = ok => { if (ok) { const d = $('#mdDate').value; if (!d || d < todayISO()) return markInvalid($('#mdDate'), 'Pick today or a later date'); mtg().next = d; mtg().time = $('#mdTime').value || ''; autosave(); rerender(); toast(`Next meeting ${fmtDate(d)}${mtg().time ? ', ' + fmtTime(mtg().time) : ''}`, 'ok'); } closeConfirm(); };
  w.addEventListener('click', e => { if (e.target === w || e.target.id === 'cfgCancel') done(false); else if (e.target.id === 'cfgOk') done(true); });
  w.addEventListener('keydown', e => { if (e.key === 'Escape') done(false); else if (e.key === 'Enter') done(true); });
  setTimeout(() => $('#mdDate').focus(), 30);
}
function relDays(iso) { const d = daysUntil(iso); return d === 0 ? 'today' : d === 1 ? 'tomorrow' : d > 0 ? `in ${d} days` : `${-d} day${d === -1 ? '' : 's'} ago`; }
function fmtClock(ms) { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
function actionDone(a) { if (a.milestoneId) { const m = findM(a.milestoneId); if (m) return m.status === 'complete'; } return !!a.done; }
function allActions() { return [...mbook().minutes.flatMap(mn => (mn.items || []).flatMap(it => (it.actions || []).map(a => Object.assign({ meeting: mn.date, item: it.title }, a)))), ...(mbook().meetings || []).flatMap(mt => (mt.steps || []).map(s => Object.assign({ meeting: mt.date, item: mt.title, meetingId: mt.id }, s)))]; }
function openActions() { const me = myOwnerName(); return allActions().filter(a => !actionDone(a)).sort((x, y) => ((y.owner && y.owner === me) - (x.owner && x.owner === me)) || (x.due || '9999').localeCompare(y.due || '9999')); }
function findAction(id) { const st = (mbook().meetings || []).flatMap(mt => mt.steps || []).find(s => s.id === id); if (st) return st; for (const mn of mbook().minutes) for (const it of (mn.items || [])) for (const a of (it.actions || [])) if (a.id === id) return a; const L = mbook().live; if (L) for (const it of L.items) for (const a of (it.actions || [])) if (a.id === id) return a; return null; }
function meetingData() {
  const list = M().filter(m => !m._draft), open = list.filter(m => m.status !== 'complete'), lm = lastMeetingISO(), since = new Date(lm + 'T23:59:59').getTime();
  const after = t => t && new Date(t).getTime() > since;
  const done = list.filter(m => m.status === 'complete' && after(m.completedAt));
  const added = list.filter(m => after(m.createdAt));
  const newly = open.filter(newlyOffTrack);
  const moved = list.filter(m => (m.dateHistory || []).some(h => after(h.t)));
  const blocked = open.filter(m => m.status === 'blocked'), behind = open.filter(m => m.status !== 'blocked' && effectiveStatus(m) === 'behind'), risk = open.filter(m => effectiveStatus(m) === 'at_risk');
  const look = open.filter(m => !blocked.includes(m) && !behind.includes(m) && !risk.includes(m) && watermelonReasons(m).length);
  const stale = open.filter(needsCheckin), byOwner = {};
  stale.forEach(m => (ownersOf(m).length ? ownersOf(m) : ['Unassigned']).forEach(o => { byOwner[o] = (byOwner[o] || 0) + 1; }));
  return { lm, done, added, newly, moved, blocked, behind, risk, look, stale, byOwner, acts: openActions() };
}
const MT_AUTO = { actions: ['Action items from last time', 5], since: ['Since the last meeting', 10], issues: ['Open issues', 15], updates: ['Updates missing', 5] };
function agendaItems() {
  const b = mbook(), d = meetingData(), items = [], mins = k => +b.mins[k] || MT_AUTO[k][1], ids = a => [...new Set(a.map(m => m.id))];
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (b.include.actions && d.acts.length) items.push({ key: 'actions', kind: 'Review', title: MT_AUTO.actions[0], mins: mins('actions'), sum: plural(d.acts.length, 'open action'), ids: [] });
  if (b.include.since) items.push({ key: 'since', kind: 'Review', title: MT_AUTO.since[0], mins: mins('since'), sum: `${d.done.length} completed · ${d.newly.length} newly off track · ${plural(d.moved.length, 'deadline')} moved · ${d.added.length} added`, ids: ids([...d.newly, ...d.moved, ...d.done, ...d.added]) });
  if (b.include.issues) items.push({ key: 'issues', kind: 'Review', title: MT_AUTO.issues[0], mins: mins('issues'), sum: `${d.blocked.length} blocked · ${d.behind.length} behind · ${d.risk.length} at risk · ${d.look.length} need attention`, ids: ids([...d.blocked, ...d.behind, ...d.risk, ...d.look]) });
  b.topics.forEach(t => items.push({ key: 't:' + t.id, kind: 'Topic', title: t.title, mins: +t.mins || 10, owner: t.owner || '', sum: t.note || ((t.ids || []).length ? ((t.ids || []).map(findM).filter(Boolean).every(m => m.status === 'complete') ? 'Already complete' : 'Milestone review') : ''), topicId: t.id, ids: (t.ids || []).filter(findM) }));
  if (b.include.updates && d.stale.length) items.push({ key: 'updates', kind: 'Review', title: MT_AUTO.updates[0], mins: mins('updates'), sum: ((e) => e.slice(0, 5).map(([o, n]) => `${o} ${n}`).join(' · ') + (e.length > 5 ? ` and ${e.length - 5} more` : ''))(Object.entries(d.byOwner).sort((x, y) => y[1] - x[1])), ids: ids(d.stale) });
  if (!mtg().last) items.forEach(x => { if (x.key === 'since') x.title = 'In the last month'; });
  const ord = b.order || [];   // the chair's order; new items keep their natural place
  return items.map((x, i) => ({ x, i, o: ord.indexOf(x.key) })).sort((p, q) => (p.o < 0 && q.o < 0) ? p.i - q.i : (p.o < 0 ? 1e3 + p.i : p.o) - (q.o < 0 ? 1e3 + q.i : q.o)).map(z => z.x);
}
function moveAgendaItem(key, dir) {
  const b = mbook(), keys = agendaItems().map(x => x.key), i = keys.indexOf(key), j = i + dir;
  if (i < 0 || j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [keys[j], keys[i]]; b.order = keys; autosave(); renderMeetings();
  setTimeout(() => { const btn = document.querySelector(`[data-mt-${dir < 0 ? 'up' : 'down'}="${key}"]`); if (btn) btn.focus(); }, 0);
}
function agendaText(items) {
  const mt = mtg();
  return `Committee meeting agenda${mt.next ? ', ' + fmtDate(mt.next) : ''}${mt.time ? ', ' + fmtTime(mt.time) : ''}\n` + items.map((x, i) => `${i + 1}. ${x.title} (${x.mins} min)${x.owner ? ' · ' + x.owner : ''}${x.sum ? '\n   ' + x.sum : ''}`).join('\n')
    + `\n\nTotal ${items.reduce((s, x) => s + (+x.mins || 0), 0)} min\n${location.origin}${location.pathname}#meetings`;
}
function minutesText(rec) {
  const lines = [`${WS_SEED[WS] ? WS_SEED[WS].title : 'Growth Readiness'} committee minutes, ${fmtDate(rec.date)}`];
  const decs = (rec.items || []).filter(x => x.decision); if (decs.length) lines.push('', 'Decisions', ...decs.map(x => `- ${x.decision}`));
  const acts = (rec.items || []).flatMap(x => x.actions || []); if (acts.length) lines.push('', 'Action items', ...acts.map(a => `- ${a.text}${a.owner ? ', ' + a.owner : ''}${a.due ? ', due ' + fmtDate(a.due) : ''}`));
  if (decs.length || acts.length) lines.push('', 'Discussion');
  if (rec.attendees) lines.push(`Attending: ${rec.attendees}`);
  if (rec.startedAt && rec.endedAt) { const mins = Math.max(1, Math.round((new Date(rec.endedAt) - new Date(rec.startedAt)) / 60000)); lines.push(`${mins} minute${mins === 1 ? '' : 's'}`); }
  (rec.items || []).forEach((it, i) => {
    lines.push('', `${i + 1}. ${it.title}${it.done ? '' : ' (not reached)'}`);
    if (it.decision) lines.push(`   Decision: ${it.decision}`);
    if (it.notes) lines.push(...it.notes.split('\n').map(l => '   ' + l));
    (it.actions || []).forEach(a => lines.push(`   Action: ${a.text}${a.owner ? ', ' + a.owner : ''}${a.due ? ', due ' + fmtDate(a.due) : ''}`));
  });
  if (rec.next) lines.push('', `Next meeting: ${fmtDate(rec.next)}`);
  lines.push(`${location.origin}${location.pathname}#meetings`);
  return lines.join('\n');
}
function mtMsList(ids, max) {
  const ms = ids.map(findM).filter(Boolean); if (!ms.length) return '<p class="mt-empty">Nothing here</p>';
  const show = ms.slice(0, max || 12);
  return `<ul class="mt-ms">${show.map(m => `<li><button type="button" class="ag-link" data-expand="${esc(m.id)}">${esc(m.activity)}</button><span class="mt-ms-meta">${canEdit() ? `<button type="button" class="kc-status mt-qs" data-qstatus="${esc(m.id)}" title="Change status">${statusDot(effectiveStatus(m))}${esc(SM(effectiveStatus(m)).label)}</button>` : statusDot(effectiveStatus(m)) + esc(SM(effectiveStatus(m)).label)} · ${esc(ownersOf(m).join(' / ') || 'Unassigned')} ${dueChip(m)}</span></li>`).join('')}</ul>${ms.length > show.length ? `<p class="mt-empty">and ${ms.length - show.length} more</p>` : ''}`;
}
function actionRow(a, editable) {
  const m = a.milestoneId && findM(a.milestoneId), done = actionDone(a);
  return `<li class="mt-act ${done ? 'is-done' : ''}">
    ${editable && !m ? `<input type="checkbox" data-mt-actdone="${esc(a.id)}" ${done ? 'checked' : ''} aria-label="Done">` : `<span class="mt-act-dot">${done ? CI('check') : ''}</span>`}
    <div class="mt-act-main"><div class="mt-act-t">${a.owner && a.owner === myOwnerName() ? '<span class="mt-tag mt-tag-blue">Yours</span> ' : ''}${m ? `<button type="button" class="ag-link" data-expand="${esc(m.id)}">${esc(a.text)}</button>` : esc(a.text)}</div>
      <div class="mt-act-m ${!done && a.due && a.due < todayISO() ? 'is-late' : ''}">${esc([a.owner || 'Unassigned', a.due ? (!done && a.due < todayISO() ? 'overdue, was due ' : 'due ') + fmtDate(a.due) : '', a.meeting ? 'from ' + fmtDate(a.meeting) : '', m ? SM(effectiveStatus(m)).label : ''].filter(Boolean).join(' · '))}</div></div>
    ${editable && !m && !done ? `<button type="button" class="btn btn-ghost btn-sm" data-mt-tomilestone="${esc(a.id)}">Make it a milestone</button>` : ''}${editable && a.live ? `<button type="button" class="icon-btn" data-mt-actdel="${esc(a.id)}" aria-label="Remove action ${esc(a.text)}" title="Remove">${CI('close')}</button>` : ''}
  </li>`;
}

let mtTimer = null;
function stopMtTimer() { clearInterval(mtTimer); mtTimer = null; }
function tickMt() {
  const L = mbook().live, c = $('#mtClock'); if (!L || !c) return stopMtTimer();
  c.textContent = fmtClock(Date.now() - new Date(L.startedAt));
  const cur = L.items[L.idx], ic = $('#mtItemClock');
  if (cur && ic) { const spent = (cur.spent || 0) + (Date.now() - (L.itemStart || Date.now())); ic.textContent = fmtClock(spent); ic.classList.toggle('over', spent > (cur.mins || 10) * 60000); if (spent > (cur.mins || 10) * 60000 && !cur._warned) { cur._warned = true; const a = $('#mtAnnounce'); if (a) a.textContent = `Over the ${cur.mins} minutes planned for this item`; } }
  const pl = $('#mtPlan'); if (pl) { const planned = L.items.slice(0, L.idx + 1).reduce((a, x) => a + (+x.mins || 0), 0) * 60000, diff = Math.round((Date.now() - new Date(L.startedAt) - planned) / 60000); pl.textContent = diff > 0 ? `${diff} min behind plan` : ''; }
}

function renderMeetingsAgenda() {
  const sec = $('#view-meetings'); if (!sec) return;
  setTimeout(renderCtxBar, 0);
  const b = mbook(), admin = isAdmin(), mt = mtg();
  const mine = !b.live || !b.live.by || b.live.by === currentDisplayName() || state.mtTookOver;
  if (b.live && ((admin && mine && state.mtRun !== false) || ((!admin || !mine) && state.mtFollow))) return renderMeetingRun(sec);
  stopMtTimer();
  if (state.mtFollow && !b.live) { state.mtFollow = false; if (b.minutes[0]) state.mtJustEnded = b.minutes[0].id; setTimeout(() => toast('The meeting ended. The minutes are under Past meetings', 'ok'), 0); }
  const d = meetingData(), items = agendaItems(), total = items.reduce((s, x) => s + (+x.mins || 0), 0);
  const tile = (n, label, drill, tone) => `<button type="button" aria-label="${n} ${label}" class="mt-tile ${tone && n ? 'tone-' + tone : ''}" ${drill ? `data-drilldim="flag" data-drillval="${drill}"` : 'data-mt="actions"'}><span class="mt-tile-n">${n}</span><span class="mt-tile-l">${label}</span></button>`;
  const stale = b.live && Date.now() - new Date(b.live.startedAt) > 12 * 3600000;
  const live = b.live ? `<div class="mt-live-note ${stale ? 'mt-warn' : ''}" role="status">${stale ? `<b>Started ${esc(fmtDate(b.live.startedAt.slice(0, 10)))} and never ended.</b>${admin ? ' End it to save the minutes, or discard it.' : ''}` : ''}<span class="mt-pulse"></span><b>Meeting in progress</b><span>Item ${Math.min(b.live.idx, b.live.items.length - 1) + 1} of ${b.live.items.length}: ${esc((b.live.items[b.live.idx] || {}).title || '')}</span>${b.live.by && b.live.by !== currentDisplayName() ? `<span class="muted">Run by ${esc(b.live.by)}</span>` : ''}${admin && mine ? '<button class="btn btn-filled btn-sm" data-mt="resume">Resume meeting</button>' : `<button class="btn btn-tonal btn-sm" data-mt="follow">Follow along</button>${admin ? '<button class="btn btn-ghost btn-sm" data-mt="takeover">Take over</button>' : ''}`}</div>` : '';
  let clock = mt.time || '';
  const row = (x, i) => { const at = clock; if (clock) clock = addMins(clock, +x.mins || 0); return `<li class="mt-item" data-mtkey="${esc(x.key)}">
      <span class="mt-num">${i + 1}${at ? `<small>${esc(fmtTime(at).replace(' AM', '').replace(' PM', ''))}</small>` : ''}</span>
      <div class="mt-item-main"><div class="mt-item-t">${esc(x.title)} <span class="mt-tag ${x.kind === 'Topic' ? 'mt-tag-blue' : ''}">${x.kind}</span></div>
        ${x.sum || x.owner ? `<div class="mt-item-s">${esc([x.owner, x.sum].filter(Boolean).join(' · '))}</div>` : ''}
        ${admin && x.key === 'updates' ? '<button type="button" class="btn btn-ghost btn-sm mt-inline" data-mt="remind">Email reminders</button>' : ''}${x.ids && x.ids.length ? `<details class="mt-peek"><summary>Show ${x.ids.length} milestone${x.ids.length === 1 ? '' : 's'}</summary>${mtMsList(x.ids, 10)}</details>` : ''}</div>
      ${admin ? `<label class="mt-mins-in"><input type="number" min="1" max="120" value="${x.mins}" data-mt-mins="${esc(x.key)}" aria-label="Minutes for ${esc(x.title)}"> min</label>` : `<span class="mt-mins">${x.mins} min</span>`}
      ${admin ? `<span class="mt-item-acts"><button type="button" class="icon-btn" data-mt-up="${esc(x.key)}" aria-label="Move ${esc(x.title)} up" title="Move up" ${i === 0 ? 'disabled' : ''}>${CI('arrow-up')}</button><button type="button" class="icon-btn" data-mt-down="${esc(x.key)}" aria-label="Move ${esc(x.title)} down" title="Move down" ${i === items.length - 1 ? 'disabled' : ''}>${CI('arrow-down')}</button>${x.topicId ? `<button type="button" class="icon-btn" data-mt-edit="${esc(x.topicId)}" aria-label="Edit ${esc(x.title)}" title="Edit">${CI('edit')}</button><button type="button" class="icon-btn" data-mt-del="${esc(x.topicId)}" aria-label="Remove ${esc(x.title)}" title="Remove topic">${CI('close')}</button>` : `<button type="button" class="icon-btn" data-mt-hide="${esc(x.key)}" aria-label="Leave ${esc(x.title)} out" title="Leave out">${CI('close')}</button>`}</span>` : ''}
    </li>`; };
  const hidden = Object.keys(MT_AUTO).filter(k => !b.include[k]);
  const builder = admin ? `<form class="mt-add" data-mt-form>
      <div class="mt-add-row"><div class="field"><label for="mtTopic">Add a topic</label><input id="mtTopic" name="title" maxlength="140" required></div>
      <div class="field"><label for="mtTopicOwner">Lead</label><select id="mtTopicOwner" name="owner">${ownerOptions('').replace('>Unassigned<', '>No lead<')}</select></div>
      <div class="field mt-add-min"><label for="mtTopicMin">Minutes</label><input id="mtTopicMin" name="mins" type="number" min="1" max="120" value="10"></div>
      <button class="btn btn-tonal" type="submit">Add topic</button></div>
      ${hidden.length ? `<div class="mt-restore">Left out: ${hidden.map(k => `<button type="button" class="btn btn-text btn-sm" data-mt-show="${k}">${esc(MT_AUTO[k][0])}</button>`).join('')}</div>` : ''}
    </form>` : '';
  const acts = state.mtAllActs ? d.acts : d.acts.slice(0, 10);
  const past = b.minutes.slice(0, 8).map(rec => `<details class="mt-past" ${rec.id === state.mtJustEnded ? 'open' : ''}><summary><span>${esc(fmtDate(rec.date))}</span><span class="muted">${rec.edited ? 'edited · ' : ''}${rec.startedAt && rec.endedAt ? Math.max(1, Math.round((new Date(rec.endedAt) - new Date(rec.startedAt)) / 60000)) + ' min · ' : ''}${(rec.items || []).filter(x => x.done).length} of ${(rec.items || []).length} items · ${((all) => all.length ? `${all.filter(actionDone).length} of ${all.length} action${all.length === 1 ? '' : 's'} done` : 'no actions')((rec.items || []).flatMap(x => x.actions || []))}${rec.by ? ' · run by ' + esc(rec.by) : ''}</span></summary>
      <pre class="mt-minutes">${esc(minutesText(rec))}</pre>${admin ? `<button type="button" class="btn btn-ghost btn-sm" data-mt-editmin="${esc(rec.id)}">Edit</button>` : ''}<button type="button" class="btn btn-ghost btn-sm" data-mt-copymin="${esc(rec.id)}">Copy minutes</button><button type="button" class="btn btn-ghost btn-sm" data-mt-printmin="${esc(rec.id)}">Print</button>${admin && (rec.items || []).some(x => (x.actions || []).some(a => !a.milestoneId && !actionDone(a))) ? `<button type="button" class="btn btn-ghost btn-sm" data-mt-allms="${esc(rec.id)}">Make actions into milestones</button>` : ''}<button type="button" class="btn btn-ghost btn-sm" data-mt-mailmin="${esc(rec.id)}">Email minutes</button>${admin ? `<button type="button" class="btn btn-ghost btn-sm mt-del-min" data-mt-delmin="${esc(rec.id)}">Delete</button>` : ''}</details>`).join('');
  sec.innerHTML = `<div class="mt-page">
    <header class="mt-head">
      <div><h2 class="mt-h">Meetings</h2>
        <p class="mt-sub">Next meeting: <b>${mt.next ? esc(fmtDate(mt.next)) + (mt.time ? ', ' + esc(fmtTime(mt.time)) : '') : 'not scheduled'}</b>${mt.next ? ` <span class="muted">· ${relDays(mt.next)}</span>` : ''}${mt.last ? ` <span class="muted">· last held ${esc(fmtDate(mt.last))}</span>` : ''} <span class="muted">· meets ${({ month: 'monthly', '2weeks': 'every 2 weeks', week: 'weekly' })[mt.every || 'month']}</span></p></div>
      <div class="mt-head-acts">${admin ? `<button class="btn btn-ghost" data-mt="date">${mt.next ? 'Change date' : 'Set date'}</button>` : ''}<button class="btn btn-ghost" data-mt="copy">Copy agenda</button>${admin ? '<button class="btn btn-ghost" data-mt="mailagenda">Email agenda</button>' : ''}<button class="btn btn-ghost" data-mt="print">Print</button>${admin && !b.live ? '<button class="btn btn-filled" data-mt="start">Start meeting</button>' : ''}</div>
    </header>
    ${live}${!b.live && mt.next && mt.next < todayISO() ? `<div class="mt-live-note mt-warn" role="status"><b>The scheduled date has passed.</b><span>${admin ? 'Start the meeting or set a new date.' : 'The chair will set a new date.'}</span></div>` : ''}
    <div class="mt-tiles" aria-label="Progress since the last meeting">
      ${tile(d.done.length, 'Completed since last meeting', 'completed_recent', '')}${tile(d.newly.length, 'Newly off track', 'newly_off', 'bad')}${tile(d.moved.length, 'Deadlines moved', 'slipped', 'warn')}${tile(d.stale.length, 'Updates missing', 'stale', 'warn')}${tile(d.acts.length, 'Open action items', '', '')}
    </div>
    <div class="mt-grid">
      <section class="mt-card mt-agenda"><div class="mt-card-head"><h3>Agenda</h3><span class="muted">${items.length} item${items.length === 1 ? '' : 's'} · ${total} min${mt.time ? ` · ${esc(fmtTime(mt.time))} to ${esc(fmtTime(addMins(mt.time, total)))}` : ''}${total > 90 ? ' · <span class="mt-long">over 90 minutes</span>' : ''}</span></div>
        ${items.length ? `<ol class="mt-list">${items.map(row).join('')}</ol>` : `<p class="mt-empty">Nothing on the agenda yet.${admin ? ' Add a topic below or bring back a section.' : ''}</p>`}
        ${builder}
        ${admin ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-mt="suggest">Suggest a topic</button>'}
      </section>
      <div class="mt-side">
        <section class="mt-card" id="mtActions"><div class="mt-card-head"><h3>Action items</h3><span class="muted">${d.acts.length} open</span></div>
          ${acts.length ? `<ul class="mt-acts">${acts.map(a => actionRow(a, admin)).join('')}</ul>${d.acts.length > acts.length ? `<button type="button" class="btn btn-ghost btn-sm" data-mt="allacts">Show all ${d.acts.length}</button>` : ''}` : '<p class="mt-empty">No open action items</p>'}
        </section>
        <section class="mt-card"><div class="mt-card-head"><h3>Past meetings</h3><span class="muted">${b.minutes.length}</span></div>
          ${past || '<p class="mt-empty">No minutes yet</p>'}
        </section>
      </div>
    </div>
  </div>`;
}

function renderMeetingRun(sec) {
  const ro = !isAdmin() || !(!mbook().live.by || mbook().live.by === currentDisplayName() || state.mtTookOver), b = mbook(), L = b.live, n = L.items.length; L.idx = Math.max(0, Math.min(L.idx || 0, n - 1));
  const cur = L.items[L.idx], doneN = L.items.filter(x => x.done).length, pctDone = Math.round(100 * doneN / Math.max(1, n));
  const steps = L.items.map((x, i) => `<li class="mt-step ${x.done ? 'is-done' : ''} ${i === L.idx ? 'is-cur' : ''}"><button type="button" ${ro ? 'disabled' : `data-mt-go="${i}"`} ${i === L.idx ? 'aria-current="step"' : ''}><span class="mt-step-ic">${x.done ? CI('check') : ''}</span><span class="mt-step-t">${esc(x.title)}<span class="sr-only">${x.done ? ', discussed' : i === L.idx ? ', current' : ''}</span></span><span class="mt-step-m">${x.mins} min</span></button></li>`).join('');
  let detail = '';
  if (cur.key === 'actions') detail = `<ul class="mt-acts">${openActions().map(a => actionRow(a, !ro)).join('') || '<li class="mt-empty">No open action items</li>'}</ul>`;
  else if (cur.key === 'updates') { const d = meetingData(); detail = `<ul class="mt-owners">${Object.entries(d.byOwner).sort((x, y) => y[1] - x[1]).map(([o, k]) => `<li><b>${esc(o)}</b><span class="muted">${k} milestone${k === 1 ? '' : 's'}</span></li>`).join('')}</ul><button type="button" class="btn btn-ghost btn-sm" data-mt="remind">Email reminders</button>`; }
  else if (cur.ids && cur.ids.length) detail = mtMsList(cur.ids, 15) + (cur.key === 'issues' ? '<button type="button" class="btn btn-ghost btn-sm" data-mt="openissues">Open all in Milestones</button>' : '');
  else if (cur.kind === 'Review') detail = '<p class="mt-empty">Nothing to review here</p>';
  const acts = (cur.actions || []).map(a => actionRow(Object.assign({ live: true }, a), !ro)).join('');
  sec.innerHTML = `<div class="mt-page mt-run"><div class="sr-only" id="mtAnnounce" aria-live="polite"></div>
    <header class="mt-runbar">
      <div class="mt-runbar-l"><span class="mt-pulse"></span><b>Meeting in progress</b><span class="muted">Started ${Date.now() - new Date(L.startedAt) > 12 * 3600000 ? esc(fmtDate(L.startedAt.slice(0, 10))) + ', ' : ''}${esc(new Date(L.startedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</span><span class="mt-clock" id="mtClock" role="timer" aria-label="Time elapsed">0:00</span><span class="mt-plan" id="mtPlan"></span></div>
      <div class="mt-runbar-r">${ro ? '<span class="mt-tag">View only</span><button class="btn btn-ghost" data-mt="unfollow">Back to agenda</button>' : `<button class="btn btn-ghost" data-mt="pause">Back to agenda</button><button class="btn btn-ghost" data-mt="discard">Discard</button><button class="btn btn-danger" data-mt="end">End meeting</button>`}</div>
    </header>
    <div class="mt-prog" role="progressbar" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${doneN}" aria-label="Items discussed"><div class="mt-prog-l"><span>${doneN} of ${n} discussed</span><span>${pctDone}%</span></div><div class="mt-prog-track"><span style="width:${pctDone}%"></span></div></div>
    ${ro ? (L.attendees ? `<p class="mt-attend-ro">Attending: ${esc(L.attendees)}</p>` : '') : `<div class="field mt-attend"><label for="mtAttend">Attending</label><input id="mtAttend" data-mt-attend value="${esc(L.attendees || '')}" placeholder="Names, separated by commas"></div>`}
    <div class="mt-run-grid">
      <nav class="mt-steps" aria-label="Agenda"><ol>${steps}</ol>${ro ? '' : '<button type="button" class="btn btn-ghost btn-sm mt-add-live" data-mt="addlive">+ Add an item</button>'}</nav>
      <section class="mt-card mt-cur">
        <div class="mt-cur-head"><div><div class="mt-cur-n">Item ${L.idx + 1} of ${n} <span class="mt-tag ${cur.kind === 'Topic' ? 'mt-tag-blue' : ''}">${cur.kind}</span></div><h3 class="mt-cur-t" id="mtCurT" tabindex="-1">${esc(cur.title)}</h3>${cur.owner || cur.sum ? `<p class="mt-item-s">${esc([cur.owner ? 'Lead: ' + cur.owner : '', cur.key === 'updates' || cur.key === 'actions' ? '' : cur.sum].filter(Boolean).join(' · '))}</p>` : ''}</div>
          <div class="mt-cur-time"><span class="mt-item-clock" id="mtItemClock" role="timer" aria-label="Time on this item">0:00</span><span class="muted">of ${cur.mins} min</span></div></div>
        <div class="mt-cur-detail">${detail}</div>
        <div class="field"><label for="mtDecision">Decision</label><input id="mtDecision" data-mt-decision maxlength="300" value="${esc(cur.decision || '')}" ${ro ? 'readonly' : ''}></div>
        <div class="field"><label for="mtNotes">Notes <span class="mt-saved" id="mtNotesSaved" aria-live="polite"></span></label><textarea id="mtNotes" rows="4" data-mt-notes ${ro ? 'readonly' : ''}>${esc(cur.notes || '')}</textarea></div>
        <div class="mt-cur-acts"><h4>Action items</h4>${acts ? `<ul class="mt-acts">${acts}</ul>` : ''}
          ${ro ? '' : `<form class="mt-add-row" data-mt-actform><div class="field"><label for="mtActText">Action</label><input id="mtActText" name="text" maxlength="200" placeholder="What needs to happen" required></div>
            <div class="field"><label for="mtActOwner">Owner</label><select id="mtActOwner" name="owner">${ownerOptions(cur.owner || '')}</select></div>
            <div class="field"><label for="mtActDue">Due</label><input id="mtActDue" name="due" type="date" min="${todayISO()}" value="${esc(mtg().next && mtg().next > todayISO() ? mtg().next : nextMeetingAfter(todayISO()))}"></div>
            <button class="btn btn-tonal" type="submit">Add action</button></form>`}</div>
        ${L.idx < n - 1 ? `<p class="mt-nextup">Next up: <b>${esc(L.items[L.idx + 1].title)}</b></p>` : ''}
        ${ro ? '' : `<div class="mt-cur-foot"><button class="btn btn-ghost" data-mt="prev" ${L.idx === 0 ? 'disabled' : ''}>Previous</button>
          <span class="mt-foot-r">${!cur.done && L.idx < n - 1 ? '<button class="btn btn-ghost" data-mt="skip">Skip for now</button>' : ''}${doneN === n ? '<button class="btn btn-filled" data-mt="end">End meeting</button>' : `<button class="btn btn-filled" data-mt="next">${cur.done ? (L.idx === n - 1 ? 'Discussed' : 'Next item') : (L.idx === n - 1 ? 'Done' : 'Done, next item')}</button>`}</span></div>`}
      </section>
    </div>
  </div>`;
  tickMt(); if (!mtTimer) mtTimer = setInterval(tickMt, 1000);
  renderCtxBar();
}
function mtSwitch(i) { const L = mbook().live; if (!L) return; const cur = L.items[L.idx]; if (cur) cur.spent = (cur.spent || 0) + (Date.now() - (L.itemStart || Date.now())); L.idx = i; L.itemStart = Date.now(); autosave(); renderMeetings(); window.scrollTo({ top: 0 });
  const h = $('#mtCurT'); if (h) h.focus({ preventScroll: true }); const a = $('#mtAnnounce'); if (a) a.textContent = `Item ${i + 1} of ${L.items.length}: ${L.items[i].title}`; }
function startMeeting(sure) {
  if (!guardAdmin()) return;
  const nx = mtg().next; if (!sure && nx && daysUntil(nx) > 1) return confirmDialog({ title: 'Start the meeting now?', message: `The next meeting is set for ${esc(fmtDate(nx))}`, confirmLabel: 'Start now', onConfirm: () => startMeeting(true) });
  const b = mbook(), items = agendaItems(); if (!items.length) return toast('Add a topic or include a section first', 'warn');
  b.live = { by: currentDisplayName() || '', startedAt: new Date().toISOString(), idx: 0, itemStart: Date.now(), items: items.map(x => ({ key: x.key, kind: x.kind, title: x.title, mins: x.mins, sum: x.sum, owner: x.owner || '', ids: x.ids || [], topicId: x.topicId || null, notes: '', actions: [], done: false, spent: 0 })) };
  state.mtRun = true; logActivity('edit', 'Started the committee meeting'); autosave(); renderMeetings(); renderNavCounts();
}
function endMeeting() {
  const b = mbook(), L = b.live; if (!L || !guardAdmin()) return;
  const left = L.items.filter(x => !x.done).length;
  confirmDialog({ title: 'End the meeting?', message: `Saves the minutes and marks the meeting held.${left ? ` ${left} item${left === 1 ? ' is' : 's are'} not marked discussed. Topics not discussed move to the next agenda.` : ''}`, confirmLabel: 'End meeting', onConfirm: () => {
    const before = clone(b), mtBefore = clone(mtg()), cur = L.items[L.idx];
    if (cur) cur.spent = (cur.spent || 0) + (Date.now() - (L.itemStart || Date.now()));
    const rec = { id: uid(), date: todayISO(), by: L.by || '', attendees: (L.attendees || '').trim(), startedAt: L.startedAt, endedAt: new Date().toISOString(), items: L.items.map(x => ({ title: x.title, kind: x.kind, done: !!x.done, decision: (x.decision || '').trim(), notes: (x.notes || '').trim(), actions: x.actions || [], spent: x.spent || 0 })) };
    b.minutes.unshift(rec); b.minutes = b.minutes.slice(0, 24);
    const discussed = new Set(L.items.filter(x => x.done && x.topicId).map(x => x.topicId)); b.topics = b.topics.filter(t => !discussed.has(t.id));
    b.live = null; state.mtRun = false; state.mtJustEnded = rec.id; stopMtTimer();
    const today = mmList().find(x => x.date === todayISO()); if (today) { today.minutesId = rec.id; rec.meetingId = today.id; }   // ties the run to its calendar entry
    const mt = mtg(); mt.last = todayISO(); if (!(mt.next && mt.next > mt.last)) mt.next = nextMeetingAfter(mt.last); mmSyncNext(); rec.next = mt.next;
    logActivity('edit', `Held the committee meeting (${rec.items.filter(x => x.done).length} of ${rec.items.length} items)`);
    autosave(); rerender(); renderNavCounts();
    toastAction(`Minutes saved. Next meeting ${fmtDate(mt.next)}`, 'Undo', () => { meta().meetBook = before; meta().meeting = mtBefore; state.mtRun = true; autosave(); rerender(); renderNavCounts(); });
  } });
}
function actionToMilestone(id, quiet) {
  const a = findAction(id); if (!a || a.milestoneId || !guardEdit()) return;
  const dm = state.filters.markets.size === 1 ? [...state.filters.markets][0] : '', tally = {};
  M().filter(x => a.owner && ownsM(x, a.owner)).forEach(x => { tally[x.functional_area] = (tally[x.functional_area] || 0) + 1; });
  const dt = Object.keys(tally).sort((x, y) => tally[y] - tally[x])[0] || defaultTeam();   // the owner's usual team
  const m = { id: uid(), state: stateOfMarket(dm) || '', market: dm, team: dt, functional_area: dt, workstream: 'General', activity: a.text, schools: [], schoolIds: [], targetFY: currentFY(), targetQuarter: '', openingFY: null, due_date: a.due || null, owner: a.owner || '', coOwners: [], status: 'not_started', progress_percent: 0, priority: 'medium', stage: 'to_do', notes: `From the ${fmtDate(a.meeting || todayISO())} committee meeting`, dependency: '', createdAt: new Date().toISOString() };
  snapshotForUndo('Milestone from action: ' + a.text.slice(0, 30));
  M().push(m); syncFiscal(m); touch(m); a.milestoneId = m.id;
  logActivity('create', `Added "${m.activity}" from a meeting action`, { itemId: m.id }); if (quiet) return;
  autosave(); renderMeetings(); toastAction('Added as a milestone', 'Open', () => openModal(m.id));
}
let mtNotesT = 0;
['pagehide', 'visibilitychange'].forEach(ev => window.addEventListener(ev, () => { if (mtNotesT && (ev === 'pagehide' || document.visibilityState === 'hidden')) { clearTimeout(mtNotesT); mtNotesT = 0; autosaveWriteLocal(); if (state.sb && state.sb.connected) sbPush(); } }));
document.addEventListener('keydown', e => {
  if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && $('.mt-run') && !$('.mt-run [data-mt-go][disabled]') && mbook().live) { const L = mbook().live, j = L.idx + (e.key === 'ArrowRight' ? 1 : -1); if (j >= 0 && j < L.items.length) { e.preventDefault(); mtSwitch(j); } return; }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && e.target.matches && e.target.matches('[data-mt-notes]') && isAdmin()) { e.preventDefault(); const n = $('[data-mt="next"]'); if (n) n.click(); }
});
document.addEventListener('input', e => {
  if (e.target.matches && e.target.matches('[data-mt-decision]')) { const L = mbook().live; if (L && isAdmin()) { L.items[L.idx].decision = e.target.value; clearTimeout(mtNotesT); mtNotesT = setTimeout(autosave, 600); } return; }
  if (e.target.matches && e.target.matches('[data-mt-attend]')) { const L = mbook().live; if (L && isAdmin()) { L.attendees = e.target.value.slice(0, 400); clearTimeout(mtNotesT); mtNotesT = setTimeout(autosave, 600); } return; }
  if (!e.target.matches || !e.target.matches('[data-mt-notes]')) return;
  const L = mbook().live; if (!L || !isAdmin()) return;
  L.items[L.idx].notes = e.target.value; clearTimeout(mtNotesT); const st = $('#mtNotesSaved'); if (st) st.textContent = 'Saving';
  mtNotesT = setTimeout(() => { autosave(); const s2 = $('#mtNotesSaved'); if (s2) s2.textContent = 'Saved'; }, 600);
});
document.addEventListener('change', e => {
  const t = e.target; if (!t.dataset) return;
  if (t.dataset.mtMins) { if (!guardAdmin()) return; const v = Math.max(1, Math.min(120, Math.round(+t.value) || 10)), k = t.dataset.mtMins, b = mbook(); if (k.startsWith('t:')) { const tp = b.topics.find(x => 't:' + x.id === k); if (tp) tp.mins = v; } else b.mins[k] = v; autosave(); renderMeetings(); const again = document.querySelector(`[data-mt-mins="${k}"]`); if (again) again.focus(); }
  if (t.dataset.mtActdone) { if (!guardAdmin()) return; const a = findAction(t.dataset.mtActdone); if (a) { a.done = t.checked; autosave(); renderMeetings(); } }
});
document.addEventListener('submit', e => {
  const f = e.target;
  if (f.matches('[data-mt-form]')) { e.preventDefault(); if (!guardAdmin()) return; const title = f.title.value.trim(); if (!title) return markInvalid(f.title, 'Name the topic'); mbook().topics.push({ id: uid(), title, owner: f.owner.value, mins: Math.max(1, Math.min(120, +f.mins.value || 10)) }); autosave(); renderMeetings(); toast('Topic added', 'ok'); setTimeout(() => { const i = $('#mtTopic'); if (i) i.focus(); }, 0); }
  if (f.matches('[data-mt-actform]')) { e.preventDefault(); const L = mbook().live; if (!L || !guardAdmin()) return; const text = f.text.value.trim(); if (!text) return markInvalid(f.text, 'Say what needs to happen'); const cur = L.items[L.idx]; (cur.actions = cur.actions || []).push({ id: uid(), text, owner: f.owner.value, due: f.due.value || '', done: false }); autosave(); renderMeetings(); setTimeout(() => { const i = $('#mtActText'); if (i) i.focus(); }, 0); }
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-mt],[data-mt-go],[data-mt-up],[data-mt-down],[data-mt-del],[data-mt-edit],[data-mt-hide],[data-mt-show],[data-mt-copymin],[data-mt-mailmin],[data-mt-delmin],[data-mt-actdel],[data-mt-editmin],[data-mt-printmin],[data-mt-allms],[data-mt-tomilestone]'); if (!t) return;
  const b = mbook(), ds = t.dataset, move = (id, dir) => { const i = b.topics.findIndex(x => x.id === id), j = i + dir; if (i < 0 || j < 0 || j >= b.topics.length) return; [b.topics[i], b.topics[j]] = [b.topics[j], b.topics[i]]; autosave(); renderMeetings(); };
  if (ds.mtGo != null) return mtSwitch(+ds.mtGo);
  if (ds.mtUp) return guardAdmin() && moveAgendaItem(ds.mtUp, -1);
  if (ds.mtDown) return guardAdmin() && moveAgendaItem(ds.mtDown, 1);
  if (ds.mtDel) { if (!guardAdmin()) return; const tp = b.topics.find(x => x.id === ds.mtDel), i = b.topics.indexOf(tp); b.topics.splice(i, 1); autosave(); renderMeetings(); return toastAction('Topic removed', 'Undo', () => { b.topics.splice(i, 0, tp); autosave(); renderMeetings(); }); }
  if (ds.mtEdit) { if (!guardAdmin()) return; const tp = b.topics.find(x => x.id === ds.mtEdit); if (!tp) return; return topicDialog(tp); }
  if (ds.mtHide) { if (!guardAdmin()) return; const k = ds.mtHide; b.include[k] = false; autosave(); renderMeetings(); return toastAction(`${MT_AUTO[k][0]} left out`, 'Undo', () => { b.include[k] = true; autosave(); renderMeetings(); }); }
  if (ds.mtShow) { if (!guardAdmin()) return; const k = ds.mtShow; b.include[k] = true; autosave(); renderMeetings(); const row = document.querySelector(`.mt-item[data-mtkey="${k}"]`); if (row) { row.scrollIntoView({ block: 'nearest' }); const bt = row.querySelector('button'); if (bt) bt.focus(); } return; }
  if (ds.mtDelmin) { if (!guardAdmin()) return; const i = b.minutes.findIndex(x => x.id === ds.mtDelmin); if (i < 0) return; const rec = b.minutes[i]; return confirmDialog({ title: `Delete the ${fmtDate(rec.date)} minutes?`, message: 'Their action items go too', confirmLabel: 'Delete', danger: true, onConfirm: () => { b.minutes.splice(i, 1); autosave(); renderMeetings(); toastAction('Minutes deleted', 'Undo', () => { b.minutes.splice(i, 0, rec); autosave(); renderMeetings(); }); } }); }
  if (ds.mtEditmin) { if (!guardAdmin()) return; const rec = b.minutes.find(x => x.id === ds.mtEditmin); if (!rec) return;
    const w = openSheet(`Edit minutes, ${fmtDate(rec.date)}`, `<div class="field"><label for="emAtt">Attending</label><input id="emAtt" value="${esc(rec.attendees || '')}"></div>` + (rec.items || []).map((it, i) => `<fieldset class="em-item"><legend>${i + 1}. ${esc(it.title)}</legend><div class="field"><label for="emD${i}">Decision</label><input id="emD${i}" maxlength="300" value="${esc(it.decision || '')}"></div><div class="field"><label for="emN${i}">Notes</label><textarea id="emN${i}" rows="3">${esc(it.notes || '')}</textarea></div></fieldset>`).join(''), '<button class="btn btn-text" data-sheet-close>Cancel</button><button class="btn btn-filled" id="emSave">Save minutes</button>');
    return $('#emSave').addEventListener('click', () => { const before = clone(rec); rec.attendees = $('#emAtt').value.trim(); (rec.items || []).forEach((it, i) => { it.decision = $('#emD' + i).value.trim(); it.notes = $('#emN' + i).value.trim(); }); rec.edited = new Date().toISOString(); closeSheet(); autosave(); renderMeetings(); toastAction('Minutes updated', 'Undo', () => { Object.assign(rec, before); autosave(); renderMeetings(); }); }); }
  if (ds.mtPrintmin) { const rec = b.minutes.find(x => x.id === ds.mtPrintmin); if (!rec) return; const wnd = window.open('', '_blank'); if (!wnd) return toast('Allow pop-ups to print minutes', 'warn'); wnd.document.write(`<!doctype html><title>Minutes ${esc(fmtDate(rec.date))}</title><style>body{font:14px/20px 'IBM Plex Sans',Arial,sans-serif;margin:40px;color:#161616}pre{white-space:pre-wrap;font:inherit}</style><pre>${esc(minutesText(rec))}</pre>`); wnd.document.close(); wnd.focus(); wnd.print(); return; }
  if (ds.mtAllms) { if (!guardAdmin()) return; const rec = b.minutes.find(x => x.id === ds.mtAllms); if (!rec) return; const todo = (rec.items || []).flatMap(x => x.actions || []).filter(a => !a.milestoneId && !actionDone(a)); return confirmDialog({ title: `Make ${todo.length} action${todo.length === 1 ? '' : 's'} into milestones?`, message: 'Each gets its owner and due date, and shows up on the board', confirmLabel: 'Make milestones', onConfirm: () => { todo.forEach(a => actionToMilestone(a.id, true)); autosave(); renderMeetings(); toast(`${todo.length} milestone${todo.length === 1 ? '' : 's'} added`, 'ok'); } }); }
  if (ds.mtMailmin) { const rec = b.minutes.find(x => x.id === ds.mtMailmin); if (!rec) return; const to = [...new Set([...(rec.items || []).flatMap(x => (x.actions || []).map(a => a.owner)), ...rosterNames()])].map(ownerEmail).filter(Boolean); return openMail(to, `Committee meeting minutes, ${fmtDate(rec.date)}`, minutesText(rec)); }
  if (ds.mtCopymin) { const rec = b.minutes.find(x => x.id === ds.mtCopymin); return rec && copyText(minutesText(rec), 'Minutes copied'); }
  if (ds.mtTomilestone) return actionToMilestone(ds.mtTomilestone);
  if (ds.mtActdel) { const L2 = b.live; if (!L2 || !guardAdmin()) return; const it = L2.items[L2.idx], k = (it.actions || []).findIndex(a => a.id === ds.mtActdel); if (k < 0) return; const gone = it.actions.splice(k, 1)[0]; autosave(); renderMeetings(); return toastAction('Action removed', 'Undo', () => { it.actions.splice(k, 0, gone); autosave(); renderMeetings(); }); }
  const L = b.live;
  switch (ds.mt) {
    case 'start': return startMeeting();
    case 'openissues': state.mtRun = false; clearFilters(); state.planFocus = true; return setView('plan');
    case 'mailagenda': { const it = agendaItems(); if (!it.length) return toast('The agenda is empty', 'warn'); return openMail(rosterNames().map(ownerEmail).filter(Boolean), `Committee meeting agenda${mtg().next ? ', ' + fmtDate(mtg().next) : ''}`, agendaText(it)); }
    case 'suggest': return openMail([], 'Topic for the next committee meeting', `Topic:\n\nWhy it needs the committee:\n\nPre-read or link:\n\n${location.origin}${location.pathname}#meetings`);
    case 'addlive': if (!guardAdmin() || !L) return; return inputDialog({ title: 'Add an item to this meeting', placeholder: 'For example: New business, Paterson budget' }, v => { L.items.push({ key: 'live:' + uid(), kind: 'Topic', title: v.slice(0, 140), mins: 5, sum: '', owner: '', ids: [], topicId: null, notes: '', actions: [], done: false, spent: 0 }); autosave(); mtSwitch(L.items.length - 1); });
    case 'allacts': state.mtAllActs = true; return renderMeetings();
    case 'resume': state.mtRun = true; return renderMeetings();
    case 'pause': state.mtRun = false; return renderMeetings();
    case 'follow': state.mtFollow = true; return renderMeetings();
    case 'takeover': if (!guardAdmin() || !L) return; return confirmDialog({ title: 'Take over this meeting?', message: `${esc(L.by || 'Someone')} started it. You will run it from here`, confirmLabel: 'Take over', onConfirm: () => { L.by = currentDisplayName() || ''; state.mtTookOver = true; state.mtRun = true; autosave(); renderMeetings(); } });
    case 'unfollow': state.mtFollow = false; return renderMeetings();
    case 'end': return endMeeting();
    case 'discard': if (!guardAdmin() || !L) return; return confirmDialog({ title: 'Discard this meeting?', message: 'Notes and action items from this run are not saved, and the meeting is not marked held', confirmLabel: 'Discard', danger: true, onConfirm: () => { const keep = clone(L); b.live = null; state.mtRun = false; stopMtTimer(); autosave(); renderMeetings(); renderNavCounts(); toastAction('Meeting discarded', 'Undo', () => { mbook().live = keep; state.mtRun = true; autosave(); renderMeetings(); renderNavCounts(); }); } });
    case 'copy': { const it = agendaItems(); return it.length ? copyText(agendaText(it), 'Agenda copied') : toast('The agenda is empty', 'warn'); }
    case 'print': document.body.classList.add('print-meeting'); window.addEventListener('afterprint', () => document.body.classList.remove('print-meeting'), { once: true }); return window.print();
    case 'date': if (!guardAdmin()) return; { const nx = mmUpcoming()[0]; return mmScheduleDialog(nx || null, nx ? null : nextMeetingAfter(todayISO())); }
    case 'actions': { const el = $('#mtActions'); return el && el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    case 'remind': { const st = meetingData().stale; return openMail([...new Set(st.flatMap(ownersOf))].map(ownerEmail).filter(Boolean), 'Causeway check-ins before our next meeting', reminderText(st)); }
    case 'prev': return L && mtSwitch(L.idx - 1);
    case 'skip': return L && mtSwitch(L.idx + 1);
    case 'next': if (!L) return; L.items[L.idx].done = true; if (L.idx < L.items.length - 1) return mtSwitch(L.idx + 1); autosave(); renderMeetings(); return toast('All items discussed. End the meeting to save the minutes', 'ok');
  }
});

['input', 'change'].forEach(t => document.addEventListener(t, e => { if (e.target.closest && e.target.closest('#modalBody')) paintDialogProgress(); }));
document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#modalBody .cp-del, #modalBody .tg-del, #modalBody #tgOffBtn, #modalBody #tgStart, #modalBody #cpSuggest')) setTimeout(paintDialogProgress, 0); });
/* ---------- Progress bar (Nov 18 2026): one Carbon progress bar for cards and the milestone dialog.
   Label and value on top, bar, then helper text. Bar color = status color. ---------- */
function progressInfo(m) {
  const es = effectiveStatus(m), tg = activeTarget(m), steps = m.checkpoints || [], color = SM(es).color;
  if (es === 'complete') return { pct: 100, label: tg ? tg.label : 'Progress', value: tg ? `${tg.total} of ${tg.total}` : '100%', helper: 'Complete', color, es };
  if (tg) {
    const pace = targetPace(m), pct = tgProgress(tg);
    const helper = pace.behind ? `Behind pace: ${pace.passed.goal} due by ${fmtDate(pace.passed.due)}` : pace.next ? `Next: ${pace.next.goal} by ${fmtDate(pace.next.due)}` : '';
    return { pct, label: tg.label, value: `${+tg.done || 0} of ${tg.total}`, helper, error: !!pace.behind, color, es };
  }
  if (measureOf(m) === 'steps' && steps.length) {
    const d = steps.filter(c => c.done).length, late = missedCheckpoints(m).length, pct = cpProgress(m);
    return { pct, label: 'Progress', value: pct + '%', helper: late ? `${late} step${late === 1 ? '' : 's'} overdue · ${d} of ${steps.length} done` : `${d} of ${steps.length} steps done`, error: !!late, color, es };
  }
  const pct = Math.max(0, Math.min(100, Math.round(+m.progress_percent || 0)));
  return { pct, label: 'Progress', value: pct + '%', helper: '', color, es };
}
function progressBar(info, id, size) {
  return `<div class="cds-pb cds-pb--${size || 'big'}">
    <div class="cds-pb__top"><span class="cds-pb__label" id="${id}">${esc(info.label)}</span><span class="cds-pb__value">${esc(info.value)}</span></div>
    <div class="cds-pb__track" role="progressbar" aria-labelledby="${id}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${info.pct}" aria-valuetext="${esc(info.value + (info.helper ? '. ' + info.helper : ''))}"><div class="cds-pb__bar" style="width:${info.pct}%;background:${info.color}"></div></div>
    ${info.helper ? `<div class="cds-pb__helper ${info.error ? 'is-error' : ''}">${info.error ? '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.5 3h1v5.5h-1zM8 12.25a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z"/></svg>' : ''}<span>${esc(info.helper)}</span></div>` : ''}
  </div>`;
}
// The milestone as it stands in the open dialog, so the bar updates while someone types
function dialogDraft() {
  const m = findM(modalId); if (!m) return null;
  const tv = liveTarget(), sel = $('#mStatus');
  const msr = ($('input[name="mMeasure"]:checked') || {}).value || measureOf(m);
  return { ...m, measure: msr, status: sel ? sel.value : m.status, due_date: ($('#mDue') || {}).value || null, progress_percent: +(($('#mProg') || {}).value || 0),
    target: tv && tv.total ? tv : null, schoolIds: tv && tv.total ? ['x'] : (m.schoolIds || []),
    checkpoints: $$('#cpList .cp-row').map(r => ({ title: r.querySelector('.cp-title').value.trim(), due: r.querySelector('.cp-due').value || null, done: r.querySelector('.cp-done').checked })).filter(c => c.title) };
}
function paintDialogProgress() {
  const box = $('#mPb'), d = dialogDraft(); if (!box || !d) return;
  const info = progressInfo(d); box.innerHTML = progressBar(info, 'mPbL', 'big');
  const spl = $('#tgSplitOn'), split = !!(spl && spl.checked);
  if ($('#tgSchoolGoals')) $('#tgSchoolGoals').hidden = !split;
  if ($('#tgSchoolDone')) $('#tgSchoolDone').hidden = !split;
  if ($('#tgTotal')) $('#tgTotal').readOnly = split;
  if ($('#tgDone')) { $('#tgDone').readOnly = split; const f = $('#tgDone').closest('.field'); if (f) f.classList.toggle('is-sum', split); }
  const chart = $('#tgChart'); if (chart) chart.innerHTML = d.measure === 'count' && d.target ? paceChart({ ...d, target: { ...d.target, log: ((findM(modalId) || {}).target || {}).log || [] } }) : '';
  const ms = d.measure, calc = ms !== 'percent', pw = $('#mProgWrap');
  if (pw) pw.hidden = ms !== 'percent';
  const sw = $('#mStepsWrap'); if (sw) sw.hidden = ms !== 'steps';
  const cw = $('#mCountWrap'); if (cw) cw.hidden = ms !== 'count';
  const cn = $('#cpNote'); if (cn) cn.hidden = true;
  const tdl = $('label[for="tgDone"]'); if (tdl) tdl.textContent = ((($('#tgLabel') || {}).value || '').trim() || 'Count') + ' so far';
  $$('#tgList .tg-row').forEach(r => { const v = r.querySelector('.tg-due').value; r.querySelector('.cp-del').setAttribute('aria-label', v ? `Remove the ${fmtDate(v)} checkpoint` : 'Remove this checkpoint'); });
  $$('#cpList .cp-row').forEach(r => { const v = r.querySelector('.cp-title').value.trim(); r.querySelector('.cp-del').setAttribute('aria-label', v ? `Remove step: ${v}` : 'Remove this step'); });
  const h = $('#mStatusHelp'); if (h) {
    const saved = d.status, shown = info.es;
    h.textContent = saved !== shown && !['complete', 'blocked'].includes(saved) ? `Showing ${SM(shown).label}: ${info.error ? 'behind pace' : 'near or past the due date'}` : calc ? `Progress comes from ${activeTarget(d) ? activeTarget(d).label.toLowerCase() : 'steps'}` : 'Updates on its own near or past the due date';
    h.classList.toggle('is-warn', saved !== shown && !['complete', 'blocked'].includes(saved));
  }
}

// Chips (Nov 18 2026): one look for schools, due dates and progress everywhere (cards, tables, lists)
const CAL_IC = '<svg viewBox="0 0 32 32" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M26 4h-4V2h-2v2h-8V2h-2v2H6a2 2 0 0 0-2 2v20a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 22H6V12h20zm0-16H6V6h4v2h2V6h8v2h2V6h4z"/></svg>';
const ERR_IC = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.5 3h1v5.5h-1zM8 12.25a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z"/></svg>';
function schoolChip(mk, labels) { return `<span class="kc-school">${mk ? `<span class="kc-mk"><i style="background:${mkColor(mk)}"></i>${esc(mk)}</span>` : ''}${(labels || []).map(x => `<span class="kc-sc">${esc(x)}</span>`).join('')}</span>`; }
function schoolGroups(m) {
  const byMk = {};
  (m.schoolIds || []).map(schoolById).filter(Boolean).forEach(x => (byMk[x.market] = byMk[x.market] || []).push(schLbl(x)));
  if (!Object.keys(byMk).length && (m.schools || []).length) byMk[m.market || ''] = m.schools.filter(Boolean);
  return byMk;
}
function schoolChips(m) {
  const sc = (m.schoolIds || []).map(schoolById).filter(Boolean), mk = sc.length ? sc[0].market : m.market;
  const legacy = !sc.length && (m.schools || []).filter(Boolean);
  const txt = sc.length ? schLbl(sc[0]) + (sc.length > 1 ? ` +${sc.length - 1}` : '') : legacy && legacy.length ? legacy[0] + (legacy.length > 1 ? ` +${legacy.length - 1}` : '') : (m.market || 'Network-wide');
  const tip = sc.length > 1 ? sc.map(x => x.market + ' · ' + schLbl(x)).join('\n') : sc.length ? sc[0].market + ' · ' + schLbl(sc[0]) : '';
  return `<span class="kc-chips"><span class="sc-tag"${tip ? ` title="${esc(tip)}"` : ''}>${mk ? `<i style="background:${mkColor(mk)}" aria-hidden="true"></i>` : ''}<span>${esc(txt)}</span></span></span>`;
}
function dueChip(m) {
  const done = m.status === 'complete', hist = m.dateHistory || [], d = daysUntil(m.due_date);
  const txt = done ? (m.completedAt ? 'Done ' + fmtDate(m.completedAt.slice(0, 10)) : 'Done') : !m.due_date ? 'No due date' : d < 0 ? `${-d} day${d === -1 ? '' : 's'} late` : fmtDate(m.due_date);
  const tip = [!done && m.due_date && d < 0 ? 'Due ' + fmtDate(m.due_date) : '', hist.length ? `${slipSummary(m)}: ` + hist.map(h => `${fmtDate(h.from)} → ${fmtDate(h.to)}${h.reason ? ' (' + h.reason + ')' : ''}`).join('; ') : ''].filter(Boolean).join('. ');
  return `<span class="due-txt ${!done && d < 0 ? 'is-late' : !m.due_date && !done ? 'is-empty' : done ? 'is-done' : ''}" ${tip ? `title="${esc(tip)}"` : ''}>${CAL_IC}<span>${esc(txt)}</span>${hist.length && !done ? `<span class="kc-moved">moved ${hist.length}×</span>` : ''}</span>`;
}
function pctChip(pct, value, color, label) {
  return `<span class="kc-chip kc-chip-pb"><span class="kc-mini" role="progressbar" aria-label="${esc(label || 'Progress')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-valuetext="${esc(value)}"><i style="width:${pct}%;background:${color}"></i></span>${esc(value)}</span>`;
}
function progressChip(m) { const info = progressInfo(m); return pctChip(info.pct, info.value, info.color, info.label); }

// Forms (Nov 18 2026): link each .field label to its control and name placeholder-only inputs, everywhere, after every render
function linkFieldLabels(root) {
  (root || document).querySelectorAll('.field > label:not([for]), .field-row .field > label:not([for])').forEach(l => {
    const c = l.parentElement.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea'); if (!c) return;
    if (!c.id) c.id = 'f-' + Math.random().toString(36).slice(2, 9); l.htmlFor = c.id;
  });
  (root || document).querySelectorAll('input[placeholder]:not([aria-label]):not([aria-labelledby]), textarea[placeholder]:not([aria-label]):not([aria-labelledby])').forEach(c => {
    if (c.id && document.querySelector(`label[for="${c.id}"]`)) return; c.setAttribute('aria-label', c.placeholder);
  });
}
let _lfl = 0; new MutationObserver(() => { if (_lfl) return; _lfl = requestAnimationFrame(() => { _lfl = 0; linkFieldLabels(); }); }).observe(document.documentElement, { childList: true, subtree: true });

// Sub-milestone audit fixes (Nov 18 2026)
function targetHistory(t) {
  const log = ((t && t.log) || []).slice().reverse(); if (!log.length) return '<div class="help-text tg-hist" id="tgHist">No updates yet</div>';
  const one = x => `${x.done} on ${fmtDate(x.t.slice(0, 10))}${x.by ? ' by ' + esc(x.by.split(' ')[0]) : ''}`;
  return `<div class="help-text tg-hist" id="tgHist">Last update: ${one(log[0])}${log.length > 1 ? `<details class="tg-hist-more"><summary>History (${log.length})</summary><ul>${log.map(x => `<li>${one(x)}</li>`).join('')}</ul></details>` : ''}</div>`;
}
// Month-end checkpoints from now to the due date, the last one equal to the goal
function spreadLadder(total, due) {
  const out = [], end = parseDate(due), d = today(); let y = d.getFullYear(), mo = d.getMonth();
  const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const dates = [];
  while (dates.length < 12) { const last = new Date(y, mo + 1, 0); if (last >= end) break; if (last > d) dates.push(iso(last)); mo++; if (mo > 11) { mo = 0; y++; } }
  dates.push(due);
  const keep = dates.length > 6 ? dates.filter((_, i) => (dates.length - 1 - i) % Math.ceil(dates.length / 6) === 0) : dates;
  return keep.map((dt, i) => ({ id: uid(), due: dt, goal: Math.round(total * (i + 1) / keep.length) }));
}
function openTargetUpdate(id) {
  if (!guardEdit()) return; const m = findM(id), t = activeTarget(m); if (!t) return;
  const pace = targetPace(m);
  const w = openSheet(`Update ${t.label.toLowerCase()}`, `<p class="modal-lede">${esc(m.activity)}</p>
    ${paceChart(m)}
    ${t.bySchool ? `<div class="field"><div class="tg-qlbl">${esc(t.label)} so far, by school</div>${Object.entries(t.bySchool).map(([sid, v]) => { const x = schoolById(sid); return x ? `<div class="tg-srow"><span class="tg-sname">${schoolChip(x.market, [schLbl(x)])}</span><label class="sr-only" for="tgq-${esc(sid)}">${esc(schLbl(x))} so far</label><input id="tgq-${esc(sid)}" class="tgq-s" data-sid="${esc(sid)}" type="number" min="0" step="1" inputmode="numeric" value="${+v.done || 0}"><span class="tg-sgoal">of ${v.total}</span></div>` : ''; }).join('')}</div><input type="hidden" id="tgQuick" value="${+t.done || 0}">`
    : `<div class="field"><label for="tgQuick">${esc(t.label)} so far</label><input id="tgQuick" type="number" min="0" step="1" inputmode="numeric" value="${+t.done || 0}"></div>`}
    <div class="help-text tg-qhelp">Goal ${t.total}${pace.next ? ` · next checkpoint ${pace.next.goal} by ${esc(fmtDate(pace.next.due))}` : ''}</div>
    ${targetHistory(t)}`, `<button class="btn btn-text" data-sheet-close>Cancel</button><button class="btn btn-filled" id="tgQuickSave">Save</button>`);
  const inp = w.querySelector('#tgQuick'), sIn = [...w.querySelectorAll('.tgq-s')];
  setTimeout(() => { const f = sIn[0] || inp; f.focus(); f.select && f.select(); }, 30);
  const save = () => {
    if (sIn.length) { sIn.forEach(i => { t.bySchool[i.dataset.sid].done = Math.max(0, Math.round(+i.value || 0)); }); inp.value = sIn.reduce((a, i) => a + Math.max(0, Math.round(+i.value || 0)), 0); }
    const v = Math.max(0, Math.round(+inp.value)); if (inp.value === '' || isNaN(v)) { markInvalid(inp, 'Enter a number'); return; }
    if (v === +t.done && !sIn.length) { closeSheet(); return; }
    snapshotForUndo(`Update ${t.label.toLowerCase()}: ${clip(m.activity, 30)}`);
    const prev = +t.done || 0; t.done = v; t.log = (t.log || []).slice(-50); t.log.push({ t: new Date().toISOString(), by: currentDisplayName() || '', done: v, ...(t.bySchool ? { bySchool: JSON.parse(JSON.stringify(t.bySchool)) } : {}) });
    if (m.status !== 'complete') m.progress_percent = tgProgress(t);
    touch(m); logActivity('update', `${t.label}: ${prev} → ${v} on "${m.activity}"`, { itemId: m.id }); autosave(); closeSheet(); rerender();
    toast(`${t.label}: ${v} of ${t.total}${targetPace(m).behind ? '. Still behind pace' : ''}`, 'ok');
  };
  w.querySelector('#tgQuickSave').addEventListener('click', save);
  [inp, ...sIn].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }));
}
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-tgupdate]'); if (!b) return; e.preventDefault(); e.stopPropagation(); openTargetUpdate(b.dataset.tgupdate); }, true);

/* ---------- Milestone dialog layout (Nov 18 2026)
   Built around what people do, most often first:
   Update   (every two weeks): progress, forecast, status, blocked, next steps
   Details  (set up once, rarely changed): what, where, who, when, how progress is measured, links
   Activity (read and discuss): comments and the history of updates
   New milestones open on Details only. Fields keep their ids, so saving is unchanged. ---------- */
function mdHistory(m) {
  const ev = [];
  (m.checkins || []).forEach(c => ev.push({ t: c.t, txt: `Forecast: ${CI_LABEL[c.answer] || c.answer}${c.forecast ? ', expects ' + fmtDate(c.forecast) : ''}${c.note ? ' · "' + c.note + '"' : ''}`, by: c.by }));
  ((m.target && m.target.log) || []).forEach(x => ev.push({ t: x.t, txt: `${m.target.label}: ${x.done} of ${m.target.total}`, by: x.by }));
  (m.dateHistory || []).forEach(h => ev.push({ t: h.t, txt: `Due date moved ${fmtDate(h.from)} → ${fmtDate(h.to)}${h.reason ? ' · ' + h.reason : ''}`, by: h.by }));
  if (m.completedAt) ev.push({ t: m.completedAt, txt: 'Marked complete', by: '' });
  ev.sort((a, b) => (b.t || '').localeCompare(a.t || ''));
  return ev.length ? `<ul class="md-hist">${ev.slice(0, 40).map(e => `<li><span class="md-hist-t">${esc(fmtWhen(e.t))}${e.by ? ' · ' + esc(e.by) : ''}</span><span>${esc(e.txt)}</span></li>`).join('')}</ul>` : '<p class="help-text">No updates yet</p>';
}
function layoutMilestoneDialog(m) {
  const body = $('#modalBody'); if (!body) return;
  const top = sel => { const e = body.querySelector(sel); if (!e) return null; let n = e; while (n.parentElement && n.parentElement !== body) n = n.parentElement; return n; };
  const fieldOf = sel => { const e = body.querySelector(sel); return e ? e.closest('.field') : null; };
  const sec = (title, nodes, id) => { const d = document.createElement('section'); d.className = 'md-sec'; if (id) d.id = id; if (title) d.innerHTML = `<h4 class="md-sec-h">${title}</h4>`; nodes.filter(Boolean).forEach(n => d.appendChild(n)); return d; };
  // pick up the pieces before clearing section headings
  const n = {
    meta: top('.m-top'), tags: top('.m-tags'), name: fieldOf('#mAct'), forecast: top('#ciBlock'),
    status: fieldOf('#mStatus'), pct: body.querySelector('#mProgWrap'), bar: body.querySelector('#mPb'), blocked: top('#mBlockWrap'),
    ownerRow: top('#mOwner'), co: top('#mCoBox') || null, team: fieldOf('#mTeam'), group: fieldOf('#mWs'), parts: body.querySelector('#tpWrap'), sdone: body.querySelector('#sdWrap'),
    tgWrap: top('#tgWrap'), tgDone: fieldOf('#tgDone'), tgHist: body.querySelector('#tgHist'), steps: fieldOf('#cpList'),
    deps: fieldOf('#depList'), lk: fieldOf('#lkList'), soSum: top('#soSum'), soHelp: top('.so-help'), soEdit: top('#soEdit'),
    notes: fieldOf('#mNotes'), more: top('.sm-details'), comments: top('.notes-field')
  };
  const needed = [...body.querySelectorAll('.dep-needed')].map(x => x.closest('.field'));
  if (n.co && n.co.classList && !n.co.classList.contains('field')) n.co = n.co.closest('.field') || n.co;
  if (!n.co) { const l = [...body.querySelectorAll('.field > label')].find(x => x.textContent.trim() === 'Co-owners'); n.co = l ? l.parentElement : null; }
  body.querySelectorAll(':scope > .m-sec-h, #tgWrap > .m-sec-h').forEach(h => h.remove());

  // How progress is measured: one choice instead of three competing tools
  const hasSchool = (m.schoolIds || []).length > 0, cur = measureOf(m);
  const msr = document.createElement('fieldset'); msr.className = 'md-measure'; msr.id = 'mMeasure';
  msr.innerHTML = `<legend>Measure progress by</legend>
    ${[['percent', 'Done or not', ''], ['count', 'A count toward a goal', hasSchool ? '' : 'Link a school opening first'], ['steps', 'Tasks', '']].map(([v, l, h]) =>
      `<label class="md-radio"><input type="radio" name="mMeasure" value="${v}" ${cur === v ? 'checked' : ''} ${v === 'count' && !hasSchool ? 'disabled' : ''}><span><b>${l}</b><small>${h}</small></span></label>`).join('')}`;
  // count: the weekly number lives in Update; goal, label and ladder live in Details
  const countUpd = document.createElement('div'); countUpd.id = 'mCountWrap'; const chartBox = document.createElement('div'); chartBox.id = 'tgChart'; countUpd.appendChild(chartBox); if (n.tgDone) countUpd.appendChild(n.tgDone); const tsd = body.querySelector('#tgSchoolDone'); if (tsd) countUpd.appendChild(tsd); if (n.tgHist) countUpd.appendChild(n.tgHist);
  const stepsWrap = document.createElement('div'); stepsWrap.id = 'mStepsWrap'; if (n.steps) stepsWrap.appendChild(n.steps);
  const setupNote = document.createElement('p'); setupNote.className = 'help-text md-note'; setupNote.id = 'mMeasureNote';

  body.innerHTML = '';
  if (m._draft) {
    [sec('', [n.name, n.team, n.group, n.parts]), sec('School openings', [n.soHelp, n.soSum, n.soEdit]), sec('Owner and dates', [n.ownerRow, n.co]),
     sec('How progress is measured', [msr, n.tgWrap, setupNote]), sec('Tasks', [stepsWrap]), sec('Waiting on', [n.deps, ...needed]), sec('Documents', [n.lk]), n.more ? sec('', [n.more]) : null,
     n.pct ? sec('', [n.pct, n.status, n.bar, n.blocked, n.notes, n.forecast]) : null].filter(Boolean).forEach(x => body.appendChild(x));
    const hidden = body.lastElementChild; if (hidden) hidden.hidden = true;   // status/progress start at defaults for a new milestone
  } else {
    const head = document.createElement('div'); head.className = 'md-head';
    head.innerHTML = `<h3 class="md-title">${esc(m.activity)}</h3><div class="md-chips">${schoolChips(m)}${dueChip(m)}<span class="kc-chip">${esc(ownersOf(m).join(', ') || 'No owner')}</span></div>`;
    if (n.tags) head.appendChild(n.tags); if (n.meta) head.appendChild(n.meta);
    const tabs = document.createElement('div'); tabs.className = 'md-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Milestone');
    const P = [['upd', 'Update'], ['det', 'Details'], ['act', `Comments${(m.noteLog || []).length ? ' (' + m.noteLog.length + ')' : ''}`]];
    tabs.innerHTML = P.map(([k, l], i) => `<button type="button" role="tab" id="mdTab-${k}" aria-controls="mdPane-${k}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" class="md-tab">${l}</button>`).join('');
    const pane = (k, kids) => { const d = document.createElement('div'); d.className = 'md-pane'; d.id = 'mdPane-' + k; d.setAttribute('role', 'tabpanel'); d.setAttribute('aria-labelledby', 'mdTab-' + k); kids.filter(Boolean).forEach(x => d.appendChild(x)); return d; };
    const upd = pane('upd', [
      readyToComplete(m) ? (() => { const d = document.createElement('div'); d.className = 'rc-banner'; d.setAttribute('role', 'status'); d.innerHTML = `<span><b>Ready to mark complete.</b> ${esc(readyToComplete(m))}.</span><button type="button" class="btn btn-filled btn-sm" data-rc-done="${esc(m.id)}">Mark complete</button>`; return d; })() : null,
      sec('', [n.bar, n.pct, countUpd, stepsWrap]),
      m.status === 'complete' ? null : sec('Forecast', [n.forecast]),
      sec('Status', [n.status, n.blocked]),
      n.sdone ? sec('Done at each school', [n.sdone]) : null,
      sec('Teams involved', [n.parts]),
      sec('Next steps', [n.notes])]);
    const det = pane('det', [sec('Milestone', [n.name, n.team, n.group]), sec('School openings', [n.soSum, n.soHelp, n.soEdit]), sec('Owner and dates', [n.ownerRow, n.co]),
      sec('How progress is measured', [msr, n.tgWrap, setupNote]), sec('Waiting on', [n.deps, ...needed]), sec('Documents', [n.lk]), n.more ? sec('More options', [n.more]) : null]);
    const hist = document.createElement('div'); hist.innerHTML = mdHistory(m);
    const act = pane('act', [sec('Comments', [n.comments]), sec('History', [hist])]);
    det.hidden = true; act.hidden = true;
    [head, tabs, upd, det, act].forEach(x => body.appendChild(x));
    const show = k => { P.forEach(([x]) => { const on = x === k, t = $('#mdTab-' + x); t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; $('#mdPane-' + x).hidden = !on; }); body.scrollTop = 0; };
    tabs.addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b) show(b.id.replace('mdTab-', '')); });
    tabs.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; const ks = P.map(x => x[0]), i = ks.indexOf((tabs.querySelector('[aria-selected=true]') || {}).id.replace('mdTab-', '')); const k = ks[(i + (e.key === 'ArrowRight' ? 1 : ks.length - 1)) % ks.length]; show(k); $('#mdTab-' + k).focus(); e.preventDefault(); });
    const goDet = document.createElement('button'); goDet.type = 'button'; goDet.className = 'btn btn-ghost btn-sm md-godet'; goDet.textContent = 'Change how progress is measured'; goDet.addEventListener('click', () => { show('det'); $('#mMeasure').scrollIntoView({ block: 'start' }); });
    upd.querySelector('.md-sec').appendChild(goDet);
  }
  // the label/legend for the forecast is now the section heading
  const ciq = $('#ciQ'); if (ciq) ciq.classList.add('md-q');
  // switching the measure: count needs the target turned on; leaving count asks first
  const tgOnNow = () => !$('#tgOn').hidden;
  const syncMeasure = () => {
    const v = ($('input[name="mMeasure"]:checked') || {}).value;
    if ($('#tgWrap')) $('#tgWrap').hidden = v !== 'count';
    const note = $('#mMeasureNote'); if (note) note.textContent = v === 'count' ? 'Update the count on the Update tab each week' : v === 'steps' ? 'Add and tick steps on the Update tab' : 'Enter the percent on the Update tab';
    if (m._draft) note.textContent = v === 'steps' ? 'Add steps below' : v === 'count' ? 'Set the goal and checkpoints here' : '';
    const sh = m._draft && $('#mStepsWrap') ? $('#mStepsWrap').closest('.md-sec') : null; if (sh) sh.hidden = v !== 'steps';
    paintDialogProgress();
  };
  $$('input[name="mMeasure"]').forEach(r => r.addEventListener('change', () => {
    modalDirty = true;
    const v = r.value;
    if (v === 'count' && !tgOnNow()) $('#tgStart').click();
    if (v !== 'count' && tgOnNow() && (+$('#tgTotal').value || 0) > 0) {
      const back = () => { const c = $('input[name="mMeasure"][value="count"]'); if (c) c.checked = true; syncMeasure(); };
      confirmDialog({ title: 'Stop counting toward a goal?', message: 'The goal, the count, the checkpoints and the update history are removed when you save. Cancel keeps them', confirmLabel: 'Stop counting', onConfirm: () => { $('#tgOn').hidden = true; $('#tgOff').hidden = false; syncMeasure(); } });
      setTimeout(() => { const c = $('#cfgCancel'); if (c) c.addEventListener('click', back, { once: true }); }, 0);
    }
    syncMeasure();
  }));
  const off = $('#tgOff'); if (off) off.hidden = true;   // the measure choice replaces "+ Track a number"
  syncMeasure();
}

// Why a milestone is on the Needs attention list, in one short line
function alWhy(m) {
  if (m.status === 'blocked') return m.dependency ? 'Blocked: ' + m.dependency : 'Blocked';
  const w = watermelonReasons(m); if (w.length) return w[0];
  const pace = targetPace(m); if (pace.behind) return `Behind pace: ${pace.passed.goal} due by ${fmtDate(pace.passed.due)}`;
  const late = missedCheckpoints(m).length; if (late) return `${late} step${late === 1 ? '' : 's'} overdue`;
  const lc = lastCheckin(m); if (lc && lc.forecast && m.due_date && lc.forecast > m.due_date) return `Owner expects ${fmtDate(lc.forecast)}`;
  if (timingLevel(m) === 'overdue') return 'Past the due date';
  if (timingLevel(m) === 'this_month') return 'Due within a month';
  return '';
}

/* ---------- Hiring pace (Nov 18 2026): per-school counts, pace chart, dashboard rollup, copy ladder ---------- */
function tgSchoolRows(m, kind) {
  const by = (m.target && m.target.bySchool) || {};
  return (m.schoolIds || []).map(schoolById).filter(Boolean).map(x => {
    const v = by[x.id] ? by[x.id][kind === 'goal' ? 'total' : 'done'] : '';
    return `<div class="tg-srow" data-sid="${esc(x.id)}"><span class="tg-sname">${schoolChip(x.market, [schLbl(x)])}</span><label class="sr-only" for="tg-${kind}-${esc(x.id)}">${esc(x.market + ' · ' + schLbl(x))} ${kind === 'goal' ? 'goal' : 'so far'}</label><input id="tg-${kind}-${esc(x.id)}" type="number" min="0" step="1" inputmode="numeric" value="${v === '' ? (kind === 'done' ? 0 : '') : esc(v)}" placeholder="${kind === 'goal' ? 'Goal' : '0'}"></div>`;
  }).join('');
}
// Where the ladder says the count should be today: straight line between the checkpoints, from 0 at the start
function expectedNow(m) {
  const t = activeTarget(m); if (!t) return null;
  const lad = (t.ladder || []).filter(r => r.due && +r.goal > 0).sort((a, b) => a.due.localeCompare(b.due)); if (!lad.length) return null;
  const start = (m.startDate || (m.createdAt || '').slice(0, 10) || ((t.log || [])[0] || {}).t || todayISO()).slice(0, 10);
  const pts = [{ due: start < lad[0].due ? start : lad[0].due, goal: 0 }, ...lad], d = todayISO();
  if (d <= pts[0].due) return 0; if (d >= pts[pts.length - 1].due) return +pts[pts.length - 1].goal;
  for (let i = 1; i < pts.length; i++) if (d <= pts[i].due) { const a = pts[i - 1], b = pts[i], f = daysBetween(parseDate(a.due), parseDate(d)) / Math.max(1, daysBetween(parseDate(a.due), parseDate(b.due))); return Math.round(+a.goal + f * (+b.goal - +a.goal)); }
  return null;
}
function paceChart(m) {
  const t = m.target; if (!t || !+t.total) return '';
  const lad = (t.ladder || []).filter(r => r.due && r.goal != null).sort((a, b) => a.due.localeCompare(b.due));
  const log = (t.log || []).map(x => ({ d: x.t.slice(0, 10), v: +x.done })).concat([{ d: todayISO(), v: +t.done || 0 }]).sort((a, b) => a.d.localeCompare(b.d));
  const start = [log[0] && log[0].d, lad[0] && lad[0].due, (m.createdAt || '').slice(0, 10), todayISO()].filter(Boolean).sort()[0];
  const end = [m.due_date, lad.length && lad[lad.length - 1].due, todayISO()].filter(Boolean).sort().pop();
  const W = 560, H = 150, L = 32, R = 12, T = 12, B = 24, span = Math.max(1, daysBetween(parseDate(start), parseDate(end)));
  const x = d => L + (W - L - R) * daysBetween(parseDate(start), parseDate(d)) / span, y = v => T + (H - T - B) * (1 - Math.min(1, v / t.total));
  const plan = [[start, 0], ...lad.map(r => [r.due, +r.goal])].map(([d, v]) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const act = log.map(p => `${x(p.d).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const tx = x(todayISO()).toFixed(1), mo = d => parseDate(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const exp = expectedNow(m), col = SM(effectiveStatus(m)).color;
  const label = `${t.label}: ${t.done} of ${t.total} hired. ${exp != null ? `The plan expects ${exp} by today.` : ''} Plan runs ${mo(start)} to ${mo(end)}.`;
  return `<figure class="pc"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none">
    <line x1="${L}" y1="${y(0)}" x2="${W - R}" y2="${y(0)}" class="pc-axis"/><line x1="${L}" y1="${y(t.total)}" x2="${W - R}" y2="${y(t.total)}" class="pc-grid"/>
    <text x="${L - 6}" y="${y(t.total) + 4}" class="pc-yl" text-anchor="end">${t.total}</text><text x="${L - 6}" y="${y(0) + 4}" class="pc-yl" text-anchor="end">0</text>
    <polyline points="${plan}" class="pc-plan"/>${lad.map(r => `<circle cx="${x(r.due).toFixed(1)}" cy="${y(+r.goal).toFixed(1)}" r="3" class="pc-dot"/>`).join('')}
    <line x1="${tx}" y1="${T}" x2="${tx}" y2="${y(0)}" class="pc-today"/><text x="${tx}" y="${H - 6}" class="pc-xl" text-anchor="middle">Today</text>
    <polyline points="${act}" class="pc-act" style="stroke:${col}"/>${log.map(p => `<circle cx="${x(p.d).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3" style="fill:${col}"/>`).join('')}
    <text x="${L}" y="${H - 6}" class="pc-xl">${mo(start)}</text><text x="${W - R}" y="${H - 6}" class="pc-xl" text-anchor="end">${mo(end)}</text>
  </svg><figcaption class="pc-key"><span class="pc-k-plan"></span>Plan<span class="pc-k-act" style="background:${col}"></span>${esc(t.label)}${exp != null ? `<span class="pc-k-exp">Expected by today: ${exp}</span>` : ''}</figcaption></figure>`;
}
function hiringCard(list) {
  const ms = list.filter(m => activeTarget(m) && m.status !== 'complete'); if (!ms.length) return '';
  const rows = ms.map(m => {
    const t = activeTarget(m), exp = expectedNow(m), pace = targetPace(m), gap = exp == null ? null : (+t.done || 0) - exp, info = progressInfo(m);
    const st = pace.far ? ['behind', 'Behind'] : pace.behind ? ['at_risk', 'Behind pace'] : gap != null && gap < 0 ? ['at_risk', 'Slightly behind'] : ['on_track', 'On pace'];
    const by = t.bySchool ? Object.entries(t.bySchool).map(([sid, v]) => { const x = schoolById(sid); return x ? `${schLbl(x)} ${v.done}/${v.total}` : ''; }).filter(Boolean).join(' · ') : '';
    return `<tr data-expand="${esc(m.id)}" title="Open">
      <td><div class="hp-t">${esc(m.activity)}</div><div class="hp-m">${schoolChips(m)}${by ? `<span class="hp-by">${esc(by)}</span>` : ''}</div></td>
      <td class="num">${pctChip(info.pct, `${t.done} of ${t.total}`, info.color, t.label)}</td>
      <td class="num">${exp == null ? '<span class="muted">No plan</span>' : exp}</td>
      <td class="num ${gap != null && gap < 0 ? 'dt-bad' : ''}">${gap == null ? '' : (gap > 0 ? '+' : '') + gap}</td>
      <td>${statusPill(st[1], SM(st[0]).color)}</td></tr>`;
  }).join('');
  const tot = ms.reduce((a, m) => a + (+activeTarget(m).done || 0), 0), goal = ms.reduce((a, m) => a + (+activeTarget(m).total || 0), 0);
  return `<section class="ex-card dt-card hp-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('flag')}<h3>Hiring pace</h3></div><span class="dt-sum"><b>${tot} of ${goal}</b> hired</span></div>
    <div class="dt-wrap"><table class="dt"><thead><tr><th>Milestone</th><th class="num">Hired</th><th class="num">Expected by today</th><th class="num">Gap</th><th>Pace</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function copyLadder() {
  const m = findM(modalId), t = liveTarget(); if (!m || !t) return;
  if (!t.total || !t.ladder.length) { toast('Add a goal and at least one checkpoint first', 'err'); return; }
  const others = M().filter(x => x.id !== m.id && activeTarget(x));
  if (!others.length) { toast('No other milestones count toward a goal yet', 'warn'); return; }
  confirmDialog({ title: `Copy this ladder to ${others.length} milestone${others.length === 1 ? '' : 's'}?`,
    message: `Same dates, with each count scaled to that milestone's goal. Their current checkpoints are replaced:<ul class="cl-list">${others.slice(0, 8).map(x => `<li>${esc(clip(x.activity, 70))} (goal ${activeTarget(x).total})</li>`).join('')}${others.length > 8 ? `<li>and ${others.length - 8} more</li>` : ''}</ul>`,
    confirmLabel: 'Copy ladder', onConfirm: () => {
      snapshotForUndo(`Copy ladder to ${others.length} milestones`);
      others.forEach(x => { const tg = x.target; tg.ladder = t.ladder.filter(r => r.due && r.goal != null).map(r => ({ id: uid(), due: r.due, goal: Math.round(r.goal / t.total * tg.total) })); touch(x); });
      logActivity('update', `Copied the hiring ladder from "${m.activity}" to ${others.length} milestones`, { itemId: m.id }); autosave(); quietRerender && quietRerender();
      toast(`Ladder copied to ${others.length} milestone${others.length === 1 ? '' : 's'}`, 'ok');
    } });
}

/* ============================================================
   MEETINGS CALENDAR (Nov 19 2026): schedule meetings on a calendar; each meeting
   holds objectives, a slide deck, key notes and next steps (owner + due date).
   Admins edit. Everyone signed in reads. Next steps show on the owner's dashboard,
   and the owner can mark their own step done (RPC growth_meeting_step_done).
   Data: mbook().meetings. Slides: Supabase Storage bucket "meeting-decks"
   (see supabase-meetings.sql); with no connection they stay in this browser (IndexedDB).
   ============================================================ */
const MM_IC = {
  doc: '<path d="M25.7 9.3l-7-7A.9.9 0 0 0 18 2H8a2 2 0 0 0-2 2v24a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V10a.9.9 0 0 0-.3-.7zM18 4.4l5.6 5.6H18zM24 28H8V4h8v6a2 2 0 0 0 2 2h6z"/><path d="M10 22h12v2H10zm0-6h12v2H10z"/>',
  left: '<path d="M10 16L20 6l1.4 1.4-8.6 8.6 8.6 8.6L20 26z"/>',
  right: '<path d="M22 16L12 26l-1.4-1.4 8.6-8.6-8.6-8.6L12 6z"/>',
  max: '<path d="M20 2v2h6.586L18 12.582 19.414 14 28 5.414V12h2V2H20zM14 19.416 12.592 18 4 26.586V20H2v10h10v-2H5.414L14 19.416z"/>',
  min: '<path d="M4 18v2h6.586L2 28.582 3.414 30 12 21.414V28h2V18H4zM30 3.416 28.592 2 20 10.586V4h-2v10h10v-2h-6.586L30 3.416z"/>',
  dl: '<path d="M26 24v4H6v-4H4v4a2 2 0 002 2h20a2 2 0 002-2v-4zM26 14l-1.41-1.41L17 20.17V2h-2v18.17l-7.59-7.58L6 14l10 10 10-10z"/>',
  grid: '<path d="M12 4H6a2 2 0 00-2 2v6a2 2 0 002 2h6a2 2 0 002-2V6a2 2 0 00-2-2zm0 8H6V6h6zM26 4h-6a2 2 0 00-2 2v6a2 2 0 002 2h6a2 2 0 002-2V6a2 2 0 00-2-2zm0 8h-6V6h6zM12 18H6a2 2 0 00-2 2v6a2 2 0 002 2h6a2 2 0 002-2v-6a2 2 0 00-2-2zm0 8H6v-6h6zM26 18h-6a2 2 0 00-2 2v6a2 2 0 002 2h6a2 2 0 002-2v-6a2 2 0 00-2-2zm0 8h-6v-6h6z"/>',
  up: '<path d="M6 18l1.41 1.41L15 11.83V30h2V11.83l7.59 7.58L26 18 16 8 6 18zM6 8V4h20v4h2V4a2 2 0 00-2-2H6a2 2 0 00-2 2v4z"/>',
  present: '<path d="M15 10h2v8h-2zM20 14h2v4h-2zM10 12h2v6h-2z"/><path d="M25 4H17V2H15V4H7A2 2 0 005 6V21a2 2 0 002 2h8v4.2l-3.6 2.2 1 1.7L16 29.2l3.6 2 1-1.7L17 27.2V23h8a2 2 0 002-2V6A2 2 0 0025 4Zm0 17H7V6H25Z"/>'
};
const mmIc = (k, s) => `<svg viewBox="0 0 32 32" width="${s || 16}" height="${s || 16}" fill="currentColor" aria-hidden="true">${MM_IC[k]}</svg>`;
const MM_MAX_MB = 50;

function mmList() {
  const b = mbook(); b.meetings = b.meetings || [];
  if (!b.meetings.length && !b._mmSeeded && mtg().next) { b._mmSeeded = true; b.meetings.push(mmNew(mtg().next, mtg().time || '')); }   // the date set before the calendar existed
  b.meetings.sort((x, y) => (x.date + (x.time || '')).localeCompare(y.date + (y.time || '')));
  return b.meetings;
}
function mmNew(date, time, title) { return { id: uid(), date, time: time || '', title: title || 'Committee meeting', region: '', objectives: [], agenda: [], notes: '', deck: null, files: [], steps: [], attend: {}, log: [], by: currentDisplayName() || '' }; }
const mmFind = id => mmList().find(x => x.id === id);
function mmUpcoming() { const t = todayISO(); return mmList().filter(x => x.date >= t); }
const mmNext = () => mmUpcoming().filter(x => !x.canceled);   // the next meeting that will actually happen
const mmCxTag = x => x.canceled ? '<span class="mm-cx">Canceled</span>' : '';
function mmSyncNext() {   // the agenda, dashboard card and reminders read mtg().next, so keep it on the next scheduled meeting
  const up = mmNext().filter(x => !mtg().last || x.date > mtg().last || x.date > todayISO())[0];
  if (up) { mtg().next = up.date; mtg().time = up.time || ''; }
}
function mmFindStep(id) { for (const mt of mmList()) { const s = (mt.steps || []).find(x => x.id === id); if (s) return { mt, s }; } return null; }
function mmWhen(mt, long) {
  const d = parseDate(mt.date); if (!d) return '';
  return d.toLocaleDateString('en-US', long ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }) + (mt.time ? ', ' + fmtTime(mt.time) : '');
}
function mmSelected() {
  const all = mmList(); let sel = state.mmSel && mmFind(state.mmSel);
  if (!sel) sel = mmUpcoming()[0] || all[all.length - 1] || null;
  if (sel) state.mmSel = sel.id; return sel;
}

/* ---------- regions, roster and shared edits (Nov 19 2026, v2) ----------
   A meeting can be tagged Paterson (PAT) or South Florida (SoFlo). The tag sets its color,
   its default roster (owners of that region's milestones) and the milestone check.
   Admins schedule meetings and set objectives and the agenda. Everyone signed in can take
   attendance, write notes, add files and add or update next steps. Those edits go through
   growth_meeting_edit (supabase-meetings-collab.sql), and every change is logged on the meeting. */
const MM_REGIONS = {
  PAT: { label: 'Paterson', short: 'PAT', markets: ['Paterson'] },
  SOFLO: { label: 'South Florida', short: 'SoFlo', markets: ['Miami-Dade', 'Broward'] }
};
const mmRgCls = code => MM_REGIONS[code] ? 'rg-' + code.toLowerCase() : 'rg-all';
const mmRgName = (code, sm) => { const r = MM_REGIONS[code]; return r ? (sm ? r.short : `${r.label} (${r.short})`) : 'All regions'; };
const mmRgTag = (code, sm) => `<span class="mm-rtag ${mmRgCls(code)}">${esc(mmRgName(code, sm))}</span>`;
const mmRegionOfMarket = mk => Object.keys(MM_REGIONS).find(k => MM_REGIONS[k].markets.includes(mk)) || '';
function mmInRegion(m, code) {
  const r = MM_REGIONS[code]; if (!r) return true;
  return r.markets.includes(m.market) || (m.schoolIds || []).some(id => { const s = schoolById(id); return s && r.markets.includes(s.market); });
}
// Regional leaders always invited to that region's meetings: roster owners whose role names the region.
// Read from the signed-in roster so no staff names ship in the public code (Nov 20 2026).
const MM_REGION_ROLE = { SOFLO: /miami|south florida|broward/i, PAT: /paterson/i };
const mmRegionPeople = code => MM_REGION_ROLE[code] ? (meta().owners || []).filter(o => MM_REGION_ROLE[code].test(o.role || '')).map(o => o.name) : [];
const mmRoleOnly = r => String(r || '').replace(/\s*\([^)]*\)/g, '').trim();   // "CGAO (Exec Sponsor)" -> "CGAO"
function mmDefaultRoster(code) {
  const known = new Set(rosterNames()), out = new Set(mmRegionPeople(code));
  M().filter(m => !m._draft && mmInRegion(m, code)).forEach(m => ownersOf(m).forEach(n => { if (known.has(n)) out.add(n); }));
  return [...out].sort((a, b) => a.localeCompare(b));
}
function mmRoster(mt) {
  const base = Array.isArray(mt.roster) ? mt.roster.slice() : mmDefaultRoster(mt.region);
  return base.concat(Object.keys(mt.attend || {}).filter(n => !base.includes(n)).sort((a, b) => a.localeCompare(b)));
}
function mmAttendCount(mt) { const r = mmRoster(mt), a = mt.attend || {}; return { total: r.length, present: r.filter(n => a[n] === 'present').length, marked: r.filter(n => a[n]).length }; }
const mmMe = () => currentDisplayName() || 'Someone';
function mmLog(mt, what) {
  const by = mmMe(), L = mt.log = mt.log || [], last = L[L.length - 1], now = new Date().toISOString();
  if (last && last.by === by && last.what === what && Date.now() - Date.parse(last.at) < 600000) last.at = now; else L.push({ at: now, by, what: String(what).slice(0, 200) });
  if (L.length > 300) L.splice(0, L.length - 300);
  if (!mmSyncing && !isAdmin()) mmQueueContent(mt, what);   // non-admins save meeting content through the shared-edit action
}
/* Everyone runs meetings together (Nov 20 2026): anyone signed in edits objectives, agenda, roster, attendance,
   slides, notes, next steps, files and comments. Scheduling, editing date, time or region, and deleting stay admin-only.
   Admins save meeting content with the board as before; everyone else sends it through growth_meeting_edit
   ('content_set'), which only accepts those content keys (supabase-meetings-open.sql). */
let mmSyncing = false;
const mmContrib = () => !authModeOn() || !!(state.auth && state.auth.user);
const mmQueueContent = (() => { const t = {}; return (mt, what) => { clearTimeout(t[mt.id]); t[mt.id] = setTimeout(() => {
  const fields = { objectives: mt.objectives || [], agenda: mt.agenda || [], roster: Array.isArray(mt.roster) ? mt.roster : null, deck: mt.deck || null, msCheck: mt.msCheck === false ? false : null };
  mmEdit(mt, 'content_set', { fields }, what).then(ok => { if (ok) mmRedraw(); });
}, 0); }; })();
const MM_APPLY = {
  notes: (mt, d) => { mt.notes = String(d.notes || '').slice(0, 20000); if (typeof d.text === 'string') mmNoteVersion(mt, d.text); },
  attend: (mt, d) => { mt.attend = mt.attend || {}; Object.entries(d.marks || {}).forEach(([n, v]) => { if (['present', 'absent', 'excused'].includes(v)) mt.attend[n] = v; else delete mt.attend[n]; }); },
  step_add: (mt, d) => { (mt.steps = mt.steps || []).push(Object.assign({}, d.step, { by: mmMe() })); },
  step_set: (mt, d) => { const s = (mt.steps || []).find(x => x.id === d.id); if (s) Object.assign(s, d.fields); },
  step_del: (mt, d) => { mt.steps = (mt.steps || []).filter(x => x.id !== d.id); },
  file_add: (mt, d) => { (mt.files = mt.files || []).push(Object.assign({}, d.file, { by: mmMe() })); },
  file_del: (mt, d) => { mt.files = (mt.files || []).filter(x => x.id !== d.id); },
  content_set: (mt, d) => { Object.entries(d.fields || {}).forEach(([k, v]) => { if (v === null) delete mt[k]; else mt[k] = v; }); },
  comment_add: (mt, d) => { (mt.comments = mt.comments || []).push(Object.assign({}, d.comment, { by: mmMe(), at: new Date().toISOString() })); },
  comment_del: (mt, d) => { mt.comments = (mt.comments || []).filter(x => x.id !== d.id); }
};
// Shared edits: through the RPC when connected (merge-safe and logged on the server), else local.
async function mmEdit(mt, op, data, what) {
  const live = state.sb && state.sb.connected;
  if (live) {
    try {
      const r = await state.sb.client.rpc('growth_meeting_edit', { p_settings: wsSettingsId('meetbook'), p_meeting: mt.id, p_op: op, p_data: data, p_log: what });
      if (r.error) throw r.error;
      const b = mbook(), i = (b.meetings || []).findIndex(x => x.id === mt.id);
      if (r.data && r.data.id === mt.id && i >= 0) b.meetings[i] = r.data; else { mmSyncing = true; MM_APPLY[op](mt, data); mmLog(mt, what); mmSyncing = false; }
    } catch (e) {
      const msg = String(e && (e.message || e.hint || e.code) || '');
      toast(/unknown change|not editable here/i.test(msg) ? 'This meeting change needs a database update. An admin needs to run supabase-meetings-open.sql' : /growth_meeting_edit|PGRST202|function/i.test(msg) ? 'Shared meeting edits are not set up yet. An admin needs to run supabase-meetings-collab.sql' : /only the person/i.test(msg) ? 'Only the person who added it or an admin can remove it' : 'Could not save. Check your connection and try again', 'err');
      return false;
    }
    autosaveWriteLocal();
  } else { mmSyncing = true; MM_APPLY[op](mt, data); mmLog(mt, what); mmSyncing = false; autosave(); }
  return true;
}

/* ---------- date ranges: day, week, month, fiscal quarter, fiscal year, calendar year ---------- */
const mmIso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MM_UNITS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['fy', 'Fiscal year'], ['year', 'Calendar year']];
const mmMonthName = (y, m, len) => new Date(y, m, 1).toLocaleDateString('en-US', { month: len || 'long' });
function mmRange() {
  const unit = state.mmUnit, a = parseDate(state.mmAnchor || todayISO()) || new Date(), y = a.getFullYear(), m = a.getMonth();
  if (unit === 'day') return { unit, s: mmIso(a), e: mmIso(a), label: a.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) };
  if (unit === 'week') {
    const s = new Date(y, m, a.getDate() - a.getDay()), e = new Date(s); e.setDate(s.getDate() + 6);
    const sm = s.toLocaleDateString('en-US', { month: 'short' }), em = e.toLocaleDateString('en-US', { month: 'short' });
    return { unit, s: mmIso(s), e: mmIso(e), label: `${sm} ${s.getDate()} to ${em === sm ? '' : em + ' '}${e.getDate()}, ${e.getFullYear()}`, sub: 'Week' };
  }
  if (unit === 'quarter') {
    const fq = Math.floor(((m + 6) % 12) / 3) + 1, fy = m >= 6 ? y + 1 : y, sm = ((fq - 1) * 3 + 6) % 12, sy = sm >= 6 ? fy - 1 : fy;
    const s = new Date(sy, sm, 1), e = new Date(sy, sm + 3, 0);
    return { unit, s: mmIso(s), e: mmIso(e), months: [0, 1, 2].map(i => [new Date(sy, sm + i, 1).getFullYear(), new Date(sy, sm + i, 1).getMonth()]), label: `Q${fq} FY${String(fy).slice(2)}`, sub: `${mmMonthName(sy, sm, 'short')} to ${mmMonthName(e.getFullYear(), e.getMonth(), 'short')} ${e.getFullYear()}` };
  }
  if (unit === 'fy') {
    const fy = m >= 6 ? y + 1 : y;
    return { unit, s: `${fy - 1}-07-01`, e: `${fy}-06-30`, months: Array.from({ length: 12 }, (_, i) => [i < 6 ? fy - 1 : fy, (i + 6) % 12]), label: `FY${String(fy).slice(2)}`, sub: `Jul ${fy - 1} to Jun ${fy}` };
  }
  if (unit === 'year') return { unit, s: `${y}-01-01`, e: `${y}-12-31`, months: Array.from({ length: 12 }, (_, i) => [y, i]), label: String(y), sub: 'Calendar year' };
  return { unit: 'month', s: mmIso(new Date(y, m, 1)), e: mmIso(new Date(y, m + 1, 0)), y, m, label: `${mmMonthName(y, m)} ${y}` };
}
function mmShift(dir) {
  const u = state.mmUnit, a = parseDate(state.mmAnchor || todayISO()) || new Date();
  if (u === 'day' || u === 'week') a.setDate(a.getDate() + dir * (u === 'day' ? 1 : 7));
  else { a.setDate(1); a.setMonth(a.getMonth() + dir * (u === 'month' ? 1 : u === 'quarter' ? 3 : 12)); }
  state.mmAnchor = mmIso(a);
}
const mmVisible = x => !state.mmRegion || !x.region || x.region === state.mmRegion;
const mmTimeLabel = x => x.time ? fmtTime(x.time) : 'Time to be set';
const mmChipLabel = x => `${x.title}${x.canceled ? ' (canceled)' : ''}, ${mmRgName(x.region)}, ${parseDate(x.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${mmTimeLabel(x)}`;

/* ---------- page ---------- */
function mmPrefs() {
  if (state.mmUnit) return;
  const g = (k, ok, d) => { const v = lsGet(k); return ok.includes(v) ? v : d; };
  state.mmUnit = g('ngc_mm_unit', MM_UNITS.map(u => u[0]), 'month');
  state.mmMode = g('ngc_mm_mode', ['cal', 'list'], 'cal');
  state.mmRegion = g('ngc_mm_region', ['', 'PAT', 'SOFLO'], '');
}
function renderMeetings() {
  const sec = $('#view-meetings'); if (!sec) return;
  const b = mbook(), admin = isAdmin(), mine = !b.live || !b.live.by || b.live.by === currentDisplayName() || state.mtTookOver;
  const running = b.live && ((admin && mine && state.mtRun !== false) || ((!admin || !mine) && state.mtFollow));
  if (running) { mmPanelClose(true); return renderMeetingsAgenda(); }   // a meeting started from the old run screen finishes there
  stopMtTimer(); setTimeout(renderCtxBar, 0); mmPrefs();
  const r = mmRange(), up = mmUpcoming().filter(mmVisible), t = todayISO();
  const seg = (attr, cur, opts, label) => `<div class="mm-switch" role="group" aria-label="${label}">${opts.map(([v, l, cls, sh]) => `<button type="button" class="mm-sw ${cur === v ? 'is-on' : ''}" aria-pressed="${cur === v}" ${attr}="${v}" ${sh ? `aria-label="${l}"` : ''}>${cls ? `<i class="mm-dot ${cls}" aria-hidden="true"></i>` : ''}${sh ? `<span class="mm-sw-long">${l}</span><span class="mm-sw-short" aria-hidden="true">${sh}</span>` : l}</button>`).join('')}</div>`;
  const inRange = mmList().filter(x => x.date >= r.s && x.date <= r.e && mmVisible(x));
  sec.innerHTML = `<div class="mt-page mm-page">
    <header class="mt-head"><div><h2 class="mt-h">Meetings</h2>
      ${up[0] ? '' : '<p class="mt-sub">No meeting scheduled</p>'}</div>
      <div class="mt-head-acts">${admin && (mbook().trash || []).length ? `<button class="btn btn-ghost btn-sm" data-mm-trash>Recently deleted (${mbook().trash.length})</button>` : ''}${admin ? `<button class="btn btn-filled" data-mm-new="${esc(up[0] ? nextMeetingAfter(up[up.length - 1].date) : nextMeetingAfter(t))}">Schedule meeting</button>` : ''}</div></header>
    ${b.live ? `<div class="mt-live-note" role="status"><span class="mt-pulse"></span><b>Meeting in progress</b><button class="btn btn-tonal btn-sm" data-mm-tab="agenda">Go to the meeting</button></div>` : ''}
    <div class="mm-bar">
      ${seg('data-mm-mode', state.mmMode, [['cal', 'Calendar'], ['list', 'List']], 'Show as')}
      <div class="mm-unit"><label for="mmUnit" class="sr-only">View</label><select id="mmUnit" data-mm-unit>${MM_UNITS.map(([v, l]) => `<option value="${v}" ${state.mmUnit === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${seg('data-mm-region', state.mmRegion, [['', 'All regions', '', 'All'], ['PAT', 'Paterson (PAT)', 'rg-pat', 'PAT'], ['SOFLO', 'South Florida (SoFlo)', 'rg-soflo', 'SoFlo']], 'Region')}
    </div>
    <div class="mm-layout">
      <section class="mt-card mm-cal-card" aria-labelledby="mmRangeH">
        <div class="mm-cal-head"><div><h3 id="mmRangeH">${esc(r.label)}</h3>${r.sub ? `<span class="mm-range-sub">${esc(r.sub)}</span>` : ''}</div>
          <div class="mm-cal-nav"><span class="mm-range-n">${inRange.length} meeting${inRange.length === 1 ? '' : 's'}</span><button type="button" class="btn btn-ghost btn-sm" data-mm-shift="today">Today</button><button type="button" class="icon-btn" data-mm-shift="-1" aria-label="Previous ${esc(MM_UNITS.find(u => u[0] === r.unit)[1].toLowerCase())}">${mmIc('left')}</button><button type="button" class="icon-btn" data-mm-shift="1" aria-label="Next ${esc(MM_UNITS.find(u => u[0] === r.unit)[1].toLowerCase())}">${mmIc('right')}</button></div></div>
        ${state.mmMode === 'list' ? mmListView(inRange, r) : r.unit === 'month' ? mmMonthGrid(r.y, r.m) : r.unit === 'week' ? mmWeekGrid(r) : r.unit === 'day' ? mmDayView(r) : mmMiniMonths(r)}
      </section>
      ${mmUpcomingList(up)}
    </div></div>`;
  if (state.mmFocus && !$('#mmPanel')) { const el = document.querySelector(state.mmFocus); state.mmFocus = null; if (el) el.focus(); }
  mmPanelRender();
}
function mmTabs() { return ''; }   // "Agenda and minutes" retired Nov 19 2026: each meeting now holds its own agenda, notes and next steps
function mmChip(x, t) {
  return `<button type="button" class="mm-chip ${mmRgCls(x.region)} ${x.date < t ? 'is-past' : ''} ${x.canceled ? 'is-cx' : ''} ${state.mmSel === x.id ? 'is-sel' : ''}" data-mm-open="${esc(x.id)}" title="${esc(mmChipLabel(x))}" aria-label="${esc(mmChipLabel(x))}"><span class="mm-chip-top">${esc(x.time ? fmtTime(x.time).replace(':00', '') : 'Time TBD')}${x.region ? `<span class="mm-chip-rg">${esc(mmRgName(x.region, true))}</span>` : ''}</span><span class="mm-chip-n">${esc(x.title)}</span>${mmCxTag(x)}</button>`;
}
function mmByDay() { const o = {}; mmList().filter(mmVisible).forEach(x => (o[x.date] = o[x.date] || []).push(x)); return o; }
function mmMonthGrid(y, mo) {
  const admin = isAdmin(), t = todayISO(), byDay = mmByDay(), first = new Date(y, mo, 1), start = new Date(y, mo, 1 - first.getDay());
  let rows = '';
  for (let w = 0; w < 6; w++) {
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + w * 7 + i); const ds = mmIso(d), out = d.getMonth() !== mo, ms = byDay[ds] || [];
      cells += `<td class="mm-day ${out ? 'is-out' : ''} ${ds === t ? 'is-today' : ''}"><div class="mm-day-h"><span class="mm-dnum" ${ds === t ? 'aria-current="date"' : ''}>${d.getDate()}</span>${admin && ds >= t ? `<button type="button" class="mm-add" data-mm-new="${ds}" aria-label="Schedule a meeting on ${esc(fmtDate(ds))}" title="Schedule a meeting">+</button>` : ''}</div>${ms.map(x => mmChip(x, t)).join('')}</td>`;
    }
    rows += `<tr>${cells}</tr>`;
    const nx = new Date(start); nx.setDate(start.getDate() + (w + 1) * 7); if (nx.getMonth() !== mo && w >= 3) break;
  }
  return `<table class="mm-cal" aria-labelledby="mmRangeH"><thead><tr>${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<th scope="col">${d}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}
function mmWeekGrid(r) {
  const admin = isAdmin(), t = todayISO(), byDay = mmByDay(), s = parseDate(r.s);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(s); d.setDate(s.getDate() + i); return d; });
  return `<table class="mm-cal mm-week" aria-labelledby="mmRangeH"><thead><tr>${days.map(d => `<th scope="col" class="${mmIso(d) === t ? 'is-today' : ''}">${d.toLocaleDateString('en-US', { weekday: 'short' })} <span class="mm-dnum">${d.getDate()}</span></th>`).join('')}</tr></thead>
    <tbody><tr>${days.map(d => { const ds = mmIso(d); return `<td class="mm-day ${ds === t ? 'is-today' : ''}">${(byDay[ds] || []).map(x => mmChip(x, t)).join('')}${admin && ds >= t ? `<button type="button" class="mm-add mm-add-w" data-mm-new="${ds}" aria-label="Schedule a meeting on ${esc(fmtDate(ds))}">+ Schedule</button>` : ''}</td>`; }).join('')}</tr></tbody></table>`;
}
function mmDayView(r) {
  const list = (mmByDay()[r.s] || []);
  return list.length ? `<ul class="mm-lrows">${list.map(mmListRow).join('')}</ul>` : `<div class="mm-none"><p>No meetings on this day</p>${isAdmin() && r.s >= todayISO() ? `<button type="button" class="btn btn-tonal btn-sm" data-mm-new="${r.s}">Schedule a meeting</button>` : ''}</div>`;
}
function mmMiniMonths(r) {
  const t = todayISO(), byDay = mmByDay();
  return `<div class="mm-minis ${r.months.length === 3 ? 'is-q' : ''}">${r.months.map(([y, mo]) => {
    const first = new Date(y, mo, 1), n = new Date(y, mo + 1, 0).getDate(), lead = first.getDay();
    let cells = Array.from({ length: lead }, () => '<span></span>').join('');
    for (let d = 1; d <= n; d++) {
      const ds = mmIso(new Date(y, mo, d)), ms = byDay[ds] || [];
      cells += ms.length ? `<button type="button" class="mm-mini-d has-mt ${mmRgCls(ms[0].region)} ${ds === t ? 'is-today' : ''}" data-mm-day="${ds}" aria-label="${esc(fmtDate(ds))}: ${ms.map(x => esc(x.title + ', ' + mmTimeLabel(x))).join('; ')}" title="${ms.map(x => esc(mmChipLabel(x))).join('\n')}">${d}<span class="mm-dots">${ms.slice(0, 3).map(x => `<i class="mm-dot ${mmRgCls(x.region)}"></i>`).join('')}</span></button>`
        : `<span class="mm-mini-d ${ds === t ? 'is-today' : ''}">${d}</span>`;
    }
    const cnt = Object.keys(byDay).filter(k => k.startsWith(`${y}-${String(mo + 1).padStart(2, '0')}`)).reduce((s2, k) => s2 + byDay[k].length, 0);
    return `<section class="mm-mini"><h4><button type="button" class="mm-mini-h" data-mm-goto="${y}-${String(mo + 1).padStart(2, '0')}-01">${mmMonthName(y, mo)} ${y}</button>${cnt ? `<span class="mm-mini-n">${cnt}</span>` : ''}</h4>
      <div class="mm-mini-g" aria-hidden="false"><span class="mm-mini-w">S</span><span class="mm-mini-w">M</span><span class="mm-mini-w">T</span><span class="mm-mini-w">W</span><span class="mm-mini-w">T</span><span class="mm-mini-w">F</span><span class="mm-mini-w">S</span>${cells}</div></section>`;
  }).join('')}</div>`;
}
function mmMeta(x) {
  const n = (x.objectives || []).length, f = (x.files || []).length + (x.deck ? 1 : 0), o = (x.steps || []).filter(s => !s.done).length, a = mmAttendCount(x);
  return [n ? `${n} objective${n === 1 ? '' : 's'}` : '', f ? `${f} file${f === 1 ? '' : 's'}` : '', o ? `${o} open next step${o === 1 ? '' : 's'}` : '', a.marked ? `${a.present} of ${a.total} attended` : ''].filter(Boolean).join(' · ');
}
function mmListRow(x) {
  const d = parseDate(x.date), meta = mmMeta(x);
  return `<li><button type="button" class="mm-lrow ${mmRgCls(x.region)} ${x.date < todayISO() ? 'is-past' : ''}" data-mm-open="${esc(x.id)}" aria-label="${esc(mmChipLabel(x))}">
    <span class="mm-lrow-d"><b>${d.getDate()}</b><small>${d.toLocaleDateString('en-US', { weekday: 'short' })}</small></span>
    <span class="mm-lrow-main"><span class="mm-lrow-t">${esc(x.title)}${mmCxTag(x)}</span><span class="mm-lrow-m">${esc(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))} · ${esc(mmTimeLabel(x))}${meta ? ' · ' + esc(meta) : ''}</span></span>
    ${mmRgTag(x.region, true)}</button></li>`;
}
function mmListView(list, r) {
  if (!list.length) return `<div class="mm-none"><p>No meetings in ${esc(r.label)}${state.mmRegion ? ' for ' + esc(mmRgName(state.mmRegion)) : ''}</p>${isAdmin() ? `<button type="button" class="btn btn-tonal btn-sm" data-mm-new="${esc(r.s >= todayISO() ? r.s : nextMeetingAfter(todayISO()))}">Schedule a meeting</button>` : ''}</div>`;
  const groups = {}; list.forEach(x => (groups[x.date.slice(0, 7)] = groups[x.date.slice(0, 7)] || []).push(x));
  return Object.keys(groups).sort().map(k => { const [y, m] = k.split('-').map(Number), g = groups[k];
    return `<div class="mm-lgroup"><h4 class="mm-lgroup-h">${mmMonthName(y, m - 1)} ${y}<span>${g.length} meeting${g.length === 1 ? '' : 's'}</span></h4><ul class="mm-lrows">${g.map(mmListRow).join('')}</ul></div>`; }).join('');
}
function mmUpcomingList(up) {
  const past = mmList().filter(x => x.date < todayISO() && mmVisible(x)).slice(-3).reverse();
  const li = x => `<li><button type="button" class="mm-up ${mmRgCls(x.region)} ${state.mmSel === x.id ? 'is-sel' : ''}" data-mm-open="${esc(x.id)}" aria-label="${esc(mmChipLabel(x))}"><span class="mm-up-t">${esc(x.title)}${mmCxTag(x)}</span><span class="mm-up-d">${esc(parseDate(x.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))} · ${esc(mmTimeLabel(x))}</span>${mmRgTag(x.region, true)}</button></li>`;
  return `<aside class="mt-card mm-up-card" aria-labelledby="mmUpH"><h3 id="mmUpH">Upcoming</h3>${up.length ? `<ul class="mm-ups">${up.slice(0, 6).map(li).join('')}</ul>` : '<p class="mt-empty">Nothing scheduled</p>'}
    ${past.length ? `<h3 class="mm-past-h">Recent</h3><ul class="mm-ups">${past.map(li).join('')}</ul>` : ''}
    <div class="mm-legend" aria-label="Region colors"><span><i class="mm-dot rg-pat"></i>Paterson (PAT)</span><span><i class="mm-dot rg-soflo"></i>South Florida (SoFlo)</span><span><i class="mm-dot rg-all"></i>All regions</span></div></aside>`;
}

/* ---------- meeting panel: opens over the calendar ---------- */
function mmPanelOpen(id, tab) {
  if (!mmFind(id)) return;
  state.mmOpener = state.mmSel && $('#mmPanel') ? state.mmOpener : id; state.mmSel = id; state.mmPTab = tab || 'meeting';
  mmPanelRender(true); document.querySelectorAll('.mm-chip.is-sel, .mm-up.is-sel').forEach(el => el.classList.remove('is-sel'));
  document.querySelectorAll(`[data-mm-open="${CSS.escape(id)}"]`).forEach(el => el.classList.add('is-sel'));
}
function mmPanelClose(quiet) {
  nqUnmount();
  const w = $('#mmPanel'); if (!w) { state.mmSel = null; return; }
  w.remove(); document.body.classList.remove('mm-panel-on'); const back = state.mmOpener; state.mmSel = null; state.mmOpener = null;
  if (quiet) return; document.querySelectorAll('.mm-chip.is-sel, .mm-up.is-sel').forEach(el => el.classList.remove('is-sel'));
  const el = back && document.querySelector(`#view-meetings [data-mm-open="${CSS.escape(back)}"]`); if (el) el.focus();
}
const mmTyping = a => !!a && a.matches('[contenteditable="true"], textarea, select, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="file"])');
function mmGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(200, Math.max(40, t.scrollHeight)) + 'px'; }
document.addEventListener('input', e => { if (e.target.id === 'mmObjIn') mmGrow(e.target); });
function mmPanelRender(first) {
  const mt = state.mmSel && mmFind(state.mmSel); let w = $('#mmPanel');
  if (!mt || state.view !== 'meetings') { if (w) mmPanelClose(true); return; }
  const a = document.activeElement, force = state.mmForce; state.mmForce = false;
  if (!first && !force && w && w.contains(a) && mmTyping(a)) { state.mmStale = true; return; }   // never redraw under someone typing
  state.mmStale = false;
  const body = w && w.querySelector('.mm-p-body'), scroll = body ? body.scrollTop : 0, focusSel = !first && a && w && w.contains(a) && a.id ? '#' + a.id : '';
  state.mmAnim = !w; if (!w) { w = document.createElement('div'); w.id = 'mmPanel'; w.className = 'mm-panel-wrap'; document.body.appendChild(w); }
  // Background redraws keep whatever someone has typed but not yet added (Nov 20 2026)
  const drafts = !force && !first && w ? [...w.querySelectorAll('form input[id], form textarea[id], form select[id]')].filter(x => x.type !== 'file' && x.type !== 'checkbox' && x.value !== (x.tagName === 'SELECT' ? x.dataset.def : x.defaultValue)).map(x => [x.id, x.value]) : [];
  const moBefore = state.mmAnim ? null : moKeys(w), tabNow = state.mmPTab || 'meeting', tabMoved = !state.mmAnim && state.mmTabShown && state.mmTabShown !== tabNow; state.mmTabShown = tabNow;
  w.innerHTML = mmPanelHtml(mt); document.body.classList.add('mm-panel-on'); rteHydrate(w);
  if (tabMoved) moIn(w.querySelector('.mm-p-body'), 4); else moNew(w, moBefore);
  nqMount(w, mt);
  drafts.forEach(([id, v]) => { const x = w.querySelector('#' + CSS.escape(id)); if (x) { x.value = v; if (x.id === 'mmObjIn') mmGrow(x); } });
  w.querySelectorAll('form select[id]').forEach(x => { x.dataset.def = x.value; });
  const nb = w.querySelector('.mm-p-body');
  if (first) { nb.scrollTop = 0; const h = $('#mmpTitle'); if (h) h.focus(); }
  else { nb.scrollTop = scroll; const f = state.mmFocus || focusSel; state.mmFocus = null; const el = f && w.querySelector(f); if (el) el.focus(); }
}
function mmPanelHtml(mt) {
  const admin = isAdmin(), tab = ['agenda', 'attend', 'notes'].includes(state.mmPTab) || !state.mmPTab ? 'meeting' : state.mmPTab, att = mmAttendCount(mt), openN = (mt.steps || []).filter(s => !s.done).length, nf = (mt.files || []).length + (mt.deck ? 1 : 0);
  // Agenda retired Nov 20 2026 (user request). One "Meeting" tab holds attendance, objectives, notes and next steps.
  // Old agenda data stays on each meeting (mt.agenda) in case it comes back.
  const tabs = [['meeting', 'Meeting', ''], ['files', 'Files', nf || ''], ['log', 'Activity', '']];
  const body = { meeting: mmPMeeting, files: mmPFiles, log: mmPLog }[tab] || mmPMeeting;
  const d = parseDate(mt.date);
  return `<div class="mm-scrim" data-mm-close></div>
  <aside class="mm-panel ${mmRgCls(mt.region)} ${state.mmAnim ? 'is-in' : ''}" role="dialog" aria-modal="true" aria-labelledby="mmpTitle">
    <header class="mm-p-head">
      <div class="mm-p-top">${isAdmin() ? `<button type="button" class="mm-retag" data-mm-retag="${esc(mt.id)}" aria-haspopup="menu" aria-expanded="false" title="Change region">${mmRgTag(mt.region)}<svg viewBox="0 0 32 32" fill="currentColor" width="14" height="14" aria-hidden="true"><path d="M16 22L6 12 7.4 10.6 16 19.2 24.6 10.6 26 12z"/></svg></button>` : mmRgTag(mt.region)}${mmCxTag(mt)}${(() => { const t = todayISO(), k = mt.canceled ? 'canceled' : mt.date === t ? 'today' : mt.date > t ? 'upcoming' : 'past'; return `<span class="mm-chip-s is-${k}">${esc(k === 'canceled' ? 'Canceled' : k === 'today' ? 'Today' : k === 'past' ? 'Held ' + relDays(mt.date) : relDays(mt.date).replace(/^./, c => c.toUpperCase()))}</span>`; })()}${admin ? `<button type="button" class="icon-btn mm-p-more" data-mm-more="${esc(mt.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions" title="More actions">${CI('overflow')}</button>` : ''}<button type="button" class="icon-btn mm-p-x" data-mm-close aria-label="Close meeting">${CI('close')}</button></div>
      <h2 id="mmpTitle" class="mm-p-title" tabindex="-1">${esc(mt.title)}</h2>
      <p class="mm-p-when">${esc(d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))} · ${esc(mmTimeLabel(mt))}</p>

    </header>
    <div class="mm-p-tabs" role="tablist" aria-label="Meeting sections">${tabs.map(([k, l, n]) => `<button type="button" role="tab" id="mmpt-${k}" class="mm-p-tab ${tab === k ? 'is-on' : ''}" aria-selected="${tab === k}" aria-controls="mmpBody" tabindex="${tab === k ? 0 : -1}" data-mm-ptab="${k}">${l}${n !== '' ? `<span class="mm-p-count">${n}</span>` : ''}</button>`).join('')}</div>
    <div class="mm-p-body" id="mmpBody" role="tabpanel" aria-labelledby="mmpt-${tab}">${body(mt)}</div>
    <input type="file" id="mmFile" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" class="hide">
  </aside>`;
}
// Sections collapse (Carbon accordion). Choice is remembered per section; Attendance starts collapsed. Nov 20 2026
const MM_COL_DEFAULT = { attendance: true };
function mmCollapsed(k) { if (!state.mmCol) { try { state.mmCol = JSON.parse(lsGet('ngc_mm_col') || '{}'); } catch (e) { state.mmCol = {}; } } return k in state.mmCol ? !!state.mmCol[k] : !!MM_COL_DEFAULT[k]; }
const mmSlug = t => String(t).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
const mmTile = (title, sub, inner, cls) => { const k = mmSlug(title), c = mmCollapsed(k); return `<section class="mm-tile ${cls || ''} ${c ? 'is-col' : ''}" id="mmSec-${k}" data-mm-sec="${k}"><div class="mm-tile-h"><button type="button" class="mm-tile-tog" aria-expanded="${!c}" aria-controls="mmSecB-${k}" data-mm-col="${k}">${CI('chevron')}<h3>${title}</h3></button>${sub ? `<span class="mm-tile-sub">${sub}</span>` : ''}</div><div class="mm-tile-b" id="mmSecB-${k}" ${c ? 'hidden' : ''}>${inner}</div></section>`; };
const mmMoveBtns = (kind, id, i, n, label) => `<button type="button" class="icon-btn" data-mm-move="${kind}:${esc(id)}:-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(label)} up" title="Move up">${CI('arrow-up')}</button><button type="button" class="icon-btn" data-mm-move="${kind}:${esc(id)}:1" ${i === n - 1 ? 'disabled' : ''} aria-label="Move ${esc(label)} down" title="Move down">${CI('arrow-down')}</button>`;

/* Objectives (the agenda and its standing milestone check were retired Nov 20 2026) */
// Meeting tab in the order a meeting runs (standard minutes): why we're meeting, who's here, what was said and
// decided, who does what next. Attendance stays folded to a one-line count. Nov 20 2026
function mmPMeeting(mt) {
  const n = (mt.objectives || []).length, open = (mt.steps || []).filter(s => !s.done).length, c = mmAttendCount(mt);
  const jump = [['objectives', 'Objectives', n || ''], ['attendance', 'Attendance', c.marked ? `${c.present}/${c.total}` : ''], ['notes', 'Notes', ''], ['next-steps', 'Next steps', open ? `${open} open` : ''], ['comments', 'Comments', (mt.comments || []).length || '']];
  return `<nav class="mm-jump" aria-label="Jump to a section">${jump.map(([k, l, x]) => `<a href="#mmSec-${k}" class="mm-jump-a" data-mm-jump="${k}">${l}${x !== '' ? `<span>${x}</span>` : ''}</a>`).join('')}</nav>`
    + mmPAgenda(mt) + mmPAttend(mt) + mmPNotes(mt) + mmPComments(mt);
}
function mmPComments(mt) {
  const me = mmMe(), list = mt.comments || [];
  const rows = list.map(c => `<li class="mm-cmt"><div class="mm-cmt-h"><b>${esc(c.by || 'Someone')}</b><span>${esc(fmtWhen(c.at))}</span>${isAdmin() || c.by === me ? `<button type="button" class="icon-btn" data-mm-cmtdel="${esc(c.id)}" aria-label="Remove comment" title="Remove">${CI('close')}</button>` : ''}</div><div class="mm-cmt-t">${renderNoteText({ text: c.text })}</div></li>`).join('');
  return mmTile('Comments', list.length ? String(list.length) : '', `${rows ? `<ul class="mm-cmts">${rows}</ul>` : ''}
    ${mmContrib() ? `<form class="mm-form" data-mm-cmtform="${esc(mt.id)}"><div class="field mm-f-grow"><label for="mmCmtT">Comment</label><textarea id="mmCmtT" name="text" rows="2" maxlength="2000"></textarea></div><button class="btn btn-tonal" type="submit">Post</button></form>` : ''}`);
}
function mmPAgenda(mt) {   // objectives only since Nov 20 2026
  const admin = mmContrib(), obs = mt.objectives || [], ag = mt.agenda || [], n = obs.length;
  const objRows = obs.map((o, i) => `<li class="mm-num-row" data-mo="obj-${esc(o.id)}"><span class="mm-num">${i + 1}</span><span class="mm-num-t">${esc(o.text)}</span>${admin ? `<span class="mm-row-acts">${mmMoveBtns('obj', o.id, i, n, 'objective ' + (i + 1))}<button type="button" class="icon-btn" data-mm-objedit="${esc(o.id)}" aria-label="Edit objective ${i + 1}" title="Edit">${CI('edit')}</button><button type="button" class="icon-btn" data-mm-objdel="${esc(o.id)}" aria-label="Remove objective ${i + 1}" title="Remove">${CI('close')}</button></span>` : ''}</li>`).join('');
  const objForm = admin ? `<form class="mm-form mm-form-obj" data-mm-objform="${esc(mt.id)}">
      <div class="field mm-f-no"><label for="mmObjNo">No.</label><input id="mmObjNo" name="no" type="number" inputmode="numeric" min="1" max="${n + 1}" value="${n + 1}"></div>
      <div class="field mm-f-grow"><label for="mmObjIn">Objective</label><textarea id="mmObjIn" name="text" rows="1" maxlength="4000" ></textarea></div>
      <button class="btn btn-tonal" type="submit">Add</button></form>` : '';
  return mmTile('Objectives', n ? `${n}` : '', `${n ? `<ol class="mm-nums">${objRows}</ol>` : (admin ? '' : '<p class="mt-empty">None yet</p>')}${objForm}`);
}
/* Standing item: open milestones for the meeting's region that are due soon, late or blocked,
   plus a quiet line naming owners whose check-ins are due. Collapsed by default. */
function mmMsCheck(mt, num) {
  const base = parseDate(mt.date) < today() ? todayISO() : mt.date, nextMt = mmList().find(x => x.date > mt.date && (!x.region || !mt.region || x.region === mt.region));
  const bd = parseDate(base), bm = bd.getMonth(), qEnd = mmIso(new Date(bd.getFullYear(), bm + (2 - ((bm + 6) % 12) % 3) + 1, 0));   // end of the fiscal quarter
  const until = [nextMt ? nextMt.date : '', qEnd, offsetDateISO(base, 1)].sort().pop();   // next meeting or quarter end, whichever is later
  const list = M().filter(m => !m._draft && m.status !== 'complete' && mmInRegion(m, mt.region));
  const due = list.filter(m => m.due_date && m.due_date <= until).sort((x, y) => x.due_date.localeCompare(y.due_date));
  const late = due.filter(m => m.due_date < todayISO()).length;
  const blocked = list.filter(m => effectiveStatus(m) === 'blocked' || (m.dependency && String(m.dependency).trim()));
  const stale = {}; list.filter(needsCheckin).forEach(m => ownersOf(m).slice(0, 1).forEach(o => { stale[o] = (stale[o] || 0) + 1; }));
  const row = m => { const k = effectiveStatus(m); return `<li class="mm-ms"><i class="stdot st-${esc(k)}" aria-hidden="true"></i><span class="mm-ms-main"><button type="button" class="ag-link" data-expand="${esc(m.id)}">${esc(m.activity)}</button><span class="mm-ms-m">${esc(SM(k).label)} · ${esc(m.owner || 'No owner')}${m.due_date ? ` · ${m.due_date < todayISO() ? 'was due' : 'due'} ${esc(fmtDate(m.due_date))}` : ''}${m.dependency ? ` · Waiting on: ${esc(m.dependency)}` : ''}</span></span></li>`; };
  const sum = [`${due.length} due by ${fmtDate(until).replace(/, \d{4}$/, '')}`, late ? `${late} late` : '', blocked.length ? `${blocked.length} blocked or waiting` : ''].filter(Boolean).join(' · ');
  const st = Object.entries(stale).sort((a, b) => b[1] - a[1]);
  return `<details class="mm-standing" ${state.mmMsOpen ? 'open' : ''} data-mm-msdetails><summary><span class="mm-num">${num}</span><span class="mm-num-t"><span class="mm-ag-t">Milestone check <span class="mm-standing-tag">Standing item</span></span><span class="mm-ag-m">${esc(sum)}${mt.region ? ' · ' + esc(mmRgName(mt.region, true)) : ''}</span></span></summary>
    <div class="mm-standing-b">
      ${due.length ? `<h4>Due by ${esc(fmtDate(until))}</h4><ul class="mm-mss">${due.slice(0, 12).map(row).join('')}</ul>${due.length > 12 ? `<p class="mm-help">And ${due.length - 12} more on the board.</p>` : ''}` : `<p class="mt-empty">Nothing due before ${esc(fmtDate(until))}</p>`}
      ${blocked.length ? `<h4>Blocked or waiting on others</h4><ul class="mm-mss">${blocked.slice(0, 8).map(row).join('')}</ul>` : ''}
      ${st.length ? `<p class="mm-stale">Check-ins due: ${st.map(([o, c]) => `${esc(o)} (${c})`).join(', ')}</p>` : ''}
      ${mmContrib() ? `<button type="button" class="btn btn-ghost btn-sm" data-mm-mscheck="off">Remove from this agenda</button>` : ''}
    </div></details>`;
}
function mmPAttend(mt) {
  const admin = mmContrib(), r = mmRoster(mt), a = mt.attend || {}, c = mmAttendCount(mt), roles = {}; (meta().owners || []).forEach(o => { if (o.role) roles[o.name] = mmRoleOnly(o.role); });
  const custom = Array.isArray(mt.roster), opts = [['present', 'Present'], ['absent', 'Absent']];   // Excused retired Nov 20 2026
  const rows = r.map(n => `<li class="mm-att-row"><span class="mm-att-n"><b>${esc(n)}</b>${roles[n] ? `<small>${esc(roles[n])}</small>` : (Array.isArray(mt.roster) ? mt.roster : mmDefaultRoster(mt.region)).includes(n) ? '' : '<small>Guest</small>'}</span>
    <span class="mm-seg" role="radiogroup" aria-label="Attendance for ${esc(n)}">${opts.map(([v, l]) => `<button type="button" role="radio" class="mm-seg-b ${(a[n] === 'excused' ? 'absent' : a[n]) === v ? 'is-on is-' + v : ''}" aria-checked="${(a[n] === 'excused' ? 'absent' : a[n]) === v}" data-mm-att="${esc(n)}" data-v="${v}">${l}</button>`).join('')}</span></li>`).join('');
  const others = rosterNames().filter(n => !r.includes(n));
  return mmTile('Attendance', `${c.present} of ${c.total} present${c.marked < c.total ? ` · ${c.total - c.marked} not marked` : ''}`, `

    <div class="mm-tile-acts"><button type="button" class="btn btn-tonal btn-sm" data-mm-allpresent ${c.marked === c.total && c.present === c.total ? 'disabled' : ''}>Mark everyone present</button>${admin ? `<button type="button" class="btn btn-ghost btn-sm" data-mm-roster>Edit roster</button>` : ''}</div>
    ${r.length ? `<ul class="mm-att">${rows}</ul>` : '<p class="mt-empty">No one on the roster yet</p>'}
    <form class="mm-form" data-mm-guestform="${esc(mt.id)}"><div class="field mm-f-grow"><label for="mmGuest">Add someone</label><input id="mmGuest" name="who" list="mmGuestList" maxlength="80" placeholder="Name"><datalist id="mmGuestList">${others.map(n => `<option value="${esc(n)}">`).join('')}</datalist></div><button class="btn btn-tonal" type="submit">Add as present</button></form>`);
}
function mmPNotes(mt) {
  const admin = isAdmin(), me = myOwnerName(), meName = mmMe(), t = todayISO(), lastN = (mt.log || []).filter(x => /notes/i.test(x.what)).pop();
  const steps = (mt.steps || []).map(s => { const late = !s.done && s.due && s.due < t, canDel = admin || (s.by && s.by === meName);
    return `<li class="mm-step ${s.done ? 'is-done' : ''}" data-mo="st-${esc(s.id)}"><input type="checkbox" data-mm-stepdone="${esc(s.id)}" ${s.done ? 'checked' : ''} aria-label="Done: ${esc(s.text)}">
      <div class="mm-step-main"><div class="mm-step-t">${s.owner && s.owner === me ? '<span class="mt-tag mt-tag-blue">Yours</span> ' : ''}${esc(s.text)}</div><div class="mm-step-m ${late ? 'is-late' : ''}">${esc(s.owner || 'No owner')}${s.due ? ' · ' + (late ? 'overdue, was due ' : 'due ') + esc(fmtDate(s.due)) : ' · no due date'}${s.by ? ` · added by ${esc(s.by)}` : ''}</div></div>
      <span class="mm-row-acts"><button type="button" class="icon-btn" data-mm-stepedit="${esc(s.id)}" aria-label="Edit next step ${esc(s.text)}" title="Edit">${CI('edit')}</button>${canDel ? `<button type="button" class="icon-btn" data-mm-stepdel="${esc(s.id)}" aria-label="Remove next step ${esc(s.text)}" title="Remove">${CI('close')}</button>` : ''}</span></li>`; }).join('');
  const openN = (mt.steps || []).filter(s => !s.done).length;
  const live = mmNotesLive(mt), nv = (mt.noteHist || []).length, showT = !!state.mmNotesT;
  return mmTile('Notes', `<span id="mmNotesWho" class="mm-who" aria-live="polite">${nqWhoHtml(mt)}</span>${live && window.GH_NOCOLLAB ? `<span class="mm-live"><i aria-hidden="true"></i>${esc(live)} is taking notes</span>` : ''}<span id="mmNotesSaved" class="mm-saved" aria-live="polite">${lastN && !live ? `${esc(lastN.by)}, ${esc(mmAgo(lastN.at))}` : ''}</span><button type="button" class="mm-chip-b is-notes" data-mm-ntog aria-expanded="${showT}" aria-controls="mmNtl">Timeline${nv ? ` <b>${nv}</b>` : ''}</button>`,
    `${rteEditor(mt)}<div class="mm-ntl" id="mmNtl" ${showT ? '' : 'hidden'}><h4 class="mm-ntl-h">Notes timeline</h4>${mmNotesTimeline(mt)}</div>`)
    + mmTile('Next steps', (mt.steps || []).length ? `${openN} open` : '', `${steps ? `<ul class="mm-steps">${steps}</ul>` : ''}
      <form class="mm-form" data-mm-stepform="${esc(mt.id)}"><div class="field mm-f-grow"><label for="mmStepT">Next step</label><input id="mmStepT" name="text" maxlength="200" placeholder="What needs to happen"></div>
        <div class="field mm-f-lead"><label for="mmStepO">Owner</label><select id="mmStepO" name="owner">${ownerOptions('')}</select></div>
        <div class="field mm-f-date"><label for="mmStepD">Due date</label><input id="mmStepD" name="due" type="date" value="${esc(nextMeetingAfter(mt.date > t ? mt.date : t))}"></div>
        <button class="btn btn-tonal" type="submit">Add</button></form>`);
}
const MM_FILE_BUCKET = 'meeting-files', MM_FILE_MB = 25;
const MM_FILE_EXT = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint', csv: 'text/csv', txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const mmExt = n => (String(n).match(/\.([a-z0-9]+)$/i) || [])[1] ? String(n).match(/\.([a-z0-9]+)$/i)[1].toLowerCase() : '';
const mmSize = b => b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const mmCanView = f => /^(pdf|pptx|jpe?g|png|gif|webp|txt|csv)$/.test(f.ext || '');
function mmPFiles(mt) {
  const admin = mmContrib(), meName = mmMe(), d = mt.deck, pend = state.mmPending && state.mmPending.mt === mt.id ? state.mmPending : null;
  const deck = d ? `<div class="mm-deck"><button type="button" class="mm-thumb" data-mm-view="${esc(mt.id)}" aria-label="Open slides ${esc(d.name)}">${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : `<span class="mm-thumb-k">${mmIc('present', 28)}<b>${deckKind(d) === 'pptx' ? 'PowerPoint' : 'PDF'}</b></span>`}</button>
      <div class="mm-deck-main"><div class="mm-deck-n">${esc(d.name)}</div><div class="muted">${d.pages ? d.pages + ' slide' + (d.pages === 1 ? '' : 's') + ' · ' : ''}${mmSize(d.size)}${String(d.path).startsWith('local:') ? ' · saved in this browser only' : ''}</div>
        <div class="mm-deck-acts"><button type="button" class="btn btn-filled btn-sm" data-mm-present="${esc(mt.id)}">${mmIc('present')} Present</button><button type="button" class="btn btn-ghost btn-sm" data-mm-view="${esc(mt.id)}">Open viewer</button><button type="button" class="btn btn-ghost btn-sm" data-mm-deckdl="${esc(mt.id)}">Download</button>${admin ? `<button type="button" class="btn btn-ghost btn-sm" data-mm-upload="${esc(mt.id)}">Replace</button><button type="button" class="btn btn-ghost btn-sm" data-mm-deckdel="${esc(mt.id)}">Remove</button>` : ''}</div></div></div>`
    : admin ? `<div class="mm-drop" data-mm-drop="${esc(mt.id)}"><button type="button" class="btn btn-tonal" data-mm-upload="${esc(mt.id)}">${mmIc('up')} Upload slides</button><p class="muted">PowerPoint (.pptx) or PDF, up to ${MM_MAX_MB} MB. Or drag the file here.</p></div>`
    : '<p class="mt-empty">No slides yet</p>';
  const files = (mt.files || []).map(f => `<li class="mm-file" data-mo="f-${esc(f.id)}"><span class="mm-file-ic" aria-hidden="true">${esc((f.ext || 'file').toUpperCase().slice(0, 4))}</span>
      <div class="mm-file-main"><div class="mm-file-n">${esc(f.name)}</div>${f.desc ? `<div class="mm-file-d">${esc(f.desc)}</div>` : ''}<div class="mm-file-m">${esc(f.fname || '')} · ${mmSize(f.size || 0)}${f.by ? ` · added by ${esc(f.by)}` : ''}${f.at ? `, ${esc(new Date(f.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}` : ''}${String(f.path).startsWith('local:') ? ' · saved in this browser only' : ''}</div></div>
      <span class="mm-row-acts"><button type="button" class="btn btn-ghost btn-sm" data-mm-fopen="${esc(f.id)}">Open</button><button type="button" class="btn btn-ghost btn-sm" data-mm-fdl="${esc(f.id)}">Download</button>${isAdmin() || f.by === meName ? `<button type="button" class="icon-btn" data-mm-fdel="${esc(f.id)}" aria-label="Remove ${esc(f.name)}" title="Remove">${CI('close')}</button>` : ''}</span></li>`).join('');
  const form = pend ? `<form class="mm-file-form" data-mm-fileform="${esc(mt.id)}"><div class="mm-file-pick"><b>${esc(pend.file.name)}</b> <span class="muted">${mmSize(pend.file.size)}</span><button type="button" class="btn btn-ghost btn-sm" data-mm-fcancel>Choose another</button></div>
      <div class="field"><label for="mmFName">Name</label><input id="mmFName" name="fname" maxlength="120" value="${esc(pend.file.name.replace(/\.[^.]+$/, ''))}"></div>
      <div class="field"><label for="mmFDesc">Description <span class="muted">(optional)</span></label><textarea id="mmFDesc" name="desc" rows="2" maxlength="500"></textarea></div>
      <div class="mm-tile-acts"><button class="btn btn-filled btn-sm" type="submit">Add file</button><button type="button" class="btn btn-ghost btn-sm" data-mm-fcancel="1">Cancel</button></div></form>`
    : `<div class="mm-drop" data-mm-fdrop="${esc(mt.id)}"><button type="button" class="btn btn-tonal" data-mm-fpick>${mmIc('up')} Add a file</button><p class="muted">Word, PDF, Excel, PowerPoint, images or text, up to ${MM_FILE_MB} MB. Or drag the file here.</p><input type="file" id="mmAFile" class="hide" accept="${Object.keys(MM_FILE_EXT).map(e => '.' + e).join(',')}"></div>`;
  return mmTile('Slides', '', deck) + mmTile('Files', (mt.files || []).length ? `${mt.files.length}` : '', `${files ? `<ul class="mm-files">${files}</ul>` : ''}${form}`);
}
function mmAgo(iso) { const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' hr ago'; return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
// Activity table: when, who, which part of the meeting, what changed. Nov 20 2026
const MM_LOG_AREAS = [[/notes|image/i, 'Notes'], [/next step|step:/i, 'Next steps'], [/objective/i, 'Objectives'], [/present|absent|excused|attendance|roster|guest|marked everyone/i, 'Attendance'], [/slides|deck|file|upload/i, 'Files'], [/schedul|details|region|canceled|cancelled|held|past meeting|title|date|time/i, 'Details']];
const mmLogArea = w => (MM_LOG_AREAS.find(([re]) => re.test(w)) || [0, 'Other'])[1];
function mmLogDetail(mt, x) {   // what a log line refers to, shown when the row is opened
  const a = mmLogArea(x.what), go = (k, l) => `<button type="button" class="btn btn-ghost btn-sm" data-mm-goto-sec="${k}">${l || 'Go to ' + ({ objectives: 'Objectives', notes: 'Notes', 'next-steps': 'Next steps', attendance: 'Attendance', files: 'Files' }[k])}</button>`;
  if (a === 'Notes') {
    const h = mt.noteHist || [], t = Date.parse(x.at) + 5000, i = (() => { for (let k = h.length - 1; k >= 0; k--) if (h[k].by === x.by && Date.parse(h[k].at) <= t) return k; return -1; })();
    if (i < 0) return `<p class="mm-log-dp">No saved version for this edit</p>${go('notes', 'Open notes')}`;
    return `<p class="mm-log-dp">What ${esc(h[i].by)} changed${h[i].since && h[i].since !== h[i].at ? ` between ${esc(new Date(h[i].since).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))} and ${esc(new Date(h[i].at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}` : ''}:</p>${mmNoteDiffHtml(i ? h[i - 1].text : '', h[i].text)}${go('notes', 'Open notes')}`;
  }
  if (a === 'Next steps') {
    const q = (x.what.split(/:\s*/)[1] || '').trim().toLowerCase(), st = (mt.steps || []).find(z => q && z.text.toLowerCase().startsWith(q.slice(0, 60)));
    return (st ? `<p class="mm-log-dp"><b>${esc(st.text)}</b><br>${esc(st.owner || 'No owner')} · ${st.due ? 'due ' + esc(fmtDate(st.due)) : 'no due date'} · <span class="mm-chip-s ${st.done ? 'is-done' : 'is-upcoming'}">${st.done ? 'Done' : 'Open'}</span></p>` : '<p class="mm-log-dp">This step has since been changed or removed.</p>') + go('next-steps');
  }
  if (a === 'Objectives') { const o = mt.objectives || []; return `${o.length ? `<ol class="mm-log-ol">${o.map(z => `<li>${esc(z.text)}</li>`).join('')}</ol>` : '<p class="mm-log-dp">No objectives now.</p>'}${go('objectives')}`; }
  if (a === 'Attendance') { const c = mmAttendCount(mt), at = mt.attend || {}, pres = mmRoster(mt).filter(n => at[n] === 'present'), abs = mmRoster(mt).filter(n => at[n] === 'absent' || at[n] === 'excused'); return `<p class="mm-log-dp"><span class="mm-chip-s is-attendance">${c.present} of ${c.total} present</span>${pres.length ? ` Present: ${esc(pres.join(', '))}.` : ''}${abs.length ? ` Absent: ${esc(abs.join(', '))}.` : ''}</p>${go('attendance')}`; }
  if (a === 'Files') { const f = mt.files || []; return `${f.length || mt.deck ? `<ul class="mm-log-ol">${mt.deck ? `<li>Slides: ${esc(mt.deck.name)}</li>` : ''}${f.map(z => `<li>${esc(z.name)}</li>`).join('')}</ul>` : '<p class="mm-log-dp">No files now.</p>'}${go('files')}`; }
  return `<p class="mm-log-dp">${esc(mmWhen(mt, true))} · ${esc(mmRgName(mt.region))}${mt.canceled ? ' · Canceled' : ''}</p>${isAdmin() ? `<button type="button" class="btn btn-ghost btn-sm" data-mm-edit="${esc(mt.id)}">Edit details</button>` : ''}`;
}
function mmPLog(mt) {
  const L = (mt.log || []).slice().reverse().slice(0, 150);
  if (!L.length) return '<p class="mt-empty">No changes yet</p>';
  const when = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (`<div class="mm-log-wrap" tabindex="0" role="region" aria-label="Meeting activity"><table class="mm-log-t"><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Section</th><th scope="col">Change</th></tr></thead><tbody>${L.map((x, i) => { const a = mmLogArea(x.what); return `<tr class="mm-log-r" tabindex="0" role="button" aria-expanded="false" aria-label="${esc(x.what)}, ${esc(x.by || 'Someone')}, ${esc(when(x.at))}. Show details" data-mm-logi="${i}"><td class="mm-log-when">${CI('chevron')}${esc(when(x.at))}</td><td>${esc(x.by || 'Someone')}</td><td><span class="mm-log-area is-${mmSlug(a)}">${esc(a)}</span></td><td>${esc(x.what)}</td></tr><tr class="mm-log-d" hidden><td colspan="4"></td></tr>`; }).join('')}</tbody></table></div>`);
}

/* ---------- rich-text meeting notes (Nov 19 2026) ----------
   Carbon toolbar over a contenteditable box. Notes are stored as cleaned HTML in mt.notes
   (old plain-text notes still load). Images upload as meeting files and are referenced by
   file id, so nothing public is ever linked. */
const RTE_FONTS = [['', 'IBM Plex Sans'], ["'IBM Plex Serif', Georgia, serif", 'IBM Plex Serif'], ["'IBM Plex Mono', Menlo, monospace", 'IBM Plex Mono']];
const RTE_SIZES = [['12px', 'Small'], ['', 'Normal'], ['18px', 'Large'], ['24px', 'Heading']];
const RTE_MARKS = [['#fddc69', 'Yellow'], ['#a7f0ba', 'Green'], ['#a6c8ff', 'Blue'], ['#ffafd2', 'Pink'], ['#d4bbff', 'Purple']];
const RTE_IC = {
  bold: '<path d="M18.25,25H9V7h8.5a5.25,5.25,0,0,1,4,8.65A5.25,5.25,0,0,1,18.25,25ZM12,22h6.23a2.25,2.25,0,1,0,0-4.5H12Zm0-7.5h5.5a2.25,2.25,0,1,0,0-4.5H12Z"/>',
  italic: '<path d="M25 9L25 7 12 7 12 9 17.14 9 12.77 23 7 23 7 25 20 25 20 23 14.86 23 19.23 9 25 9z"/>',
  underline: '<path d="M4 26H28V28H4zM16 23a7 7 0 01-7-7V5h2V16a5 5 0 0010 0V5h2V16A7 7 0 0116 23z"/>',
  mark: '<path d="M27.7 8.7l-4.4-4.4a1 1 0 00-1.4 0L9 17.2V23h5.8L27.7 10.1a1 1 0 000-1.4zM14 21H11V18l9-9 3 3zM24.4 10.6l-3-3 2.6-2.6 3 3z"/><path class="rte-swatch" d="M4 26H28V30H4z"/>',
  ul: '<circle cx="7" cy="9" r="3"/><circle cx="7" cy="23" r="3"/><path d="M16 22H30V24H16zM16 8H30V10H16z"/>',
  ol: '<path d="M16 22H30V24H16zM16 8H30V10H16zM8 12V4H6V5H4V7H6v5H4v2h6V12zM10 30H4V26a2 2 0 012-2H8V22H4V20H8a2 2 0 012 2v2a2 2 0 01-2 2H6v2h4z"/>',
  outdent: '<path d="M14 6H28V8H14zM14 12H28V14H14zM7 18H28V20H7zM7 24H28V26H7zM10 6.41L6.71 10 10 13.59 8.58 15 3.96 10 8.58 5 10 6.41z"/>',
  indent: '<path d="M14 6H28V8H14zM14 12H28V14H14zM7 18H28V20H7zM7 24H28V26H7zM4 13.59L7.29 10 4 6.41 5.42 5 10.04 10 5.42 15 4 13.59z"/>',
  image: '<path d="M19 14a3 3 0 10-3-3A3 3 0 0019 14zm0-4a1 1 0 11-1 1A1 1 0 0119 10z"/><path d="M26 4H6A2 2 0 004 6V26a2 2 0 002 2H26a2 2 0 002-2V6A2 2 0 0026 4zm0 22H6V20l5-5 5.59 5.59a2 2 0 002.82 0L21 19l5 5zm0-4.83l-3.59-3.59a2 2 0 00-2.82 0L18 19.17l-5.59-5.59a2 2 0 00-2.82 0L6 17.17V6H26z"/>'
};
const rteIc = n => `<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true">${RTE_IC[n]}</svg>`;
// Keep only formatting tags and a few safe style properties; images keep only their file id.
const RTE_TAGS = new Set(['P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'SPAN', 'BLOCKQUOTE', 'IMG']);
const RTE_CSS = { 'font-size': /^\d{1,2}px$/, 'font-family': /^[\w\s,'"-]{1,80}$/, 'background-color': /^(rgb\(\d{1,3}, ?\d{1,3}, ?\d{1,3}\)|#[0-9a-f]{3,6}|transparent)$/i,
  'font-weight': /^(bold|normal|[4-7]00)$/, 'font-style': /^(italic|normal)$/, 'text-decoration-line': /^(underline|none)$/, 'text-decoration': /^(underline|none)$/, 'margin-left': /^\d{1,3}px$/, 'padding-left': /^\d{1,3}px$/ };
function rteClean(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html'), root = doc.body.firstChild;
  const walk = el => [...el.childNodes].forEach(n => {
    if (n.nodeType === 3) return;
    if (n.nodeType !== 1) return n.remove();
    let x = n;
    if (n.tagName === 'FONT') { x = doc.createElement('span'); const face = n.getAttribute('face'); if (face) x.style.fontFamily = face; while (n.firstChild) x.appendChild(n.firstChild); n.replaceWith(x); }
    else if (n.tagName === 'MARK') { x = doc.createElement('span'); x.style.backgroundColor = '#fddc69'; while (n.firstChild) x.appendChild(n.firstChild); n.replaceWith(x); }
    else if (['H1', 'H2', 'H3', 'H4'].includes(n.tagName)) { x = doc.createElement('p'); const s = doc.createElement('span'); s.style.fontSize = n.tagName === 'H1' ? '24px' : '18px'; s.style.fontWeight = 'bold'; while (n.firstChild) s.appendChild(n.firstChild); x.appendChild(s); n.replaceWith(x); }
    else if (!RTE_TAGS.has(n.tagName)) { if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'TEMPLATE', 'SVG', 'MATH'].includes(n.tagName)) return n.remove(); walk(n); return n.replaceWith(...n.childNodes); }
    const keep = x.tagName === 'IMG' ? { fid: x.getAttribute('data-mm-file'), alt: x.getAttribute('alt') } : null;
    const css = [...x.style].map(p => [p, x.style.getPropertyValue(p)]).filter(([p, v]) => RTE_CSS[p] && RTE_CSS[p].test(v.trim()));
    [...x.attributes].forEach(a => x.removeAttribute(a.name));
    if (keep) { if (!/^[\w-]{1,40}$/.test(keep.fid || '')) return x.remove(); x.setAttribute('data-mm-file', keep.fid); x.setAttribute('alt', (keep.alt || 'Image').slice(0, 120)); return; }
    if (css.length) x.setAttribute('style', css.map(([p, v]) => `${p}: ${v.trim()}`).join('; '));
    walk(x);
  });
  walk(root);
  return root.innerHTML.replace(/(<br>\s*)+$/, '').trim();
}
// Saved notes are HTML from the editor; a line with no tags can still hold entities like &nbsp; (the editor adds one after a trailing space). Nov 20 2026
const rteIsHtml = s => /<\/?(p|div|br|b|strong|i|em|u|ul|ol|li|span|blockquote|img)\b|&(nbsp|amp|lt|gt|quot|#\d+);/i.test(String(s || ''));
const rteFromNotes = s => rteIsHtml(s) ? rteClean(s) : esc(String(s || '')).replace(/\n/g, '<br>');
// Notes timeline (Nov 20 2026): a plain-text snapshot per person every 5 minutes (server does the same in growth_meeting_edit)
function rteText(html) { const doc = new DOMParser().parseFromString(`<div>${String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|blockquote)>/gi, '\n$&')}</div>`, 'text/html'); doc.querySelectorAll('li').forEach(li => li.prepend('• ')); return (doc.body.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000); }
function mmNoteVersion(mt, text) {
  const h = mt.noteHist = mt.noteHist || [], by = mmMe(), now = new Date().toISOString(), last = h[h.length - 1];
  if (last && last.by === by && Date.now() - Date.parse(last.at) < 300000) Object.assign(last, { at: now, text, since: last.since || last.at }); else h.push({ at: now, by, text, since: now });
  if (h.length > 60) h.splice(0, h.length - 60);
}
function mmLineDiff(a, b) {   // added and removed lines between two versions (LCS on lines)
  const A = String(a || '').split('\n').filter(x => x.trim()), B = String(b || '').split('\n').filter(x => x.trim()), n = A.length, m = B.length;
  if (n * m > 40000) return { add: B.filter(x => !A.includes(x)), del: A.filter(x => !B.includes(x)) };
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const add = [], del = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) del.push(A[i++]); else add.push(B[j++]); }
  while (i < n) del.push(A[i++]); while (j < m) add.push(B[j++]);
  return { add, del };
}
function mmNoteDiffHtml(prev, cur) {
  const d = mmLineDiff(prev, cur);
  if (!d.add.length && !d.del.length) return '<p class="mm-nt-none">No text change (formatting only)</p>';
  return `<ul class="mm-nt-diff">${d.add.slice(0, 30).map(x => `<li class="is-add"><span aria-hidden="true">+</span><span class="sr-only">Added: </span>${esc(x)}</li>`).join('')}${d.del.slice(0, 30).map(x => `<li class="is-del"><span aria-hidden="true">−</span><span class="sr-only">Removed: </span>${esc(x)}</li>`).join('')}</ul>`;
}
function mmNotesTimeline(mt) {
  const h = (mt.noteHist || []).slice();
  if (!h.length) return '<p class="mt-empty">No saved versions yet</p>';
  return `<ol class="mm-nt">${h.map((v, i) => ({ v, prev: i ? h[i - 1].text : '' })).reverse().map(({ v, prev }, k) => { const d = mmLineDiff(prev, v.text); return `<li class="mm-nt-i" data-mo="nt-${esc(v.since || v.at)}">
      <div class="mm-nt-h"><span class="mm-chip-s is-notes">${esc(v.by)}</span><span class="mm-nt-t">${esc(new Date(v.since || v.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}${v.since && Math.abs(Date.parse(v.at) - Date.parse(v.since)) > 60000 ? ' to ' + esc(new Date(v.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) : ''}</span>${d.add.length ? `<span class="mm-nt-n is-add">+${d.add.length}</span>` : ''}${d.del.length ? `<span class="mm-nt-n is-del">−${d.del.length}</span>` : ''}${k === 0 ? '<span class="mm-nt-n">Latest</span>' : ''}</div>
      ${mmNoteDiffHtml(prev, v.text)}
      <details class="mm-nt-full"><summary>Full notes at this point</summary><pre>${esc(v.text)}</pre></details></li>`; }).join('')}</ol>`;
}
function mmNotesLive(mt) {   // someone else saved notes in the last 2 minutes
  const h = mt.noteHist || [], v = h[h.length - 1];
  return v && v.by !== mmMe() && Date.now() - Date.parse(v.at) < 120000 ? v.by : '';
}
function rteLegacyBody(mt) { return `<div class="rte-body" id="mmNotes" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Meeting notes" spellcheck="true" data-mm-notes="${esc(mt.id)}" data-placeholder="Decisions, takeaways and anything people should remember">${rteFromNotes(mt.notes)}</div>`; }
function rteEditor(mt) {
  const sel = (id, label, opts) => `<select class="rte-sel" id="${id}" aria-label="${label}" title="${label}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === '' ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const b = (cmd, label, key) => `<button type="button" class="rte-b" data-rte="${cmd}" aria-label="${label}" title="${label}${key ? ' (' + key + ')' : ''}" aria-pressed="false">${rteIc(cmd)}</button>`;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  return `<div class="rte">
    <div class="rte-bar" role="toolbar" aria-label="Text formatting" aria-controls="mmNotes">
      ${sel('rteFont', 'Font', RTE_FONTS)}${sel('rteSize', 'Font size', RTE_SIZES)}<span class="rte-sep" aria-hidden="true"></span>
      ${b('bold', 'Bold', mod + 'B')}${b('italic', 'Italic', mod + 'I')}${b('underline', 'Underline', mod + 'U')}
      <span class="rte-markw"><button type="button" class="rte-b rte-mark" data-rte="mark" aria-label="Highlight" title="Highlight" aria-haspopup="true" aria-expanded="false">${rteIc('mark')}</button>
        <span class="rte-marks" role="menu" aria-label="Highlight color" hidden>${RTE_MARKS.map(([c, l]) => `<button type="button" role="menuitem" class="rte-sw" data-rte-mark="${c}" style="background:${c}" aria-label="${l}" title="${l}"></button>`).join('')}<button type="button" role="menuitem" class="rte-sw rte-sw-none" data-rte-mark="transparent" aria-label="No highlight" title="No highlight">${CI('close')}</button></span></span>
      <span class="rte-sep" aria-hidden="true"></span>${b('ul', 'Bulleted list')}${b('ol', 'Numbered list')}${b('outdent', 'Decrease indent', 'Shift+Tab')}${b('indent', 'Increase indent', 'Tab')}
      <span class="rte-sep" aria-hidden="true"></span>${b('image', 'Insert image')}<input type="file" id="rteImg" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
    </div>
    ${window.GH_NOCOLLAB ? rteLegacyBody(mt) : `<div class="rte-qph" id="mmNotesQ" data-mm-nq="${esc(mt.id)}"><div class="rte-body rte-preview" aria-busy="true">${rteFromNotes(mt.notes)}</div></div>`}
  </div>`;
}
const RTE_EXEC = { bold: 'bold', italic: 'italic', underline: 'underline', ul: 'insertUnorderedList', ol: 'insertOrderedList', indent: 'indent', outdent: 'outdent' };
let rteRange = null;
const rteBody = () => $('#mmNotes.rte-body');
function rteKeep() { const ed = rteBody(), s = getSelection(); if (ed && s.rangeCount && ed.contains(s.anchorNode)) rteRange = s.getRangeAt(0).cloneRange(); }
function rteRestore() { const ed = rteBody(); if (!ed) return null; const cur = getSelection(); if (cur.rangeCount && ed.contains(cur.anchorNode)) return ed; ed.focus(); if (rteRange && ed.contains(rteRange.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(rteRange); } return ed; }
function rteChanged() { const ed = rteBody(); if (!ed) return; ed.classList.toggle('is-empty', !ed.textContent.trim() && !ed.querySelector('img, li')); ed.dispatchEvent(new Event('input', { bubbles: true })); rteState(); }
function rteState() {
  const ed = rteBody(); if (!ed) return; const s = getSelection(); if (!s.rangeCount || !ed.contains(s.anchorNode)) return;
  ['bold', 'italic', 'underline', 'ul', 'ol'].forEach(k => { const btn = document.querySelector(`.rte-b[data-rte="${k}"]`); if (btn) { let on = false; try { on = document.queryCommandState(RTE_EXEC[k]); } catch (e) {} btn.setAttribute('aria-pressed', String(on)); } });
  const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement, cs = el && getComputedStyle(el);
  const fs = $('#rteSize'), ff = $('#rteFont');
  if (fs && cs) fs.value = (RTE_SIZES.find(([v]) => v && v === cs.fontSize) || [''])[0];
  if (ff && cs) (ff.value = /^["']?IBM Plex Mono/i.test(cs.fontFamily) ? RTE_FONTS[2][0] : /^["']?(IBM Plex Serif|Georgia)/i.test(cs.fontFamily) ? RTE_FONTS[1][0] : '');
}
function rteExec(cmd, val) {
  if (nqActive()) return nqExec(cmd, val);
  const ed = rteRestore(); if (!ed) return;
  try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
  if (cmd === 'fontSize') {
    document.execCommand('fontSize', false, '7');
    ed.querySelectorAll('font[size="7"], span[style*="xxx-large"]').forEach(n => { n.removeAttribute('size'); n.style.fontSize = val || ''; if (!n.getAttribute('style')) n.replaceWith(...n.childNodes); });
  } else if (cmd === 'fontName') {
    document.execCommand('fontName', false, val || 'IBM Plex Sans');
    if (!val) ed.querySelectorAll('[style*="font-family"]').forEach(n => { if (/IBM Plex Sans/.test(n.style.fontFamily)) { n.style.fontFamily = ''; if (!n.getAttribute('style')) n.replaceWith(...n.childNodes); } });
  } else document.execCommand(cmd, false, val);
  rteKeep(); rteChanged();
}
async function rteImage(file) {
  if (nqActive()) return nqImage(file);
  const ed = rteBody(), mt = ed && mmFind(ed.dataset.mmNotes); if (!mt || !file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return toast('Use a PNG, JPG, GIF or WebP image', 'warn');
  clearTimeout(mmNotesT); await mmEdit(mt, 'notes', { notes: rteClean(ed.innerHTML), text: rteText(rteClean(ed.innerHTML)) }, 'Edited notes');   // save typing first
  const f = await mmFileUpload(mmFind(mt.id) || mt, file, 'Image in notes: ' + file.name, '');
  if (!f) return;
  const ed2 = rteRestore(); if (!ed2) return;
  if (!rteRange || !ed2.contains(rteRange.startContainer)) { const r = document.createRange(); r.selectNodeContents(ed2); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  document.execCommand('insertHTML', false, `<img data-mm-file="${esc(f.id)}" alt="${esc(file.name)}"><br>`);
  rteHydrate(ed2); rteChanged();
}
function rteHydrate(root) {
  const ed = root && root.matches && root.matches('.rte-body') ? root : (root || document).querySelector('.rte-body'); if (!ed) return;
  ed.classList.toggle('is-empty', !ed.textContent.trim() && !ed.querySelector('img, li'));
  const mt = mmFind(ed.dataset.mmNotes); if (!mt) return;
  ed.querySelectorAll('img[data-mm-file]:not([src])').forEach(async img => {
    const f = (mt.files || []).find(x => x.id === img.dataset.mmFile);
    if (!f) { img.alt = 'Image removed'; img.classList.add('is-missing'); return; }
    try { img.src = URL.createObjectURL(await mmFileBlob(f)); } catch (e) { img.alt = 'Image could not load'; img.classList.add('is-missing'); }
  });
}
document.addEventListener('mousedown', e => { if (e.target.closest('.rte-b, .rte-sw')) e.preventDefault(); });   // keep the text selection
document.addEventListener('click', e => {
  const sw = e.target.closest('[data-rte-mark]');
  if (sw) { const m = sw.closest('.rte-marks'); m.hidden = true; m.previousElementSibling.setAttribute('aria-expanded', 'false'); const c = sw.dataset.rteMark; document.querySelector('.rte-mark .rte-swatch')?.setAttribute('fill', c === 'transparent' ? 'currentColor' : c); return rteExec('hiliteColor', c); }
  const b = e.target.closest('.rte-b'); if (!b) { const open = document.querySelector('.rte-marks:not([hidden])'); if (open && !e.target.closest('.rte-markw')) { open.hidden = true; open.previousElementSibling.setAttribute('aria-expanded', 'false'); } return; }
  const k = b.dataset.rte;
  if (k === 'mark') { const m = b.nextElementSibling, show = m.hidden; m.hidden = !show; b.setAttribute('aria-expanded', String(show)); if (show) m.querySelector('button').focus(); return; }
  if (k === 'image') { rteKeep(); const f = $('#rteImg'); f.value = ''; f.onchange = () => rteImage(f.files[0]); return f.click(); }
  rteExec(RTE_EXEC[k]);
});
document.addEventListener('change', e => { if (e.target.id === 'rteFont') rteExec('fontName', e.target.value); else if (e.target.id === 'rteSize') rteExec('fontSize', e.target.value); });
document.addEventListener('focusin', e => { if (e.target.matches('.rte-sel')) rteKeep(); });
document.addEventListener('selectionchange', () => { rteKeep(); rteState(); });
document.addEventListener('keydown', e => {
  const ed = e.target.closest && e.target.closest('.rte-body'); if (!ed) { if (e.key === 'Escape' && e.target.closest && e.target.closest('.rte-marks')) { const m = e.target.closest('.rte-marks'); m.hidden = true; m.previousElementSibling.focus(); e.stopPropagation(); } return; }
  if (e.key === 'Tab' && getSelection().anchorNode && (getSelection().anchorNode.parentElement || {}).closest && getSelection().anchorNode.parentElement.closest('li')) { e.preventDefault(); e.stopPropagation(); rteExec(e.shiftKey ? 'outdent' : 'indent'); }
}, true);
document.addEventListener('paste', e => {
  const ed = e.target.closest && e.target.closest('.rte-body'); if (!ed || ed.closest('.rte-q')) return;   // Quill handles its own paste
  const img = [...(e.clipboardData.files || [])].find(f => /^image\//.test(f.type));
  e.preventDefault();
  if (img) { rteKeep(); return rteImage(img); }
  const html = e.clipboardData.getData('text/html'), txt = e.clipboardData.getData('text/plain');
  document.execCommand('insertHTML', false, html ? rteClean(html.replace(/^[\s\S]*<!--StartFragment-->|<!--EndFragment-->[\s\S]*$/g, '')).replace(/<img[^>]*>/g, '') : esc(txt).replace(/\n/g, '<br>'));
  rteChanged();
});

/* ---------- deleted meetings (Nov 19 2026) ----------
   Deleting moves a meeting to mbook().trash with its files intact. Admins restore it from
   "Recently deleted" on the Meetings page. After 30 days it and its files are removed for good. */
const MM_TRASH_DAYS = 30;
function mmTrashList() {
  const b = mbook(); b.trash = b.trash || []; const cut = Date.now() - MM_TRASH_DAYS * 86400000;
  const old = b.trash.filter(x => Date.parse(x.deletedAt) < cut);
  if (old.length) { old.forEach(x => { mmDeckRemove(x.deck); (x.files || []).forEach(mmFileRemoveBlob); }); b.trash = b.trash.filter(x => !old.includes(x)); autosave(); }
  return b.trash;
}
function mmTrash(x) {
  const b = mbook(); b.meetings = b.meetings.filter(y => y.id !== x.id);
  mmTrashList().unshift(Object.assign(x, { deletedAt: new Date().toISOString(), deletedBy: mmMe() }));
  mmSyncNext(); logActivity('edit', `Deleted ${x.title}, ${fmtDate(x.date)}`); autosave(); renderMeetings();
}
function mmRestore(id) {
  if (!guardAdmin()) return; const b = mbook(), list = mmTrashList(), x = list.find(y => y.id === id); if (!x) return;
  b.trash = list.filter(y => y.id !== id); delete x.deletedAt; delete x.deletedBy; b.meetings.push(x);
  mmLog(x, 'Restored the meeting'); mmSyncNext(); logActivity('edit', `Restored ${x.title}, ${fmtDate(x.date)}`); autosave(); renderMeetings();
  toast(`Restored ${x.title}`, 'ok');
}
function mmTrashSheet() {
  const list = mmTrashList();
  const left = x => Math.max(1, MM_TRASH_DAYS - Math.floor((Date.now() - Date.parse(x.deletedAt)) / 86400000));
  openSheet('Recently deleted', list.length ? `<ul class="mm-trash">${list.map(x => `<li><div><b>${esc(x.title)}</b><small>${esc(fmtDate(x.date))} · deleted by ${esc(x.deletedBy || 'someone')} ${esc(mmAgo(x.deletedAt))} · ${left(x)} day${left(x) === 1 ? '' : 's'} left</small></div><button type="button" class="btn btn-tonal btn-sm" data-mm-restore="${esc(x.id)}">Restore</button></li>`).join('')}</ul>` : '<p class="mt-empty">Nothing deleted in the last 30 days</p>');
}
document.addEventListener('click', e => {
  const r = e.target.closest('[data-mm-restore]'); if (r) { mmRestore(r.dataset.mmRestore); return mmTrashList().length ? mmTrashSheet() : closeSheet(); }
  if (e.target.closest('[data-mm-trash]')) { if (guardAdmin()) mmTrashSheet(); }
});

/* ---------- files people add ---------- */
async function mmFileUpload(mt, file, name, desc) {
  const ext = mmExt(file.name);
  if (!MM_FILE_EXT[ext]) return toast('Add a Word, PDF, Excel, PowerPoint, image or text file', 'warn'), false;
  if (file.size > MM_FILE_MB * 1048576) return toast(`That file is over ${MM_FILE_MB} MB`, 'warn'), false;
  const live = state.sb && state.sb.connected, key = `${WS}/${mt.id}/${uid()}.${ext}`; let path = key;
  toast('Uploading', '');
  try {
    if (live) { const r = await state.sb.client.storage.from(MM_FILE_BUCKET).upload(key, file, { contentType: file.type || MM_FILE_EXT[ext], upsert: false }); if (r.error) throw r.error; }
    else { path = 'local:' + key; await mmIdbDo('readwrite', st => st.put(file, path)); }
  } catch (e) { toast(/bucket/i.test(String(e && e.message)) ? 'File storage is not set up yet. An admin needs to run supabase-meetings-collab.sql' : 'Upload failed. Check your connection and try again', 'err'); return false; }
  mmBlobCache[path] = file;
  const f = { id: uid(), name: (name || file.name).slice(0, 120), desc: (desc || '').slice(0, 500), fname: file.name.slice(0, 140), ext, mime: file.type || MM_FILE_EXT[ext], size: file.size, path, at: new Date().toISOString() };
  const ok = await mmEdit(mt, 'file_add', { file: f }, `Added file: ${f.name}`);
  if (!ok) { mmFileRemoveBlob(f); return false; }
  toast('File added', 'ok'); return f;
}
async function mmFileBlob(f) {
  if (mmBlobCache[f.path]) return mmBlobCache[f.path];
  let blob;
  if (String(f.path).startsWith('local:')) blob = await mmIdbDo('readonly', st => st.get(f.path));
  else { const r = await state.sb.client.storage.from(MM_FILE_BUCKET).download(f.path); if (r.error) throw r.error; blob = r.data; }
  if (!blob) throw new Error('missing'); return (mmBlobCache[f.path] = blob);
}
async function mmFileRemoveBlob(f) {
  delete mmBlobCache[f.path];
  try { if (String(f.path).startsWith('local:')) await mmIdbDo('readwrite', st => st.delete(f.path)); else if (state.sb && state.sb.connected) await state.sb.client.storage.from(MM_FILE_BUCKET).remove([f.path]); } catch (e) { /* orphaned at worst */ }
}
async function mmFileGet(f, open) {
  const win = open ? window.open('', '_blank') : null;
  try {
    const blob = await mmFileBlob(f), typed = blob.type ? blob : new Blob([blob], { type: f.mime || '' }), url = URL.createObjectURL(typed);
    if (win) win.location.href = url;
    else { const a = document.createElement('a'); a.href = url; a.download = /\.[a-z0-9]+$/i.test(f.name) ? f.name : `${f.name}.${f.ext}`; document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { if (win) win.close(); toast(String(f.path).startsWith('local:') ? 'This file was saved in another browser' : 'Could not open the file. Check your connection', 'err'); }
}

/* ---------- add milestones or a school to the next meeting's agenda ---------- */
function mmAddToNext(items, region) {
  const t = todayISO(), mt = mmList().find(x => x.date >= t && !x.canceled && (!region || !x.region || x.region === region));
  if (!mt) { toast('Schedule a meeting first', 'warn'); return null; }
  mt.agenda = mt.agenda || []; let n = 0;
  items.forEach(it => { if (it.ids && it.ids.length && mt.agenda.some(a => (a.ids || []).join() === it.ids.join())) return; mt.agenda.push({ id: uid(), title: String(it.title).slice(0, 140), mins: it.mins || 5, lead: it.lead || '', ids: it.ids || [] }); n++; });
  if (!n) { toast('Already on the next agenda', 'ok'); return mt; }
  mmLog(mt, `Added ${n} agenda item${n === 1 ? '' : 's'}`); autosave();
  toastAction(`Added to ${mt.title}, ${fmtDate(mt.date)}`, 'Open', () => { if (typeof closeModal === 'function') closeModal(); setView('meetings'); mmPanelOpen(mt.id, 'meeting'); });
  return mt;
}

/* ---------- schedule dialog ---------- */
// Change a meeting's region in one click from its panel header (admins). Nov 19 2026
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-mm-retag]'); if (!b) return;
  if (!guardAdmin()) return; const mt = mmFind(b.dataset.mmRetag); if (!mt) return;
  const opts = [['SOFLO', 'South Florida (SoFlo)'], ['PAT', 'Paterson (PAT)'], ['', 'All regions']];
  const p = openPopover(b, `<div class="cds-dd-list" role="menu" aria-label="Region">${opts.map(([v, l]) => `<button type="button" class="cds-dd-opt" role="menuitemradio" aria-checked="${(mt.region || '') === v}" aria-selected="${(mt.region || '') === v}" data-rg="${v}"><span><i class="mm-dot ${mmRgCls(v)}"></i> ${l}</span>${(mt.region || '') === v ? CI('check') : ''}</button>`).join('')}</div>`);
  p.classList.add('cds-dd-pop');
  p.addEventListener('click', ev => {
    const o = ev.target.closest('[data-rg]'); if (!o) return; closePopover();
    const v = o.dataset.rg; if ((mt.region || '') === v) return;
    const was = mmRgName(mt.region); mt.region = v;
    mmLog(mt, `Changed region from ${was} to ${mmRgName(v)}`); logActivity('edit', `${mt.title}: region set to ${mmRgName(v)}`);
    mmSyncNext(); autosave(); state.mmForce = true; renderMeetings(); toast(`Region set to ${mmRgName(v)}`, 'ok');
  });
});
function mmScheduleDialog(mt, date) {
  if (!guardAdmin()) return; closeConfirm();
  const isNew = !mt, cur = mt || { title: 'Committee meeting', date: date || nextMeetingAfter(todayISO()), time: mtg().time || '', region: state.mmRegion || '' };
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  w.innerHTML = `<div class="confirm-box mm-sched" role="dialog" aria-modal="true" aria-labelledby="mmsH"><h3 id="mmsH">${isNew ? 'Schedule meeting' : 'Edit meeting details'}</h3>
    <div class="field"><label for="mmsTitle">Name</label><input id="mmsTitle" maxlength="120" value="${esc(cur.title)}"></div>
    <fieldset class="field mm-rg-pick"><legend>Region</legend>${[['PAT', 'Paterson (PAT)'], ['SOFLO', 'South Florida (SoFlo)'], ['', 'All regions']].map(([v, l]) => `<label class="mm-rg-opt"><input type="radio" name="mmsRg" value="${v}" ${(cur.region || '') === v ? 'checked' : ''}><i class="mm-dot ${mmRgCls(v)}" aria-hidden="true"></i>${l}</label>`).join('')}</fieldset>
    <div class="field-row"><div class="field"><label for="mmsDate">Date</label><input id="mmsDate" type="date" value="${esc(cur.date)}"></div>
    <div class="field"><label for="mmsTime">Start time</label><input id="mmsTime" type="time" step="300" value="${esc(cur.time || '')}"></div></div>
    <label class="mm-cx-pick"><input type="checkbox" id="mmsCx" ${cur.canceled ? 'checked' : ''}>Meeting was canceled</label>
    <p class="mm-past-warn hide" id="mmsPast" role="alert"></p>
    <div class="confirm-actions"><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn btn-filled" id="cfgOk">${isNew ? 'Schedule' : 'Save'}</button></div></div>`;
  document.body.appendChild(w);
  let pastOk = '';   // the past date the admin already confirmed
  const okLabel = () => isNew ? 'Schedule' : 'Save';
  const resetPast = () => { if (!pastOk && $('#mmsPast').classList.contains('hide')) return; pastOk = ''; $('#mmsPast').classList.add('hide'); $('#cfgOk').textContent = okLabel(); };
  $('#mmsDate').addEventListener('input', resetPast);
  const done = ok => {
    if (ok) {
      const d = $('#mmsDate').value, title = $('#mmsTitle').value.trim() || 'Committee meeting', time = $('#mmsTime').value || '', region = (w.querySelector('input[name="mmsRg"]:checked') || {}).value || '', canceled = $('#mmsCx').checked;
      if (!d) return markInvalid($('#mmsDate'), 'Pick a date');
      // Past dates are allowed (to record meetings held before the tool), after one confirm. Nov 20 2026
      if (d < todayISO() && (isNew || d !== mt.date) && pastOk !== d) {
        pastOk = d; const p = $('#mmsPast');
        p.textContent = `${fmtDate(d)} has passed. ${isNew ? 'Add this as a past meeting' : 'Move this meeting to a past date'}?`;
        p.classList.remove('hide'); $('#cfgOk').textContent = isNew ? 'Add past meeting' : 'Save past date'; $('#cfgOk').focus(); return;
      }
      const x = mt || mmNew(d, time, title), was = mt ? `${mt.title}, ${fmtDate(mt.date)}${mt.time ? ' ' + fmtTime(mt.time) : ''}, ${mmRgName(mt.region)}` : '';
      const cxChanged = !!x.canceled !== canceled;
      Object.assign(x, { date: d, time, title, region }); if (canceled) x.canceled = true; else delete x.canceled; if (isNew) mmList().push(x);
      mmLog(x, isNew ? (d < todayISO() ? 'Added as a past meeting' : 'Scheduled the meeting') : `Changed details (was ${was})`);
      if (cxChanged && (!isNew || canceled)) mmLog(x, canceled ? 'Marked canceled' : 'Marked as held (not canceled)');
      state.mmAnchor = d; mmSyncNext();
      logActivity('edit', `${isNew ? (d < todayISO() ? 'Added past meeting' : 'Scheduled') : 'Updated'} ${title}, ${fmtDate(d)}${canceled ? ' (canceled)' : ''}`); autosave(); closeConfirm(); renderMeetings(); mmPanelOpen(x.id, state.mmPTab);
      return toast(`${isNew ? (d < todayISO() ? 'Added' : 'Scheduled') : 'Saved'}: ${mmWhen(x)}${canceled ? ', canceled' : ''}`, 'ok');
    }
    closeConfirm();
  };
  w.addEventListener('click', e => { if (e.target === w || e.target.id === 'cfgCancel') done(false); else if (e.target.id === 'cfgOk') done(true); });
  w.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'radio') done(true); });
  setTimeout(() => $('#mmsTitle').focus(), 30);
}
function mmRosterDialog(mt) {
  if (!mmContrib()) return; closeConfirm();
  const cur = new Set(Array.isArray(mt.roster) ? mt.roster : mmDefaultRoster(mt.region)), def = new Set(mmDefaultRoster(mt.region));
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  w.innerHTML = `<div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="mmrH"><h3 id="mmrH">Edit roster</h3>
    <fieldset class="mm-roster-pick"><legend class="sr-only">People</legend>${[...new Set([...rosterNames(), ...def])].sort((a, b) => a.localeCompare(b)).map(n => `<label><input type="checkbox" value="${esc(n)}" ${cur.has(n) ? 'checked' : ''}>${esc(n)}${def.has(n) ? ' <span class="muted">default</span>' : ''}</label>`).join('')}</fieldset>
    <div class="confirm-actions"><button class="btn btn-ghost" id="mmrReset">Use default</button><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn btn-filled" id="cfgOk">Save</button></div></div>`;
  document.body.appendChild(w);
  const fin = list => { mt.roster = list; mmLog(mt, list ? `Edited the roster (${list.length} people)` : 'Reset the roster to the default'); autosave(); closeConfirm(); mmPanelRender(); renderMeetings(); };
  w.addEventListener('click', e => { if (e.target === w || e.target.id === 'cfgCancel') closeConfirm(); else if (e.target.id === 'mmrReset') fin(null); else if (e.target.id === 'cfgOk') fin([...w.querySelectorAll('input:checked')].map(x => x.value)); });
  w.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeConfirm(); } });
  setTimeout(() => { const f = w.querySelector('input'); if (f) f.focus(); }, 30);
}
function mmItemDialog(o) {   // small edit dialog: fields [{id,label,value,type,options}]
  closeConfirm();
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  w.innerHTML = `<div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="mmiH"><h3 id="mmiH">${esc(o.title)}</h3>
    ${o.fields.map(f => `<div class="field"><label for="mmi_${f.id}">${esc(f.label)}</label>${f.type === 'select' ? `<select id="mmi_${f.id}">${f.options}</select>` : f.type === 'area' ? `<textarea id="mmi_${f.id}" rows="3" maxlength="${f.max || 4000}">${esc(f.value || '')}</textarea>` : `<input id="mmi_${f.id}" type="${f.type || 'text'}" maxlength="${f.max || 200}" value="${esc(f.value == null ? '' : f.value)}">`}</div>`).join('')}
    <div class="confirm-actions"><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn btn-filled" id="cfgOk">Save</button></div></div>`;
  document.body.appendChild(w);
  const done = ok => { if (ok) { const v = {}; o.fields.forEach(f => { v[f.id] = $('#mmi_' + f.id).value; }); const first = o.fields[0]; if (!String(v[first.id]).trim()) return markInvalid($('#mmi_' + first.id), 'Fill this in'); closeConfirm(); return o.onSave(v); } closeConfirm(); };
  w.addEventListener('click', e => { if (e.target === w || e.target.id === 'cfgCancel') done(false); else if (e.target.id === 'cfgOk') done(true); });
  w.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') done(true); });
  setTimeout(() => $('#mmi_' + o.fields[0].id).focus(), 30);
}

/* ---------- next steps: done toggle (owner or admin) and the dashboard card ---------- */
async function mmToggleStep(id, done, el) {
  const hit = mmFindStep(id);
  if (!hit) { const a = findAction(id); if (!a || !guardAdmin()) { if (el) el.checked = !done; return; } a.done = done; autosave(); return rerender(); }   // an action item from old run-meeting minutes
  const { mt, s } = hit;   // anyone signed in can update next steps; each change is logged on the meeting
  const ok = await mmEdit(mt, 'step_set', { id, fields: { done, doneAt: done ? new Date().toISOString() : null } }, `${done ? 'Marked done' : 'Reopened'}: ${String(s.text).slice(0, 80)}`);
  if (!ok) { if (el) el.checked = !done; return; }
  if (state.view === 'meetings') { state.mmFocus = `[data-mm-stepdone="${CSS.escape(id)}"]`; state.mmForce = true; renderMeetings(); } else rerender();
  toast(done ? 'Marked done' : 'Marked not done', 'ok');
}
function myStepsCard() {
  if (!MEETINGS_ON) return ''; const me = myOwnerName(); if (!me) return '';
  const t = todayISO(), list = openActions().filter(a => a.owner === me); if (!list.length) return '';
  const row = a => { const late = a.due && a.due < t, can = !!a.meetingId || isAdmin();
    return `<li class="mm-step"><input type="checkbox" data-mm-stepdone="${esc(a.id)}" ${can && !a.milestoneId ? '' : 'disabled'} aria-label="Done: ${esc(a.text)}">
      <div class="mm-step-main"><div class="mm-step-t">${a.milestoneId && findM(a.milestoneId) ? `<button type="button" class="ag-link" data-expand="${esc(a.milestoneId)}">${esc(a.text)}</button>` : esc(a.text)}</div>
      <div class="mm-step-m ${late ? 'is-late' : ''}">${a.due ? (late ? 'Overdue, was due ' : 'Due ') + esc(fmtDate(a.due)) : 'No due date'}${a.meeting ? ` · from <button type="button" class="ag-link" ${a.meetingId ? `data-mm-open="${esc(a.meetingId)}"` : 'data-mm-tab="agenda"'}>${esc((a.item && a.meetingId ? a.item : 'meeting') + ', ' + fmtDate(a.meeting))}</button>` : ''}</div></div></li>`; };
  return `<section class="ex-card mm-mine"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('check')}<h3>Your next steps</h3></div><span class="dt-sum">${list.length}</span></div>
    <ul class="mm-steps">${list.slice(0, 6).map(row).join('')}</ul>${list.length > 6 ? `<button class="card-more" data-mm-tab="cal">View all ${list.length}</button>` : ''}</section>`;
}

/* ---------- slide storage ---------- */
const MM_BUCKET = 'meeting-decks', mmBlobCache = {};
function mmIdb() { return new Promise((ok, no) => { const r = indexedDB.open('ngc_decks', 1); r.onupgradeneeded = () => r.result.createObjectStore('decks'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); }
async function mmIdbDo(mode, fn) { const db = await mmIdb(); return new Promise((ok, no) => { const tx = db.transaction('decks', mode), st = tx.objectStore('decks'), r = fn(st); tx.oncomplete = () => ok(r && r.result); tx.onerror = () => no(tx.error); }); }
async function mmDeckBlob(deck) {
  if (mmBlobCache[deck.path]) return mmBlobCache[deck.path];
  let blob;
  if (String(deck.path).startsWith('local:')) blob = await mmIdbDo('readonly', st => st.get(deck.path));
  else { const r = await state.sb.client.storage.from(MM_BUCKET).download(deck.path); if (r.error) throw r.error; blob = r.data; }
  if (!blob) throw new Error('missing'); return (mmBlobCache[deck.path] = blob);
}
async function mmDeckRemove(deck) {
  if (!deck) return; delete mmBlobCache[deck.path];
  try { if (String(deck.path).startsWith('local:')) await mmIdbDo('readwrite', st => st.delete(deck.path)); else if (state.sb && state.sb.connected) await state.sb.client.storage.from(MM_BUCKET).remove([deck.path]); } catch (e) { /* the file is orphaned at worst */ }
}
let pdfjsP = null;
function loadPdfjs() { return pdfjsP || (pdfjsP = import('./assets/pdfjs/pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = new URL('assets/pdfjs/pdf.worker.min.mjs', location.href).href; return m; }).catch(e => { pdfjsP = null; throw e; })); }
async function mmUpload(mtId, file) {
  const mt = mmFind(mtId); if (!mt || !file || !mmContrib()) return;
  const kind = /\.pptx$/i.test(file.name) || file.type === PPTX_MIME ? 'pptx' : /\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? 'pdf' : '';
  if (!kind) return toast(/\.ppt$/i.test(file.name) ? 'That is an old PowerPoint file. Save it as .pptx or PDF and try again' : 'Upload a PowerPoint (.pptx) or PDF file', 'warn');
  if (file.size > MM_MAX_MB * 1048576) return toast(`That file is over ${MM_MAX_MB} MB. Compress the PDF and try again`, 'warn');
  toast('Uploading slides', '');
  let pages = 0, thumb = '';
  if (kind === 'pptx') {
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-10000px;top:0;width:960px;height:540px'; document.body.appendChild(host);
    try { const api = await pptxFrame(host); pages = await api.load(await file.arrayBuffer()); api.destroy(); } catch (e) { host.remove(); return toast('That PowerPoint file could not be read. Open it in PowerPoint, save it again and retry', 'err'); }
    host.remove();
  } else try {
    const lib = await loadPdfjs(), pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; pages = pdf.numPages;
    const pg = await pdf.getPage(1), v0 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: 320 / v0.width }), c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height; await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; thumb = c.toDataURL('image/jpeg', 0.7); pdf.destroy();
  } catch (e) { return toast('That PDF could not be read. Export it again and retry', 'err'); }
  const live = state.sb && state.sb.connected, key = `${WS}/${mt.id}/${uid()}.${kind}`; let path = key;
  try {
    if (live) { const r = await state.sb.client.storage.from(MM_BUCKET).upload(key, file, { contentType: kind === 'pptx' ? PPTX_MIME : 'application/pdf', upsert: false }); if (r.error) throw r.error; }
    else { path = 'local:' + key; await mmIdbDo('readwrite', st => st.put(file, path)); }
  } catch (e) { return toast(/bucket/i.test(String(e && e.message)) ? 'Slide storage is not set up yet. Run supabase-meetings.sql in Supabase' : 'Upload failed. Check your connection and try again', 'err'); }
  const old = mt.deck; mmBlobCache[path] = file;
  mt.deck = { name: file.name.slice(0, 140), kind, path, size: file.size, pages, thumb, by: currentDisplayName() || '', at: new Date().toISOString() };
  if (old) mmDeckRemove(old);
  logActivity('edit', `Added slides to ${mt.title}, ${fmtDate(mt.date)}`); if (!isAdmin()) mmQueueContent(mt, 'Added slides'); autosave(); renderMeetings(); toast(`Slides added: ${pages} slide${pages === 1 ? '' : 's'}`, 'ok');
}

/* ---------- PowerPoint (.pptx) rendering ----------
   pptx-preview 1.0.7 (assets/pptx, closed-source npm build, free for commercial use) draws
   slides as HTML. It runs in a sandboxed srcdoc iframe with no same-origin access and a
   CSP that blocks all network, so it cannot read the session or send data anywhere. */
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const deckKind = d => d && (d.kind || (/\.pptx$/i.test(d.name || '') ? 'pptx' : 'pdf'));
let pptxLibP = null;
/* Layout fixes for pptx-preview, applied as the library loads so the vendored file stays untouched (Nov 20 2026).
   The library rendered text unlike PowerPoint or Google Slides:
   1. it added space above every paragraph (20% of the font size) that decks don't have;
   2. it treated "single" line spacing as 1.0x the font size; PowerPoint and Apple's Office renderer use 1.2x
      the line-spacing percent (checked against macOS Quick Look on the Nov 2026 committee decks);
   3. any bullet character outside a short list turned into a square, and bullets had no hanging indent,
      so wrapped lines didn't line up under the text;
   4. text with no named font was squeezed 4% (meant for Chinese fonts).
   Each fix is an exact text match; one that no longer matches (a library update) is skipped and logged. */
const PPTX_PATCHES = [
  ['f.style.margin="".concat(Math.floor(.2*p()),"px  0 0 0")', 'f.style.margin="0"'],
  ['v.style.lineHeight=m+""', 'v.style.lineHeight=1.2*m+""'],
  ['n.textContent={n:"■",l:"●",u:"◆",p:"□","ü":"✔","Ø":"➢","•":"•"}[e.buChar]||"■",n.style.marginRight="10px",t.prepend(n)}(v,d),v.style.paddingLeft=(d.marginLeft||0)+(d.indent||0)+"px"',
   'n.textContent={n:"■",l:"●",u:"◆",p:"□","ü":"✔","Ø":"➢","§":"■","·":"•",q:"❑",v:"❖","Ü":"➢",o:"○"}[e.buChar]||(e.buChar.charCodeAt(0)>127?e.buChar:"•"),n.style.fontFamily=r.style.fontFamily,n.style.display="inline-block",n.style.textIndent="0",n.style.minWidth=Math.max(0,-(e.indent||0))+"px",n.style.paddingRight=(e.indent<0?0:6)+"px",t.prepend(n)}(v,d),v.style.paddingLeft=(d.marginLeft||0)+"px",v.style.textIndent=(d.indent||0)+"px"'],
  ['r.style.marginRight="10px",e.buAutoNum){', 'r.style.display="inline-block",r.style.textIndent="0",r.style.minWidth=Math.max(0,-(e.indent||0))+"px",r.style.paddingRight=(e.indent<0?0:6)+"px",r.style.fontFamily=i.style.fontFamily,e.buAutoNum){'],
  ['}else h.test(o)&&(l.style.letterSpacing=-.04*u+"px");return a.bold', '}return a.bold']
];
function pptxPatch(src) { PPTX_PATCHES.forEach(([a, b], i) => { if (src.includes(a)) src = src.split(a).join(b); else console.warn('pptx layout fix ' + (i + 1) + ' did not apply'); }); return src; }
function loadPptxLib() { return pptxLibP || (pptxLibP = fetch('assets/pptx/pptx-preview.umd.js').then(r => { if (!r.ok) throw new Error('lib'); return r.text(); }).then(t => pptxPatch(t).replace(/<\/script/gi, '<\\/script')).catch(e => { pptxLibP = null; throw e; })); }
function pptxFrameMain() {   // runs inside the sandboxed frame
  var pv = null, count = 0, stage = document.getElementById('stage');
  function send(m) { m.src = 'pptx-frame'; parent.postMessage(m, '*'); }
  function fit() {
    var w = stage.firstElementChild; if (!w) return;
    var sl = w.querySelector('.pptx-preview-slide-wrapper'), sw = 960, sh = sl ? sl.offsetHeight : 540;
    w.style.height = sh + 'px'; w.style.background = 'transparent'; w.style.overflow = 'hidden';
    var k = Math.min(innerWidth / sw, innerHeight / sh);
    stage.style.transform = 'translate(' + (innerWidth - sw * k) / 2 + 'px,' + (innerHeight - sh * k) / 2 + 'px) scale(' + k + ')';
  }
  function show(n) {
    n = Math.max(1, Math.min(count, n));
    var w = stage.firstElementChild; if (w) w.querySelectorAll('.pptx-preview-slide-wrapper').forEach(function (x) { x.remove(); });
    try { pv.renderSingleSlide(n - 1); } catch (e) { return send({ type: 'error', msg: String(e && e.message || e) }); }
    var sl = stage.querySelector('.pptx-preview-slide-wrapper'); if (sl) sl.style.top = '0px';
    fit(); send({ type: 'shown', n: n, text: (stage.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 4000) });
    var fams = {}; stage.querySelectorAll('[style*="font-family"]').forEach(function (el) { var f = (el.style.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(); if (f) fams[f] = 1; });
    send({ type: 'fonts', list: Object.keys(fams) });
  }
  addEventListener('resize', fit);
  addEventListener('message', function (e) {
    if (e.source !== parent) return; var d = e.data || {};
    if (d.type === 'load') {
      try {
        pv = pptxPreview.init(stage, { width: 960, height: 540, mode: 'slide' });
        pv.load(d.buf).then(function () { count = pv.slideCount || 0; send(count ? { type: 'loaded', count: count } : { type: 'error', msg: 'no slides' }); }, function (err) { send({ type: 'error', msg: String(err && err.message || err) }); });
      } catch (err) { send({ type: 'error', msg: String(err && err.message || err) }); }
    } else if (d.type === 'show' && pv) show(d.n);
    else if (d.type === 'font') { (d.faces || []).forEach(function (x) { try { var ff = new FontFace(x.family, x.buf, { weight: x.weight, style: x.style, unicodeRange: x.range || 'U+0-10FFFF' }); document.fonts.add(ff); ff.load().then(fit); } catch (e) {} }); }
  });
  send({ type: 'ready' });
}
/* Fonts: decks name fonts the viewer's computer may not have (Calibri on a Mac) or embed them
   in a compressed format browsers cannot read. Load free matches from Google Fonts by name:
   Carlito has Calibri's exact widths, Caladea has Cambria's; others load as themselves.
   Only font names leave the browser. Fonts the computer already has are left alone. */
const PPTX_FONT_ALIAS = { 'calibri': 'Carlito', 'calibri light': 'Carlito', 'cambria': 'Caladea', 'aptos': 'Inter', 'aptos display': 'Inter', 'aptos narrow': 'Inter', 'segoe ui': 'Open Sans', 'century gothic': 'Questrial', 'gill sans mt': 'Lato', 'franklin gothic book': 'Libre Franklin' };
const PPTX_SYS_FONTS = /^(arial|helvetica|helvetica neue|times|times new roman|georgia|verdana|tahoma|trebuchet ms|courier|courier new|impact|comic sans ms|palatino|system-ui|sans-serif|serif|monospace)$/i;
const pptxFontCache = {};
function fontInstalled(fam) {
  const c = (fontInstalled.c = fontInstalled.c || document.createElement('canvas').getContext('2d')), t = 'mmmmwwwwllllii 0123 AaBbQq';
  return ['monospace', 'serif'].some(base => { c.font = `40px ${base}`; const a = c.measureText(t).width; c.font = `40px "${fam}", ${base}`; return c.measureText(t).width !== a; });
}
function pptxFontFaces(fam) {
  const key = fam.toLowerCase(); if (pptxFontCache[key]) return pptxFontCache[key];
  const src = PPTX_FONT_ALIAS[key] || fam;
  const css = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(src).replace(/%20/g, '+')}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
  const one = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(src).replace(/%20/g, '+')}&display=swap`;   // single-style families (Permanent Marker)
  return (pptxFontCache[key] = fetch(css).then(r => r.ok ? r : fetch(one)).then(r => r.ok ? r.text() : '').then(async txt => {
    const faces = [], re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*{([^}]*)}/g; let m;
    while ((m = re.exec(txt))) {
      if (!/^(latin|latin-ext)$/.test(m[1])) continue;
      const b = m[2], url = (b.match(/url\(([^)]+)\)/) || [])[1]; if (!url) continue;
      faces.push({ family: fam, url, weight: (b.match(/font-weight:\s*(\d+)/) || [])[1] || '400', style: (b.match(/font-style:\s*(\w+)/) || [])[1] || 'normal', range: ((b.match(/unicode-range:\s*([^;]+)/) || [])[1] || '').trim() });
    }
    return Promise.all(faces.map(x => fetch(x.url).then(r => r.arrayBuffer()).then(buf => Object.assign(x, { buf })).catch(() => null))).then(a => a.filter(Boolean));
  }).catch(() => []));
}
function pptxSendFonts(frame, list) {
  (list || []).forEach(fam => {
    if (PPTX_SYS_FONTS.test(fam)) return;
    if (PPTX_FONT_ALIAS[fam.toLowerCase()] && fontInstalled(fam)) return;   // the real Calibri is here
    frame._fontsSent = frame._fontsSent || {}; if (frame._fontsSent[fam]) return; frame._fontsSent[fam] = 1;
    pptxFontFaces(fam).then(faces => { if (faces.length && frame.contentWindow) frame.contentWindow.postMessage({ type: 'font', faces: faces.map(x => ({ family: x.family, weight: x.weight, style: x.style, range: x.range, buf: x.buf.slice(0) })) }, '*'); });
  });
}
function pptxFrame(host) {
  return loadPptxLib().then(lib => new Promise((ok, no) => {
    const f = document.createElement('iframe'), waits = {};
    f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('inert', ''); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1; f.title = 'Slide';
    const wait = type => new Promise((res, rej) => { waits[type] = res; waits.error = d => rej(new Error(d.msg || 'error')); });
    const onMsg = e => { if (e.source !== f.contentWindow) return; const d = e.data || {}; if (d.src !== 'pptx-frame') return; if (d.type === 'fonts') return pptxSendFonts(f, d.list); const fn = waits[d.type]; if (fn) { delete waits[d.type]; fn(d); } };
    window.addEventListener('message', onMsg);
    const api = {
      frame: f,
      load(buf) { const p = wait('loaded'); f.contentWindow.postMessage({ type: 'load', buf }, '*', [buf]); return p.then(d => d.count); },
      show(n) { const p = wait('shown'); f.contentWindow.postMessage({ type: 'show', n }, '*'); return p; },
      destroy() { window.removeEventListener('message', onMsg); f.remove(); }
    };
    const t = setTimeout(() => { api.destroy(); no(new Error('timeout')); }, 20000);
    waits.ready = () => { clearTimeout(t); ok(api); };
    f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:Calibri,Arial,Helvetica,sans-serif}#stage{position:absolute;left:0;top:0;transform-origin:0 0}#stage *{pointer-events:none}</style></head><body><div id="stage"></div><script>${lib}<\/script><script>(${pptxFrameMain.toString()})()<\/script></body></html>`;
    host.appendChild(f);
  }));
}

/* ---------- slide viewer ----------
   Best practices applied: real buttons with labels; slide count and a live region
   ("Slide 3 of 20"); arrow keys, Page Up/Down (presentation clickers), Space, Home/End;
   F for full screen and Esc to leave; no autoplay; focus trapped in the dialog and
   returned on close; canvas sized to the screen at device pixel ratio and letterboxed;
   neighbor slides pre-rendered so flipping is instant; slide text exposed to screen
   readers; swipe on touch; controls fade in full screen until the mouse moves; a
   slide list for jumping; it reopens on the slide you left. */
function dvHideLoad() { const l = $('#dvLoad'); if (!l || l.dataset.hiding) return; l.dataset.hiding = '1'; setTimeout(() => l.remove(), Math.max(0, LOAD_MIN_MS - (Date.now() - (dv.openedAt || 0)))); }
const dv = { pdf: null, n: 1, total: 0, cache: new Map(), key: '', tok: 0, opener: null, idle: 0, deck: null };
// Opens the meeting's slides, or (Nov 20 2026) one of its files: PDF and PowerPoint page through like slides;
// images and text show whole; Word and Excel get a download card, since browsers can't draw them.
function openDeck(mtId, present, file) {
  const mt0 = mmFind(mtId); if (!mt0 || (!file && !mt0.deck)) return;
  const fname = file ? (/\.[a-z0-9]+$/i.test(file.name) ? file.name : `${file.name}.${file.ext}`) : '';
  const mt = file ? Object.assign({}, mt0, { deck: { name: fname, path: file.path, pages: 0, kind: file.ext === 'pptx' ? 'pptx' : 'pdf', size: file.size } }) : mt0;
  dv.getBlob = file ? () => mmFileBlob(file) : () => mmDeckBlob(mt0.deck);
  dv.mode = !file || /^(pdf|pptx)$/.test(file.ext) ? 'pages' : /^(jpe?g|png|gif|webp)$/.test(file.ext) ? 'image' : /^(txt|csv)$/.test(file.ext) ? 'text' : 'none';
  closeDeck(true); dv.deck = mt.deck; dv.opener = document.activeElement; dv.n = (state.dvPos || {})[mt.deck.path] || 1; dv.total = mt.deck.pages || 0; dv.cache = new Map();
  const w = document.createElement('div'); dv.openedAt = Date.now(); w.className = 'dv'; w.id = 'deckViewer'; w.setAttribute('role', 'dialog'); w.setAttribute('aria-modal', 'true'); w.setAttribute('aria-label', 'Slides: ' + mt.deck.name); w.tabIndex = -1;
  const kindLabel = file ? ({ pdf: 'PDF', pptx: 'PowerPoint', ppt: 'PowerPoint', docx: 'Word', doc: 'Word', xlsx: 'Excel', xls: 'Excel', csv: 'CSV', txt: 'Text' }[file.ext] || 'Image') : deckKind(mt.deck) === 'pptx' ? 'PowerPoint' : 'PDF', firstRun = !file && !lsGet('ngc_dv_seen');
  if (file) w.setAttribute('aria-label', 'File: ' + fname);
  w.innerHTML = `<header class="dv-top">
      <div class="dv-doc"><span class="dv-doc-ic" aria-hidden="true">${mmIc(file && dv.mode !== 'pages' ? 'doc' : 'present', 20)}</span><div class="dv-doc-t"><b>${esc(file ? file.name.replace(/\.[a-z0-9]+$/i, '') : mt.deck.name.replace(/\.(pptx|pdf)$/i, ''))}</b><span>${esc(mt.title)} · ${esc(mmWhen(mt))} · ${kindLabel}</span></div></div>
      <div class="dv-tools"><button type="button" class="dv-btn" data-dv="dl" aria-label="Download ${kindLabel}" title="Download">${mmIc('dl', 20)}</button><button type="button" class="dv-btn" data-dv="close" aria-label="Close slides" title="Close (Esc)">${CI('close').replace('width="16" height="16"', 'width="20" height="20"')}</button></div>
    </header>
    <div class="dv-body"><nav class="dv-thumbs" id="dvThumbs" aria-label="Slides" hidden></nav>
      <div class="dv-stage" id="dvStage"><canvas id="dvCanvas" role="img" aria-roledescription="slide"></canvas><div class="dv-frame" id="dvFrame" role="img" aria-roledescription="slide" hidden></div><div class="dv-load" id="dvLoad"><span class="dv-spin" aria-hidden="true"></span>${file ? 'Loading' : 'Loading slides'}</div></div></div>
    <div class="dv-ctrl" role="toolbar" aria-label="Slide controls">
      <button type="button" class="dv-btn dv-prev" data-dv="prev" aria-label="Previous slide" title="Previous (Left arrow)">${mmIc('left', 20)}</button>
      <span class="dv-count" id="dvCount" aria-hidden="true">&nbsp;</span>
      <button type="button" class="dv-btn dv-next" data-dv="next" aria-label="Next slide" title="Next (Right arrow)">${mmIc('right', 20)}</button>
      <span class="dv-sep" aria-hidden="true"></span>
      <button type="button" class="dv-btn" data-dv="thumbs" aria-pressed="false" aria-label="Slide list" title="Slide list (T)">${mmIc('grid', 20)}</button>
      <button type="button" class="dv-btn" data-dv="fs" aria-label="Full screen" title="Full screen (F)">${mmIc('max', 20)}</button>
    </div>
    <div class="dv-prog" aria-hidden="true"><i id="dvProg"></i></div>
    
    <div class="sr-only" id="dvText"></div><div class="sr-only" aria-live="polite" id="dvLive"></div>`;
  if (firstRun) { lsSet('ngc_dv_seen', '1'); setTimeout(() => { const t = $('#dvTip'); if (t) t.classList.add('is-gone'); }, 5000); }
  if (dv.mode !== 'pages') { w.classList.add('dv-static'); w.querySelector('.dv-ctrl').hidden = true; w.querySelector('.dv-prog').hidden = true; }
  document.body.appendChild(w); document.body.classList.add('dv-open');
  if (present) dvFullscreen(true);
  w.focus();
  w.addEventListener('click', dvClick); w.addEventListener('mousemove', dvWake);
  let px = null; const st = $('#dvStage');
  st.addEventListener('pointerdown', e => { px = e.clientX; }); st.addEventListener('pointerup', e => { if (px != null && Math.abs(e.clientX - px) > 50) { dvGo(dv.n + (e.clientX < px ? 1 : -1)); dv.swiped = true; } px = null; });
  if (dv.mode !== 'pages') { dvStatic(file, fname, kindLabel); return; }
  (async () => {
    try {
      if (deckKind(mt.deck) === 'pptx') {
        const fr = $('#dvFrame'), [api, blob] = await Promise.all([pptxFrame(fr), dv.getBlob()]); if (!$('#deckViewer')) return api.destroy();
        dv.api = api; dv.total = await api.load(await blob.arrayBuffer()); fr.hidden = false; $('#dvCanvas').hidden = true;
      } else { const [lib, blob] = await Promise.all([loadPdfjs(), dv.getBlob()]); if (!$('#deckViewer')) return; dv.pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise; dv.total = dv.pdf.numPages; }
      dv.n = Math.min(dv.n, dv.total); dvRender();
    }
    catch (e) { const l = $('#dvLoad'); if (l) l.textContent = String(mt.deck.path).startsWith('local:') && !file ? 'These slides were saved in another browser' : `The ${file ? 'file' : 'slides'} could not be loaded. Check your connection and try again`; }
  })();
}
function dvCsv(t) {   // RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); } return rows;
}
const dvDropLoad = () => { const l = $('#dvLoad'); if (l) l.remove(); };   // files show at once; the 2 s minimum is for slides
async function dvStatic(file, fname, kindLabel) {
  const st = $('#dvStage'); $('#dvCanvas').hidden = true;
  const card = msg => { st.insertAdjacentHTML('beforeend', `<div class="dv-card"><span class="dv-card-ic" aria-hidden="true">${esc((file.ext || 'file').toUpperCase().slice(0, 4))}</span><b>${esc(fname)}</b><p>${esc(msg)}</p><button type="button" class="btn btn-filled" data-dv="dl">${mmIc('dl')} Download</button></div>`); dvDropLoad(); };
  if (dv.mode === 'none') return card(`${kindLabel} files can't be previewed in the browser. Download to open it in ${kindLabel === 'Excel' ? 'Excel' : kindLabel === 'Word' ? 'Word' : 'its app'}.`);
  try {
    const blob = await dv.getBlob(); if (!$('#deckViewer')) return;
    if (dv.mode === 'image') { const img = document.createElement('img'); img.className = 'dv-img'; img.alt = file.desc || file.name; img.src = dv.url = URL.createObjectURL(blob); st.appendChild(img); }
    else if (file.ext === 'csv') { const rows = dvCsv((await blob.text()).slice(0, 500000)).slice(0, 2000); st.insertAdjacentHTML('beforeend', `<div class="dv-table" tabindex="0" role="region" aria-label="${esc(file.name)}"><table class="dt"><thead><tr>${(rows[0] || []).map(c => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); }
    else { const pre = document.createElement('pre'); pre.className = 'dv-text'; pre.tabIndex = 0; pre.textContent = (await blob.text()).slice(0, 500000); st.appendChild(pre); }
    dvDropLoad();
  } catch (e) { card(String(file.path).startsWith('local:') ? 'This file was saved in another browser.' : 'The file could not be loaded. Check your connection and try again.'); }
}
function closeDeck(quiet) {
  const w = $('#deckViewer'); if (!w) return;
  if (dv.deck) { state.dvPos = state.dvPos || {}; state.dvPos[dv.deck.path] = dv.n; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  w.remove(); document.body.classList.remove('dv-open'); clearTimeout(dv.idle); if (dv.url) { URL.revokeObjectURL(dv.url); dv.url = null; }
  if (dv.pdf) { dv.pdf.destroy(); dv.pdf = null; } if (dv.api) { dv.api.destroy(); dv.api = null; } dv.cache = new Map(); dv.tok++;
  if (!quiet && dv.opener && dv.opener.isConnected) dv.opener.focus();
}
function dvFullscreen(on) {
  const w = $('#deckViewer'); if (!w) return;
  if (on == null) on = !document.fullscreenElement;
  if (on) { const rq = w.requestFullscreen || w.webkitRequestFullscreen; if (rq) Promise.resolve(rq.call(w)).catch(() => {}); }
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
function dvWake() { const w = $('#deckViewer'); if (!w) return; w.classList.remove('dv-idle'); clearTimeout(dv.idle); dv.idle = setTimeout(() => { if (document.fullscreenElement) w.classList.add('dv-idle'); }, 2500); }
function dvClick(e) {
  const b = e.target.closest('[data-dv],[data-dv-go]');
  if (!b) { if ((e.target.id === 'dvCanvas' || e.target.id === 'dvFrame') && !dv.swiped) dvGo(dv.n + 1); dv.swiped = false; return; }
  if (b.dataset.dvGo) return dvGo(+b.dataset.dvGo);
  switch (b.dataset.dv) {
    case 'prev': return dvGo(dv.n - 1);
    case 'next': return dvGo(dv.n + 1);
    case 'fs': return dvFullscreen();
    case 'close': return closeDeck();
    case 'thumbs': return dvThumbs();
    case 'dl': return (dv.getBlob ? dv.getBlob() : mmDeckBlob(dv.deck)).then(bl => { const a = document.createElement('a'); a.href = URL.createObjectURL(bl); a.download = dv.deck.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }).catch(() => toast('Download failed', 'err'));
  }
}
function dvGo(n) {
  if (!dv.pdf && !dv.api) return; n = Math.max(1, Math.min(dv.total, n)); if (n === dv.n && (dv.cache.size || dv.api)) return;
  dv.n = n; dvRender(); const l = $('#dvLive'); if (l) l.textContent = `Slide ${n} of ${dv.total}`;
}
async function dvPage(n, wpx, hpx) {
  const key = `${n}@${wpx}x${hpx}`; if (dv.cache.has(key)) return dv.cache.get(key);
  const p = (async () => { const pg = await dv.pdf.getPage(n), v0 = pg.getViewport({ scale: 1 }), dpr = Math.min(window.devicePixelRatio || 1, 2), sc = Math.min(wpx / v0.width, hpx / v0.height), vp = pg.getViewport({ scale: sc * dpr }), c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height); c._css = [Math.floor(vp.width / dpr), Math.floor(vp.height / dpr)]; await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    pg.getTextContent().then(tc => { c._text = tc.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim(); }).catch(() => {}); return c; })();
  p.catch(() => dv.cache.delete(key)); dv.cache.set(key, p); if (dv.cache.size > 12) dv.cache.delete(dv.cache.keys().next().value); return p;
}
async function dvRender() {
  const st = $('#dvStage'), cv = $('#dvCanvas'); if (!st || !cv || (!dv.pdf && !dv.api)) return;
  const cs = getComputedStyle(st), tok = ++dv.tok, wpx = Math.max(200, st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), hpx = Math.max(150, st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)), n = dv.n;
  $('#dvCount').textContent = `${n} / ${dv.total}`; const pg = $('#dvProg'); if (pg) pg.style.width = (100 * n / Math.max(1, dv.total)) + '%';
  $('.dv-prev').disabled = n <= 1; $('.dv-next').disabled = n >= dv.total;
  dvMarkThumb(n);
  if (dv.api) {   // PowerPoint: the sandboxed frame draws the slide
    let d; try { d = await dv.api.show(n); } catch (e) { return; } if (tok !== dv.tok) return;
    const fr = $('#dvFrame'); if (fr) fr.setAttribute('aria-label', `Slide ${n} of ${dv.total}`); dvHideLoad();
    const tx = $('#dvText'); if (tx) tx.textContent = d.text ? `Slide ${n} text: ${d.text}` : ''; return;
  }
  let src; try { src = await dvPage(n, wpx, hpx); } catch (e) { return; } if (tok !== dv.tok || !$('#dvCanvas')) return;
  cv.width = src.width; cv.height = src.height; cv.style.width = src._css[0] + 'px'; cv.style.height = src._css[1] + 'px'; cv.getContext('2d').drawImage(src, 0, 0);
  cv.setAttribute('aria-label', `Slide ${n} of ${dv.total}`); dvHideLoad();
  setTimeout(() => { const tx = $('#dvText'); if (tx && tok === dv.tok) tx.textContent = src._text ? `Slide ${n} text: ${src._text}` : ''; }, 150);
  [n + 1, n - 1].filter(k => k >= 1 && k <= dv.total).forEach(k => dvPage(k, wpx, hpx).catch(() => {}));   // flip without waiting
}
function dvMarkThumb(n) { $$('#dvThumbs [data-dv-go]').forEach(b => { const on = +b.dataset.dvGo === n; b.classList.toggle('is-cur', on); if (on) { b.setAttribute('aria-current', 'true'); b.scrollIntoView({ block: 'nearest' }); } else b.removeAttribute('aria-current'); }); }
async function dvThumbs() {
  const nav = $('#dvThumbs'), btn = $('[data-dv="thumbs"]'); if (!nav || (!dv.pdf && !dv.api)) return;
  nav.hidden = !nav.hidden; btn.setAttribute('aria-pressed', String(!nav.hidden)); setTimeout(dvRender, 0);
  if (nav.hidden || nav.childElementCount) return;
  nav.innerHTML = Array.from({ length: dv.total }, (_, i) => `<button type="button" class="dv-th ${dv.api ? 'dv-th-num' : ''} ${i + 1 === dv.n ? 'is-cur' : ''}" data-dv-go="${i + 1}" aria-label="Slide ${i + 1}">${dv.api ? `Slide ${i + 1}` : `<span>${i + 1}</span><canvas></canvas>`}</button>`).join('');
  if (dv.api) return;   // PowerPoint slides are listed by number
  for (let i = 1; i <= dv.total; i++) { if (!$('#deckViewer') || !dv.pdf) return; let pg; try { pg = await dv.pdf.getPage(i); } catch (e) { return; } const v0 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: 280 / v0.width }), c = nav.querySelector(`[data-dv-go="${i}"] canvas`); if (!c) return; c.width = vp.width; c.height = vp.height; try { await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; } catch (e) { return; } }
}
document.addEventListener('keydown', e => {
  const w = $('#deckViewer'); if (!w) return;
  if (e.key === 'Tab') { const f = [...w.querySelectorAll('button:not([disabled])')].filter(x => x.offsetParent !== null); if (!f.length) return; const i = f.indexOf(document.activeElement); if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); } return; }
  const k = e.key, act = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1, Backspace: -1 }[k];
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (act && !(k === ' ' && e.target.closest('button'))) { e.preventDefault(); dvWake(); return dvGo(dv.n + act); }
  if (k === 'Home') { e.preventDefault(); return dvGo(1); }
  if (k === 'End') { e.preventDefault(); return dvGo(dv.total); }
  if (k === 'f' || k === 'F') { e.preventDefault(); return dvFullscreen(); }
  if (k === 't' || k === 'T') { e.preventDefault(); return dvThumbs(); }
  if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); return document.fullscreenElement ? dvFullscreen(false) : closeDeck(); }
}, true);
document.addEventListener('fullscreenchange', () => {
  const w = $('#deckViewer'); if (!w) return; const on = document.fullscreenElement === w, b = w.querySelector('[data-dv="fs"]');
  w.classList.toggle('dv-fs', on); if (b) { b.innerHTML = mmIc(on ? 'min' : 'max', 20); b.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen'); b.title = on ? 'Exit full screen (F)' : 'Full screen (F)'; }
  if (!on) w.classList.remove('dv-idle'); else dvWake(); dv.cache = new Map(); setTimeout(dvRender, 60);
});
let dvResizeT = 0; window.addEventListener('resize', () => { if (!$('#deckViewer')) return; clearTimeout(dvResizeT); dvResizeT = setTimeout(() => { dv.cache = new Map(); dvRender(); }, 150); });

/* ---------- events ---------- */
let mmNotesT = 0;
function mmRedraw() { state.mmForce = true; renderMeetings(); }   // the page redraws the open panel too
function smRedraw(focusSel) { if (modalMode !== 'school' || !schoolId) return; if (modalDirty) return toast('Save or cancel your changes first', 'warn'); const y = $('#modalBody').scrollTop; openSchoolModal(schoolId); $('#modalBody').scrollTop = y; const f = focusSel && document.querySelector(focusSel); if (f) f.focus(); }
document.addEventListener('change', e => { const c = e.target.closest && e.target.closest('[data-smf]'); if (!c) return; const k = c.dataset.smf;
  if (k === 'done') lsSet('ngc_sm_done', c.checked ? '1' : '0'); else if (k === 'mine') lsSet('ngc_sm_mine', c.checked ? '1' : ''); else if (k === 'due') lsSet('ngc_sm_due', c.value); else if (k === 'from') lsSet('ngc_sm_from', c.value); else if (k === 'to') lsSet('ngc_sm_to', c.value);
  smRedraw('#' + c.id); });
document.addEventListener('click', e => {   // quarter multi-select: open/close, clear, click outside
  if (e.target.closest('[data-smqclear]')) { e.stopPropagation(); lsSet('ngc_sm_qs', ''); return smRedraw('#smQBtn'); }
  if (e.target.closest('[data-smq]')) { state.smQOpen = !state.smQOpen; return smRedraw(state.smQOpen ? '.sm-qms-list input' : '#smQBtn'); }
  if (state.smQOpen && !e.target.closest('.sm-qms')) { state.smQOpen = false; const l = document.querySelector('.sm-qms-list'); if (l) l.remove(); const b = $('#smQBtn'); if (b) b.setAttribute('aria-expanded', 'false'); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.smQOpen && e.target.closest && e.target.closest('.sm-qms')) { e.stopPropagation(); e.preventDefault(); state.smQOpen = false; smRedraw('#smQBtn'); } else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-smqclear]')) { e.preventDefault(); lsSet('ngc_sm_qs', ''); smRedraw('#smQBtn'); } }, true);
document.addEventListener('change', e => { const c = e.target.closest && e.target.closest('[data-smqv]'); if (!c) return; const set = new Set((lsGet('ngc_sm_qs') || '').split(',').filter(Boolean)); if (c.checked) set.add(c.dataset.smqv); else set.delete(c.dataset.smqv); lsSet('ngc_sm_qs', [...set].join(',')); smRedraw(`[data-smqv="${c.dataset.smqv}"]`); });
document.addEventListener('click', e => { if (!e.target.closest('[data-smfilt]')) return; state.smFiltOpen = !state.smFiltOpen; smRedraw(state.smFiltOpen ? '#smDue' : '#smFiltBtn'); });
document.addEventListener('click', e => { if (!e.target.closest('[data-smreset]')) return; ['ngc_sm_due', 'ngc_sm_from', 'ngc_sm_to', 'ngc_sm_qs', 'ngc_sm_mine'].forEach(k => lsSet(k, '')); lsSet('ngc_sm_done', '1'); smRedraw('#smDue'); });
document.addEventListener('click', e => { const g = e.target.closest('[data-smgroup]'); if (g && modalMode === 'school' && schoolId) { if (modalDirty) return toast('Save or cancel your changes first', 'warn'); lsSet('ngc_sm_group', g.dataset.smgroup); const y = $('#modalBody').scrollTop; openSchoolModal(schoolId); $('#modalBody').scrollTop = y; const f = document.querySelector(`[data-smgroup="${g.dataset.smgroup}"]`); if (f) f.focus(); } });   // school dialog grouping toggle
document.addEventListener('click', e => { const ex = e.target.closest('#mmPanel [data-expand]'); if (ex) openModal(ex.dataset.expand); });   // milestone links open the milestone above the panel
function mmMove(arr, id, dir) { const i = arr.findIndex(x => x.id === id), j = i + dir; if (i < 0 || j < 0 || j >= arr.length) return false; [arr[i], arr[j]] = [arr[j], arr[i]]; return true; }
document.addEventListener('click', e => {
  const t = e.target.closest('[data-mm-tab],[data-mm-open],[data-mm-new],[data-mm-shift],[data-mm-mode],[data-mm-region],[data-mm-day],[data-mm-goto],[data-mm-close],[data-mm-ptab],[data-mm-edit],[data-mm-del],[data-mm-objdel],[data-mm-objedit],[data-mm-move],[data-mm-agedit],[data-mm-agdel],[data-mm-mscheck],[data-mm-stepdel],[data-mm-stepedit],[data-mm-upload],[data-mm-deckdel],[data-mm-view],[data-mm-present],[data-mm-att],[data-mm-allpresent],[data-mm-roster],[data-mm-fpick],[data-mm-fcancel],[data-mm-fopen],[data-mm-fdl],[data-mm-fdel],[data-mm-deckdl],[data-mm-cmtdel]'); if (!t) return;
  const ds = t.dataset, mt = state.mmSel ? mmFind(state.mmSel) : null;
  if (ds.mmTab) { state.mtTab = ds.mmTab; if (state.view !== 'meetings') return setView('meetings'); return renderMeetings(); }
  if (ds.mmOpen) { if (state.view !== 'meetings') { setView('meetings'); } const x = mmFind(ds.mmOpen); if (x && state.mmUnit) { const r = mmRange(); if (x.date < r.s || x.date > r.e) { state.mmAnchor = x.date; renderMeetings(); } } return mmPanelOpen(ds.mmOpen, ds.mmTabTo); }
  if (ds.mmClose !== undefined) return mmPanelClose();
  if (ds.mmNew) return mmScheduleDialog(null, ds.mmNew);
  if (ds.mmShift) { if (ds.mmShift === 'today') state.mmAnchor = todayISO(); else mmShift(+ds.mmShift); state.mmFocus = `[data-mm-shift="${ds.mmShift}"]`; return renderMeetings(); }
  if (ds.mmMode) { state.mmMode = ds.mmMode; lsSet('ngc_mm_mode', ds.mmMode); state.mmFocus = `[data-mm-mode="${ds.mmMode}"]`; return renderMeetings(); }
  if (ds.mmRegion !== undefined) { state.mmRegion = ds.mmRegion; lsSet('ngc_mm_region', ds.mmRegion); state.mmFocus = `[data-mm-region="${ds.mmRegion}"]`; return renderMeetings(); }
  if (ds.mmDay) { const list = mmList().filter(x => x.date === ds.mmDay && mmVisible(x)); if (list.length === 1) return mmPanelOpen(list[0].id); state.mmUnit = 'day'; state.mmAnchor = ds.mmDay; return renderMeetings(); }
  if (ds.mmGoto) { state.mmUnit = 'month'; state.mmAnchor = ds.mmGoto; return renderMeetings(); }
  if (ds.mmPtab) { state.mmPTab = ds.mmPtab; state.mmFocus = `#mmpt-${ds.mmPtab}`; state.mmForce = true; return mmPanelRender(); }
  if (ds.mmView) return openDeck(ds.mmView, false);
  if (ds.mmPresent) return openDeck(ds.mmPresent, true);
  if (!mt && !ds.mmEdit && !ds.mmDel) return;
  /* shared edits: everyone signed in */
  if (ds.mmAtt) { const cur = (mt.attend || {})[ds.mmAtt], v = cur === ds.v ? '' : ds.v; state.mmFocus = `[data-mm-att="${CSS.escape(ds.mmAtt)}"][data-v="${ds.v}"]`; return mmEdit(mt, 'attend', { marks: { [ds.mmAtt]: v } }, v ? `Marked ${ds.mmAtt} ${v}` : `Cleared attendance for ${ds.mmAtt}`).then(mmRedraw); }
  if (ds.mmAllpresent !== undefined) { const marks = {}; mmRoster(mt).forEach(n => { if (!(mt.attend || {})[n]) marks[n] = 'present'; }); if (!Object.keys(marks).length) return; return mmEdit(mt, 'attend', { marks }, `Marked ${Object.keys(marks).length} people present`).then(mmRedraw); }
  if (ds.mmStepedit) { const s = (mt.steps || []).find(x => x.id === ds.mmStepedit); if (!s) return; return mmItemDialog({ title: 'Edit next step', fields: [{ id: 'text', label: 'Next step', value: s.text }, { id: 'owner', label: 'Owner', type: 'select', options: ownerOptions(s.owner || '') }, { id: 'due', label: 'Due date', type: 'date', value: s.due || '' }], onSave: v => mmEdit(mt, 'step_set', { id: s.id, fields: { text: v.text.trim().slice(0, 200), owner: v.owner, due: v.due || '' } }, `Edited next step: ${v.text.trim().slice(0, 80)}`).then(mmRedraw) }); }
  if (ds.mmStepdel) { const s = (mt.steps || []).find(x => x.id === ds.mmStepdel); if (!s) return; return confirmDialog({ undo: false, title: 'Remove this next step?', message: esc(s.text), confirmLabel: 'Remove', danger: true, onConfirm: () => mmEdit(mt, 'step_del', { id: s.id }, `Removed next step: ${s.text.slice(0, 80)}`).then(mmRedraw) }); }
  if (ds.mmFpick !== undefined) { const f = $('#mmAFile'); if (f) { f.value = ''; f.onchange = () => { if (f.files[0]) { state.mmPending = { mt: mt.id, file: f.files[0] }; state.mmFocus = '#mmFName'; state.mmForce = true; mmPanelRender(); } }; f.click(); } return; }
  if (ds.mmFcancel !== undefined) { const again = !ds.mmFcancel; state.mmPending = null; state.mmForce = true; mmPanelRender(); if (again) { const b = document.querySelector('[data-mm-fpick]'); if (b) b.click(); } return; }
  if (ds.mmFopen) { const f = (mt.files || []).find(x => x.id === ds.mmFopen); return f && openDeck(mt.id, false, f); }
  if (ds.mmFdl) { const f = (mt.files || []).find(x => x.id === ds.mmFdl); return f && mmFileGet(f, false); }
  if (ds.mmDeckdl) { if (!mt.deck) return; return mmDeckBlob(mt.deck).then(bl => { const a = document.createElement('a'); a.href = URL.createObjectURL(bl); a.download = mt.deck.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }).catch(() => toast(String(mt.deck.path).startsWith('local:') ? 'These slides were saved in another browser' : 'Download failed. Check your connection and try again', 'err')); }
  if (ds.mmCmtdel) return confirmDialog({ undo: false, title: 'Remove this comment?', message: 'It is removed for everyone', confirmLabel: 'Remove', danger: true, onConfirm: () => { closeConfirm(); mmEdit(mt, 'comment_del', { id: ds.mmCmtdel }, 'Removed a comment').then(ok => { if (ok) mmRedraw(); }); } });
  if (ds.mmFdel) { const f = (mt.files || []).find(x => x.id === ds.mmFdel); if (!f) return; return confirmDialog({ undo: false, title: `Remove ${f.name}?`, message: 'The file is deleted for everyone', confirmLabel: 'Remove', danger: true, onConfirm: async () => { if (await mmEdit(mt, 'file_del', { id: f.id }, `Removed file: ${f.name}`)) { mmFileRemoveBlob(f); toast('File removed', 'ok'); } mmRedraw(); } }); }
  /* admins only: a meeting's details and deleting it. Everyone signed in edits the content below. */
  if (ds.mmEdit) { if (!guardAdmin()) return; return mmScheduleDialog(mmFind(ds.mmEdit)); }
  if (ds.mmDel) { if (!guardAdmin()) return; const x = mmFind(ds.mmDel); if (!x) return; return confirmDialog({ undo: false, title: `Delete ${x.title}, ${fmtDate(x.date)}?`, message: 'It moves to Recently deleted. An admin can restore it within 30 days', confirmLabel: 'Delete meeting', danger: true, onConfirm: () => { mmTrash(x); mmPanelClose(true); toastAction('Meeting deleted', 'Undo', () => mmRestore(x.id)); } }); }
  if (ds.mmMove) { const [k, id, dir] = ds.mmMove.split(':'), arr = k === 'obj' ? mt.objectives : mt.agenda; if (!arr || !mmMove(arr, id, +dir)) return; mmLog(mt, k === 'obj' ? 'Reordered objectives' : 'Reordered the agenda'); autosave(); state.mmFocus = `[data-mm-move="${ds.mmMove}"]`; return mmRedraw(); }
  if (ds.mmObjdel) { const i = mt.objectives.findIndex(o => o.id === ds.mmObjdel); if (i < 0) return; const gone = mt.objectives.splice(i, 1)[0]; mmLog(mt, `Removed objective ${i + 1}`); autosave(); mmRedraw(); return toastAction('Objective removed', 'Undo', () => { mt.objectives.splice(i, 0, gone); mmLog(mt, 'Restored an objective'); autosave(); mmRedraw(); }); }
  if (ds.mmObjedit) { const o = mt.objectives.find(x => x.id === ds.mmObjedit); if (!o) return; return mmItemDialog({ title: 'Edit objective', fields: [{ id: 'text', label: 'Objective', type: 'area', value: o.text, max: 600 }], onSave: v => { o.text = v.text.trim().slice(0, 600); mmLog(mt, 'Edited an objective'); autosave(); mmRedraw(); } }); }
  if (ds.mmAgedit) { const a = (mt.agenda || []).find(x => x.id === ds.mmAgedit); if (!a) return; return mmItemDialog({ title: 'Edit agenda item', fields: [{ id: 'title', label: 'Agenda item', value: a.title, max: 140 }, { id: 'mins', label: 'Minutes', type: 'number', value: a.mins || '' }, { id: 'lead', label: 'Lead', type: 'select', options: ownerOptions(a.lead || '').replace('>Unassigned<', '>No lead<') }], onSave: v => { a.title = v.title.trim().slice(0, 140); a.mins = Math.max(0, Math.min(240, +v.mins || 0)); a.lead = v.lead; mmLog(mt, `Edited agenda item: ${a.title}`); autosave(); mmRedraw(); } }); }
  if (ds.mmAgdel) { const i = (mt.agenda || []).findIndex(x => x.id === ds.mmAgdel); if (i < 0) return; const gone = mt.agenda.splice(i, 1)[0]; mmLog(mt, `Removed agenda item: ${gone.title}`); autosave(); mmRedraw(); return toastAction('Agenda item removed', 'Undo', () => { mt.agenda.splice(i, 0, gone); autosave(); mmRedraw(); }); }
  if (ds.mmMscheck) { mt.msCheck = ds.mmMscheck === 'on' ? undefined : false; mmLog(mt, ds.mmMscheck === 'on' ? 'Added the milestone check' : 'Removed the milestone check'); autosave(); return mmRedraw(); }
  if (ds.mmRoster !== undefined) return mmRosterDialog(mt);
  if (ds.mmUpload) { const f = $('#mmFile'); if (!f) return; f.value = ''; f.onchange = () => mmUpload(mt.id, f.files[0]); return f.click(); }
  if (ds.mmDeckdel) return confirmDialog({ undo: false, title: 'Remove these slides?', message: `${esc(mt.deck.name)} is deleted for everyone`, confirmLabel: 'Remove', danger: true, onConfirm: () => { mmDeckRemove(mt.deck); mt.deck = null; mmLog(mt, 'Removed the slides'); autosave(); mmRedraw(); toast('Slides removed', 'ok'); } });
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset && t.dataset.mmStepdone) return mmToggleStep(t.dataset.mmStepdone, t.checked, t);
  if (t.dataset && t.dataset.mmUnit !== undefined) { state.mmUnit = t.value; lsSet('ngc_mm_unit', t.value); state.mmFocus = '#mmUnit'; return renderMeetings(); }
});
document.addEventListener('toggle', e => { if (e.target.matches && e.target.matches('[data-mm-msdetails]')) state.mmMsOpen = e.target.open; }, true);
document.addEventListener('submit', e => {
  const f = e.target, d = f.dataset || {}, id = d.mmObjform || d.mmAgform || d.mmStepform || d.mmGuestform || d.mmFileform || d.mmCmtform; if (!id) return;
  e.preventDefault(); const mt = mmFind(id); if (!mt) return;
  if (d.mmFileform) {
    const p = state.mmPending; if (!p || p.mt !== mt.id) return; const name = f.fname.value.trim(); if (!name) return markInvalid(f.fname, 'Name the file');
    const btn = f.querySelector('[type="submit"]'); btn.disabled = true; btn.textContent = 'Uploading';
    return mmFileUpload(mt, p.file, name, f.desc.value.trim()).then(ok => { if (ok) state.mmPending = null; else { btn.disabled = false; btn.textContent = 'Add file'; } mmRedraw(); });
  }
  if (d.mmGuestform) { const n = f.who.value.trim().slice(0, 80); if (!n) return markInvalid(f.who, 'Type a name'); state.mmFocus = '#mmGuest'; return mmEdit(mt, 'attend', { marks: { [n]: 'present' } }, `Added ${n} as present`).then(mmRedraw); }
  if (d.mmCmtform) {
    const text = f.text.value.trim(); if (!text) return markInvalid(f.text, 'Write a comment');
    state.mmFocus = '#mmCmtT';
    return mmEdit(mt, 'comment_add', { comment: { id: uid(), text: text.slice(0, 2000) } }, 'Added a comment').then(ok => { if (ok) mmRedraw(); });
  }
  if (d.mmStepform) {
    const text = f.text.value.trim(); if (!text) return markInvalid(f.text, 'Say what needs to happen');
    state.mmFocus = '#mmStepT';
    return mmEdit(mt, 'step_add', { step: { id: uid(), text: text.slice(0, 200), owner: f.owner.value, due: f.due.value || '', done: false, at: new Date().toISOString() } }, `Added next step: ${text.slice(0, 80)}`).then(mmRedraw);
  }
  if (!mmContrib()) return;
  if (d.mmObjform) {
    const lines = f.text.value.split(/\n+/).map(s => s.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean); if (!lines.length) return markInvalid(f.text, 'Type an objective');
    mt.objectives = mt.objectives || []; const at = Math.max(0, Math.min(mt.objectives.length, (parseInt(f.no.value, 10) || mt.objectives.length + 1) - 1));
    mt.objectives.splice(at, 0, ...lines.map(s => ({ id: uid(), text: s.slice(0, 600) })));
    mmLog(mt, lines.length === 1 ? `Added objective ${at + 1}` : `Added ${lines.length} objectives`); state.mmFocus = '#mmObjIn';
  } else {
    const text = f.text.value.trim(); if (!text) return markInvalid(f.text, 'Name the agenda item');
    (mt.agenda = mt.agenda || []).push({ id: uid(), title: text.slice(0, 140), mins: Math.max(0, Math.min(240, +f.mins.value || 0)), lead: f.lead.value, ids: [] });
    mmLog(mt, `Added agenda item: ${text.slice(0, 80)}`); state.mmFocus = '#mmAgT';
  }
  autosave(); mmRedraw();
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'mmObjIn' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.target.form.requestSubmit(); return; }
  const w = $('#mmPanel'); if (!w || $('#confirmBackdrop') || $('#deckViewer') || ($('#modalBackdrop') && $('#modalBackdrop').classList.contains('open'))) return;
  if (e.key === 'Escape') { e.preventDefault(); return mmPanelClose(); }
  const tab = e.target.closest && e.target.closest('.mm-p-tab');
  if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End')) {
    const all = [...w.querySelectorAll('.mm-p-tab')], i = all.indexOf(tab), j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
    e.preventDefault(); state.mmPTab = all[j].dataset.mmPtab; state.mmFocus = `#mmpt-${state.mmPTab}`; state.mmForce = true; return mmPanelRender();
  }
  if (e.key === 'Tab') { const f = [...w.querySelectorAll('button:not([disabled]), input:not([disabled]):not(.hide), select, textarea, summary, [tabindex="0"]')].filter(x => x.offsetParent !== null); if (!f.length) return; const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
});
let mmPtrDown = false;
document.addEventListener('pointerdown', () => { mmPtrDown = true; }, true);
document.addEventListener('pointerup', () => { mmPtrDown = false; if (state.mmStale) setTimeout(mmStaleRedraw, 0); }, true);
document.addEventListener('pointercancel', () => { mmPtrDown = false; }, true);
function mmStaleRedraw() { const w = $('#mmPanel'); if (!w || !state.mmStale || mmPtrDown) return; const a = document.activeElement; if (!(w.contains(a) && mmTyping(a))) mmPanelRender(); }
// A redraw waiting on someone's typing runs once they leave the field, but never mid-click (it used to
// rebuild the form between mouse down and up, which lost the text and the click). Nov 20 2026
document.addEventListener('focusout', e => { const w = $('#mmPanel'); if (w && state.mmStale && w.contains(e.target)) setTimeout(mmStaleRedraw, 0); });
document.addEventListener('input', e => {
  const t = e.target; if (!t.dataset || !t.dataset.mmNotes) return; const mt = mmFind(t.dataset.mmNotes); if (!mt) return;
  if (t.isContentEditable) t.classList.toggle('is-empty', !t.textContent.trim() && !t.querySelector('img, li'));   // placeholder clears as you type
  const s = $('#mmNotesSaved'); if (s) s.textContent = 'Saving';
  clearTimeout(mmNotesT); mmNotesT = setTimeout(async () => { const v = t.isContentEditable ? rteClean(t.innerHTML) : t.value; if (v.length > 20000) { const s3 = $('#mmNotesSaved'); if (s3) s3.textContent = 'Too long to save. Shorten the notes'; return; } const ok = await mmEdit(mt, 'notes', { notes: v, text: t.isContentEditable ? rteText(v) : String(v).slice(0, 6000) }, 'Edited notes'); const s2 = $('#mmNotesSaved'); if (s2) s2.textContent = ok ? 'Saved' : 'Not saved'; }, 900);
});
['dragover', 'drop', 'dragleave'].forEach(ev => document.addEventListener(ev, e => {
  const z = e.target.closest && e.target.closest('[data-mm-drop],[data-mm-fdrop]'); if (!z) return; e.preventDefault();
  z.classList.toggle('is-over', ev === 'dragover');
  if (ev !== 'drop' || !e.dataTransfer.files[0]) return;
  if (z.dataset.mmDrop) { if (mmContrib()) mmUpload(z.dataset.mmDrop, e.dataTransfer.files[0]); }
  else { state.mmPending = { mt: z.dataset.mmFdrop, file: e.dataTransfer.files[0] }; state.mmFocus = '#mmFName'; state.mmForce = true; mmPanelRender(); }
}));

function mmLogToggle(r) {
  const mt = mmFind(state.mmSel); if (!mt) return; const L = (mt.log || []).slice().reverse().slice(0, 150), x = L[+r.dataset.mmLogi]; if (!x) return;
  const d = r.nextElementSibling, open = r.getAttribute('aria-expanded') !== 'true';
  if (open) d.firstElementChild.innerHTML = mmLogDetail(mt, x);
  d.hidden = !open; if (open) moIn(d.firstElementChild, 4, 160); r.setAttribute('aria-expanded', String(open)); r.classList.toggle('is-open', open);
}
function mmGotoSec(k) {
  state.mmPTab = k === 'files' ? 'files' : 'meeting'; state.mmForce = true; mmPanelRender();
  if (k === 'files') return;
  setTimeout(() => { const b = document.querySelector(`[data-mm-jump="${k}"]`); if (b) b.click(); const sec = $('#mmSec-' + k); if (sec) { sec.classList.add('is-flash'); setTimeout(() => sec.classList.remove('is-flash'), 1600); } }, 30);
}
document.addEventListener('keydown', e => { const r = e.target.closest && e.target.closest('.mm-log-r'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); mmLogToggle(r); } });
document.addEventListener('click', e => {
  const lr = e.target.closest && e.target.closest('.mm-log-r'); if (lr) return mmLogToggle(lr);
  const gs = e.target.closest && e.target.closest('[data-mm-goto-sec]'); if (gs) return mmGotoSec(gs.dataset.mmGotoSec);
  const nt = e.target.closest && e.target.closest('[data-mm-ntog]'); if (nt) { state.mmNotesT = !state.mmNotesT; const p = $('#mmNtl'); if (p) moShow(p, state.mmNotesT); nt.setAttribute('aria-expanded', String(state.mmNotesT)); return; }
  const t = e.target.closest && e.target.closest('[data-mm-col],[data-mm-jump],[data-mm-more]'); if (!t || !$('#mmPanel') || !$('#mmPanel').contains(t)) return;
  const setCol = (k, c) => { mmCollapsed(k); state.mmCol[k] = c; lsSet('ngc_mm_col', JSON.stringify(state.mmCol)); const sec = $('#mmSec-' + k); if (!sec) return; sec.classList.toggle('is-col', c); moShow(sec.querySelector('.mm-tile-b'), !c); sec.querySelector('.mm-tile-tog').setAttribute('aria-expanded', String(!c)); };
  if (t.dataset.mmCol) return setCol(t.dataset.mmCol, !mmCollapsed(t.dataset.mmCol));
  if (t.dataset.mmJump) { e.preventDefault(); const k = t.dataset.mmJump, sec = $('#mmSec-' + k); if (!sec) return; if (mmCollapsed(k)) setCol(k, false); sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); const tg = sec.querySelector('.mm-tile-tog'); if (tg) tg.focus({ preventScroll: true }); return; }
  if (t.dataset.mmMore) {
    const id = t.dataset.mmMore, p = openPopover(t, `<div class="cds-dd-list" role="menu"><button type="button" class="cds-dd-opt" role="menuitem" data-mm-edit="${esc(id)}"><span>Edit details</span></button><button type="button" class="cds-dd-opt mm-danger" role="menuitem" data-mm-del="${esc(id)}"><span>Delete meeting</span></button></div>`);
    p.classList.add('cds-dd-pop'); p.addEventListener('click', () => setTimeout(closePopover, 0));
  }
});

/* ============================================================
   NOTES CO-EDITING (Nov 20 2026): Google Docs-style live editing with named cursors.
   Yjs merges everyone's keystrokes (no overwrites, works offline and catches up), Quill is the editor,
   quill-cursors draws each person's caret and selection. Messages go over a Supabase Realtime broadcast
   channel per meeting, plus a BroadcastChannel so two tabs in one browser also sync (used for QA).
   The first person in seeds the document from the saved notes with a fixed Yjs client id derived from
   the content, so two people joining at once produce the identical seed and never duplicate the text.
   Each person's own edits still save to the meeting (and the notes timeline) about a second after typing.
   ============================================================ */
let nqLibP = null; state.nq = null;
function nqLoad() {
  if (window.GHCollab) return Promise.resolve(window.GHCollab);
  return nqLibP || (nqLibP = new Promise((ok, no) => {
    const v = encodeURIComponent(window.GH_VERSION || ''), sc = document.createElement('script'); sc.src = 'assets/collab/collab.min.js?v=' + v; sc.onload = () => window.GHCollab ? ok(window.GHCollab) : no(new Error('collab')); sc.onerror = () => { nqLibP = null; no(new Error('collab')); };
    const ln = document.createElement('link'); ln.rel = 'stylesheet'; ln.href = 'assets/collab/quill.core.css?v=' + v; document.head.appendChild(ln); document.head.appendChild(sc);
  }));
}
function nqActive(id) { const q = state.nq; return !!(q && q.quill && (!id || q.mtId === id) && document.contains(q.wrap)); }
const nqB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const nqU8 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
function nqHash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 1000000000 + 1; }
const NQ_FONTS = { 'IBM Plex Serif': "'IBM Plex Serif', Georgia, serif", 'IBM Plex Mono': "'IBM Plex Mono', Menlo, monospace" };
function nqRegister(C) {
  if (C._ghReg) return; C._ghReg = true;
  const Q = C.Quill, P = Q.import('parchment');
  class FontAttr extends P.StyleAttributor {
    add(node, value) { if (!NQ_FONTS[value]) return false; node.style.fontFamily = NQ_FONTS[value]; return true; }
    value(node) { const f = String(node.style.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(); return NQ_FONTS[f] ? f : ''; }
  }
  Q.register(new FontAttr('font', 'font-family', { scope: P.Scope.INLINE }), true);
  Q.register(new P.StyleAttributor('size', 'font-size', { scope: P.Scope.INLINE, whitelist: ['12px', '18px', '24px'] }), true);
  class MmImage extends P.EmbedBlot {
    static create(id) { const n = super.create(); n.setAttribute('data-mm-file', id); n.setAttribute('alt', 'Image'); nqHydrateImg(n); return n; }
    static value(n) { return n.getAttribute('data-mm-file'); }
  }
  MmImage.blotName = 'mmimage'; MmImage.tagName = 'IMG'; MmImage.className = 'mm-img';
  Q.register(MmImage, true);
}
async function nqHydrateImg(n) {
  const mt = state.nq && mmFind(state.nq.mtId), f = mt && (mt.files || []).find(x => x.id === n.getAttribute('data-mm-file'));
  if (!f) { n.alt = 'Image removed'; n.classList.add('is-missing'); return; }
  try { n.src = URL.createObjectURL(await mmFileBlob(f)); } catch (e) { n.alt = 'Image could not load'; n.classList.add('is-missing'); }
}
const nqHtmlIn = html => String(html || '').replace(/<img(?![^>]*class=)([^>]*data-mm-file=)/gi, '<img class="mm-img"$1');
function nqMount(w, mt) {
  const ph = w.querySelector('#mmNotesQ'); if (!ph) return;
  if (state.nq && state.nq.mtId === mt.id && state.nq.wrap) { ph.replaceWith(state.nq.wrap); nqPaintWho(); return; }
  nqUnmount();
  const wrap = document.createElement('div'); wrap.className = 'rte-qwrap'; wrap.innerHTML = ph.innerHTML; ph.replaceWith(wrap);
  const nq = state.nq = { mtId: mt.id, wrap, peers: new Map() };
  nqLoad().then(C => { if (state.nq !== nq) return; nqStart(C, nq); }).catch(() => {
    if (state.nq !== nq) return; state.nq = null; const cur = mmFind(mt.id); wrap.innerHTML = rteLegacyBody(cur || mt); rteHydrate(wrap);   // the library could not load: plain editor as before
  });
}
function nqStart(C, nq) {
  nqRegister(C);
  const mt = mmFind(nq.mtId); if (!mt) return;
  nq.wrap.innerHTML = '<div class="rte-q" aria-label="Meeting notes"></div>';
  const quill = new C.Quill(nq.wrap.firstChild, { modules: { toolbar: false, cursors: { transformOnTextChange: true, hideDelayMs: 4000, hideSpeedMs: 300 }, history: { userOnly: true } }, placeholder: 'Decisions, takeaways and anything people should remember', formats: ['bold', 'italic', 'underline', 'background', 'font', 'size', 'list', 'indent', 'mmimage'] });
  quill.root.setAttribute('aria-label', 'Meeting notes'); quill.root.setAttribute('role', 'textbox'); quill.root.setAttribute('aria-multiline', 'true'); quill.root.classList.add('rte-body');
  const doc = new C.Y.Doc(), ytext = doc.getText('notes'), aw = new C.Awareness(doc), me = mmMe();
  aw.setLocalStateField('user', { name: me, color: avatarColor(me) });
  const binding = new C.QuillBinding(ytext, quill, aw);
  Object.assign(nq, { C, quill, doc, ytext, aw, binding, synced: false });
  const topic = `ghn:${wsSettingsId('meetbook')}:${nq.mtId}`;
  const send = (type, data) => { const msg = { type, data, from: doc.clientID }; try { nq.bc && nq.bc.postMessage(msg); } catch (e) {} if (nq.ch && nq.chReady) nq.ch.send({ type: 'broadcast', event: 'm', payload: msg }); };
  nq.send = send;
  const handle = msg => {
    if (!msg || msg.from === doc.clientID || state.nq !== nq) return;
    try {
      if (msg.type === 'u') C.Y.applyUpdate(doc, nqU8(msg.data), 'remote');
      else if (msg.type === 'aw') C.applyAwarenessUpdate(aw, nqU8(msg.data), 'remote');
      else if (msg.type === 'sync1') { if (ytext.length || nq.synced) send('sync2', nqB64(C.Y.encodeStateAsUpdate(doc, nqU8(msg.data)))); send('aw', nqB64(C.encodeAwarenessUpdate(aw, [doc.clientID]))); }
      else if (msg.type === 'sync2') { C.Y.applyUpdate(doc, nqU8(msg.data), 'remote'); nq.synced = true; }
    } catch (e) { console.warn('notes sync', e); }
  };
  doc.on('update', (u, origin) => { if (origin !== 'remote') send('u', nqB64(u)); });
  aw.on('update', ({ added, updated, removed }, origin) => { if (origin !== 'remote') send('aw', nqB64(C.encodeAwarenessUpdate(aw, added.concat(updated, removed)))); else added.concat(updated).forEach(id => nqFlag(nq, id)); nqPaintWho(); });
  try { nq.bc = new BroadcastChannel(topic); nq.bc.onmessage = e => handle(e.data); } catch (e) {}
  const cl = state.sb && state.sb.connected && state.sb.client;
  if (cl && cl.channel) {
    try {
      nq.ch = cl.channel(topic, { config: { broadcast: { self: false } } });
      nq.ch.on('broadcast', { event: 'm' }, ({ payload }) => handle(payload));
      nq.ch.subscribe(st => { if (st === 'SUBSCRIBED' && state.nq === nq) { nq.chReady = true; send('sync1', nqB64(C.Y.encodeStateVector(doc))); send('aw', nqB64(C.encodeAwarenessUpdate(aw, [doc.clientID]))); } });
    } catch (e) { console.warn('notes channel', e); }
  }
  send('sync1', nqB64(C.Y.encodeStateVector(doc)));
  setTimeout(() => {   // no one answered with content: start from the saved notes (same seed on every client)
    if (state.nq !== nq || ytext.length) { nq.synced = true; return; }
    const cur = mmFind(nq.mtId), html = nqHtmlIn(rteFromNotes(cur ? cur.notes : ''));
    if (html.replace(/<[^>]+>/g, '').trim() || /<img/i.test(html)) {
      const delta = quill.clipboard.convert({ html }), seed = new C.Y.Doc(); seed.clientID = nqHash(nq.mtId + '|' + html);
      seed.getText('notes').applyDelta(delta.ops); C.Y.applyUpdate(doc, C.Y.encodeStateAsUpdate(seed), 'seed'); seed.destroy();
    }
    nq.synced = true; quill.history.clear();
  }, 700);
  // save your own edits (merged text) about a second after you stop
  quill.on('text-change', (d, old, source) => {
    if (source !== 'user') return; const s = $('#mmNotesSaved'); if (s) s.textContent = 'Saving';
    clearTimeout(nq.saveT); nq.saveT = setTimeout(async () => {
      const cur = mmFind(nq.mtId); if (!cur || state.nq !== nq) return;
      const html = rteClean(quill.getSemanticHTML().replace(/&nbsp;/g, ' ')),   // Quill exports every space as &nbsp;
        v = quill.getText().trim() || /<img/i.test(html) ? html : '';
      if (v.length > 20000) { const s3 = $('#mmNotesSaved'); if (s3) s3.textContent = 'Too long to save. Shorten the notes'; return; }
      const ok = await mmEdit(cur, 'notes', { notes: v, text: rteText(v) }, 'Edited notes');
      const s2 = $('#mmNotesSaved'); if (s2) s2.textContent = ok ? 'Saved' : 'Not saved';
    }, 900);
  });
  quill.on('editor-change', () => nqState());
  quill.root.addEventListener('paste', e => { const img = [...((e.clipboardData && e.clipboardData.files) || [])].find(f => /^image\//.test(f.type)); if (img) { e.preventDefault(); e.stopPropagation(); nqImage(img); } }, true);
  nq.onLeave = () => { try { C.removeAwarenessStates(aw, [doc.clientID], 'local'); } catch (e) {} };
  window.addEventListener('beforeunload', nq.onLeave);
  nqPaintWho();
}
// A person's name floats above their caret while they type, then fades about 2.5 s after they stop
function nqFlag(nq, id) {
  if (id === (nq.doc && nq.doc.clientID)) return;
  requestAnimationFrame(() => { const el = nq.wrap && nq.wrap.querySelector(`#ql-cursor-${CSS.escape(String(id))}`); if (!el) return;
    el.classList.add('is-typing'); clearTimeout(el._ghT); el._ghT = setTimeout(() => el.classList.remove('is-typing'), 2500); });
}
function nqUnmount() {
  const nq = state.nq; if (!nq) return; state.nq = null;
  clearTimeout(nq.saveT);
  try { if (nq.onLeave) { nq.onLeave(); window.removeEventListener('beforeunload', nq.onLeave); } } catch (e) {}
  try { nq.binding && nq.binding.destroy(); } catch (e) {}
  try { nq.bc && nq.bc.close(); } catch (e) {}
  try { if (nq.ch && state.sb && state.sb.client) state.sb.client.removeChannel(nq.ch); } catch (e) {}
  try { nq.aw && nq.aw.destroy(); nq.doc && nq.doc.destroy(); } catch (e) {}
}
function nqPeers() { const q = state.nq; if (!q || !q.aw) return []; const out = []; q.aw.getStates().forEach((st, id) => { if (id !== q.doc.clientID && st && st.user && st.user.name) out.push(st.user); }); const seen = new Set(); return out.filter(u => !seen.has(u.name) && seen.add(u.name)); }
function nqWhoHtml(mt) { if (!nqActive(mt.id)) return ''; const p = nqPeers(); return p.length ? `<span class="mm-who-l">Editing now</span>${p.slice(0, 4).map(u => `<span class="mm-who-p" title="${esc(u.name)}"><i style="background:${esc(u.color)}"></i>${esc(u.name.split(' ')[0])}</span>`).join('')}${p.length > 4 ? `<span class="mm-who-p">+${p.length - 4}</span>` : ''}` : ''; }
function nqPaintWho() { const el = $('#mmNotesWho'), q = state.nq; if (!el || !q) return; const mt = mmFind(q.mtId); if (!mt) return; const h = nqWhoHtml(mt); if (el.innerHTML !== h && el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; } }   // only redraw when who is here changes
function nqExec(cmd, val) {
  const q = state.nq.quill, r = q.getSelection(true), f = q.getFormat(r);
  if (cmd === 'bold' || cmd === 'italic' || cmd === 'underline') q.format(cmd, !f[cmd], 'user');
  else if (cmd === 'insertUnorderedList') q.format('list', f.list === 'bullet' ? false : 'bullet', 'user');
  else if (cmd === 'insertOrderedList') q.format('list', f.list === 'ordered' ? false : 'ordered', 'user');
  else if (cmd === 'indent' || cmd === 'outdent') q.format('indent', cmd === 'indent' ? '+1' : '-1', 'user');
  else if (cmd === 'hiliteColor') q.format('background', !val || val === 'transparent' ? false : val, 'user');
  else if (cmd === 'fontName') q.format('font', (RTE_FONTS.find(x => x[0] === val) || [0, ''])[1] in NQ_FONTS ? (RTE_FONTS.find(x => x[0] === val) || [0, ''])[1] : false, 'user');
  else if (cmd === 'fontSize') q.format('size', val || false, 'user');
  nqState();
}
async function nqImage(file) {
  const q = state.nq && state.nq.quill, mt = q && mmFind(state.nq.mtId); if (!mt || !file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return toast('Use a PNG, JPG, GIF or WebP image', 'warn');
  const r = q.getSelection(true), f = await mmFileUpload(mmFind(mt.id) || mt, file, 'Image in notes: ' + file.name, ''); if (!f || !state.nq) return;
  q.insertEmbed(r ? r.index : q.getLength() - 1, 'mmimage', f.id, 'user'); q.insertText((r ? r.index : q.getLength() - 1) + 1, '\n', 'user');
}
function nqState() {
  const q = state.nq && state.nq.quill; if (!q) return; const r = q.getSelection(); if (!r) return; const f = q.getFormat(r);
  [['bold', !!f.bold], ['italic', !!f.italic], ['underline', !!f.underline], ['ul', f.list === 'bullet'], ['ol', f.list === 'ordered']].forEach(([k, on]) => { const b = document.querySelector(`.rte-b[data-rte="${k}"]`); if (b) b.setAttribute('aria-pressed', String(on)); });
  const fs = $('#rteSize'), ff = $('#rteFont'); if (fs) fs.value = f.size || ''; if (ff) ff.value = f.font ? NQ_FONTS[f.font] || '' : '';
}

/* ============================================================
   MOTION (Nov 20 2026): Carbon productive motion through the Web Animations API, so an element animates
   only when it actually appears, leaves or moves, never on a redraw. Reduced-motion settings turn it off.
   ============================================================ */
const MO_IN = 'cubic-bezier(0, 0, .38, .9)', MO_OUT = 'cubic-bezier(.2, 0, 1, .9)', MO_STD = 'cubic-bezier(.2, 0, .38, .9)';
function moOK() { return !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
function moIn(el, dy, ms) { if (!el || !moOK() || !el.animate) return; el.animate([{ opacity: 0, transform: `translateY(${dy == null ? 6 : dy}px)` }, { opacity: 1, transform: 'none' }], { duration: ms || 180, easing: MO_IN }); }
function moOut(el, ms) { return new Promise(res => { if (!el || !moOK() || !el.animate) return res(); const a = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: ms || 110, easing: MO_OUT, fill: 'forwards' }); a.onfinish = () => res(); a.oncancel = () => res(); }); }
function moShow(el, show) {   // fold open or shut: height, opacity, slight slide
  if (!el) return; if (!moOK() || !el.animate) { el.hidden = !show; return; }
  if (show) { el.hidden = false; const h = el.scrollHeight; el.animate([{ height: '0px', opacity: 0, overflow: 'hidden' }, { height: h + 'px', opacity: 1, overflow: 'hidden' }], { duration: Math.min(260, 120 + h / 8), easing: MO_IN }); }
  else { const h = el.scrollHeight, a = el.animate([{ height: h + 'px', opacity: 1, overflow: 'hidden' }, { height: '0px', opacity: 0, overflow: 'hidden' }], { duration: Math.min(200, 100 + h / 10), easing: MO_OUT }); a.onfinish = () => { el.hidden = true; }; }
}
function moKeys(root) { return new Set(root ? [...root.querySelectorAll('[data-mo]')].map(e => e.dataset.mo) : []); }
function moNew(root, before) { if (!root || !before) return; root.querySelectorAll('[data-mo]').forEach(e => { if (!before.has(e.dataset.mo)) moIn(e); }); }
function moBar(root, oldPct) {   // progress bars grow from their old value after a redraw
  if (!root || oldPct == null || !moOK()) return; const i = root.querySelector('.mv-bar i'); if (!i) return; const to = i.style.width;
  if (to === oldPct + '%') return; i.style.transition = 'none'; i.style.width = oldPct + '%'; requestAnimationFrame(() => requestAnimationFrame(() => { i.style.transition = ''; i.style.width = to; }));
}

/* ============================================================
   MILESTONE VIEW (Nov 20 2026)
   Opening a saved milestone shows one Carbon page you edit in place: click the pencil to rename,
   click a tag (status, due date, owners, schools, team) to change it, and tick, add or edit tasks,
   links, waiting-on milestones and comments where they sit. Each change saves at once (Undo in
   the toast). A second tab shows the milestone's history. New milestones still use the create form,
   and "Edit all fields" in the overflow menu opens the full form for rarely used fields
   (targets, team parts, priority, start date and so on).
   ============================================================ */
function mvOn() { const bd = $('#modalBackdrop'); return !!bd && bd.classList.contains('mv') && bd.classList.contains('open') && modalMode === 'task' && !!findM(modalId); }
function mvM() { return findM(modalId); }
function mvOpen(m) {
  const bd = $('#modalBackdrop'); bd.classList.add('mv');
  if (state.mvId !== m.id) { state.mvId = m.id; state.mvTab = 'main'; }
  const nav = $('#modalNav'); if (nav) nav.insertAdjacentHTML('beforeend', `<button type="button" class="icon-btn mv-more" data-mv="more" aria-haspopup="menu" aria-expanded="false" aria-label="More actions" title="More actions">${CI('overflow')}</button>`);
  $('#modalTitle').textContent = canEdit() ? 'Milestone' : 'Milestone (view only)';
  mvRender(true); bd.classList.add('open');
  requestAnimationFrame(() => { const h = $('#mvTitle'); if (h) h.focus({ preventScroll: true }); });
}
function mvSave(label, fn, quiet) {
  if (!guardEdit()) return false; const m = mvM(); if (!m) return false;
  snapshotForUndo(`${label}: ${(m.activity || '').slice(0, 30)}`);
  fn(m); touch(m); logActivity('edit', `${label}: ${m.activity}`, { itemId: m.id });
  autosave(); state.mvSkip = true; try { rerender(); } finally { state.mvSkip = false; } mvRender();
  const s = $('#mvSaved'); if (s) s.textContent = 'Saved';
  if (!quiet) toastAction(`${label} saved`, 'Undo', () => { undo(); if (mvOn()) mvRender(); });
  return true;
}
function mvTag(key, inner, cls, label) {
  return canEdit() ? `<button type="button" class="mv-tag ${cls || ''}" data-mv="${key}" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(label)}">${inner}${CI('chevron')}</button>` : `<span class="mv-tag ${cls || ''}">${inner}</span>`;
}
function mvRender(first) {
  const m = mvM(), body = $('#modalBody'); if (!m || !body) return;
  const ed = canEdit(), es = effectiveStatus(m), keep = first ? 0 : body.scrollTop, tab = state.mvTab || 'main';
  const a = document.activeElement, inMv = a && a !== document.body && (body.contains(a) || (a.closest && a.closest('.modal-head')));
  const fsel = !inMv || first ? '' : a.id ? '#' + CSS.escape(a.id) : a.closest('[data-cp]') && a.classList[0] ? `[data-cp="${CSS.escape(a.closest('[data-cp]').dataset.cp)}"] .${a.classList[0]}` : a.dataset && a.dataset.mv ? `[data-mv="${a.dataset.mv}"]${a.dataset.v ? `[data-v="${a.dataset.v}"]` : ''}` : '';
  const own = ownersOf(m), d = m.due_date ? daysUntil(m.due_date) : null, done = m.status === 'complete';
  const dueTxt = done ? 'Done' + (m.completedAt ? ' ' + fmtDate(m.completedAt.slice(0, 10)) : '') : m.due_date ? `Due ${fmtDate(m.due_date)}${d < 0 ? ` · ${-d} day${d === -1 ? '' : 's'} late` : ''}` : 'No due date';
  const sch = (m.schoolIds || []).map(schoolById).filter(Boolean);
  const schTxt = sch.length > 2 ? `${sch.length} schools` : sch.length ? sch.map(x => esc(schLbl(x))).join(', ') : esc(m.market || 'Network-wide');
  const tags = [
    mvTag('status', `${statusDot(es)}${esc(SM(es).label)}`, 'mv-tag-status', `Status: ${SM(es).label}. Change status`),
    mvTag('due', `${CAL_IC}${esc(dueTxt)}`, !done && d != null && d < 0 ? 'is-late' : '', `${dueTxt}. Change due date`),
    mvTag('owners', esc(own.length ? own[0] + (own.length > 1 ? ` +${own.length - 1}` : '') : 'No owner'), own.length ? '' : 'is-empty', `Owners: ${own.join(', ') || 'none'}. Change owner or co-owners`),
    mvTag('schools', `${sch.length || m.market ? `<i class="mv-mk" style="background:${mkColor(sch.length ? sch[0].market : m.market)}"></i>` : ''}${schTxt}`, '', `Schools: ${sch.map(schLbl).join(', ') || m.market || 'network-wide'}. Change schools`),
    mvTag('team', esc(m.functional_area || 'No team'), '', `Team: ${m.functional_area || 'none'}. Change team`)
  ].join('');
  const rc = ed && readyToComplete(m);
  const head = `<div class="mv-head">
      <div class="mv-title-row" id="mvTitleRow"><h2 class="mv-title" id="mvTitle" tabindex="-1">${esc(m.activity)}</h2>${ed ? `<button type="button" class="icon-btn mv-pencil" data-mv="name" aria-label="Edit milestone name" title="Edit name">${CI('edit')}</button>` : ''}</div>
      <div class="mv-tags">${tags}</div>
      ${m.status === 'blocked' && m.dependency ? `<p class="mv-blocked" data-mo="blocked">${CI('flag')}<span><b>Blocked:</b> ${esc(m.dependency)}</span></p>` : ''}
      ${m.dueRequest ? dueReqBanner(m) : ''}
      ${rc ? `<div class="rc-banner" role="status" data-mo="rc"><span><b>Ready to mark complete.</b> ${esc(rc)}.</span><button type="button" class="btn btn-filled btn-sm" data-mv="complete">Mark complete</button></div>` : ''}
    </div>
    <div class="mv-tabs" role="tablist" aria-label="Milestone"><button type="button" role="tab" id="mvTab-main" class="mv-tabb" aria-selected="${tab === 'main'}" aria-controls="mvPane" tabindex="${tab === 'main' ? 0 : -1}" data-mvtab="main">Overview</button><button type="button" role="tab" id="mvTab-hist" class="mv-tabb" aria-selected="${tab === 'hist'}" aria-controls="mvPane" tabindex="${tab === 'hist' ? 0 : -1}" data-mvtab="hist">History</button><span class="mv-saved" id="mvSaved" aria-live="polite"></span></div>`;
  const moBefore = first ? null : moKeys(body), oldBar = body.querySelector('.mv-bar'), oldPct = oldBar ? +oldBar.getAttribute('aria-valuenow') : null, tabChanged = !first && state.mvTabShown !== tab; state.mvTabShown = tab;
  body.innerHTML = `<div class="mv" data-nodirty>${head}<div class="mv-pane" id="mvPane" role="tabpanel" aria-labelledby="mvTab-${tab}">${tab === 'hist' ? mvHistory(m) : mvMain(m)}</div></div>`;
  if (tabChanged) moIn($('#mvPane'), 4); else { moNew(body, moBefore); moBar(body, oldPct); }
  body.scrollTop = keep;
  if (fsel) { const f = document.querySelector('#modalBackdrop ' + fsel); if (f) f.focus({ preventScroll: true }); }
  if (tab === 'hist') mvLoadAudit(m);
}
function mvMain(m) {
  const ed = canEdit(), mode = measureOf(m), pct = curProgress(m), cps = m.checkpoints || [];
  const modes = [['steps', 'Tasks'], ['binary', 'Done or not'], ...(mode === 'count' ? [['count', 'Count']] : [])];
  const sw = `<div class="mv-switch" role="group" aria-label="Track progress by">${modes.map(([v, l]) => `<button type="button" class="mv-sw ${mode === v ? 'is-on' : ''}" aria-pressed="${mode === v}" data-mv="mode" data-v="${v}" ${ed ? '' : 'disabled'}>${l}</button>`).join('')}</div>`;
  const bar = mode === 'binary' ? '' : `<div class="mv-bar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`;
  let prog = '';
  if (mode === 'steps') {
    const nDone = cps.filter(c => c.done).length, t = todayISO();
    prog = `
      <ul class="mv-tasks">${cps.map(c => `<li class="mv-task ${c.done ? 'is-done' : ''}" data-cp="${esc(c.id)}" data-mo="cp-${esc(c.id)}">
        <input type="checkbox" class="mv-cp-done" ${c.done ? 'checked' : ''} ${ed ? '' : 'disabled'} aria-label="Done: ${esc(c.title)}">
        ${ed ? `<input class="mv-cp-title" value="${esc(c.title)}" maxlength="200" aria-label="Task name">` : `<span class="mv-cp-title">${esc(c.title)}</span>`}
        ${ed ? `<input type="date" class="mv-cp-due ${!c.done && c.due && c.due < t ? 'is-late' : ''} ${c.due ? '' : 'is-empty'}" value="${esc(c.due || '')}" aria-label="Task due date">` : c.due ? `<span class="mv-cp-due">${esc(fmtDate(c.due))}</span>` : ''}
        ${ed ? `<button type="button" class="icon-btn" data-mv="cpdel" aria-label="Remove task ${esc(c.title)}" title="Remove">${CI('close')}</button>` : ''}</li>`).join('')}</ul>
      ${ed ? `<form class="mv-add" data-mvform="task"><label class="sr-only" for="mvTaskIn">New task</label><input id="mvTaskIn" maxlength="200" placeholder="Add a task" autocomplete="off"><button class="btn btn-ghost btn-sm" type="submit">${CI('add')} Add task</button></form>` : ''}`;
  } else if (mode === 'count') {
    const tg = m.target || {};
    prog = `<p class="mv-help">${esc(tg.label || 'Count')}: ${+tg.done || 0} of ${+tg.total || 0}</p>
      ${ed ? `<form class="mv-add mv-count" data-mvform="count"><label for="mvCount">Count to date</label><input id="mvCount" type="number" min="0" step="1" inputmode="numeric" value="${+tg.done || 0}"><button class="btn btn-ghost btn-sm" type="submit">Update</button></form>` : ''}`;
  } else {
    const done = m.status === 'complete';
    prog = `<div class="mv-binary ${done ? 'is-done' : ''}">${done ? `${CI('check')}<span>Done${m.completedAt ? ' ' + esc(fmtDate(m.completedAt.slice(0, 10))) : ''}</span>` : `<span>Not done yet</span>${ed ? '<button type="button" class="btn btn-tonal btn-sm" data-mv="complete">Mark complete</button>' : ''}`}</div>`;
  }

  const links = (m.links || []).map(l => { const u = safeUrl(l.url); return u ? `<li class="mv-link kd-row" data-mo="lk-${esc(u)}"><span class="kd-ic">${KD_IC.link}</span><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(l.label || hostOf(u) || u)}</a><span class="mv-host">${esc(hostOf(u))}</span>${ed ? `<button type="button" class="icon-btn" data-mv="lkdel" data-url="${esc(u)}" aria-label="Remove link ${esc(l.label || u)}" title="Remove">${CI('close')}</button>` : ''}</li>` : ''; }).join('');
  const deps = (m.blockedBy || []).map(findM).filter(Boolean), needed = M().filter(x => (x.blockedBy || []).includes(m.id));
  const depRow = (x, rm) => { const iss = rm ? depIssue(m, x) : ''; return `<li class="mv-dep">${statusDot(effectiveStatus(x))}<button type="button" class="mv-dep-n" data-expand="${esc(x.id)}">${esc(x.activity)}</button><span class="mv-host">${x.status === 'complete' ? 'Done' : x.due_date ? 'Due ' + esc(fmtDate(x.due_date)) : 'No due date'}${iss ? ` · <span class="mv-warn">${esc(iss)}</span>` : ''}</span>${rm && ed ? `<button type="button" class="icon-btn" data-mv="depdel" data-id="${esc(x.id)}" aria-label="Stop waiting on ${esc(x.activity)}" title="Remove">${CI('close')}</button>` : ''}</li>`; };
  const sec = (h, inner, right, cls) => `<section class="mv-sec ${cls || ''}"><div class="mv-sec-h"><h3>${h}</h3>${right || ''}</div>${inner}</section>`;
  const right = mode === 'steps' ? (cps.length ? `${cps.filter(c => c.done).length} of ${cps.length} done` : '') : mode === 'count' ? `${+(m.target || {}).done || 0} of ${+(m.target || {}).total || 0}` : '';
  return sec('Progress', `${sw}${bar}${prog}`, right ? `<span class="mv-pctv">${right}</span>` : '')
    + (m.notes || '' ? sec('Notes', `<div id="mvNotesRow"><p class="mv-notes">${esc(m.notes)}</p></div>`, ed ? `<button type="button" class="icon-btn" data-mv="notes" aria-label="Edit notes" title="Edit notes">${CI('edit')}</button>` : '') : '')
    + sec('Key links and documents', kdHtml(m, links), '', 'kd-sec')
    + sec('Dependencies', mvDepsHtml(m))
    + sec('Comments', notesSection('task', m.id, m.noteLog));
}
/* ---------- Key links and documents (Nov 20 2026) ----------
   Links and files in one list. Files go to the private "meeting-files" bucket under <board>/ms/<milestone>/
   (same rules: anyone signed in can add and read; the uploader or an admin can delete). Offline they stay on this device.
   Every external link asks before leaving the Hub; every download asks before saving. */
const KD_IC = {
  link: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M29.25,6.76a6,6,0,0,0-8.5,0l1.42,1.42a4,4,0,1,1,5.67,5.67l-8,8a4,4,0,1,1-5.67-5.66l1.41-1.42-1.41-1.42-1.42,1.42a6,6,0,0,0,0,8.5A6,6,0,0,0,17,25a6,6,0,0,0,4.27-1.76l8-8A6,6,0,0,0,29.25,6.76Z"/><path d="M4.19,24.82a4,4,0,0,1,0-5.67l8-8a4,4,0,0,1,5.67,0A3.94,3.94,0,0,1,19,14a4,4,0,0,1-1.17,2.85L15.71,19l1.42,1.42,2.12-2.12a6,6,0,0,0-8.51-8.51l-8,8a6,6,0,0,0,0,8.51A6,6,0,0,0,7,28a6.07,6.07,0,0,0,4.28-1.76L9.86,24.82A4,4,0,0,1,4.19,24.82Z"/></svg>',
  doc: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M25.7,9.3l-7-7C18.5,2.1,18.3,2,18,2H8C6.9,2,6,2.9,6,4v24c0,1.1,0.9,2,2,2h16c1.1,0,2-0.9,2-2V10C26,9.7,25.9,9.5,25.7,9.3z M18,4.4l5.6,5.6H18V4.4z M24,28H8V4h8v6c0,1.1,0.9,2,2,2h6V28z"/><path d="M10 22H22V24H10zM10 16H22V18H10z"/></svg>',
  up: '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 18L7.41 19.41 15 11.83 15 30 17 30 17 11.83 24.59 19.41 26 18 16 8 6 18zM6 8V4H26V8h2V4a2 2 0 00-2-2H6A2 2 0 004 4V8z"/></svg>'
};
function kdHtml(m, links) {
  const ed = canEdit(), docs = m.docs || [], up = (state.kdUp || {})[m.id] || [];
  const docRows = docs.map(f => `<li class="kd-row ${state.kdNew === f.id ? 'is-new' : ''}" data-mo="kd-${esc(f.id)}"><span class="kd-ext kd-ext-${esc(f.ext)}" aria-hidden="true">${esc(String(f.ext || 'file').slice(0, 4).toUpperCase())}</span><button type="button" class="kd-name" data-kd-dl="${esc(f.id)}" title="Download ${esc(f.fname || f.name)}">${esc(f.name)}</button><span class="mv-host">${esc(mmSize(f.size || 0))}${f.by ? ' · ' + esc(f.by) : ''}</span>${state.kdNew === f.id ? `<span class="kd-ok" aria-label="Uploaded">${CI('check')}</span>` : ''}${ed ? `<button type="button" class="icon-btn" data-mv="kddel" data-id="${esc(f.id)}" aria-label="Remove ${esc(f.name)}" title="Remove">${CI('close')}</button>` : ''}</li>`).join('');
  const upRows = up.map(u => `<li class="kd-row is-up" aria-live="polite"><span class="kd-hop" aria-hidden="true">${KD_IC.doc}</span><span class="kd-up-t"><span>${esc(u.name)}</span><span class="kd-dots" aria-label="Uploading"><i></i><i></i><i></i></span></span><span class="kd-shimmer" aria-hidden="true"></span></li>`).join('');
  const any = links || docRows || upRows;
  const form = ed && state.kdLink ? `<form class="mv-add mv-add-link" data-mvform="link" novalidate><label class="sr-only" for="mvLkUrl">Link</label><input id="mvLkUrl" type="url" placeholder="https://" autocomplete="off"><label class="sr-only" for="mvLkName">Name</label><input id="mvLkName" placeholder="Name" autocomplete="off"><button class="btn btn-filled btn-sm" type="submit">Add</button><button class="btn btn-ghost btn-sm" type="button" data-kd-cancel>Cancel</button></form>` : '';
  return `${any ? `<ul class="mv-list kd-list">${links}${docRows}${upRows}</ul>` : ed ? '' : '<p class="mv-empty">None</p>'}${form}
    ${ed ? `<div class="kd-acts">${state.kdLink ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-kd-link>${KD_IC.link} Add link</button>`}<button type="button" class="btn btn-ghost btn-sm" data-kd-pick>${KD_IC.up} Upload file</button><input type="file" id="kdFile" multiple hidden accept="${Object.keys(MM_FILE_EXT).map(x => '.' + x).join(',')}"></div>` : ''}
    ${ed ? '<div class="kd-dropmask" aria-hidden="true">Drop to upload</div>' : ''}`;
}
async function kdUpload(m, files) {
  if (!guardEdit()) return;
  for (const file of [...files]) {
    const ext = mmExt(file.name);
    if (!MM_FILE_EXT[ext]) { toast('Add a PDF, Word, Excel, PowerPoint, image or text file', 'warn'); continue; }
    if (file.size > MM_FILE_MB * 1048576) { toast(`${file.name} is over ${MM_FILE_MB} MB`, 'warn'); continue; }
    const tmp = { id: uid(), name: file.name }; ((state.kdUp = state.kdUp || {})[m.id] = state.kdUp[m.id] || []).push(tmp); mvRender();
    const live = state.sb && state.sb.connected, key = `${WS}/ms/${m.id}/${uid()}.${ext}`; let path = key, ok = true;
    const t0 = Date.now();
    try {
      if (live) { const r = await state.sb.client.storage.from(MM_FILE_BUCKET).upload(key, file, { contentType: file.type || MM_FILE_EXT[ext], upsert: false }); if (r.error) throw r.error; }
      else { path = 'local:' + key; await mmIdbDo('readwrite', st => st.put(file, path)); }
    } catch (e) { ok = false; toast(/bucket/i.test(String(e && e.message)) ? 'File storage is not set up yet. An admin needs to run supabase-meetings-collab.sql' : `${file.name} didn't upload. Check your connection and try again`, 'err'); }
    if (Date.now() - t0 < 700) await new Promise(r => setTimeout(r, 700 - (Date.now() - t0)));   // let the animation be seen
    state.kdUp[m.id] = state.kdUp[m.id].filter(x => x !== tmp);
    if (!ok) { mvRender(); continue; }
    mmBlobCache[path] = file;
    const f = { id: uid(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 120) || file.name, fname: file.name.slice(0, 140), ext, mime: file.type || MM_FILE_EXT[ext], size: file.size, path, by: currentDisplayName() || '', at: new Date().toISOString() };
    state.kdNew = f.id; setTimeout(() => { if (state.kdNew === f.id) { state.kdNew = null; if (mvOn()) mvRender(); } }, 2400);
    mvSave('Documents', x => { (x.docs = x.docs || []).push(f); }, true);
  }
}
function kdDownload(m, id) {
  const f = (m.docs || []).find(x => x.id === id); if (!f) return;
  confirmDialog({ title: 'Download this file?', message: `<b>${esc(f.fname || f.name)}</b><br><span class="muted">${esc(String(f.ext || '').toUpperCase())} · ${esc(mmSize(f.size || 0))}${f.by ? ' · added by ' + esc(f.by) : ''}</span>`, confirmLabel: 'Download', onConfirm: async () => {
    try { const blob = await mmFileBlob(f), a = document.createElement('a'), u = URL.createObjectURL(blob); a.href = u; a.download = f.fname || f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); }
    catch (e) { toast('That file could not be downloaded. Try again', 'err'); }
  } });
}
document.addEventListener('click', e => {
  if (!e.target.closest || !mvOn()) return;
  const m = mvM(); if (!m) return;
  if (e.target.closest('[data-kd-link]')) { state.kdLink = true; mvRender(); const u = $('#mvLkUrl'); if (u) u.focus(); return; }
  if (e.target.closest('[data-kd-cancel]')) { state.kdLink = false; return mvRender(); }
  if (e.target.closest('[data-kd-pick]')) { const f = $('#kdFile'); if (f) { f.value = ''; f.onchange = () => kdUpload(m, f.files); f.click(); } return; }
  const dl = e.target.closest('[data-kd-dl]'); if (dl) return kdDownload(m, dl.dataset.kdDl);
});
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { const sec = e.target.closest && e.target.closest('.kd-sec'); if (!sec || !canEdit() || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); sec.classList.add('is-drop'); }));
document.addEventListener('dragleave', e => { const sec = e.target.closest && e.target.closest('.kd-sec'); if (sec && !sec.contains(e.relatedTarget)) sec.classList.remove('is-drop'); });
document.addEventListener('drop', e => { const sec = e.target.closest && e.target.closest('.kd-sec'); if (!sec || !e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); sec.classList.remove('is-drop'); const m = mvM(); if (m) kdUpload(m, e.dataTransfer.files); });
// Leaving the Hub: any link to another site asks first (Carbon passive modal)
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href]'); if (!a || a.hasAttribute('download') || a.dataset.noLeave !== undefined || e.defaultPrevented) return;
  let u; try { u = new URL(a.getAttribute('href'), location.href); } catch (x) { return; }
  if (!/^https?:$/.test(u.protocol) || u.origin === location.origin) return;
  e.preventDefault(); e.stopPropagation();
  confirmDialog({ title: 'Leave Causeway?', message: `This opens <b>${esc(u.hostname.replace(/^www\./, ''))}</b> in a new tab.<div class="leave-url">${esc(u.href)}</div>`, confirmLabel: 'Open link', onConfirm: () => window.open(u.href, '_blank', 'noopener,noreferrer') });
}, true);
/* ---------- Dependencies (Nov 20 2026) ----------
   What this milestone needs before it can finish. Two kinds, each tagged and tied to a team:
   - Milestone: an existing one (search) or a new one created here (same market and schools). Stored in m.blockedBy.
   - Task: a named piece of work another team owes. Stored in m.depTasks [{ id, title, team, owner, due, done }].
   Adding one posts a comment that @mentions the people who owe it, so it reaches their "Comments for you" and bell. */
function mvDepsHtml(m) {
  const ed = canEdit(), mode = state.mvDepMode || '', t = todayISO();
  const deps = (m.blockedBy || []).map(findM).filter(Boolean), tasks = m.depTasks || [], needed = M().filter(x => (x.blockedBy || []).includes(m.id));
  const chip = (txt, cls) => `<span class="mv-chip ${cls || ''}">${txt}</span>`;
  const msRow = x => { const iss = depIssue(m, x); return `<li class="mv-dep2" data-mo="dep-${esc(x.id)}">
      ${chip('Milestone', 'is-ms')}<span class="mv-dep2-main"><button type="button" class="mv-dep-n" data-expand="${esc(x.id)}">${esc(x.activity)}</button>
      <span class="mv-dep2-meta">${statusDot(effectiveStatus(x))}<span>${esc(SM(effectiveStatus(x)).label)}</span>${x.functional_area ? chip(esc(x.functional_area), 'is-team') : ''}${ownersOf(x)[0] ? `<span>${esc(ownersOf(x)[0])}</span>` : ''}<span>${x.status === 'complete' ? 'Done' : x.due_date ? 'Due ' + esc(fmtDate(x.due_date)) : 'No due date'}</span>${iss ? `<span class="mv-warn">${esc(iss)}</span>` : ''}</span></span>
      ${ed ? `<button type="button" class="icon-btn" data-mv="depdel" data-id="${esc(x.id)}" aria-label="Remove dependency ${esc(x.activity)}" title="Remove">${CI('close')}</button>` : ''}</li>`; };
  const tkRow = k => `<li class="mv-dep2 ${k.done ? 'is-done' : ''}" data-mo="dt-${esc(k.id)}">
      ${chip('Task', 'is-task')}<span class="mv-dep2-main"><label class="mv-dep2-t"><input type="checkbox" data-dt-done="${esc(k.id)}" ${k.done ? 'checked' : ''} ${ed ? '' : 'disabled'} aria-label="Done: ${esc(k.title)}"><span>${esc(k.title)}</span></label>
      <span class="mv-dep2-meta">${k.team ? chip(esc(k.team), 'is-team') : ''}${k.owner ? `<span>${esc(k.owner)}</span>` : '<span>No owner</span>'}<span class="${!k.done && k.due && k.due < t ? 'mv-warn' : ''}">${k.done ? 'Done' : k.due ? 'Due ' + esc(fmtDate(k.due)) : 'No due date'}</span></span></span>
      ${ed ? `<button type="button" class="icon-btn" data-dt-del="${esc(k.id)}" aria-label="Remove dependency ${esc(k.title)}" title="Remove">${CI('close')}</button>` : ''}</li>`;
  const list = deps.length || tasks.length ? `<ul class="mv-list">${deps.map(msRow).join('')}${tasks.map(tkRow).join('')}</ul>` : '<p class="mv-empty">None</p>';
  const tabs = ed ? `<div class="mv-switch mv-dep-sw" role="group" aria-label="Add a dependency">${[['link', 'Link a milestone'], ['task', 'New task'], ['ms', 'New milestone']].map(([v, l]) => `<button type="button" class="mv-sw ${mode === v ? 'is-on' : ''}" aria-pressed="${mode === v}" data-depmode="${v}">${CI('add')} ${l}</button>`).join('')}</div>` : '';
  const form = !ed || !mode ? '' : mode === 'link'
    ? `<div class="mv-dsearch" data-mo="depf-link"><label class="sr-only" for="mvDepQ">Search milestones</label><input id="mvDepQ" type="search" placeholder="Search milestones" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="mvDepRes" aria-autocomplete="list"><ul id="mvDepRes" class="mv-dres" role="listbox" aria-label="Milestones" hidden></ul></div>`
    : `<form class="mv-depf" data-mvform="dep" data-kind="${mode}" data-mo="depf-${mode}">
        <div class="field mv-depf-n"><label for="mvDfName">${mode === 'task' ? 'Task' : 'Milestone'} name</label><input id="mvDfName" maxlength="200" autocomplete="off"></div>
        <div class="field"><label for="mvDfTeam">Team</label><select id="mvDfTeam"><option value="">Pick a team</option>${teams().map(x => `<option>${esc(x)}</option>`).join('')}</select></div>
        <div class="field"><label for="mvDfOwner">Owner</label><select id="mvDfOwner">${ownerOptions('')}</select></div>
        <div class="field"><label for="mvDfDue">Due</label><input id="mvDfDue" type="date" value="${esc(m.due_date || '')}"></div>
        <div class="mv-depf-acts"><button type="button" class="btn btn-tonal btn-sm" data-depmode="">Cancel</button><button type="submit" class="btn btn-filled btn-sm">Add ${mode === 'task' ? 'task' : 'milestone'}</button></div>
      </form>`;
  return list + tabs + form + (needed.length ? `<h4 class="mv-subh">These depend on this milestone</h4><ul class="mv-list">${needed.map(x => `<li class="mv-dep2">${chip('Milestone', 'is-ms')}<span class="mv-dep2-main"><button type="button" class="mv-dep-n" data-expand="${esc(x.id)}">${esc(x.activity)}</button><span class="mv-dep2-meta">${statusDot(effectiveStatus(x))}<span>${esc(SM(effectiveStatus(x)).label)}</span>${x.functional_area ? chip(esc(x.functional_area), 'is-team') : ''}<span>${x.due_date ? 'Due ' + esc(fmtDate(x.due_date)) : 'No due date'}</span></span></span></li>`).join('')}</ul>` : '');
}
// A comment that tells the people who owe a dependency. Same path as a typed comment (server-merged when live).
async function depNotify(target, text) {
  const nt = { t: Date.now(), by: currentDisplayName() || '', text, kind: 'dependency' }, ments = mentionsIn(text); if (ments.length) nt.mentions = ments;
  const live = state.sb && state.sb.connected && sbLoaded && state.auth.user;
  if (live) {
    try { await sbFlush(); const r = await state.sb.client.rpc('growth_add_note', { p_table: SB_TABLE.m, p_id: target.id, p_note: nt }); if (r.error) throw r.error; const base = sbLastPushed.has(target.id) ? JSON.parse(sbLastPushed.get(target.id)) : null; mergeIncoming(target, base, r.data); sbLastPushed.set(target.id, JSON.stringify(r.data)); autosaveWriteLocal(); }
    catch (e) { (target.noteLog = target.noteLog || []).push(nt); autosave(); }
  } else { (target.noteLog = target.noteLog || []).push(nt); autosave(); }
}
function depWho(names) { const me = myOwnerName(), mine = currentDisplayName(); return [...new Set(names.filter(n => n && n !== me && n !== mine && rosterNames().includes(n)))]; }
function depNotifyMilestone(m, x) {   // x now blocks m: tell x's owners on x
  const who = depWho(ownersOf(x)); if (!who.length) return '';
  depNotify(x, `${who.map(n => '@' + n).join(' ')} "${m.activity}" now depends on this milestone${m.due_date ? ` (due ${fmtDate(m.due_date)})` : ''}.`);
  return who.join(', ');
}
function depNotifyTask(m, k) {   // a task another team owes: tell its owner on m
  const who = depWho([k.owner]); if (!who.length) return '';
  depNotify(m, `${who.map(n => '@' + n).join(' ')} you own a dependency for this milestone: "${k.title}"${k.team ? ` (${k.team})` : ''}${k.due ? `, due ${fmtDate(k.due)}` : ''}.`);
  return who.join(', ');
}
/* ---------- link an existing milestone: search instead of a long dropdown ----------
   Empty box: suggestions (shares a school or market, due before this one). Typing: every word must match the
   name, team, market or owner. Milestones that already wait on this one are left out so no loop can form. */
function mvDepPool(m) {
  const taken = new Set(m.blockedBy || []);
  const waitsOnMe = x => { const seen = new Set(); const walk = id => { if (id === m.id) return true; if (seen.has(id)) return false; seen.add(id); const n = findM(id); return !!n && (n.blockedBy || []).some(walk); }; return walk(x.id); };
  return M().filter(x => x.id !== m.id && !x._draft && x.status !== 'complete' && !taken.has(x.id) && !waitsOnMe(x));
}
function mvDepResults(m, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean), sch = new Set(m.schoolIds || []);
  const score = x => (x.schoolIds || []).some(id => sch.has(id)) * 3 + (x.market && x.market === m.market) * 2 + (!!x.due_date && !!m.due_date && x.due_date <= m.due_date) * 1 + (x.functional_area === m.functional_area) * 0.5;
  let list = mvDepPool(m);
  if (words.length) list = list.filter(x => { const hay = `${x.activity} ${x.functional_area || ''} ${x.market || ''} ${ownersOf(x).join(' ')}`.toLowerCase(); return words.every(w => hay.includes(w)); });
  return list.map(x => ({ x, s: score(x) + (words.length && x.activity.toLowerCase().includes(words.join(' ')) ? 5 : 0) })).sort((a, b) => b.s - a.s || (a.x.due_date || '9999').localeCompare(b.x.due_date || '9999')).slice(0, 8).map(r => r.x);
}
function mvDepPaint(open) {
  const m = mvM(), inp = $('#mvDepQ'), ul = $('#mvDepRes'); if (!m || !inp || !ul) return;
  if (!open) { ul.hidden = true; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); return; }
  const q = inp.value.trim(), res = mvDepResults(m, q), words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hi = t => { let h = esc(t); words.forEach(w => { h = h.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>'); }); return h; };
  ul.innerHTML = (q ? '' : '<li class="mv-dres-h" role="presentation">Suggested</li>') + (res.length ? res.map((x, i) => `<li role="option" id="mvDr-${i}" class="mv-dres-o ${i === 0 ? 'is-act' : ''}" aria-selected="${i === 0}" data-dep-add="${esc(x.id)}">${statusDot(effectiveStatus(x))}<span class="mv-dres-m"><span class="mv-dres-n">${hi(x.activity)}</span><span class="mv-dres-c">${x.functional_area ? `<span class="mv-dres-chip">${esc(x.functional_area)}</span>` : ''}${x.market ? `<span class="mv-dres-chip"><i style="background:${mkColor(x.market)}"></i>${esc(x.market)}</span>` : ''}<span class="mv-dres-d">${x.due_date ? 'Due ' + esc(fmtDate(x.due_date)) : 'No due date'}</span></span></span></li>`).join('') : `<li class="mv-dres-h" role="presentation">${q ? mvDepWhyNot(m, words) : 'No other open milestones'}</li>`);
  ul.hidden = false; inp.setAttribute('aria-expanded', 'true'); if (res.length) inp.setAttribute('aria-activedescendant', 'mvDr-0');
}
function mvDepWhyNot(m, words) {   // explain a search that finds only milestones that can't be added
  const hit = M().filter(x => x.id !== m.id && !x._draft && words.every(w => `${x.activity} ${x.functional_area || ''} ${x.market || ''} ${ownersOf(x).join(' ')}`.toLowerCase().includes(w)));
  const loop = hit.find(x => x.status !== 'complete' && !(m.blockedBy || []).includes(x.id)), had = hit.find(x => (m.blockedBy || []).includes(x.id)), done = hit.find(x => x.status === 'complete');
  return loop ? `"${esc(clip(loop.activity, 60))}" already waits on this milestone, so it can't also be something this waits on` : had ? `Already waiting on "${esc(clip(had.activity, 60))}"` : done ? 'Only completed milestones match' : 'No open milestone matches';
}
function mvDepAdd(id) { const x = findM(id), m = mvM(); if (!x || !m) return; mvSave('Dependencies', y => { y.blockedBy = [...new Set([...(y.blockedBy || []), id])]; }, true); const told = depNotifyMilestone(m, x); toast(`Added dependency: ${clip(x.activity, 50)}${told ? ` (${told} notified)` : ''}`, 'ok'); }
document.addEventListener('input', e => { if (e.target.id === 'mvDepQ') mvDepPaint(true); });
document.addEventListener('focusin', e => { if (e.target.id === 'mvDepQ') mvDepPaint(true); });
document.addEventListener('focusout', e => { if (e.target.id === 'mvDepQ') setTimeout(() => { if (document.activeElement !== $('#mvDepQ')) mvDepPaint(false); }, 150); });
document.addEventListener('mousedown', e => { if (e.target.closest && e.target.closest('#mvDepRes')) e.preventDefault(); });
document.addEventListener('click', e => { const o = e.target.closest && e.target.closest('[data-dep-add]'); if (o && mvOn() && canEdit()) mvDepAdd(o.dataset.depAdd); });
document.addEventListener('keydown', e => {
  if (e.target.id !== 'mvDepQ') return; const ul = $('#mvDepRes'), opts = ul ? [...ul.querySelectorAll('[role=option]')] : [];
  if (e.key === 'Escape') { if (ul && !ul.hidden) { e.preventDefault(); e.stopPropagation(); mvDepPaint(false); } return; }
  if (!opts.length) return; let i = opts.findIndex(o => o.classList.contains('is-act'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (ul.hidden) mvDepPaint(true); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length; opts.forEach((o, k) => { o.classList.toggle('is-act', k === i); o.setAttribute('aria-selected', String(k === i)); }); e.target.setAttribute('aria-activedescendant', opts[i].id); opts[i].scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'Enter') { e.preventDefault(); if (i >= 0) mvDepAdd(opts[i].dataset.depAdd); }
});
/* ---------- history: this browser's record of dated events, plus the server's saved versions ---------- */
function mvHistory(m) {
  const a = state.mvAudit && state.mvAudit[m.id];
  const server = a === 'loading' ? '<p class="mv-empty">Loading changes</p>' : Array.isArray(a) ? (a.length ? `<ul class="md-hist">${a.map(e => `<li><span class="md-hist-t">${esc(fmtWhen(e.t))}${e.by ? ' · ' + esc(e.by) : ''}</span><span>${esc(e.txt)}</span></li>`).join('')}</ul>` : '<p class="mv-empty">No saved changes yet</p>') : '';
  return `<section class="mv-sec"><div class="mv-sec-h"><h3>Changes</h3></div>${server || '<p class="mv-empty">Sign in to see every saved change.</p>'}</section>
    <section class="mv-sec"><div class="mv-sec-h"><h3>Dates, forecasts and completion</h3></div>${mdHistory(m)}</section>`;
}
function mvDiff(a, b) {   // plain-language changes between two saved versions
  const out = [], f = (x, k) => (x || {})[k], lst = v => (v || []).join(', ') || 'none';
  if (!a) return ['Created the milestone'];
  if (f(a, 'activity') !== f(b, 'activity')) out.push(`Renamed to "${clip(f(b, 'activity') || '', 60)}"`);
  if (f(a, 'status') !== f(b, 'status')) out.push(`Status: ${SM(f(a, 'status') || 'not_started').label} to ${SM(f(b, 'status') || 'not_started').label}`);
  if (f(a, 'due_date') !== f(b, 'due_date')) out.push(`Due date: ${f(a, 'due_date') ? fmtDate(f(a, 'due_date')) : 'none'} to ${f(b, 'due_date') ? fmtDate(f(b, 'due_date')) : 'none'}`);
  if (!f(a, 'dueRequest') && f(b, 'dueRequest')) out.push(`Asked to move the due date to ${fmtDate(f(b, 'dueRequest').to)}`);
  if (f(a, 'owner') !== f(b, 'owner')) out.push(`Owner: ${f(a, 'owner') || 'none'} to ${f(b, 'owner') || 'none'}`);
  if (lst(f(a, 'coOwners')) !== lst(f(b, 'coOwners'))) out.push(`Co-owners: ${lst(f(b, 'coOwners'))}`);
  if ((+f(a, 'progress_percent') || 0) !== (+f(b, 'progress_percent') || 0)) out.push(`Progress: ${+f(a, 'progress_percent') || 0}% to ${+f(b, 'progress_percent') || 0}%`);
  const ca = f(a, 'checkpoints') || [], cb = f(b, 'checkpoints') || [];
  cb.filter(c => !ca.some(x => x.id === c.id)).forEach(c => out.push(`Added task "${clip(c.title || '', 50)}"`));
  ca.filter(c => !cb.some(x => x.id === c.id)).forEach(c => out.push(`Removed task "${clip(c.title || '', 50)}"`));
  cb.forEach(c => { const o = ca.find(x => x.id === c.id); if (o && !o.done && c.done) out.push(`Checked off "${clip(c.title || '', 50)}"`); if (o && o.done && !c.done) out.push(`Unchecked "${clip(c.title || '', 50)}"`); });
  const la = (f(a, 'links') || []).length, lb = (f(b, 'links') || []).length; if (la !== lb) out.push(lb > la ? 'Added a link' : 'Removed a link');
  if (lst(f(a, 'blockedBy')) !== lst(f(b, 'blockedBy'))) out.push('Changed milestone dependencies');
  const ta = f(a, 'depTasks') || [], tb = f(b, 'depTasks') || [];
  tb.filter(k => !ta.some(x => x.id === k.id)).forEach(k => out.push(`Added task dependency "${clip(k.title || '', 50)}"${k.team ? ` for ${k.team}` : ''}`));
  ta.filter(k => !tb.some(x => x.id === k.id)).forEach(k => out.push(`Removed task dependency "${clip(k.title || '', 50)}"`));
  tb.forEach(k => { const o = ta.find(x => x.id === k.id); if (o && !o.done && k.done) out.push(`Task dependency done: "${clip(k.title || '', 50)}"`); });
  if (lst(f(a, 'schoolIds')) !== lst(f(b, 'schoolIds'))) out.push('Changed schools');
  if (f(a, 'functional_area') !== f(b, 'functional_area')) out.push(`Team: ${f(b, 'functional_area') || 'none'}`);
  const na = (f(a, 'noteLog') || []).length, nb = (f(b, 'noteLog') || []).length; if (nb > na) out.push(nb - na === 1 ? 'Commented' : `Added ${nb - na} comments`);
  if ((f(a, 'notes') || '') !== (f(b, 'notes') || '')) out.push('Edited notes');
  return out;
}
async function mvLoadAudit(m) {
  state.mvAudit = state.mvAudit || {};
  const c = state.sb && state.sb.connected && state.sb.client; if (!c || state.mvAudit[m.id] === 'loading' || Array.isArray(state.mvAudit[m.id])) return;
  state.mvAudit[m.id] = 'loading';
  try {
    const { data, error } = await c.from('growth_audit_v').select('ts,action,actor_name,actor_email,changed_data').eq('entity_type', 'milestone').eq('entity_id', m.id).order('ts', { ascending: true }).limit(200);
    if (error) throw error;
    const ev = []; let prev = null;
    (Array.isArray(data) ? data : []).forEach(r => { const doc = r.changed_data && r.changed_data.doc; const by = r.actor_name || r.actor_email || ''; (r.action === 'insert' && !prev ? ['Created the milestone'] : mvDiff(prev, doc)).forEach(txt => ev.push({ t: r.ts, by, txt })); if (doc) prev = doc; });
    state.mvAudit[m.id] = ev.reverse().slice(0, 150);
  } catch (e) { state.mvAudit[m.id] = []; }
  if (mvOn() && mvM().id === m.id && state.mvTab === 'hist') mvRender();
}
/* ---------- popovers for the tags ---------- */
function mvPop(anchor, html, wide) {
  const p = openPopover(anchor, `<div class="mv-pop ${wide ? 'is-wide' : ''}" role="dialog" aria-label="${esc(anchor.getAttribute('aria-label') || '')}">${html}</div>`);
  p.classList.add('mv-popover');
  p.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); } });
  return p;
}
const mvPopBtns = (ok) => `<div class="mv-pop-acts"><button type="button" class="btn btn-tonal btn-sm" data-pop="cancel">Cancel</button><button type="button" class="btn btn-filled btn-sm" data-pop="ok">${ok || 'Save'}</button></div>`;
function mvStatusPop(b) {
  const m = mvM(), cur = m.status;
  const p = mvPop(b, `<div class="cds-dd-list" role="menu">${meta().statuses.map(s => `<button type="button" class="cds-dd-opt" role="menuitemradio" aria-checked="${cur === s}" data-st="${esc(s)}"><span>${statusDot(s)} ${esc(SM(s).label)}</span>${cur === s ? CI('check') : ''}</button>`).join('')}</div>`);
  p.addEventListener('click', e => {
    const o = e.target.closest('[data-st]'); if (!o) return; const v = o.dataset.st; if (v === cur) return closePopover();
    if (v === 'complete') { closePopover(); if (completeMilestone(m)) mvRender(); return; }
    if (v === 'blocked') {
      p.innerHTML = `<div class="mv-pop" role="dialog" aria-label="What's blocking it"><div class="field"><label for="mvWhy">What's blocking it?</label><input id="mvWhy" maxlength="300" value="${esc(m.dependency || '')}"></div>${mvPopBtns('Flag as blocked')}</div>`;
      $('#mvWhy').focus();
      const go = () => { const w = $('#mvWhy').value.trim(); if (!w) return markInvalid($('#mvWhy'), "Say what's blocking it"); closePopover(); mvSave('Status', x => { if (x.status !== 'blocked') x.statusBeforeBlock = x.status; x.status = 'blocked'; x.dependency = w; }); };
      p.querySelector('[data-pop="ok"]').onclick = go; p.querySelector('[data-pop="cancel"]').onclick = closePopover; $('#mvWhy').onkeydown = e2 => { if (e2.key === 'Enter') go(); };
      return;
    }
    closePopover();
    mvSave('Status', x => { const was = x.status; x.status = v; if (was === 'complete') { if (x.progress_percent === 100) x.progress_percent = 95; delete x.completedAt; } if (x.stage === 'complete') x.stage = 'in_progress'; if (CI_REV[v]) recordCheckin(x, CI_REV[v], null, ''); });
  });
}
function mvDuePop(b) {
  const m = mvM(), old = m.due_date || '';
  const p = mvPop(b, `<div class="field"><label for="mvDue">Due date</label><input id="mvDue" type="date" value="${esc(old)}"></div>
    <div class="field" id="mvWhyWrap" hidden><label for="mvDueWhy">Why is it moving?</label><input id="mvDueWhy" maxlength="300" ></div>
    ${mvPopBtns(old && !isAdmin() ? 'Request change' : 'Save')}`);
  const inp = $('#mvDue'), wrap = $('#mvWhyWrap');
  inp.addEventListener('input', () => { wrap.hidden = !(old && inp.value && inp.value !== old); });
  const go = () => {
    const v = inp.value, why = ($('#mvDueWhy').value || '').trim();
    if (!v) return markInvalid(inp, 'Pick a date');
    if (v === old) return closePopover();
    if (old && !why) { wrap.hidden = false; return markInvalid($('#mvDueWhy'), 'Add a reason for moving the date'); }
    closePopover();
    if (old && !isAdmin()) { mvSave('Date change request', x => { x.dueRequest = dueReq(old, v, why); }, true); return toast(`Sent to an admin. It stays ${fmtDate(old)} until approved`); }
    mvSave('Due date', x => { if (old) logDateMove(x, old, v, why); x.due_date = v; delete x.dueRequest; syncFiscal(x); });
  };
  p.querySelector('[data-pop="ok"]').onclick = go; p.querySelector('[data-pop="cancel"]').onclick = closePopover;
  p.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); go(); } });
}
function mvOwnersPop(b) {
  const m = mvM(), cur = new Set(m.coOwners || []), names = [...new Set([...rosterNames(), ...cur])].sort((a, c) => a.localeCompare(c));
  const p = mvPop(b, `<div class="field"><label for="mvOwner">Owner</label><select id="mvOwner">${ownerOptions(m.owner)}</select></div>
    <fieldset class="mv-co"><legend>Co-owners</legend>${names.length > 8 ? '<input type="search" id="mvCoFind" placeholder="Find a person" aria-label="Find a co-owner">' : ''}
      <div class="mv-co-list">${names.map(n => `<label class="mv-co-opt"><input type="checkbox" value="${esc(n)}" ${cur.has(n) ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('')}</div></fieldset>${mvPopBtns()}`);
  const own = $('#mvOwner'), sync = () => p.querySelectorAll('.mv-co-opt input').forEach(c => { const me = c.value === own.value; c.disabled = me; c.closest('label').classList.toggle('is-owner', me); });
  own.addEventListener('change', sync); sync();
  const f = $('#mvCoFind'); if (f) f.addEventListener('input', () => { const q = f.value.toLowerCase(); p.querySelectorAll('.mv-co-opt').forEach(l => { l.hidden = !l.textContent.toLowerCase().includes(q); }); });
  p.querySelector('[data-pop="cancel"]').onclick = closePopover;
  p.querySelector('[data-pop="ok"]').onclick = () => { const o = own.value.trim(), co = [...p.querySelectorAll('.mv-co-opt input:checked')].map(c => c.value).filter(x => x && x !== o); closePopover(); mvSave('Owners', x => { x.owner = o; x.coOwners = co; }); };
}
function mvSchoolsPop(b) {
  const m = mvM();
  const p = mvPop(b, `<p class="mv-pop-h">School openings</p><div class="so-pick" id="mvSchools">${schoolPicker(m)}</div>
    <div class="field" id="mvMkWrap" ${(m.schoolIds || []).length ? 'hidden' : ''}><label for="mvMk">Market when no school is picked</label><select id="mvMk"><option value="">Network-wide</option>${markets().map(x => `<option ${x === m.market && !(m.schoolIds || []).length ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>${mvPopBtns()}`, true);
  const ids = () => [...p.querySelectorAll('.m-school:checked')].map(x => x.value);
  p.addEventListener('change', e => { if (!e.target.classList.contains('m-school')) return; e.target.closest('.so-opt').classList.toggle('on', e.target.checked); $('#mvMkWrap').hidden = ids().length > 0; });
  p.querySelector('[data-pop="cancel"]').onclick = closePopover;
  p.querySelector('[data-pop="ok"]').onclick = () => { const sel = ids(), mk = $('#mvMk').value; closePopover(); mvSave('Schools', x => { x.schoolIds = sel; x.schools = sel.map(id => (schoolById(id) || {}).code).filter(Boolean); x.market = derivedMarket(sel) || mk || ''; x.state = stateOfMarket(x.market) || ''; const os = sel.length ? schoolById(sel[0]) : null; if (os) x.openingFY = os.openingFY; }); };
}
function mvTeamPop(b) {
  const m = mvM();
  const p = mvPop(b, `<div class="cds-dd-list" role="menu">${teams().map(t => `<button type="button" class="cds-dd-opt" role="menuitemradio" aria-checked="${m.functional_area === t}" data-team="${esc(t)}"><span>${esc(t)}</span>${m.functional_area === t ? CI('check') : ''}</button>`).join('')}</div>`);
  p.addEventListener('click', e => { const o = e.target.closest('[data-team]'); if (!o) return; const v = o.dataset.team; closePopover(); if (v !== m.functional_area) mvSave('Team', x => { x.team = v; x.functional_area = v; }); });
}
function mvMorePop(b) {
  const m = mvM(), ed = canEdit();
  const p = mvPop(b, `<div class="cds-dd-list" role="menu">
    <button type="button" class="cds-dd-opt" role="menuitem" data-more="copy"><span>Copy link</span></button>
    ${ed ? `<button type="button" class="cds-dd-opt" role="menuitem" data-more="dupe"><span>Duplicate</span></button>
    <button type="button" class="cds-dd-opt" role="menuitem" data-more="full"><span>Edit all fields</span></button>
    <button type="button" class="cds-dd-opt mv-danger" role="menuitem" data-more="del"><span>Delete milestone</span></button>` : ''}</div>`);
  p.addEventListener('click', e => {
    const o = e.target.closest('[data-more]'); if (!o) return; closePopover(); const k = o.dataset.more;
    if (k === 'copy') return copyText(milestoneUrl(m.id), 'Link copied');
    if (k === 'dupe') return duplicateMilestone(m.id);
    if (k === 'del') return deleteModal();
    if (k === 'full') { state.mvFull = true; return openModal(m.id); }
  });
}
function mvEditText(row, value, label, multi, onSave) {   // in-place text editor with Save and Cancel
  const keepHtml = row.innerHTML;
  row.innerHTML = `<label class="sr-only" for="mvEd">${esc(label)}</label><textarea id="mvEd" class="mv-ed ${multi ? 'is-multi' : ''}" maxlength="${multi ? 4000 : 300}" rows="${multi ? 4 : 1}">${esc(value)}</textarea><div class="mv-ed-acts"><button type="button" class="btn btn-tonal btn-sm" data-ed="cancel">Cancel</button><button type="button" class="btn btn-filled btn-sm" data-ed="ok">Save</button></div>`;
  const t = row.querySelector('#mvEd'), grow = () => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };
  grow(); t.focus(); t.setSelectionRange(t.value.length, t.value.length); t.addEventListener('input', grow);
  const cancel = () => { row.innerHTML = keepHtml; const pb = row.querySelector('.icon-btn'); if (pb) pb.focus(); };
  const ok = () => { const v = t.value.trim(); if (!multi && !v) return markInvalid(t, 'Add a name'); if (v === String(value).trim()) return cancel(); onSave(v); };
  row.querySelector('[data-ed="cancel"]').onclick = cancel; row.querySelector('[data-ed="ok"]').onclick = ok;
  t.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } else if (e.key === 'Enter' && !e.shiftKey && !multi) { e.preventDefault(); ok(); } });
}
/* ---------- events ---------- */
document.addEventListener('click', e => {
  if (!mvOn()) return;
  const tb = e.target.closest('[data-mvtab]'); if (tb && $('#modalBody').contains(tb)) { state.mvTab = tb.dataset.mvtab; mvRender(); const nt = $('#mvTab-' + state.mvTab); if (nt) nt.focus(); return; }
  const b = e.target.closest('[data-mv]'); if (!b || !($('#modalBackdrop').contains(b))) return;
  const k = b.dataset.mv, m = mvM();
  if (k === 'more') return mvMorePop(b);
  if (!canEdit()) return;
  if (k === 'status') return mvStatusPop(b);
  if (k === 'due') return mvDuePop(b);
  if (k === 'owners') return mvOwnersPop(b);
  if (k === 'schools') return mvSchoolsPop(b);
  if (k === 'team') return mvTeamPop(b);
  if (k === 'complete') { if (completeMilestone(m)) mvRender(); return; }
  if (k === 'name') return mvEditText($('#mvTitleRow'), m.activity, 'Milestone name', false, v => mvSave('Name', x => { x.activity = v; }));
  if (k === 'notes') return mvEditText($('#mvNotesRow'), m.notes || '', 'Notes', true, v => mvSave('Notes', x => { x.notes = v; }));
  if (k === 'mode') { const v = b.dataset.v; if (v === measureOf(m)) return; return mvSave('Progress tracking', x => { x.measure = v; if (v === 'steps' && (x.checkpoints || []).length && x.status !== 'complete') x.progress_percent = cpProgress(x); }, true); }
  if (k === 'cpdel') { const id = b.closest('[data-cp]').dataset.cp; return moOut(b.closest('li')).then(() => mvSave('Tasks', x => { x.checkpoints = (x.checkpoints || []).filter(c => c.id !== id); if (measureOf(x) === 'steps' && x.checkpoints.length && x.status !== 'complete') x.progress_percent = cpProgress(x); })); }
  if (k === 'kddel') { const id = b.dataset.id, f = (m.docs || []).find(x => x.id === id); return confirmDialog({ title: 'Remove this file?', message: `<b>${esc(f ? f.name : 'This file')}</b> will be removed from the milestone`, confirmLabel: 'Remove', danger: true, undo: false, onConfirm: () => moOut(b.closest('li')).then(() => { mvSave('Documents', x => { x.docs = (x.docs || []).filter(d => d.id !== id); }); if (f) mmFileRemoveBlob(f); }) }); }
  if (k === 'lkdel') { const u = b.dataset.url; return moOut(b.closest('li')).then(() => mvSave('Links', x => { x.links = (x.links || []).filter(l => safeUrl(l.url) !== u); })); }
  if (k === 'depdel') { const id = b.dataset.id; return moOut(b.closest('li')).then(() => mvSave('Dependencies', x => { x.blockedBy = (x.blockedBy || []).filter(d => d !== id); })); }
});
document.addEventListener('change', e => {
  if (!mvOn() || !$('#modalBody').contains(e.target) || !canEdit()) return;
  const t = e.target, row = t.closest('[data-cp]');
  if (row && t.classList.contains('mv-cp-done')) {
    const id = row.dataset.cp, on = t.checked;
    mvSave('Tasks', x => { const c = (x.checkpoints || []).find(y => y.id === id); if (!c) return; c.done = on; c.doneAt = on ? new Date().toISOString() : null; if (measureOf(x) === 'steps' && x.status !== 'complete') x.progress_percent = cpProgress(x); }, true);
    return;
  }
  if (row && (t.classList.contains('mv-cp-title') || t.classList.contains('mv-cp-due'))) {
    const id = row.dataset.cp, v = t.value.trim(), m = mvM(), due = t.classList.contains('mv-cp-due');
    if (!due && !v) { t.value = ((m.checkpoints || []).find(y => y.id === id) || {}).title || ''; return; }
    if (due && v && m.due_date && v > m.due_date) toast("That's after the milestone's due date", 'warn');
    return mvSave('Tasks', x => { const c = (x.checkpoints || []).find(y => y.id === id); if (c) c[due ? 'due' : 'title'] = due ? (v || null) : v; }, true);
  }
  if (t.id === 'mvPctR' || t.id === 'mvPctN') {
    const v = Math.max(0, Math.min(100, Math.round(+t.value || 0))), m = mvM(), was = +m.progress_percent || 0; if (v === was) return;
    mvSave('Progress', x => { x.progress_percent = v; if (v > 0 && x.status === 'not_started') x.status = 'on_track'; }, true);
    if (v === 100 && m.status !== 'complete') setTimeout(() => askToComplete(m, 'Progress reached 100%'), 100);
    return;
  }
  if (t.matches('[data-mv-depadd]') && t.value) { const id = t.value; return mvSave('Waiting on', x => { x.blockedBy = [...new Set([...(x.blockedBy || []), id])]; }); }
});
document.addEventListener('input', e => { if (!mvOn()) return; if (e.target.id === 'mvPctR') { const n = $('#mvPctN'); if (n) n.value = e.target.value; } });
document.addEventListener('click', e => {
  if (!mvOn() || !e.target.closest) return;
  const dm = e.target.closest('[data-depmode]'); if (dm && $('#modalBody').contains(dm)) { const v = dm.dataset.depmode; state.mvDepMode = state.mvDepMode === v ? '' : v; mvRender(); const f = $(v === 'link' ? '#mvDepQ' : '#mvDfName'); if (f) f.focus(); return; }
  const dd = e.target.closest('[data-dt-del]'); if (dd && canEdit()) { const id = dd.dataset.dtDel; return moOut(dd.closest('li')).then(() => mvSave('Dependencies', x => { x.depTasks = (x.depTasks || []).filter(k => k.id !== id); })); }
});
document.addEventListener('change', e => {
  const c = e.target.closest && e.target.closest('[data-dt-done]'); if (!c || !mvOn() || !canEdit()) return;
  const id = c.dataset.dtDone, on = c.checked; mvSave('Dependencies', x => { const k = (x.depTasks || []).find(z => z.id === id); if (k) { k.done = on; k.doneAt = on ? new Date().toISOString() : null; } }, true);
});
document.addEventListener('submit', e => {
  const f = e.target.closest && e.target.closest('[data-mvform]'); if (!f || !mvOn()) return; e.preventDefault(); if (!canEdit()) return;
  const k = f.dataset.mvform;
  if (k === 'dep') {
    const name = $('#mvDfName').value.trim(), team = $('#mvDfTeam').value, owner = $('#mvDfOwner').value.trim(), due = $('#mvDfDue').value || null, m = mvM();
    if (!name) return markInvalid($('#mvDfName'), 'Name it'); if (!team) return markInvalid($('#mvDfTeam'), 'Pick the team that owes it');
    state.mvDepMode = '';
    if (f.dataset.kind === 'task') {
      const tk = { id: uid(), title: name.slice(0, 200), team, owner, due, done: false, by: currentDisplayName() || '', at: new Date().toISOString() };
      mvSave('Dependencies', x => { (x.depTasks = x.depTasks || []).push(tk); }, true);
      const told = depNotifyTask(m, tk); return toast(`Added task dependency${told ? ` (${told} notified)` : ''}`, 'ok');
    }
    snapshotForUndo('New dependency milestone: ' + name.slice(0, 30));
    const nm = { id: uid(), state: m.state || '', market: m.market || '', team, functional_area: team, workstream: 'General', activity: name.slice(0, 300), schools: (m.schools || []).slice(), schoolIds: (m.schoolIds || []).slice(), targetFY: null, targetQuarter: '', openingFY: m.openingFY || null, due_date: due, status: 'not_started', stage: 'to_do', progress_percent: 0, priority: 'medium', owner, dependency: '', keyMilestone: false, greenlight: false, transition: false, notes: '', tags: [], createdAt: new Date().toISOString() };
    syncFiscal(nm); touch(nm); state.data.milestones.push(nm); logActivity('create', 'Created: ' + nm.activity, { itemId: nm.id });
    mvSave('Dependencies', x => { x.blockedBy = [...new Set([...(x.blockedBy || []), nm.id])]; }, true);
    const told = depNotifyMilestone(m, nm); return toast(`Created "${clip(name, 40)}" for ${team} and added it as a dependency${told ? ` (${told} notified)` : ''}`, 'ok');
  }
  if (k === 'task') {
    const inp = $('#mvTaskIn'), v = inp.value.trim(); if (!v) return markInvalid(inp, 'Name the task');
    mvSave('Tasks', x => { (x.checkpoints = x.checkpoints || []).push({ id: uid(), title: v.slice(0, 200), due: null, done: false, doneAt: null }); if (!x.measure) x.measure = 'steps'; if (measureOf(x) === 'steps' && x.status !== 'complete') x.progress_percent = cpProgress(x); }, true);
    const n = $('#mvTaskIn'); if (n) n.focus(); return;
  }
  if (k === 'link') {
    const u = $('#mvLkUrl'), raw = u.value.trim(); if (!raw) return markInvalid(u, 'Paste a link');
    const url = safeUrl(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); if (!url) return markInvalid(u, 'Paste a full link that starts with https://');
    if ((mvM().links || []).some(l => safeUrl(l.url) === url)) return markInvalid(u, 'That link is already here');
    const label = $('#mvLkName').value.trim();
    state.kdLink = false; mvSave('Links', x => { (x.links = x.links || []).push({ url, label }); }); return;
  }
  if (k === 'count') {
    const v = Math.max(0, Math.round(+$('#mvCount').value || 0));
    mvSave('Count', x => { const t = x.target; if (!t) return; if (+t.done !== v) { t.log = (t.log || []).slice(-50); t.log.push({ t: new Date().toISOString(), by: currentDisplayName() || '', done: v }); } t.done = v; if (x.status !== 'complete') x.progress_percent = tgProgress(t); });
  }
});
