/* ============================================================
   School Opening Timeline & Project Management
   3-tab tool per implementation spec.
   Vanilla JS · auto-save · optional Supabase live sync.
   ============================================================ */
'use strict';

const LS = { theme: 'ngc_theme', data: 'ngc_data', gh: 'ngc_gh', supabase: 'ngc_supabase', ui: 'ngc_ui', gate: 'ngc_gate' };
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
  filters: { states: new Set(), fys: new Set(), types: new Set(), areas: new Set(), markets: new Set(), statuses: new Set(), priorities: new Set(), openingFYs: new Set(), schoolId: '', search: '', timing: '' },
  sb: { connected: false, client: null },
  adminUnlocked: false,
  auth: { user: null, profile: null, wired: false },
};

/* ---------- palette (spec colors) ---------- */
const STATE_COLOR = { NJ: '#16357F', FL: '#0F766E' };
// KIPP brand palette: navy #16357F · sky #43B0E6 (reserved for status "on track") · green #4A8C1F · orange #F6A11C · red #E63E2F
// Market palette: distinct hues, deliberately non-overlapping with status colors
const MARKET_COLOR = { Paterson: '#6D28D9', 'Miami-Dade': '#BE185D', Broward: '#7C3F5C', Newark: '#0E7490', Orange: '#065F46', Orlando: '#065F46', Camden: '#B45309' };
const TYPE_COLOR = { ES: '#1B6EA5', MS: '#C77400', HS: '#5F3DC4' };
const mkColor = m => MARKET_COLOR[m] || '#5A6B8C';
const stColor = s => STATE_COLOR[s] || '#5A6B8C';
const PRIORITY = { high: { label: 'High', color: '#D62828' }, medium: { label: 'Medium', color: '#FFA500' }, low: { label: 'Low', color: '#6C757D' } };

/* ---------- utils ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const uid = () => Math.random().toString(36).slice(2, 12);
function fyLabel(fy) { return fy ? `${String(fy - 1).slice(-2)}–${String(fy).slice(-2)}` : '-'; }
function fyList() { return [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033]; }
function currentFY() { const n = new Date(); return n.getMonth() >= 6 ? n.getFullYear() + 1 : n.getFullYear(); }
function initials(n) { return String(n || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase(); }
// deterministic per-person avatar color (Asana/Jira-style), so each owner is visually distinct
const AVATAR_COLORS = ['#2563EB', '#7C3AED', '#059669', '#D97706', '#DB2777', '#0891B2', '#4F46E5', '#65A30D', '#DC2626', '#0D9488'];
function avatarColor(n) { const s = String(n || ''); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; }
// initials-only person chip: colored circle, full name on hover. `unassigned` = neutral dashed circle.
function personChip(name, cls) {
  if (!name) return `<span class="pchip pchip-none ${cls || ''}" title="Unassigned">–</span>`;
  return `<span class="pchip ${cls || ''}" title="${esc(name)}" style="background:${avatarColor(name)}">${esc(initials(name))}</span>`;
}
function fmtMoney(n) { return n >= 1e6 ? '$' + (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + n; }
function parseDate(s) { return s ? new Date(s + 'T00:00:00') : null; }
function daysUntil(s) { const d = parseDate(s); if (!d) return null; return Math.round((d - new Date(new Date().toDateString())) / 86400000); }
function fmtDate(s) { const d = parseDate(s); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-'; }
/* ---------- threaded notes (attach to a task or school; surface wherever it's opened) ---------- */
function fmtWhen(t) { try { return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
function noteItemHtml(nt) { return `<div class="note-item"><div class="note-meta"><b>${nt.by ? esc(nt.by) : 'Someone'}</b> · ${esc(fmtWhen(nt.t))}</div><div class="note-text">${esc(nt.text)}</div></div>`; }
function postNote(wrap) {
  if (!wrap) return;
  const kind = wrap.dataset.notekind, id = wrap.dataset.noteid;
  const inp = wrap.querySelector('#noteInput'), au = wrap.querySelector('#noteAuthor');
  const text = (inp.value || '').trim(); if (!text) { inp.focus(); return; }
  const by = (au.value || '').trim();
  const ent = kind === 'school' ? (state.data.schools || []).find(x => x.id === id) : findM(id);
  if (!ent) return;
  if (!Array.isArray(ent.noteLog)) ent.noteLog = [];
  const nt = { t: Date.now(), by, text };
  ent.noteLog.push(nt);
  if (by) lsSet('ngc_author', by);
  autosave();
  const thread = wrap.querySelector('.note-thread');
  const empty = thread.querySelector('.note-empty'); if (empty) empty.remove();
  thread.insertAdjacentHTML('beforeend', noteItemHtml(nt));
  inp.value = ''; inp.focus();
  thread.scrollTop = thread.scrollHeight;
}
function notesSection(kind, id, log) {
  const items = (log || []).slice().sort((a, b) => a.t - b.t).map(noteItemHtml).join('') || '<div class="note-empty muted">No notes yet - add the first update.</div>';
  return `<div class="notes-field" data-notekind="${kind}" data-noteid="${esc(id)}"><label class="notes-label">Notes &amp; updates</label>
    <div class="note-thread">${items}</div>
    <div class="note-add"><input id="noteAuthor" class="note-author" placeholder="Your name" value="${esc(lsGet('ngc_author') || '')}"><input id="noteInput" class="note-input" placeholder="Add a note or status update…"><button class="btn btn-filled btn-sm" id="noteAdd">Post</button></div></div>`;
}

/* ---------- status meta ---------- */
const SM = k => (state.data.meta.statusMeta[k] || { label: k, color: '#ccc', text: '#000' });
function statusPill(k) { const m = SM(k); return `<span class="stpill" style="background:${m.color}22;color:${m.color === '#E0E0E0' ? '#5A5A5A' : m.color}"><i style="background:${m.color}"></i>${esc(m.label)}</span>`; }
function statusDot(k) { return `<i class="stdot" style="background:${SM(k).color}"></i>`; }

/* ---------- timing (live, date-driven urgency) ---------- */
const SEV = { not_started: 0, on_track: 1, at_risk: 2, behind: 3, blocked: 4, complete: 9 };
function worseStatus(a, b) { return (SEV[a] || 0) >= (SEV[b] || 0) ? a : b; }
function timingLevel(m) {
  if (m.status === 'complete') return 'done';
  const d = daysUntil(m.due_date); if (d == null) return 'none';
  if (d < 0) return 'overdue';
  const due = parseDate(m.due_date), now = new Date();
  if (due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth()) return 'this_month';
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
  return s;
}
function dueBadge(m) {
  const t = timingLevel(m), d = daysUntil(m.due_date);
  if (t === 'overdue') return `<span class="due-badge overdue">Overdue ${Math.abs(d)}d</span>`;
  if (t === 'this_month') return `<span class="due-badge month">⏰ Due this month</span>`;
  if (t === 'soon') return `<span class="due-badge soon">In ${d}d</span>`;
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
  }
};
/* Normalize milestone shape on every load. This is idempotent and cheap.
   It resolves the schema debt (team vs functional_area, schools vs schoolIds,
   three booleans vs one type) without needing a versioned migration. Reads
   throughout the app assume the normalized shape. Writes still populate
   both fields on new items for backward compatibility. */
function normalizeData(data) {
  if (!data || !Array.isArray(data.milestones)) return data;
  data.milestones.forEach(m => {
    // Workstream: functional_area is the canonical read; sync team = functional_area.
    if (m.functional_area && !m.team) m.team = m.functional_area;
    else if (m.team && !m.functional_area) m.functional_area = m.team;
    // Schools: schoolIds is the source of truth; keep schools codes as a mirror.
    if (!Array.isArray(m.schoolIds)) m.schoolIds = [];
    if (!Array.isArray(m.schools)) m.schools = [];
    // Derived type enum from the historical boolean flags. Preserves flags for
    // any code path that still reads them; new UI can read m.type directly.
    if (!m.type) m.type = m.greenlight ? 'greenlight' : m.transition ? 'transition' : m.keyMilestone ? 'key' : 'task';
  });
  return data;
}

async function loadData() {
  let base;
  if (window.__EMBEDDED_DATA__) base = JSON.parse(JSON.stringify(window.__EMBEDDED_DATA__));
  else { try { base = await (await fetch('data.json', { cache: 'no-store' })).json(); } catch (e) { $('.container').innerHTML = '<div class="empty-state">Could not load <span class="mono">data.json</span>. Run a local server (see README).</div>'; return null; } }
  try {
    const s = JSON.parse(lsGet(LS.data) || 'null');
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
function autosaveWriteLocal() { try { const c = JSON.parse(JSON.stringify(state.data)); c.__baseVersion = state.data.meta && state.data.meta.version; lsSet(LS.data, JSON.stringify(c)); return true; } catch (e) { return false; } }
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
  if (f.markets.size && !f.markets.has(m.market)) return false;
  if (f.statuses.size && !f.statuses.has(effectiveStatus(m))) return false;
  if (f.priorities.size && !f.priorities.has(m.priority)) return false;
  if (f.timing && timingLevel(m) !== f.timing) return false;
  if (f.openingFYs.size && m.openingFY && !f.openingFYs.has(m.openingFY)) return false;
  if (f.schoolId) { const sc = state.data.schools.find(x => x.id === f.schoolId); if (!sc || !taskInSchool(m, sc)) return false; }
  if (f.search) { const q = f.search.toLowerCase(); if (!`${m.activity} ${m.workstream} ${m.functional_area} ${m.market} ${m.owner} ${(m.tags || []).join(' ')}`.toLowerCase().includes(q)) return false; }
  return true;
}
function filtered() { return M().filter(passFilters); }
function pct(list) { return list.length ? Math.round(100 * list.filter(m => m.status === 'complete').length / list.length) : 0; }
function progressAvg(list) { return list.length ? Math.round(list.reduce((a, m) => a + (m.progress_percent || 0), 0) / list.length) : 0; }

/* school rollup status (worst-of) for timeline/health */
function rollupStatus(list) {
  if (!list.length) return 'not_started';
  const eff = list.map(effectiveStatus);
  if (eff.every(s => s === 'complete')) return 'complete';
  if (eff.some(s => s === 'behind')) return 'behind';
  if (eff.some(s => s === 'at_risk')) return 'at_risk';
  if (eff.some(s => s === 'on_track')) return 'on_track';
  return 'not_started';
}

/* ---------- toggle a Set filter ---------- */
function toggleFilter(key, val, cast) {
  const set = state.filters[key]; val = cast ? cast(val) : val;
  if (set.has(val)) set.delete(val); else set.add(val);
  // cascade cleanup: drop downstream selections that no longer belong
  if (key === 'states') { const ok = new Set(marketsForStates()); [...state.filters.markets].forEach(mk => { if (!ok.has(mk)) state.filters.markets.delete(mk); }); }
  if (key === 'states' || key === 'markets') { const sc = state.filters.schoolId && schoolById(state.filters.schoolId); if (sc && !schoolFacetPass(sc, null)) state.filters.schoolId = ''; }
}
function clearFilters() { ['states', 'fys', 'types', 'areas', 'markets', 'statuses', 'priorities', 'openingFYs'].forEach(k => state.filters[k].clear()); state.filters.schoolId = ''; state.filters.search = ''; state.filters.timing = ''; const cb = $('#cbSearch'); if (cb) cb.value = ''; }
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
function chipRow(label, items) {
  return `<div class="chiprow"><span class="chiprow-label">${esc(label)}</span>${items}</div>`;
}
function fchip(key, val, label, color) {
  const on = state.filters[key].has(val);
  return `<button class="fchip ${on ? 'on' : ''}" data-fkey="${key}" data-fval="${esc(val)}" ${key === 'fys' ? 'data-num="1"' : ''}>${color ? `<i style="background:${color}"></i>` : ''}${esc(label)}</button>`;
}

/* ---------- unified filter bar (dropdown menus, live counts) ---------- */
const FILTER_LABEL = { states: 'State', types: 'Type', markets: 'Market', fys: 'Year', areas: 'Workstream', statuses: 'Status', priorities: 'Priority' };
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
  if (key === 'statuses') return meta().statuses.map(s => [s, SM(s).label, SM(s).color]);
  if (key === 'priorities') return ['high', 'medium', 'low'].map(p => [p, PRIORITY[p].label, PRIORITY[p].color]);
  return [];
}
function activeCount() { let n = 0; ['states', 'types', 'markets', 'fys', 'areas', 'statuses', 'priorities', 'openingFYs'].forEach(k => n += state.filters[k].size); if (state.filters.schoolId) n++; if (state.filters.search) n++; if (state.filters.timing) n++; return n; }
function filterBar(menus, opts = {}) {
  // #fSearch removed - #cbSearch in the header content-bar is the single, wired search across every view
  const search = '';
  const btns = menus.map(k => { const n = state.filters[k].size; return `<button class="fb-menu ${n ? 'on' : ''}" data-fmenu="${k}"><span>${FILTER_LABEL[k]}</span>${n ? `<span class="fb-count">${n}</span>` : ''}<svg class="fb-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button>`; }).join('');
  const school = opts.school ? `<select id="dashSchool" class="fb-select"><option value="">All schools</option>${state.data.schools.filter(s => s.openingFY && schoolFacetPass(s, null) && (!state.filters.fys.size || state.filters.fys.has(s.openingFY))).sort((a, b) => (a.openingFY - b.openingFY) || a.market.localeCompare(b.market)).map(s => `<option value="${s.id}" ${state.filters.schoolId === s.id ? 'selected' : ''}>${esc(s.market)} · ${esc(s.display_label)}</option>`).join('')}</select>` : '';
  return `<div class="filterbar" id="filterbar"><span class="fb-label">Filters</span>${search}${btns}${school}<button class="fb-clear ${activeCount() ? '' : 'is-empty'}" id="clearFilters"${activeCount() ? '' : ' disabled'}>Clear all</button><span class="fb-spacer"></span>${opts.right || ''}</div>`;
}
/* toggle chips to show / hide opening-year cohorts */
function openingYearBar() {
  const ys = openingYears(); if (ys.length <= 1) return '';
  const allOn = !state.filters.openingFYs.size;
  return `<div class="oybar"><span class="oy-label">Show openings</span>${ys.map(fy => `<button class="oychip ${oyShown(fy) ? 'on' : ''}" data-oyear="${fy}">Fall ${fy - 1}</button>`).join('')}<button class="oychip oy-all ${allOn ? 'on' : ''}" data-oyall="1">All</button></div>`;
}
function openFilterMenu(anchor, key) {
  const set = state.filters[key];
  const html = `<div class="pop-title">${FILTER_LABEL[key]}</div><div class="pop-list pop-checks">${filterOpts(key).map(([v, l, color]) => { const on = set.has(key === 'fys' ? Number(v) : v); return `<label class="pop-check"><input type="checkbox" data-fkey="${key}" data-fval="${esc(v)}" ${on ? 'checked' : ''}>${color ? `<i class="fdot" style="background:${color}"></i>` : ''}${esc(l)}</label>`; }).join('')}</div>`;
  const p = openPopover(anchor, html);
  p.addEventListener('change', e => {
    const cb = e.target.closest('[data-fkey]'); if (!cb) return;
    const k = cb.dataset.fkey;
    toggleFilter(k, cb.dataset.fval, k === 'fys' ? Number : null);
    // Dashboard renders the applied-filter chip row inside the filter bar, so every change needs a
    // rerender to refresh those chips (badges on the menu buttons alone aren't enough).
    const needsFullRerender = k === 'states' || k === 'markets' || k === 'fys' || state.view === 'progress';
    if (needsFullRerender) { rerender(); const btn = $(`.fb-menu[data-fmenu="${k}"]`); if (btn) openFilterMenu(btn, k); else closePopover(); }
    else { updateMenuBadge(k); refreshBody(); }
  });
}
function updateMenuBadge(key) {
  const btn = $(`.fb-menu[data-fmenu="${key}"]`);
  if (btn) { const n = state.filters[key].size; btn.classList.toggle('on', !!n); let c = btn.querySelector('.fb-count'); if (n) { if (!c) { c = document.createElement('span'); c.className = 'fb-count'; btn.insertBefore(c, btn.querySelector('.fb-chev')); } c.textContent = n; } else if (c) c.remove(); }
  const cl = $('#clearFilters'); if (cl) cl.classList.toggle('hide', !activeCount());
}
function refreshBody() { const sec = $('#view-' + state.view); const b = sec ? sec.querySelector('#viewBody') : $('#viewBody'); if (!b) return rerender(); if (state.view === 'progress') b.innerHTML = progressBodyHtml(); else if (state.view === 'timeline') b.innerHTML = ganttBodyHtml(); else b.innerHTML = planBodyHtml(); if (typeof paintAvatars === 'function') requestAnimationFrame(() => paintAvatars(b)); if (typeof updateFilterBubble === 'function') updateFilterBubble(); }
function otCard(s) {
  const sm = schoolMs(s), r = ragReady(sm), n = sm.length;
  const done = sm.filter(m => effectiveStatus(m) === 'complete').length;
  const pct = n ? Math.round(100 * done / n) : 0;
  const mk = mkColor(s.market);
  const now = Date.now();
  const opens = s.opening_date ? parseDate(s.opening_date) : null;
  const mo = opens ? Math.max(0, Math.round((opens - now) / 2.63e9)) : null;
  // Group header already announces "Fall YYYY · N months out" - only surface a card-level date when unscheduled.
  const when = s.openingFY ? '' : 'Opening not scheduled';
  const statusLbl = n === 0 ? 'Not yet scoped' : r.label.split(' · ')[0];   // "On track" / "At risk" / "Behind" / "Complete" / "Not started"
  return `<article class="ot-card" data-drillschool="${esc(s.id)}" style="--mk:${mk}">
      <div class="ot-card-top">
        <span class="ot-mkt"><i style="background:${mk}"></i>${esc(s.market)}</span>
        <span class="ot-status" data-rag="${r.key}"><i style="background:${r.color}"></i>${esc(statusLbl)}</span>
      </div>
      <h4 class="ot-title">${esc(s.display_label)}</h4>
      ${when ? `<p class="ot-when">${esc(when)}</p>` : ''}
      ${n ? `<div class="ot-prog">
        <div class="ot-prog-bar"><span style="width:${pct}%;background:${r.color}"></span></div>
        <div class="ot-prog-lbl"><b>${done}/${n}</b> milestones cleared<span class="muted"> · ${pct}%</span></div>
      </div>` : `<div class="ot-prog"><div class="ot-prog-empty">No milestones yet</div></div>`}
    </article>`;
}
function ganttBodyHtml() {
  const list = ganttSchools();
  if (!list.length) return '<div class="empty-state">No openings match the filters.</div>';
  const now = Date.now();
  const terms = [...new Set(list.map(s => s.openingFY))].filter(Boolean).sort((a, b) => a - b);
  const body = terms.map(fy => {
    const cs = list.filter(s => s.openingFY === fy).sort((a, b) => a.state.localeCompare(b.state) || a.market.localeCompare(b.market) || a.display_label.localeCompare(b.display_label));
    const first = Math.min(...cs.map(s => +parseDate(s.opening_date)));
    const mo = Math.max(0, Math.round((first - now) / 2.63e9));
    const when = mo <= 0 ? 'opening now' : `${mo} month${mo === 1 ? '' : 's'} out`;
    return `<section class="ot-term">
      <div class="ot-rail"><span class="ot-node"></span></div>
      <div class="ot-term-body">
        <div class="ot-term-h"><h3>Fall ${fy - 1}</h3><span class="ot-when">${when} · ${cs.length} school${cs.length === 1 ? '' : 's'}</span></div>
        <div class="ot-grid">${cs.map(otCard).join('')}</div>
      </div>
    </section>`;
  }).join('');
  return `<div class="ot">${body}</div>
    <div class="ot-legend"><span><i class="rag" style="background:${RAG.none}"></i>Not started</span><span><i class="rag" style="background:${RAG.blue}"></i>In progress</span><span><i class="rag" style="background:${RAG.yellow}"></i>At risk</span><span><i class="rag" style="background:${RAG.red}"></i>Behind</span><span><i class="rag" style="background:${RAG.green}"></i>Cleared</span><span class="muted">· click a school to open its milestones</span></div>`;
}
function renderTimeline() {
  // No H2 - sidebar already indicates active page. Action button floats right.
  const el = $('#view-timeline'); if (el) el.innerHTML = `
    <div class="view-actions">
      <button class="btn btn-filled" id="addSchool"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>Add school opening</button>
    </div>
    ${filterBar(['states', 'markets', 'types'])}
    ${openingYearBar()}
    <div id="viewBody">${ganttBodyHtml()}</div>`;
}
// (Deleted: renderReports + reportsBodyHtml. The Reports tab was removed
//  months ago; the functions had no callers and referenced a #view-reports
//  element that no longer exists in index.html.)

/* ============================================================
   TAB 2 - PROGRESS MONITORING (collapsible)
   ============================================================ */
function isExp(k) { return !!state.expanded[k]; }
function chev(open) { return `<svg class="chev ${open ? 'open' : ''}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>`; }

function pmItem(m) {
  const open = isExp('it:' + m.id), es = effectiveStatus(m), pcol = SM(es).color;
  return `<div class="pm-item">
    <div class="pm-item-head" data-toggle="it:${m.id}">
      ${chev(open)}${statusDot(es)}
      <span class="pm-title">${m.keyMilestone ? '★ ' : ''}${esc(m.activity)}<span class="dept-chip">${esc(m.functional_area)}</span></span>
      ${personChip(m.owner, 'pchip-sm')}
      <span class="pm-due">${dueBadge(m) || (m.due_date ? `<span class="due-ok">${fmtDate(m.due_date)}</span>` : '<span class="muted">-</span>')}</span>
      <div class="pm-prog"><span style="width:${m.progress_percent || 0}%;background:${pcol}"></span></div>
      <span class="pm-pct">${m.progress_percent || 0}%</span>
    </div>
    <div class="pm-body ${open ? '' : 'hide'}">
      <div class="pm-meta"><b>Workstream:</b> ${esc(m.functional_area)} · <b>Market:</b> ${esc(m.market)} · <b>Detail:</b> ${esc(m.workstream)}</div>
      ${m.dependency ? `<div class="pm-meta"><b>Depends on:</b> ${esc(m.dependency)}</div>` : ''}
      ${m.notes ? `<div class="pm-meta">${esc(m.notes)}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:8px"><button class="btn btn-tonal btn-sm" data-expand="${m.id}">Edit</button><button class="btn btn-text btn-sm" data-goplan="${m.id}">Open in Project Plan →</button></div>
    </div>
  </div>`;
}
const URANK = { overdue: 0, this_month: 1, soon: 2, ok: 3, none: 4, done: 5 };
function bySortUrgency(a, b) { return (URANK[timingLevel(a)] - URANK[timingLevel(b)]) || ((a.targetFY || 9999) - (b.targetFY || 9999)); }
function subGroup(gk, name, color, list) {
  const open = isExp(gk), roll = rollupStatus(list);
  const sorted = list.slice().sort(bySortUrgency);
  return `<div class="pm-group">
    <div class="pm-group-head" data-toggle="${esc(gk)}">${chev(open)}<span class="pm-gtitle">${color ? `<i class="gdot" style="background:${color}"></i>` : ''}${esc(name)}</span><span class="pm-gcount">${list.length}</span>${statusDot(roll)}<div class="pm-gprog"><span style="width:${progressAvg(list)}%;background:${SM(roll).color}"></span></div></div>
    <div class="pm-group-body ${open ? '' : 'hide'}">${sorted.map(pmItem).join('')}</div>
  </div>`;
}
function section(sk, title, subs, hint) {
  const open = isExp(sk), total = subs.reduce((a, s) => a + s.list.length, 0);
  return `<div class="pm-section">
    <div class="pm-section-head" data-toggle="${esc(sk)}">${chev(open)}<h3>${esc(title)}</h3><span class="pm-scount">${total} items</span>${hint ? `<span class="muted pm-hint">${esc(hint)}</span>` : ''}</div>
    <div class="pm-section-body ${open ? '' : 'hide'}">${subs.filter(s => s.list.length).map(s => subGroup(s.key, s.name, s.color, s.list)).join('') || '<div class="placeholder-note">No items.</div>'}</div>
  </div>`;
}

/* ---- visualizations ---- */
const STATUS_ORDER = ['complete', 'on_track', 'at_risk', 'behind', 'blocked', 'not_started'];
function effCounts(list) { const c = {}; STATUS_ORDER.forEach(s => c[s] = 0); list.forEach(m => { const e = effectiveStatus(m); c[e] = (c[e] || 0) + 1; }); return c; }
function groupsByDim(dim, list) {
  const g = [];
  if (dim === 'team') teams().forEach(t => { const l = list.filter(m => m.functional_area === t); if (l.length) g.push({ name: t, val: t, list: l }); });
  else if (dim === 'market') markets().forEach(mk => { const l = list.filter(m => m.market === mk); if (l.length) g.push({ name: mk, val: mk, color: mkColor(mk), list: l }); });
  else if (dim === 'state') statesMeta().forEach(s => { const l = list.filter(m => m.state === s.code); if (l.length) g.push({ name: s.name, val: s.code, color: stColor(s.code), list: l }); });
  else if (dim === 'year') { const map = {}; list.forEach(m => { const k = m.targetFY || 'none'; (map[k] = map[k] || []).push(m); }); Object.keys(map).filter(k => k !== 'none').map(Number).sort((a, b) => a - b).forEach(fy => g.push({ name: 'FY ' + fyLabel(fy), val: fy, list: map[fy] })); if (map['none']) g.push({ name: 'No date', val: '', list: map['none'] }); }
  else if (dim === 'school') { state.data.schools.forEach(s => { const l = list.filter(m => taskInSchool(m, s)); if (l.length) g.push({ name: s.market + ' · ' + s.display_label, val: s.id, color: mkColor(s.market), list: l, school: s }); }); g.sort((a, b) => ((a.school && a.school.openingFY) || 9999) - ((b.school && b.school.openingFY) || 9999)); }
  return g;
}
function statusBar(list) { const c = effCounts(list), t = list.length || 1; return `<div class="sbar">${STATUS_ORDER.map(s => c[s] ? `<span style="width:${100 * c[s] / t}%;background:${SM(s).color}" title="${SM(s).label}: ${c[s]}"></span>` : '').join('')}</div>`; }
function barsHtml(dim, list) {
  const groups = groupsByDim(dim, list); if (!groups.length) return '<div class="placeholder-note">No data.</div>';
  return `<div class="pbars">` + groups.map(g => `<div class="pbar-row drill" data-drilldim="${dim}" data-drillval="${esc(g.val)}" title="Click to see these items">${g.color ? `<span class="pbar-name"><i class="rp-dot" style="background:${g.color}"></i>${esc(g.name)}</span>` : `<span class="pbar-name">${esc(g.name)}</span>`}${statusBar(g.list)}<span class="pbar-pct">${pct(g.list)}%</span><span class="pbar-n">${g.list.length}</span></div>`).join('') + `</div>`;
}
function donutSVG(list) {
  const c = effCounts(list), t = list.length || 1, r = 54, C = 2 * Math.PI * r; let acc = 0;
  const segs = STATUS_ORDER.filter(s => c[s]).map(s => { const frac = c[s] / t, dash = frac * C, seg = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${SM(s).color}" stroke-width="22" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-acc * C).toFixed(2)}" transform="rotate(-90 70 70)"/>`; acc += frac; return seg; }).join('');
  return `<div class="donut-wrap"><svg viewBox="0 0 140 140" width="150" height="150" class="donut">${segs}<text x="70" y="66" text-anchor="middle" font-size="28" font-weight="700" fill="var(--on-surface)">${pct(list)}%</text><text x="70" y="88" text-anchor="middle" font-size="11" fill="var(--on-surface-variant)">complete</text></svg>
    <div class="donut-legend">${STATUS_ORDER.map(s => `<span class="drill" data-drilldim="status" data-drillval="${s}" title="Click to filter to ${SM(s).label}"><i style="background:${SM(s).color}"></i>${SM(s).label} <b>${c[s]}</b></span>`).join('')}</div></div>`;
}
function columnChart(list) {
  const map = {}; list.forEach(m => { if (m.targetFY) (map[m.targetFY] = map[m.targetFY] || []).push(m); });
  const fys = Object.keys(map).map(Number).sort((a, b) => a - b); if (!fys.length) return '<div class="placeholder-note">No dated items.</div>';
  const max = Math.max(...fys.map(fy => map[fy].length), 1);
  const yrLbl = fy => fy ? `${fy - 1}–${String(fy).slice(2)}` : '-';   // school year, e.g. 2027–28 (no "FY" jargon)
  return `<div class="colchart">` + fys.map(fy => { const l = map[fy], c = effCounts(l); return `<div class="col drill" data-drilldim="year" data-drillval="${fy}" title="Click to see ${yrLbl(fy)} school-year items"><div class="col-n">${l.length}</div><div class="col-bar" style="height:${Math.max(6, 100 * l.length / max)}%">${STATUS_ORDER.filter(s => c[s]).map(s => `<span style="height:${100 * c[s] / l.length}%;background:${SM(s).color}" title="${SM(s).label}: ${c[s]}"></span>`).join('')}</div><div class="col-lbl">${yrLbl(fy)}</div></div>`; }).join('') + `</div>`;
}
function chartsHtml(list) {
  const dims = [['team', 'Workstream'], ['year', 'Year'], ['school', 'School opening'], ['market', 'Market'], ['state', 'State']];
  const dimSeg = dims.map(([v, l]) => `<button class="seg ${state.progressDim === v ? 'on' : ''}" data-progressdim="${v}"><span>${l}</span></button>`).join('');
  return `
    <div class="chart-grid">
      <div class="card"><div class="chart-head"><h3>Status overview</h3></div>${donutSVG(list)}</div>
      <div class="card"><div class="chart-head"><h3>Milestones due by fiscal year</h3><span class="muted" style="font-size:12px">bars colored by live status</span></div>${columnChart(list)}</div>
    </div>
    <div class="card" style="margin-top:16px"><div class="chart-head"><h3>Progress by</h3><div class="segmented">${dimSeg}</div><span class="tb-spacer"></span><span class="muted" style="font-size:12px">bar = status mix · % = complete</span></div>${barsHtml(state.progressDim, list)}</div>`;
}

function progressBodyHtml() {
  return dashboardHtml(filtered());   // Dashboard is the only status view; drill-downs jump to the Project Plan
}
function progressBodyHtml_legacyList() {
  const list = filtered();
  const byArea = teams().map(t => ({ key: 'a:' + t, name: t, list: list.filter(m => m.functional_area === t) }));
  const njMk = statesMeta().find(s => s.code === 'NJ').markets, flMk = statesMeta().find(s => s.code === 'FL').markets;
  const byNJ = njMk.map(mk => ({ key: 'nj:' + mk, name: mk, color: mkColor(mk), list: list.filter(m => m.market === mk) }));
  const byFL = flMk.map(mk => ({ key: 'fl:' + mk, name: mk, color: mkColor(mk), list: list.filter(m => m.market === mk) }));
  const prio = list.filter(m => m.keyMilestone || m.greenlight || m.transition).slice().sort(bySortUrgency);
  state._pmKeys = ['sec:prio', 'prio:all', 'sec:area', ...byArea.map(s => s.key), 'sec:nj', ...byNJ.map(s => s.key), 'sec:fl', ...byFL.map(s => s.key)];
  const overdue = list.filter(m => timingLevel(m) === 'overdue').length, month = list.filter(m => timingLevel(m) === 'this_month').length;
  const kpis = `<div class="kpi-grid" style="margin-bottom:16px">
      <div class="kpi tone-b drill" data-drilldim="all" data-drillval="" title="See all shown items as a list"><div class="kpi-value">${list.length}</div><div class="kpi-label">Milestones shown</div><div class="kpi-foot">${M().length} total in plan</div></div>
      <div class="kpi tone-g drill" data-drilldim="status" data-drillval="complete" title="See completed items"><div class="kpi-value">${pct(list)}%</div><div class="kpi-label">Complete</div><div class="kpi-foot">${list.filter(m => m.status === 'complete').length} done</div></div>
      <div class="kpi ${overdue ? 'tone-r' : 'tone-g'} drill" data-drilldim="timing" data-drillval="overdue" title="See overdue items"><div class="kpi-value">${overdue}</div><div class="kpi-label">Overdue</div><div class="kpi-foot">${month} due this month</div></div>
      <div class="kpi tone-y drill" data-drilldim="riskbehind" data-drillval="" title="See at-risk & behind items"><div class="kpi-value">${list.filter(m => ['behind', 'at_risk'].includes(effectiveStatus(m))).length}</div><div class="kpi-label">At risk / behind</div><div class="kpi-foot">need attention</div></div>
    </div>`;
  if (state.progressView === 'charts') return dashboardHtml(list);
  // Filtered/drilled → show a flat results list so the matches are immediately visible.
  if (activeCount() > 0) {
    const items = list.slice().sort(bySortUrgency);
    return kpis + `<div class="card"><div class="chart-head"><h3>${items.length} matching item${items.length === 1 ? '' : 's'}</h3><span class="tb-spacer"></span><button class="btn btn-text btn-sm" id="clearFilters2">Clear filters</button></div>
      <div class="pm-items">${items.map(pmItem).join('') || '<div class="empty-state">No items match these filters.</div>'}</div></div>`;
  }
  return kpis + `<div class="pm-urgency"><span class="muted" style="font-size:12.5px">Click any section to expand · click a callout above to drill in</span><span class="tb-spacer"></span><button class="btn btn-text btn-sm" id="pmExpandAll">Expand all</button><button class="btn btn-text btn-sm" id="pmCollapseAll">Collapse all</button></div>
    ${section('sec:prio', 'Key Milestones & Greenlights', [{ key: 'prio:all', name: 'Flagged milestones, greenlights & transitions', list: prio }], 'The decisions and gateways that unlock each opening')}
    ${section('sec:area', 'By Workstream', byArea)}
    ${section('sec:nj', 'By Market (New Jersey)', byNJ)}
    ${section('sec:fl', 'By Market (Florida)', byFL)}`;
}
function renderProgress() {
  const printBtn = `<button class="btn btn-tonal" id="dashPrint"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/></svg>Print / PDF</button>`;
  // Filter bar is always visible on the dashboard: it's a primary scoping control, not an occasional detour.
  // Menus kept to what changes the STATUS picture: State, Market, Workstream. Opening year lives on the cohort strip;
  // status/priority filters belong to the Project Plan (the dashboard IS the status/priority view).
  $('#view-progress').innerHTML = `
    <div class="view-actions">${printBtn}</div>
    <div class="dash-filters" id="dashFilters">${filterBar(['states', 'markets', 'areas'], { right: appliedFilterChips() })}</div>
    <div id="viewBody">${progressBodyHtml()}</div>`;
}
/* Applied-filter chips: shown inline in the filter bar so the current scope is visible at a glance
   and individually removable (no "open the panel to see what's on" hunt). */
function appliedFilterChips() {
  const f = state.filters, chips = [];
  const push = (label, onRemove) => chips.push(`<button class="af-chip" data-afclear="${onRemove}" title="Remove filter"><span>${esc(label)}</span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`);
  f.states.forEach(v => push('State: ' + v, 'states:' + v));
  f.markets.forEach(v => push(v, 'markets:' + v));
  f.areas.forEach(v => push(v, 'areas:' + v));
  f.openingFYs.forEach(v => push('Fall ' + (v - 1), 'openingFYs:' + v));
  f.statuses.forEach(v => push(SM(v).label, 'statuses:' + v));
  if (f.timing) push(f.timing === 'overdue' ? 'Overdue' : f.timing === 'this_month' ? 'Due this month' : 'Due soon', 'timing:');
  if (f.search) push('“' + f.search.slice(0, 24) + (f.search.length > 24 ? '…' : '') + '”', 'search:');
  if (f.schoolId) { const sc = schoolById(f.schoolId); if (sc) push(sc.market + ' · ' + sc.display_label, 'schoolId:'); }
  if (!chips.length) return '';
  return `<div class="af-chips">${chips.join('')}</div>`;
}
function removeAppliedFilter(spec) {
  const [key, val] = spec.split(':');
  const f = state.filters;
  if (key === 'timing') f.timing = '';
  else if (key === 'search') { f.search = ''; const cb = $('#cbSearch'); if (cb) cb.value = ''; }
  else if (key === 'schoolId') f.schoolId = '';
  else if (f[key] instanceof Set) {
    if (key === 'openingFYs' || key === 'fys') f[key].delete(Number(val));
    else f[key].delete(val);
    if (key === 'states') { const ok = new Set(marketsForStates()); [...f.markets].forEach(mk => { if (!ok.has(mk)) f.markets.delete(mk); }); }
  }
}

/* ============================================================
   TAB 3 - PROJECT PLAN (Kanban)
   ============================================================ */
function planCard(m) {
  const es = effectiveStatus(m), t = timingLevel(m), scol = SM(es).color;
  const urgent = t === 'overdue' || t === 'this_month';
  const nc = (m.noteLog || []).length;
  const mk = m.market ? mkColor(m.market) : '';
  // Information order (top → bottom): TITLE (what) · CONTEXT market+workstream (where) · META
  //   due date + priority (when/how important) · PROGRESS · OWNER (who). Never lead with a date.
  const ctx = (m.market || m.functional_area) ? `<div class="kc-ctx">${m.market ? `<span class="kc-mkdot" style="background:${mk}"></span><span class="kc-mk">${esc(m.market)}</span>` : ''}${m.functional_area ? `<span class="kc-team">${esc(m.functional_area)}</span>` : ''}</div>` : '';
  const due = dueBadge(m) || (m.due_date ? `<span class="kc-due"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${fmtDate(m.due_date)}</span>` : '');
  const flag = m.priority === 'high' ? '<span class="kc-flag kc-flag-high" title="High priority">⚑</span>'
    : m.priority === 'low' ? '<span class="kc-flag kc-flag-low" title="Low priority">⚑</span>' : '';
  const metaRow = (due || flag) ? `<div class="kc-metarow">${due || '<span></span>'}${flag}</div>` : '';
  const pct = Math.max(0, Math.min(100, m.progress_percent || 0));
  const prog = `<div class="kc-prog"><div class="kc-prog-top"><span>Progress</span><b>${pct}%</b></div><div class="kc-prog-bar"><span style="width:${pct}%;background:${scol}"></span></div></div>`;
  const notes = nc ? `<span class="kc-notes" title="${nc} note${nc === 1 ? '' : 's'}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${nc}</span>` : '';
  return `<div class="kcard kcard-v2 ${urgent ? 'urgent' : ''}" draggable="true" data-id="${m.id}" style="border-left-color:${scol}">
    <div class="kc-title" data-expand="${m.id}">${esc(m.activity)}</div>
    ${ctx}
    ${metaRow}
    ${prog}
    <div class="kc-foot">${personChip(m.owner)}<span class="kc-foot-r">${notes}</span></div>
  </div>`;
}
function planFocusHtml() {
  const list = filtered().filter(m => ['overdue', 'this_month'].includes(timingLevel(m)) || ['behind', 'at_risk'].includes(effectiveStatus(m)));
  if (!list.length) return '<div class="empty-state">Nothing needs attention right now - no overdue, due-soon, or off-track milestones in this filter.</div>';
  const rank = m => timingLevel(m) === 'overdue' ? 0 : effectiveStatus(m) === 'behind' ? 1 : timingLevel(m) === 'this_month' ? 2 : 3;
  list.sort((a, b) => rank(a) - rank(b) || (parseDate(a.due_date) || 9e15) - (parseDate(b.due_date) || 9e15));
  return `<div class="plan-focus-note">${list.length} task${list.length === 1 ? '' : 's'} overdue, due this month, or off-track - sorted by urgency.</div><div class="plan-cards">${list.map(planCard).join('')}</div>`;
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
    if (gb === 'market') return m.market;
    if (gb === 'year') { order['FY ' + fyLabel(m.targetFY)] = m.targetFY || 9999; return m.targetFY ? 'FY ' + fyLabel(m.targetFY) : 'No date'; }
    if (gb === 'school') { const s = state.data.schools.find(x => taskInSchool(m, x)); return s ? s.market + ' · ' + s.display_label : 'Not tied to a school'; }
    return m.functional_area;
  };
  list.forEach(m => { const k = keyOf(m) || '-'; (g[k] = g[k] || []).push(m); });
  const keys = Object.keys(g).sort((a, b) => gb === 'year' ? (order[a] || 9999) - (order[b] || 9999) : a.localeCompare(b));
  if (!keys.length) return '<div class="empty-state">No milestones match the filters.</div>';
  state._planKeys = keys.map(k => 'pg:' + k);
  // groups default COLLAPSED so the page opens as a scannable outline, not 132 cards
  return keys.map(k => {
    const ck = 'pg:' + k, open = !!state.expanded[ck];
    const risk = g[k].filter(m => ['overdue', 'this_month'].includes(timingLevel(m)) || ['behind', 'at_risk'].includes(effectiveStatus(m))).length;
    const flag = risk ? `<span class="pm-gflag" title="${risk} need attention">${risk}</span>` : '';
    return `<div class="plan-group ${open ? '' : 'is-collapsed'}"><div class="plan-group-head" data-toggle="${esc(ck)}">${chev(open)}<span class="pg-name">${esc(k)}</span>${flag}<span class="pm-gcount">${g[k].length}</span></div><div class="plan-cards ${open ? '' : 'hide'}">${g[k].map(planCard).join('')}</div></div>`;
  }).join('');
}
function planBodyHtml() {
  if (state.planFocus) return planFocusHtml();
  return state.planGroup === 'stage' ? planKanbanHtml() : planListHtml();
}
function renderPlan() {
  const list = filtered();
  const focusN = list.filter(m => ['overdue', 'this_month'].includes(timingLevel(m)) || ['behind', 'at_risk'].includes(effectiveStatus(m))).length;
  const focusBtn = `<button class="btn btn-focus ${state.planFocus ? 'on' : ''}" id="planFocus" title="Show only overdue, due-soon, and off-track milestones">Needs attention${focusN ? ` <span class="focus-n">${focusN}</span>` : ''}</button>`;
  const isBoard = state.planGroup === 'stage';
  const viewToggle = `<div class="plan-view-toggle"><button class="pvt ${!isBoard ? 'on' : ''}" data-planview="list" title="List view"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 14h4v-4H3v4zm0 5h4v-4H3v4zM3 9h4V5H3v4zm5 5h13v-4H8v4zm0 5h13v-4H8v4zM8 5v4h13V5H8z"/></svg></button><button class="pvt ${isBoard ? 'on' : ''}" data-planview="board" title="Board view"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 5v13h17V5H4zm4 11H6v-9h2v9zm4 0h-2v-9h2v9zm4 0h-2v-9h2v9zm3 0h-1v-9h1v9z"/></svg></button></div>`;
  const viewSel = isBoard ? '' : `<label class="tb-group ${state.planFocus ? 'is-dim' : ''}">Group by
    <select id="planGroupSel" ${state.planFocus ? 'disabled' : ''}>${[['team', 'Workstream'], ['school', 'School opening'], ['market', 'Market'], ['year', 'Year']].map(([v, l]) => `<option value="${v}" ${state.planGroup === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const expandBtns = (!state.planFocus && !isBoard) ? `<button class="btn btn-ghost btn-sm" id="planExpandAll">Expand all</button><button class="btn btn-ghost btn-sm" id="planCollapseAll">Collapse all</button>` : '';
  const right = `${viewToggle}${focusBtn}${viewSel}${expandBtns}<button class="btn btn-filled" id="newItem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>New milestone</button>`;
  // No H2 - all actions live in the filter bar's right slot.
  $('#view-plan').innerHTML = `
    ${filterBar(['states', 'markets', 'fys', 'areas'], { school: true, right })}
    <div id="viewBody">${planBodyHtml()}</div>`;
}

/* ============================================================
   EDIT ENGINE + cross-tab
   ============================================================ */
function rerender() { if (state.view === 'progress') renderProgress(); else if (state.view === 'timeline') renderTimeline(); else renderPlan(); requestAnimationFrame(() => paintAvatars()); if (typeof updateFilterBubble === 'function') updateFilterBubble(); }

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
function fmtMoney(n) { return n >= 1e6 ? '$' + (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + (n || 0); }
function ragDot(st, title) { const c = st === 'x' ? '#C9CDD6' : SM(st).color; return `<span class="rag" style="background:${c}" title="${esc(title || (st === 'x' ? 'no milestones' : SM(st).label))}"></span>`; }
/* consistent R/Y/G by milestone completion: <50% red · ≥50% yellow · all complete green */
/* greenlight/gating status per domain - deliberately distinct from market brand colors.
   grey = not started · blue = in progress · green = cleared (gate met) · amber/red = off-track */
// status palette drawn from the KIPP brand: green=complete, sky=on track, orange=at risk, red=behind
const RAG = { green: '#4A8C1F', blue: '#43B0E6', yellow: '#F6A11C', red: '#E63E2F', none: '#C7CCD6' };
function ragProgress(list) {
  if (!list.length) return { key: 'none', color: RAG.none, label: 'No milestones yet', pct: null };
  const done = list.filter(m => effectiveStatus(m) === 'complete').length, pctc = Math.round(100 * done / list.length);
  if (done === list.length) return { key: 'green', color: RAG.green, label: 'All complete', pct: 100 };
  if (done * 2 >= list.length) return { key: 'yellow', color: RAG.yellow, label: pctc + '% complete', pct: pctc };
  return { key: 'red', color: RAG.red, label: pctc + '% complete', pct: pctc };
}
function ragDotP(list, prefix) { const r = ragProgress(list); return `<span class="rag" style="background:${r.color}" title="${esc((prefix ? prefix + ' - ' : '') + r.label)}"></span>`; }
/* readiness = are we ON SCHEDULE (timing-aware), with % complete kept in the tooltip */
function ragReady(list) {
  if (!list.length) return { key: 'none', color: RAG.none, label: 'Not started' };
  const eff = list.map(effectiveStatus), done = eff.filter(s => s === 'complete').length, pctc = Math.round(100 * done / list.length);
  if (done === list.length) return { key: 'green', color: RAG.green, label: 'Complete' };
  if (eff.some(s => s === 'behind' || s === 'blocked')) return { key: 'red', color: RAG.red, label: 'Behind · ' + pctc + '% done' };
  if (eff.some(s => s === 'at_risk')) return { key: 'yellow', color: RAG.yellow, label: 'At risk · ' + pctc + '% done' };
  if (eff.some(s => s === 'on_track' || s === 'complete')) return { key: 'blue', color: RAG.blue, label: 'On track · ' + pctc + '% done' };
  return { key: 'none', color: RAG.none, label: 'Not started' };
}
function ragDotR(list, prefix) { const r = ragReady(list); return `<span class="rag" style="background:${r.color}" title="${esc((prefix ? prefix + ' - ' : '') + r.label)}"></span>`; }
function exLi(m, flag) { return `<div class="ex-li nodot" data-expand="${m.id}"><span class="ex-li-t">${flag || ''}${esc(m.activity)}</span><span class="ex-li-m muted">${esc(m.market)} · ${esc(m.functional_area)}</span><span class="ex-li-d muted">${m.due_date ? fmtDate(m.due_date) : ''}</span></div>`; }
// monthly trend snapshots (localStorage) → powers the KPI "vs last month" deltas
function captureTrend() {
  const ym = new Date().toISOString().slice(0, 7);
  let t = []; try { t = JSON.parse(lsGet('ngc_trends') || '[]'); } catch (e) {}
  if (t.length && t[t.length - 1].ym === ym) return;
  const schools = state.data.schools, rags = schools.map(s => ragReady(schoolMs(s))), cnt = k => rags.filter(r => r.key === k).length;
  const attention = cnt('red') + cnt('yellow'), onTrack = schools.length - attention, overdue = M().filter(m => timingLevel(m) === 'overdue').length;
  t.push({ ym, onTrack, attention, overdue }); if (t.length > 24) t = t.slice(-24);
  try { lsSet('ngc_trends', JSON.stringify(t)); } catch (e) {}
}
function trendPrev() { let t = []; try { t = JSON.parse(lsGet('ngc_trends') || '[]'); } catch (e) {} const ym = new Date().toISOString().slice(0, 7); return t.filter(x => x.ym < ym).slice(-1)[0] || null; }
// Segmented status bar (Lintel-style): the whole milestone mix in one glance
function statusPipeline(list) {
  const order = ['not_started', 'on_track', 'at_risk', 'behind', 'blocked', 'complete'];
  const c = {}; order.forEach(s => c[s] = 0);
  list.forEach(m => { const es = effectiveStatus(m); if (c[es] == null) c[es] = 0; c[es]++; });
  const seg = order.map(s => c[s] ? `<span class="pl-seg" style="flex:${c[s]};background:${SM(s).color}" title="${SM(s).label}: ${c[s]}"></span>` : '').join('') || '<span class="pl-seg" style="flex:1;background:var(--surface-container-high)"></span>';
  const legend = order.filter(s => c[s]).map(s => `<span class="pl-leg"><i style="background:${SM(s).color}"></i>${SM(s).label}<b>${c[s]}</b></span>`).join('');
  return `<section class="ex-card"><div class="ex-card-head"><div class="ex-cardhead-l"><h3>Milestone Status</h3></div><span class="muted ex-hint">${list.length} total</span></div>
    <div class="pl-legend">${legend || '<span class="muted">No milestones in view.</span>'}</div><div class="pl-bar">${seg}</div></section>`;
}
// NORTH STAR - the charter's stakeholder answer, rendered ABOVE the filters so a busy exec
// (often on a phone) sees "are we on track?" before any controls.
function northStarHtml() {
  const schools = schoolsInView();
  const total = schools.length;
  const rags = schools.map(s => ({ s, r: ragReady(schoolMs(s)) }));
  const cnt = k => rags.filter(x => x.r.key === k).length;
  const g = cnt('green'), b = cnt('blue'), y = cnt('yellow'), r = cnt('red'), none = cnt('none');
  const seg = (v, c) => v ? `<span style="flex:${v};background:${c}"></span>` : '';
  const attention = r + y;                 // behind or at risk = the only "off-track" states
  const onTrack = total - attention;       // everything not slipping counts as on track
  const inMotion = g + b;
  const nsBar = `<div class="ns-bar" title="${g} cleared · ${b} in progress · ${none} not yet started · ${y} at risk · ${r} behind">${seg(g, RAG.green)}${seg(b, RAG.blue)}${seg(none, RAG.none)}${seg(y, RAG.yellow)}${seg(r, RAG.red)}</div>`;
  return `<section class="north-star">
    <div class="ns-lead">
      <div class="ns-eyebrow">On track to open on schedule</div>
      <div class="ns-big"><b>${onTrack}</b><span>of ${total} schools</span></div>
    </div>
    <div class="ns-right">
      ${nsBar}
      <div class="ns-chips">
        ${attention ? `<button class="ns-chip att drill" data-drilldim="riskbehind" data-drillval="" title="See the tasks that need attention"><i></i>${attention} need attention</button>` : '<span class="ns-chip ok"><i></i>Nothing off-track</span>'}
        ${inMotion ? `<span class="ns-chip ok"><i></i>${inMotion} actively in prep</span>` : ''}
      </div>
    </div>
  </section>`;
}
/* ============================================================
   DASHBOARD building blocks (overview layout)
   ============================================================ */
const EH_IC = {
  table:    '<path d="M3 5h18M3 12h18M3 19h18"/>',
  warning:  '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  check:    '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  people:   '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  flag:     '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>'
};
function ehIc(k) { return `<svg class="eh-ic" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EH_IC[k] || ''}</svg>`; }
const RAG_SEV = { red: 4, yellow: 3, blue: 2, none: 1, green: 0 };
function ragTonePill(r) { return `<span class="rt-pill rt-${r.key}"><i></i>${esc(r.label.split(' · ')[0])}</span>`; }

/* ---- Progress monitoring by opening year (cohort) + by workstream ---- */
// The focused opening year = the single value in the openingFYs filter (null = all years).
// Focusing scopes the whole app (passFilters/schoolsInView/ganttSchools all honor openingFYs),
// so a drill from here into the Plan or Timeline stays on the same cohort.
function focusCohort() { return state.filters.openingFYs.size === 1 ? [...state.filters.openingFYs][0] : null; }
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
// High level: pre-opening milestone progress for each opening YEAR. Always shows every
// cohort (computed from all schools); the focused one is highlighted.
function cohortStrip() {
  const years = openingYears();
  if (!years.length) return '';
  const focus = focusCohort(), now = Date.now();
  const cards = years.map(fy => {
    const cs = state.data.schools.filter(s => s.openingFY === fy);
    const ms = cs.flatMap(schoolMs);
    const total = ms.length, done = ms.filter(m => effectiveStatus(m) === 'complete').length;
    const pctc = total ? Math.round(100 * done / total) : 0;
    const c = effCounts(ms), behind = (c.behind || 0) + (c.blocked || 0), atRisk = c.at_risk || 0;
    const firsts = cs.map(s => +parseDate(s.opening_date)).filter(n => !isNaN(n));
    const mo = firsts.length ? Math.max(0, Math.round((Math.min(...firsts) - now) / 2.63e9)) : null;
    const mkts = [...new Set(cs.map(s => s.market))];
    const health = behind ? `<span class="coh-c r">${behind} behind</span>` : atRisk ? `<span class="coh-c y">${atRisk} at risk</span>` : total ? `<span class="coh-c g">on track</span>` : `<span class="coh-c muted">not scoped</span>`;
    return `<button class="coh-card ${focus === fy ? 'is-focus' : ''}" data-cohort="${fy}" title="Focus Fall ${fy - 1} - scopes the dashboard, plan &amp; timeline">
      <div class="coh-top"><span class="coh-fy">Fall ${fy - 1}</span>${mo != null ? `<span class="coh-mo">${mo <= 0 ? 'opening' : mo + ' mo out'}</span>` : ''}</div>
      <div class="coh-meta">${cs.length} school${cs.length === 1 ? '' : 's'}${mkts.length ? ' · ' + esc(mkts.join(' · ')) : ''}</div>
      <div class="coh-pct">${total ? pctc + '%' : '—'}<span>pre-opening complete</span></div>
      <div class="coh-bar"><span style="width:${pctc}%"></span></div>
      <div class="coh-foot">${health}<span class="coh-c muted">${done}/${total} done</span></div>
    </button>`;
  }).join('');
  const right = focus ? '<button class="card-more" data-cohort="all">Show all years →</button>' : '<span class="muted ex-hint">Click a year to focus</span>';
  return `<section class="ex-card coh-wrap"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('flag')}<h3>Progress by opening year</h3></div>${right}</div><div class="coh-grid">${cards}</div></section>`;
}
// Progress broken down by workstream (functional area), scoped to the current focus.
function wsBreakdownRows(list) {
  const rows = teams().map(t => {
    const tl = list.filter(m => m.functional_area === t);
    if (!tl.length) return null;
    const done = tl.filter(m => effectiveStatus(m) === 'complete').length;
    return { t, n: tl.length, done, pctc: Math.round(100 * done / tl.length), r: ragReady(tl) };
  }).filter(Boolean).sort((a, b) => (RAG_SEV[b.r.key] || 0) - (RAG_SEV[a.r.key] || 0) || a.pctc - b.pctc);
  if (!rows.length) return '<div class="muted ex-empty">No milestones in scope.</div>';
  return `<div class="wb-list">${rows.map(x => `<button class="wb-row" data-drilldim="team" data-drillval="${esc(x.t)}" title="Open ${esc(x.t)} in the Project Plan">
      <span class="wb-name">${esc(x.t)}</span>
      <span class="wb-bar"><span style="width:${x.pctc}%;background:${x.r.color}"></span></span>
      <span class="wb-pct">${x.pctc}%</span>
      <span class="wb-n">${x.done}/${x.n}</span>
      ${ragTonePill(x.r)}
    </button>`).join('')}</div>`;
}
// Progress broken down by school opening, scoped to the current focus.
function schoolBreakdownRows(schools) {
  if (!schools.length) return '<div class="muted ex-empty">No openings in scope.</div>';
  const rows = schools.map(s => {
    const sm = schoolMs(s), r = ragReady(sm), n = sm.length;
    const done = sm.filter(m => effectiveStatus(m) === 'complete').length;
    return { s, r, n, pctc: n ? Math.round(100 * done / n) : 0, mk: mkColor(s.market), opens: s.openingFY ? 'Fall ' + (s.openingFY - 1) : '—', fy: s.openingFY || 9999, sev: RAG_SEV[r.key] || 0 };
  }).sort((a, b) => a.fy - b.fy || b.sev - a.sev || a.s.market.localeCompare(b.s.market));
  const body = rows.map(({ s, r, n, pctc, mk, opens }) => `<tr class="rt-row" data-drillschool="${esc(s.id)}" title="Open ${esc(s.display_label)}">
      <td class="rt-name"><span class="rt-dot" style="background:${mk}"></span><span class="rt-nm"><b>${esc(s.display_label)}</b><small>${esc(s.market)}</small></span></td>
      <td class="rt-st">${ragTonePill(r)}</td>
      <td class="rt-pc"><div class="rt-prog"><div class="rt-bar"><span style="width:${pctc}%;background:${r.color}"></span></div><span class="rt-pct">${n ? pctc + '%' : '—'}</span></div></td>
      <td class="rt-due">${esc(opens)}</td></tr>`).join('');
  return `<div class="rt-wrap"><table class="rt-table"><thead><tr><th>School opening</th><th>Status</th><th>Progress</th><th>Opens</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
// Breakdown card with a By workstream / By school toggle.
function breakdownCard(list, schools) {
  const dim = state.dashBreakdown === 'school' ? 'school' : 'workstream';
  const focus = focusCohort();
  const scope = focus ? `Fall ${focus - 1}` : 'all openings';
  const toggle = `<div class="segmented sm bd-toggle"><button class="seg ${dim === 'workstream' ? 'on' : ''}" data-dashbd="workstream">By workstream</button><button class="seg ${dim === 'school' ? 'on' : ''}" data-dashbd="school">By school</button></div>`;
  const body = dim === 'school' ? schoolBreakdownRows(schools) : wsBreakdownRows(list);
  return `<section class="ex-card bd-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('table')}<h3>Progress · ${esc(scope)}</h3></div>${toggle}</div>${body}</section>`;
}

// Needs attention - overdue / off-track / blocked, ranked by urgency (replaces the AI-insights slot)
function needsAttentionCard(list) {
  const items = list.filter(m => effectiveStatus(m) !== 'complete' && (['overdue', 'this_month'].includes(timingLevel(m)) || ['behind', 'at_risk', 'blocked'].includes(effectiveStatus(m))));
  const rank = m => timingLevel(m) === 'overdue' ? 0 : (effectiveStatus(m) === 'behind' || effectiveStatus(m) === 'blocked') ? 1 : timingLevel(m) === 'this_month' ? 2 : 3;
  items.sort((a, b) => rank(a) - rank(b) || (parseDate(a.due_date) || 9e15) - (parseDate(b.due_date) || 9e15));
  const reason = m => {
    const t = timingLevel(m), es = effectiveStatus(m), d = daysUntil(m.due_date);
    if (t === 'overdue') return { c: 'na-tag-r', t: d != null ? Math.abs(d) + 'd overdue' : 'Overdue' };
    if (es === 'blocked') return { c: 'na-tag-r', t: 'Blocked' };
    if (es === 'behind') return { c: 'na-tag-r', t: 'Behind' };
    if (es === 'at_risk') return { c: 'na-tag-y', t: 'At risk' };
    if (t === 'this_month') return { c: 'na-tag-y', t: d != null && d >= 0 ? 'Due in ' + d + 'd' : 'Due soon' };
    return { c: 'na-tag-y', t: 'Attention' };
  };
  const top = items.slice(0, 8);
  const rows = top.map(m => { const z = reason(m); return `<div class="na-item" data-expand="${m.id}"><div class="na-main"><span class="na-title">${esc(m.activity)}</span><span class="na-meta">${esc([m.market, m.functional_area].filter(Boolean).join(' · '))}</span></div><span class="na-tag ${z.c}">${esc(z.t)}</span></div>`; }).join('');
  const foot = items.length ? `<button class="na-more" data-showmore="focus">${items.length > top.length ? 'View all ' + items.length + ' →' : 'Open in Project Plan →'}</button>` : '';
  return `<section class="ex-card na-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('warning')}<h3>Needs attention</h3></div><span class="dash-count ${items.length ? 'bad' : ''}">${items.length}</span></div>
    <div class="na-body">${top.length ? rows : '<div class="muted ex-empty">Nothing overdue, off-track, or blocked right now.</div>'}</div>${foot}</section>`;
}

// My tasks (assigned to signed-in user) - falls back to upcoming key milestones when none/anonymous
function myTasksCard(list) {
  const name = currentDisplayName();
  const mine = name ? myOpenTasks(list, name) : [];
  if (mine.length) {
    mine.sort(bySortUrgency);
    const rows = mine.slice(0, 8).map(m => {
      const due = dueBadge(m) || (m.due_date ? `<span class="mt-due">${fmtDate(m.due_date)}</span>` : '');
      return `<div class="mt-item"><button class="mt-check" data-complete="${m.id}" title="Mark complete" aria-label="Mark complete"></button><div class="mt-main" data-expand="${m.id}"><span class="mt-title">${esc(m.activity)}</span><span class="mt-tags">${m.market ? `<span class="mt-tag">${esc(m.market)}</span>` : ''}${due}</span></div></div>`;
    }).join('');
    return `<section class="ex-card mt-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('check')}<h3>My tasks</h3></div><button class="card-more" data-drillmine="1">View all →</button></div><div class="mt-body">${rows}</div></section>`;
  }
  const soon = Date.now() + 90 * 864e5;
  const up = list.filter(m => (m.keyMilestone || m.greenlight || m.transition) && m.due_date && parseDate(m.due_date) <= soon && effectiveStatus(m) !== 'complete')
    .sort((a, b) => parseDate(a.due_date) - parseDate(b.due_date)).slice(0, 8);
  const rows = up.map(m => {
    const flag = m.greenlight ? '<span class="ex-flag ex-flag-green" title="Greenlight decision"></span>' : m.transition ? '<span class="ex-flag ex-flag-trans" title="Transition to Regional Ops"></span>' : '';
    const due = dueBadge(m) || (m.due_date ? `<span class="mt-due">${fmtDate(m.due_date)}</span>` : '');
    return `<div class="mt-item"><div class="mt-main" data-expand="${m.id}"><span class="mt-title">${flag}${esc(m.activity)}</span><span class="mt-tags">${m.market ? `<span class="mt-tag">${esc(m.market)}</span>` : ''}${due}</span></div></div>`;
  }).join('');
  return `<section class="ex-card mt-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('flag')}<h3>Upcoming milestones</h3></div><span class="muted ex-hint">Next 90 days</span></div><div class="mt-body">${up.length ? rows : '<div class="muted ex-empty">Nothing due in the next 90 days.</div>'}</div></section>`;
}

// Team activity - the recent change feed, inline on the dashboard
function teamActivityCard() {
  const log = activityEntries(8);
  const team = activityIsTeam();
  const rows = log.map(e => {
    const who = e.author || 'Someone';
    const exists = e.itemId && findM(e.itemId);
    const attr = exists ? ` data-openitem="${esc(e.itemId)}" title="Open milestone"` : '';
    return `<div class="ta-item${exists ? ' ta-click' : ''}"${attr}>${personChip(e.author || '')}<div class="ta-main"><span class="ta-what"><b>${esc(who)}</b> ${esc(e.detail)}</span><span class="ta-when">${esc(fmtWhen(e.ts))}</span></div></div>`;
  }).join('');
  const scope = team ? '<span class="ta-scope" title="Live from all signed-in members">Team-wide</span>' : '';
  const empty = team ? 'No changes logged yet. Team edits will appear here.' : 'No activity yet. Changes you make will appear here.';
  return `<section class="ex-card ta-card"><div class="ex-card-head"><div class="ex-cardhead-l">${ehIc('people')}<h3>Team activity</h3>${scope}</div><button class="card-more" data-activityall="1">View all →</button></div><div class="ta-body">${log.length ? rows : `<div class="muted ex-empty">${empty}</div>`}</div></section>`;
}

function dashboardHtml(list) {
  const schools = schoolsInView();
  const total = schools.length;
  const rags = schools.map(s => ({ s, r: ragReady(schoolMs(s)) }));
  const cnt = k => rags.filter(x => x.r.key === k).length;
  const g = cnt('green'), y = cnt('yellow'), r = cnt('red'), none = cnt('none');
  const tms = teams();
  const seg = (v, c) => v ? `<span style="flex:${v};background:${c}"></span>` : '';

  // HERO - how ready is each UPCOMING opening batch (by fiscal-year cohort)?
  const now = Date.now();
  const cohorts = [...new Set(schools.map(s => s.openingFY))].filter(Boolean).sort((a, b) => a - b).map(fy => {
    const cs = schools.filter(s => s.openingFY === fy);
    const ms = cs.flatMap(s => schoolMs(s));
    const done = ms.filter(m => effectiveStatus(m) === 'complete').length;
    const prep = ms.length ? Math.round(100 * done / ms.length) : 0;
    const mkts = [...new Set(cs.map(s => s.market))];
    const first = Math.min(...cs.map(s => +parseDate(s.opening_date)));
    const mo = Math.max(0, Math.round((first - now) / 2.63e9));
    return { fy, cs, ms, prep, mkts, mo };
  });
  const nextC = cohorts.find(c => c.mo >= 0) || cohorts[0];

  // KPI SUMMARY - restrained, clearly-labeled cards; each number tied to a click-through
  const b = cnt('blue'), attention = r + y, onTrack = total - attention;
  const overdue = list.filter(m => timingLevel(m) === 'overdue').length;
  // Material Symbols (Rounded, filled) - clean geometric shapes on a subtle tinted disc
  const KPI_IC = {
    school:  '<path d="M12 3 1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z"/>',
    warning: '<path d="M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z"/>',
    flag:    '<path d="M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z"/>',
    alarm:   '<path d="M22 5.72 17.4 1.86 16.11 3.39l4.6 3.86 1.29-1.53zM7.88 3.39 6.6 1.86 2 5.71 3.29 7.24zM12.5 8H11v6l4.75 2.85.75-1.23-4-2.37V8zM12 4a9 9 0 1 0 .01 18.01A9 9 0 0 0 12 4zm0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/>'
  };
  // month-over-month trend (portfolio-wide; only shown when no filters are applied)
  const unfiltered = !state.filters.states.size && !state.filters.markets.size && !state.filters.areas.size && !state.filters.statuses.size && !state.filters.openingFYs.size && !state.filters.schoolId && !state.filters.search && !state.filters.timing;
  const tp = unfiltered ? trendPrev() : null;
  const dChip = (cur, key, goodUp) => { if (!tp || typeof tp[key] !== 'number') return ''; const d = cur - tp[key]; if (!d) return ''; const up = d > 0; const good = up === goodUp; return `<span class="k-delta ${good ? 'good' : 'bad'}">${up ? '▲' : '▼'} ${Math.abs(d)}<span class="k-delta-lbl"> vs last month</span></span>`; };
  const kpi = (icon, num, den, lbl, sub, cls, drill, delta) => `<${drill ? 'button' : 'div'} class="kcard2 ${cls || ''} ${drill ? 'drill' : ''}" ${drill || ''}><span class="k-ic"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">${KPI_IC[icon]}</svg></span><div class="k-num">${num}${den ? `<span class="k-den">${den}</span>` : ''}</div><div class="k-lbl">${lbl}</div><div class="k-sub">${sub}</div>${delta || ''}</${drill ? 'button' : 'div'}>`;
  const kpiStrip = `<section class="kpi-strip">
    ${kpi('school', onTrack, `/ ${total}`, 'Schools on track', '', 'k-tone-ok', '', dChip(onTrack, 'onTrack', true))}
    ${kpi('warning', attention, '', 'Need attention', '', 'k-tone-warn' + (attention ? ' k-alert' : ''), attention ? 'data-drilldim="riskbehind" data-drillval=""' : '', dChip(attention, 'attention', false))}
    ${nextC ? kpi('flag', nextC.mo <= 0 ? 'Now' : nextC.mo, nextC.mo <= 0 ? '' : ' mo', 'Next opening', `Fall ${nextC.fy - 1} · ${esc(nextC.mkts.join(' · '))}`, 'k-tone-nav', `data-drilldim="year" data-drillval="${nextC.fy}"`) : ''}
    ${kpi('alarm', overdue, '', 'Milestones overdue', '', 'k-tone-err' + (overdue ? ' k-alert' : ''), overdue ? 'data-drilldim="timing" data-drillval="overdue"' : '', dChip(overdue, 'overdue', false))}
  </section>`;


  // GROWTH FUNDRAISING
  const camps = (state.data.campaigns || []).filter(c => !state.filters.states.size || state.filters.states.has(c.state));
  const fOpen = !state.expanded['dash:fund'];
  const capital = camps.length ? `<section class="ex-card" data-section="capital"><div class="ex-card-head toggle" data-toggle="dash:fund"><div class="ex-cardhead-l">${chev(fOpen)}<h3>Growth Fundraising</h3></div></div><div class="ex-card-body ${fOpen ? '' : 'hide'}"><div class="ex-caps">${camps.map(c => {
    const p = c.target ? Math.min(100, Math.round(100 * c.raised / c.target)) : 0;
    return `<div class="ex-cap"><div class="ex-cap-top"><b>${esc(c.name)}</b><span>${fmtMoney(c.raised)} <span class="muted">/ ${fmtMoney(c.target)}</span></span></div>
      <div class="ex-cap-bar"><span style="width:${p}%"></span></div><div class="ex-cap-foot muted">${p}% raised</div></div>`;
  }).join('')}</div></div></section>` : '';

  // WORKLOAD - pacing across fiscal years
  const wOpen = !state.expanded['dash:workload'];
  const statusLegend = `<div class="pl-legend pl-legend-sm">${STATUS_ORDER.filter(s => list.some(m => effectiveStatus(m) === s)).map(s => `<span class="pl-leg"><i style="background:${SM(s).color}"></i>${SM(s).label}</span>`).join('')}</div>`;
  const workload = `<section class="ex-card" data-section="workload"><div class="ex-card-head toggle" data-toggle="dash:workload"><div class="ex-cardhead-l">${chev(wOpen)}<h3>Milestone Workload by Year</h3></div></div><div class="ex-card-body ${wOpen ? '' : 'hide'}">${statusLegend}${columnChart(list)}</div></section>`;

  // Info hierarchy (overview layout, for Chiefs/Board) - two dense columns so the
  // cards fill their space instead of leaving voids:
  //   LEFT  (wide): Opening-readiness table · Milestone status · Growth fundraising
  //   RIGHT (rail): Needs attention · My tasks · Team activity
  //   FULL width:   Milestone workload by year
  const leftCol = `<div class="dash-col dash-col-main">${breakdownCard(list, schools)}${statusPipeline(list)}${capital}${workload}</div>`;
  const rightCol = `<div class="dash-col dash-col-rail">${needsAttentionCard(list)}${myTasksCard(list)}${teamActivityCard()}</div>`;
  return `<div class="dash dash-v2">
    ${greetBanner(list)}
    ${kpiStrip}
    ${cohortStrip()}
    <div class="dash-main">${leftCol}${rightCol}</div>
  </div>`;
}

/* The full greeting moved to the top content bar (updateGreeting).
   Here we render just the personal shortcut pill (only when the signed-in
   user has open tasks assigned to them). Empty otherwise. */
function greetBanner(list) {
  const name = currentDisplayName();
  const myCount = name ? myOpenTasks(list, name).length : 0;
  if (!myCount) return '';
  return `<div class="dash-mypill"><button class="db-pill" data-drillmine="1"><span class="db-pill-n">${myCount}</span>${myCount === 1 ? ' task assigned to you' : ' tasks assigned to you'}<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button></div>`;
}

/* Tasks assigned to the current user. Exact owner match, then last-name fallback
   so "Aden Avery" catches "A. Avery". Used by banner pill and drill handler. */
function myOpenTasks(list, name) {
  const n = (name || '').toLowerCase().trim(); if (!n) return [];
  const ln = n.split(/\s+/).pop();
  return list.filter(m => {
    if (effectiveStatus(m) === 'complete') return false;
    const o = (m.owner || '').toLowerCase().trim(); if (!o) return false;
    if (o === n) return true;
    return ln && ln.length > 2 && o.includes(ln);
  });
}
function applyDrill(dim, val) {
  if (dim === 'team') state.filters.areas = new Set([val]);
  else if (dim === 'market') state.filters.markets = new Set([val]);
  else if (dim === 'state') state.filters.states = new Set([val]);
  else if (dim === 'year') state.filters.fys = new Set([Number(val)]);
  else if (dim === 'school') state.filters.schoolId = val;
  else if (dim === 'status') { state.filters.statuses = new Set([val]); state.filters.timing = ''; }
  else if (dim === 'timing') { state.filters.timing = val; state.filters.statuses.clear(); }
  else if (dim === 'riskbehind') { state.filters.statuses = new Set(['at_risk', 'behind']); state.filters.timing = ''; }
  else if (dim === 'all') { /* just show the detailed list */ }
  setView('plan'); window.scrollTo({ top: 0, behavior: 'smooth' });   // dashboard = status; drilling opens the Project Plan, filtered
}
function refreshResults() { refreshBody(); }

function addItem(stage) {
  snapshotForUndo('Create new milestone');
  const st = stage || 'to_do', done = st === 'complete';
  const m = { id: uid(), state: 'NJ', market: 'Paterson', team: teams()[0], functional_area: teams()[0], workstream: 'General', activity: 'New milestone', schools: [], schoolIds: [], targetFY: currentFY(), targetQuarter: '', openingFY: null, due_date: null, status: done ? 'complete' : 'not_started', stage: st, progress_percent: done ? 100 : 0, priority: 'medium', owner: '', dependency: '', keyMilestone: false, greenlight: false, transition: false, notes: '', tags: [] };
  M().push(m); autosave(); logActivity('create', 'Created new milestone', { itemId: m.id }); openModal(m.id);
}

/* popovers */
function closePopover() { const p = $('#popover'); if (p) p.remove(); document.removeEventListener('mousedown', outsidePop, true); }
function outsidePop(e) { if (!e.target.closest('#popover')) closePopover(); }
function openPopover(anchor, html) {
  closePopover();
  const p = document.createElement('div'); p.className = 'popover'; p.id = 'popover'; p.innerHTML = html; document.body.appendChild(p);
  const r = anchor.getBoundingClientRect();
  p.style.top = (window.scrollY + r.bottom + 6) + 'px';
  p.style.left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - p.offsetWidth - 12)) + 'px';
  setTimeout(() => document.addEventListener('mousedown', outsidePop, true), 0);
  return p;
}

/* detail modal */
let modalId = null, modalMode = 'task', schoolId = null;
function openModal(id) {
  modalMode = 'task'; modalId = id; modalDirty = false; const m = findM(id); if (!m) return;
  $('#modalTitle').textContent = 'Milestone details';
  const opt = (arr, val) => arr.map(x => Array.isArray(x) ? `<option value="${x[0]}" ${x[0] === val ? 'selected' : ''}>${esc(x[1])}</option>` : `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const schoolChecks = state.data.schools.filter(s => s.market === m.market).map(s => `<label class="field-check"><input type="checkbox" class="m-school" value="${esc(s.id)}" ${(m.schoolIds || []).includes(s.id) ? 'checked' : ''}> ${esc(s.display_label)} <span class="muted">${esc(fyLabel(s.openingFY))}</span></label>`).join('') || '<span class="muted">No schools in this market.</span>';
  const linked = (m.schoolIds || []).map(id => schoolById(id)).filter(Boolean);
  const schoolLinks = linked.length ? `<div class="sm-school-links">Linked schools: ${linked.map(s => `<button class="sm-school-link" data-openschool="${esc(s.id)}" title="Open ${esc(s.display_label)}">${esc(s.market)} · ${esc(s.display_label)} →</button>`).join('')}</div>` : '';
  $('#modalBody').innerHTML = `
    <div class="field"><label>Milestone</label><textarea id="mAct">${esc(m.activity)}</textarea></div>
    <div class="field-row"><div class="field"><label>Owner</label><input id="mOwner" list="ownerRoster" value="${esc(m.owner)}" placeholder="Pick from the team or type a name"><datalist id="ownerRoster">${(meta().owners || []).map(o => `<option value="${esc(o.name)}">${esc(o.role || '')}</option>`).join('')}</datalist></div><div class="field"><label>Due date</label><input id="mDue" type="date" value="${esc(m.due_date || '')}"></div></div>
    <div class="field"><label>Status</label><select id="mStatus">${opt(meta().statuses.map(s => [s, SM(s).label]), m.status)}</select>
      <div class="help-text">Overdue or due-this-month milestones flag automatically, even if marked "On track."</div></div>
    <div class="field-row"><div class="field"><label>Market / location</label><select id="mMarket">${opt(markets(), m.market)}</select></div><div class="field"><label>Workstream</label><select id="mTeam">${opt(teams(), m.functional_area)}</select></div></div>
    <div class="field"><label>School(s) this belongs to</label>${schoolLinks}<div id="mSchools" class="check-box">${schoolChecks}</div></div>
    <div class="field"><label>Notes / next steps</label><textarea id="mNotes">${esc(m.notes)}</textarea></div>
    <details class="sm-details"><summary>More options</summary>
      <div class="field"><label>Detail / sub-workstream</label><input id="mWs" value="${esc(m.workstream)}"></div>
      <div class="field-row"><div class="field"><label>Priority</label><select id="mPri">${opt([['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], m.priority)}</select></div><div class="field"><label>Progress %</label><input id="mProg" type="number" min="0" max="100" value="${m.progress_percent || 0}"></div></div>
      <div class="field-row"><div class="field"><label>Target fiscal year</label><select id="mFy"><option value="">-</option>${fyList().map(fy => `<option value="${fy}" ${m.targetFY === fy ? 'selected' : ''}>${fyLabel(fy)}</option>`).join('')}</select></div><div class="field"><label>Quarter</label><select id="mQ">${opt(['', 'Q1', 'Q2', 'Q3', 'Q4'], m.targetQuarter)}</select></div></div>
      <div class="field"><label>Stage (Kanban)</label><select id="mStage">${opt(meta().stages, m.stage || 'to_do')}</select></div>
      <div class="field"><label>Dependency / blockers</label><input id="mDep" value="${esc(m.dependency)}"></div>
      <div class="field-row"><label class="field-check"><input type="checkbox" id="mKey" ${m.keyMilestone ? 'checked' : ''}> Key milestone</label><label class="field-check"><input type="checkbox" id="mTrans" ${m.transition ? 'checked' : ''}> Transition to Regional Ops</label></div>
    </details>
    ${notesSection('task', m.id, m.noteLog)}`;
  $('#modalBackdrop').classList.add('open');
}
function saveModal() {
  if (modalMode === 'school') return saveSchool();
  const m = findM(modalId); if (!m) return;
  snapshotForUndo('Edit milestone: ' + (m.activity || '').slice(0, 40));
  m.activity = $('#mAct').value.trim() || m.activity; m.market = $('#mMarket').value; m.state = stateOfMarket(m.market) || m.state;
  m.team = $('#mTeam').value; m.functional_area = m.team; m.workstream = $('#mWs').value.trim() || 'General';
  m.schoolIds = $$('#mSchools .m-school').filter(x => x.checked).map(x => x.value);
  m.schools = m.schoolIds.map(id => { const sc = schoolById(id); return sc ? sc.code : null; }).filter(Boolean);
  m.targetFY = $('#mFy').value ? +$('#mFy').value : null; m.targetQuarter = $('#mQ').value;
  m.status = $('#mStatus').value; m.stage = $('#mStage').value; m.priority = $('#mPri').value;
  m.progress_percent = Math.max(0, Math.min(100, +$('#mProg').value || 0));
  m.owner = $('#mOwner').value.trim(); m.due_date = $('#mDue').value || null; m.dependency = $('#mDep').value.trim();
  m.notes = $('#mNotes').value.trim(); m.keyMilestone = $('#mKey').checked; m.transition = $('#mTrans').checked;
  const os = m.schoolIds.length ? schoolById(m.schoolIds[0]) : null; if (os) m.openingFY = os.openingFY;
  logActivity('edit', 'Updated: ' + m.activity, { itemId: m.id });
  autosave(); closeModal(); rerender(); toast('Saved', 'ok');
}
function deleteModal() {
  if (modalMode === 'school') return deleteSchool();
  if (!modalId) return; const m = findM(modalId), id = modalId;
  confirmDialog({ title: 'Delete this task?', message: `"${esc(m ? m.activity : 'this task')}" will be permanently removed.`, confirmLabel: 'Delete task', danger: true, onConfirm: () => { snapshotForUndo('Delete task: ' + (m ? m.activity : '')); logActivity('delete', 'Deleted: ' + (m ? m.activity : 'task')); state.data.milestones = M().filter(x => x.id !== id); autosave(); closeModal(); rerender(); toast('Task deleted', 'ok'); } });
}
let taskReturnSchool = null;
let modalDirty = false;
function closeModal() { modalDirty = false; $('#modalBackdrop').classList.remove('open'); modalId = null; const ret = taskReturnSchool; taskReturnSchool = null; if (ret) setTimeout(() => openSchoolModal(ret), 0); }
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
function confirmDialog(opts) {
  closeConfirm();
  const shared = state.sb && state.sb.connected;
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  const typedBlock = opts.requireTyped ? `<div class="confirm-typed"><label>Type <span class="mono">${esc(opts.requireTyped)}</span> to confirm</label><input id="cfgTyped" class="mono" autocomplete="off" placeholder="${esc(opts.requireTyped)}"></div>` : '';
  w.innerHTML = `<div class="confirm-box">
    <div class="confirm-ic ${opts.danger ? 'danger' : ''}">${opts.danger ? '⚠' : '?'}</div>
    <h3>${esc(opts.title)}</h3>
    <div class="confirm-msg">${opts.message}</div>
    ${opts.danger ? `<div class="confirm-shared">${shared ? 'This deletes it for <b>everyone</b> on the shared board' : 'This cannot be undone'} - please confirm.</div>` : ''}
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
function typeFromCode(code) { const m = /^([A-Za-z]+)(\d+)?/.exec(code || ''); const t = (m ? m[1] : '').toUpperCase(); return t === 'HS' ? 'HS' : t === 'ES' ? 'ES' : 'MS'; }
function openSchoolModal(id) {
  modalMode = 'school'; schoolId = id; modalDirty = false;
  const isNew = !id;
  const s = id ? schoolById(id) : { id: uid(), display_label: '', code: '', school_type: 'ES', pod_number: null, market: markets()[0], state: stateOfMarket(markets()[0]), openingFY: currentFY() + 1, openingQuarter: 'Q1', priority: false, confirmed: true, _new: true };
  $('#modalTitle').textContent = isNew ? 'Add a school opening' : `${s.market} ${s.display_label} - Milestones`;
  const opt = (arr, val) => arr.map(x => Array.isArray(x) ? `<option value="${x[0]}" ${x[0] === val ? 'selected' : ''}>${esc(x[1])}</option>` : `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const sm = isNew ? [] : schoolMs(s);
  const roll = sm.length ? rollupStatus(sm) : 'not_started';
  const taskList = sm.length ? sm.slice().sort(bySortUrgency).map(m => `<div class="sm-task" data-expand="${m.id}">${statusDot(effectiveStatus(m))}<span class="sm-t-title">${esc(m.activity)}</span><span class="sm-t-team">${esc(m.functional_area || '')}</span><span class="sm-t-due">${dueBadge(m) || (m.due_date ? fmtDate(m.due_date) : '-')}</span></div>`).join('') : '<div class="muted" style="font-size:12.5px">No milestones yet - add the first one below.</div>';
  const summary = isNew ? '' : `<div class="sm-summary">
    <span><span class="state-badge sm" style="background:${stColor(s.state)}">${esc(s.state)}</span> <b>${esc(s.market)}</b> · Fall ${s.openingFY - 1}</span>
    <span class="sm-summary-r"><span class="muted">${sm.length} milestone${sm.length === 1 ? '' : 's'}</span>${sm.length ? `<button class="btn btn-text btn-sm sm-openplan" data-openplanschool="${esc(s.id)}" title="See this school's tasks in the Project Plan (filtered)">Open in Project Plan →</button>` : ''}</span></div>`;
  // plain calendar year - a school with openingFY=2028 opens in August 2027, so we show "2027"
  const fyField = `<div class="field"><label>Opens in - August of… <span class="req">*</span></label><select id="sFy">${fyList().map(fy => `<option value="${fy}" ${s.openingFY === fy ? 'selected' : ''}>${fy - 1}</option>`).join('')}</select></div>`;
  const qField = `<div class="field"><label>Opening quarter</label><select id="sQ">${opt(['Q1', 'Q2', 'Q3', 'Q4'], s.openingQuarter || 'Q1')}</select></div>`;
  const marketOnly = `<div class="field"><label>Market / location <span class="req">*</span></label><select id="sMarket">${opt(markets(), s.market)}</select></div>`;
  const labelField = `<div class="field-row"><div class="field"><label>Label <span class="req">*</span></label><input id="sLabel" value="${esc(s.display_label || s.code || '')}" placeholder="ES4"><div class="help-text">Short identifier, e.g. <span class="mono">ES4</span> for the 4th Elementary or <span class="mono">MS2</span> for the 2nd Middle.</div></div><div class="field"><label>School type</label><select id="sType">${opt([['ES', 'Elementary (ES)'], ['MS', 'Middle (MS)'], ['HS', 'High (HS)']], s.school_type)}</select></div></div>`;
  const marketField = `<div class="field-row"><div class="field"><label>Market / location</label><select id="sMarket">${opt(markets(), s.market)}</select></div><div class="field"><label>Pod #</label><input id="sPod" type="number" min="1" value="${s.pod_number || ''}" placeholder="4"></div></div>`;
  const confField = `<label class="field-check"><input type="checkbox" id="sConf" ${s.confirmed !== false ? 'checked' : ''}> Opening confirmed</label>`;
  $('#modalBody').innerHTML = isNew ? `
    <div class="add-school-intro">
      <div class="asi-step"><span class="asi-num">1</span><div><b>Set up the school opening</b><span class="muted"> - market, opening year, label</span></div></div>
      <div class="asi-step"><span class="asi-num">2</span><div><b>Save</b><span class="muted"> - you'll return to this school with a task list</span></div></div>
      <div class="asi-step"><span class="asi-num">3</span><div><b>Load starter milestones or add your own</b><span class="muted"> - assign owners and deadlines</span></div></div>
    </div>
    ${labelField}
    ${marketOnly}
    ${fyField}
    <div class="field-row">${confField}</div>
    <details class="sm-details"><summary>More details</summary>
      <div class="field-row"><div class="field"><label>Pod #</label><input id="sPod" type="number" min="1" value="${s.pod_number || ''}" placeholder="4"></div>${qField}</div>
    </details>`
    : `
    ${summary}
    <div class="reschedule">
      <div class="rs-head">Reschedule opening <span class="muted">- push it back or pull it forward as plans change</span></div>
      <div class="field-row">${fyField}${qField}</div>
      <label class="field-check"><input type="checkbox" id="sShift" checked> Also move this school's ${sm.length} milestone deadline${sm.length === 1 ? '' : 's'} by the same shift</label>
    </div>
    <div class="field"><label>Milestones - click any to open</label><div class="sm-tasks">${taskList}</div>
      <div class="sm-task-actions"><button class="btn btn-tonal btn-sm" id="addTaskForSchool">+ Add milestone</button>${templatesButton(s)}</div>${templatesPanel(s)}</div>
    <details class="sm-details"><summary>More school details</summary>
      ${labelField}
      ${marketField}
      <div class="field-row">${confField}</div>
    </details>
    ${notesSection('school', s.id, s.noteLog)}`;
  $('#modalDelete').style.display = isNew ? 'none' : '';
  $('#modalBackdrop').classList.add('open');
}
function shiftDateYears(iso, years) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if (!m) return iso; return `${Number(m[1]) + years}-${m[2]}-${m[3]}`; }
function saveSchool() {
  const isNew = !schoolById(schoolId);
  const s = isNew ? { id: schoolId || uid() } : schoolById(schoolId);
  const old = { code: s.code, market: s.market, openingFY: s.openingFY };
  const label = ($('#sLabel').value.trim() || 'NEW').toUpperCase().replace(/\s+/g, '');
  s.display_label = label; s.code = label; s.school_type = $('#sType').value;
  s.pod_number = $('#sPod').value ? +$('#sPod').value : null;
  s.market = $('#sMarket').value; s.location = s.market; s.state = stateOfMarket(s.market);
  s.openingFY = +$('#sFy').value; s.fiscal_year = s.openingFY; s.openingQuarter = $('#sQ').value;
  s.opening_date = `${s.openingFY - 1}-08-01`; s.confirmed = $('#sConf').checked;
  const shiftEl = $('#sShift');
  const shift = (old.openingFY && s.openingFY && (!shiftEl || shiftEl.checked)) ? (s.openingFY - old.openingFY) : 0;
  if (isNew) { delete s._new; state.data.schools.push(s); }
  else {
    // tasks stay linked by stable id; keep their denormalized fields in sync + slide deadlines on reschedule
    M().forEach(m => {
      if (!(m.schoolIds || []).includes(s.id)) return;
      if (old.code && old.code !== s.code) m.schools = (m.schools || []).map(c => c === old.code ? s.code : c);
      m.market = s.market; m.state = s.state; m.openingFY = s.openingFY;
      if (shift) {
        if (m.targetFY) m.targetFY += shift;
        if (m.due_date) m.due_date = shiftDateYears(m.due_date, shift);
        m.tags = (m.tags || []).map(t => /^FY\d\d$/.test(t) ? 'FY' + String(s.openingFY).slice(-2) : t);
      }
    });
  }
  autosave(); const nid = s.id;
  if (isNew) { closeModal(); rerender(); toast('School added - now add its tasks', 'ok'); setTimeout(() => openSchoolModal(nid), 60); }
  else { closeModal(); rerender(); const msg = shift ? `Opening moved ${shift > 0 ? 'back' : 'earlier'} ${Math.abs(shift)} yr - tasks shifted` : 'School saved'; toast(msg, 'ok'); }
}
function deleteSchool() {
  const s = schoolById(schoolId); if (!s) return; const tasks = schoolMs(s), sid = s.id, mk = s.market, ofy = s.openingFY, cd = s.code;
  confirmDialog({ title: `Remove ${esc(s.display_label)}?`, message: `Remove <b>${esc(s.display_label)} (${esc(s.market)})</b> from the opening schedule.` + (tasks.length ? ` Its <b>${tasks.length} task(s)</b> will also be deleted.` : ''), confirmLabel: 'Remove school', danger: true, onConfirm: () => {
    state.data.schools = state.data.schools.filter(x => x.id !== sid);
    // unlink this school from its tasks; drop a task only if it belonged to no other school
    state.data.milestones = M().filter(m => {
      if (!(m.schoolIds || []).includes(sid)) return true;
      m.schoolIds = m.schoolIds.filter(id => id !== sid); m.schools = (m.schools || []).filter(c => c !== cd);
      return m.schoolIds.length > 0;
    });
    autosave(); closeModal(); rerender(); toast('School removed', 'ok');
  } });
}
/* ---------- milestone templates: quick-add starter pre-opening milestones ---------- */
function milestoneTemplates() { return (meta().milestoneTemplates || []); }
function templatesButton(s) {
  const tpls = milestoneTemplates(); if (!tpls.length) return '';
  return `<button class="btn btn-tonal btn-sm" id="tplToggle" title="Add one or more standard pre-opening milestones">+ Load starter milestones (${tpls.length})</button>`;
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
        const flags = [t.keyMilestone && '★', t.greenlight && '◆', t.transition && '⇄'].filter(Boolean).join(' ');
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
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  d.setMonth(d.getMonth() + monthDelta);
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
  const s = schoolById(schoolId); if (!s) return;
  const picked = Array.from(document.querySelectorAll('#tplPanel .tpl-check:checked')).map(c => c.dataset.tplid);
  if (!picked.length) return;
  const tpls = milestoneTemplates().filter(t => picked.includes(t.id));
  snapshotForUndo(`Add ${tpls.length} starter milestone${tpls.length === 1 ? '' : 's'} for ${s.display_label}`);
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
    M().push(m);
  });
  logActivity('create', `Added ${tpls.length} starter milestone${tpls.length === 1 ? '' : 's'} to ${s.market} · ${s.display_label}`);
  autosave();
  toast(`Added ${tpls.length} milestone${tpls.length === 1 ? '' : 's'}`, 'ok');
  const reopenId = s.id;
  closeModal();
  setTimeout(() => openSchoolModal(reopenId), 60);
}

function addTaskForSchool() {
  const s = schoolById(schoolId); if (!s) return;
  const m = { id: uid(), state: s.state, market: s.market, team: teams()[0], functional_area: teams()[0], workstream: 'General', activity: 'New milestone', schools: [s.code], schoolIds: [s.id], targetFY: s.openingFY, targetQuarter: '', openingFY: s.openingFY, due_date: null, status: 'not_started', stage: 'to_do', progress_percent: 0, priority: s.priority ? 'high' : 'medium', owner: '', dependency: '', keyMilestone: false, greenlight: false, transition: false, notes: '', tags: [s.state, s.code, 'FY' + String(s.openingFY).slice(-2)] };
  M().push(m); autosave(); openModal(m.id);
}

/* ============================================================
   SUPABASE LIVE SYNC (optional)
   ============================================================ */
let sbPushTimer = null, sbLastPushed = new Map(), sbLastSchools = new Map();
const S = () => state.data.schools;
const SB_TABLE = { m: 'growth_milestones', s: 'growth_schools' };
/* Pre-filled shared project so the committee auto-connects on load (publishable key is public by design). */
const SB_DEFAULT = { url: 'https://cwjmlunqfhaioyuijhkk.supabase.co', key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3am1sdW5xZmhhaW95dWlqaGtrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNjk3OTcsImV4cCI6MjEwMjc0NTc5N30.1OeHzNFoeCu7ezocqyqxvvpOinjYnnocGuwBGVbKynU' };
const SB_SQL = `-- run once in Supabase → SQL Editor
create table if not exists growth_milestones (id text primary key, doc jsonb not null, updated_at timestamptz default now());
create table if not exists growth_schools    (id text primary key, doc jsonb not null, updated_at timestamptz default now());
alter table growth_milestones enable row level security;
alter table growth_schools    enable row level security;
create policy "rw_m" on growth_milestones for all using (true) with check (true);
create policy "rw_s" on growth_schools    for all using (true) with check (true);
alter publication supabase_realtime add table growth_milestones;
alter publication supabase_realtime add table growth_schools;`;
function sbSavedCfg() { try { return JSON.parse(lsGet(LS.supabase) || 'null'); } catch (e) { return null; } }
async function sbConnect(url, key, silent) {
  const s = $('#sbStatus'); if (s && !silent) s.innerHTML = '<div class="status-note warn">Connecting…</div>';
  try {
    const mod = await import('https://esm.sh/@supabase/supabase-js@2');
    const client = mod.createClient(url, key);
    state.sb = { connected: true, client };
    lsSet(LS.supabase, JSON.stringify({ url, key }));
    // Auth bootstrap FIRST - restores session if any, wires onAuthStateChange to load data on sign-in
    try { await bootstrapAuth(client); } catch (e) { console.warn('bootstrapAuth failed:', e); }
    // In auth mode with no session, skip data ops - they'd fail RLS. Data loads after sign-in.
    if (authModeOn() && !state.auth.user) {
      if (s && !silent) s.innerHTML = '<div class="status-note ok">✓ Connected. Sign in to load the board.</div>';
      renderDrawer(); return true;
    }
    await sbLoadData(client);
    const b = $('#saveState'); if (b) { b.textContent = 'Synced • live'; b.className = 'save-state saved'; }
    if (s) s.innerHTML = '<div class="status-note ok">✓ Connected. Edits &amp; schools sync live to everyone on this project.</div>'; renderDrawer(); return true;
  } catch (e) { state.sb = { connected: false, client: null }; if (s) s.innerHTML = `<div class="status-note err">Couldn't connect: ${esc(e.message || e)}. Check URL/key and that you ran the SQL.</div>`; return false; }
}
async function sbLoadData(client) {
  // milestones
  const rm = await client.from(SB_TABLE.m).select('id,doc'); if (rm.error) throw rm.error;
  if (rm.data && rm.data.length) state.data.milestones = rm.data.map(r => r.doc).filter(Boolean);
  else { const r = await client.from(SB_TABLE.m).upsert(M().map(m => ({ id: m.id, doc: m, updated_at: new Date().toISOString() }))); if (r.error) throw r.error; }
  sbLastPushed = new Map(M().map(m => [m.id, JSON.stringify(m)]));
  // schools
  const rs = await client.from(SB_TABLE.s).select('id,doc'); if (rs.error) throw rs.error;
  if (rs.data && rs.data.length) state.data.schools = rs.data.map(r => r.doc).filter(Boolean);
  else { const r = await client.from(SB_TABLE.s).upsert(S().map(x => ({ id: x.id, doc: x, updated_at: new Date().toISOString() }))); if (r.error) throw r.error; }
  sbLastSchools = new Map(S().map(x => [x.id, JSON.stringify(x)]));
  if (!client._ngcChannels) {
    client.channel('gm_rt').on('postgres_changes', { event: '*', schema: 'public', table: SB_TABLE.m }, sbOnRemote).subscribe();
    client.channel('gs_rt').on('postgres_changes', { event: '*', schema: 'public', table: SB_TABLE.s }, sbOnRemote).subscribe();
    client._ngcChannels = true;
  }
  autosaveWriteLocal(); rerender();
  // Load the team-wide audit feed (account mode) so Team activity shows everyone's changes.
  refreshActivityViews();
}
function sbDisconnect() { try { if (state.sb.client) state.sb.client.removeAllChannels(); } catch (e) {} state.sb = { connected: false, client: null }; lsDel(LS.supabase); renderDrawer(); toast('Disconnected', 'ok'); }
function sbOnRemote(p) {
  try {
    const isSchool = p.table === SB_TABLE.s;
    const arr = isSchool ? S() : M(), last = isSchool ? sbLastSchools : sbLastPushed;
    if (p.eventType === 'DELETE') { const id = p.old && p.old.id; if (id) { const na = arr.filter(x => x.id !== id); if (isSchool) state.data.schools = na; else state.data.milestones = na; last.delete(id); } }
    else { const doc = p.new && p.new.doc; if (!doc) return; const j = JSON.stringify(doc); if (last.get(doc.id) === j) return; const i = arr.findIndex(x => x.id === doc.id); if (i >= 0) arr[i] = doc; else arr.push(doc); last.set(doc.id, j); }
    autosaveWriteLocal(); if (!$('#popover') && !$('#modalBackdrop').classList.contains('open')) rerender();
    // A teammate changed data - pull the fresh audit so Team activity reflects who did it.
    if (authModeOn()) sbFetchAudit(50).then(() => { renderActivityPanel(); if (state.view === 'progress' && !$('#modalBackdrop').classList.contains('open')) refreshBody(); });
  } catch (e) { console.error(e); }
}
async function sbPushTable(client, table, list, last) {
  const cur = new Map(list.map(x => [x.id, JSON.stringify(x)])); const ups = [];
  cur.forEach((j, id) => { if (last.get(id) !== j) ups.push({ id, doc: JSON.parse(j), updated_at: new Date().toISOString() }); });
  const dels = []; last.forEach((_v, id) => { if (!cur.has(id)) dels.push(id); });
  if (ups.length) { const r = await client.from(table).upsert(ups); if (r.error) throw r.error; }
  if (dels.length) { const r = await client.from(table).delete().in('id', dels); if (r.error) throw r.error; }
  return cur;
}
async function sbPush() {
  if (!(state.sb && state.sb.connected)) return; const client = state.sb.client;
  try { sbLastPushed = await sbPushTable(client, SB_TABLE.m, M(), sbLastPushed); sbLastSchools = await sbPushTable(client, SB_TABLE.s, S(), sbLastSchools); }
  catch (e) { console.error(e); const b = $('#saveState'); if (b) { b.textContent = 'Saved locally · sync error'; b.className = 'save-state err'; } }
}
function sbPushDebounced() { clearTimeout(sbPushTimer); sbPushTimer = setTimeout(sbPush, 400); }

/* ---------- drawer / export ---------- */
function ghConfig() { try { return JSON.parse(lsGet(LS.gh) || '{}'); } catch (e) { return {}; } }
function renderDrawer() {
  const cfg = ghConfig(), sc = sbSavedCfg() || SB_DEFAULT, connected = state.sb && state.sb.connected;
  $('#drawerBody').innerHTML = `
    <p class="dw-intro">Every change saves automatically on this device. To share <b>one live board</b> with the whole committee, connect Supabase once below.</p>

    <section class="dw-sec">
      <div class="dw-h"><span class="dw-num">1</span><h4>Share with the Committee</h4></div>
      ${connected ? `<div class="status-note ok">● Live - everyone connected to <span class="mono">${esc((sc.url || '').replace(/^https?:\/\//, ''))}</span> shares this board.</div><div class="dw-btns"><button class="btn btn-tonal" id="sbDisconnect">Disconnect</button></div>`
      : `<p class="dw-help">Paste your Supabase <b>Project URL</b> and <b>anon public key</b> (Supabase → Project Settings → API). First time only: open <b>SQL setup</b> and run it once in Supabase.</p>
         <div class="field"><label>Project URL</label><input id="sbUrl" class="mono" placeholder="https://xxxx.supabase.co" value="${esc(sc.url || '')}"></div>
         <div class="field"><label>Anon public key</label><input id="sbKey" type="password" class="mono" value="${esc(sc.key || '')}"></div>
         <div class="dw-btns"><button class="btn btn-filled" id="sbConnect">Connect &amp; go live</button><button class="btn btn-text" id="sbShowSql">SQL setup</button></div>
         <pre class="sql-box hide" id="sbSqlBox">${esc(SB_SQL)}</pre>`}
      <div id="sbStatus"></div>
      <details class="dw-adv"><summary>No Supabase? Publish via GitHub instead</summary>
        <div class="field"><label>Repository (owner/repo)</label><input id="ghRepo" class="mono" placeholder="kippnj/ngc-tracker" value="${esc(cfg.repo || '')}"></div>
        <div class="field-row"><div class="field"><label>Branch</label><input id="ghBranch" class="mono" value="${esc(cfg.branch || 'main')}"></div><div class="field"><label>Token</label><input id="ghToken" type="password" class="mono" value="${esc(cfg.token || '')}"></div></div>
        <div class="dw-btns"><button class="btn btn-filled" id="ghSave">Commit</button></div><div id="ghStatus"></div>
      </details>
    </section>

    <section class="dw-sec">
      <div class="dw-h"><span class="dw-num">2</span><h4>Access &amp; Accounts</h4></div>
      <div class="auth-mode-block">
        <label class="field-check"><input type="radio" name="authMode" value="password" ${!authModeOn() ? 'checked' : ''}> <b>Shared password</b> <span class="muted">- one password for the whole team (legacy)</span></label>
        <label class="field-check"><input type="radio" name="authMode" value="supabase" ${authModeOn() ? 'checked' : ''}> <b>Individual accounts</b> <span class="muted">- each person signs in; edits are attributed. Requires Supabase configured with saved URL/key.</span></label>
        ${authModeOn() && state.auth.user ? `<div class="status-note ok" style="margin-top:8px">Signed in as <b>${esc(state.auth.profile ? state.auth.profile.full_name || state.auth.profile.email : state.auth.user.email)}</b> · role: <b>${esc(currentRole() || 'viewer')}</b></div>` : ''}
      </div>
      <div class="dw-divider"></div>
      <div class="dw-sublabel">Shared password (used when Individual accounts is off)</div>
      <label class="field-check"><input type="checkbox" id="gateEnable" ${gateOn() ? 'checked' : ''}> Require a shared password to open the board</label>
      <div class="field" style="margin-top:10px"><label>Change the password</label><input id="gateNew" type="text" autocomplete="off" placeholder="Leave blank to keep the current one"></div>
      <div class="dw-btns"><button class="btn btn-filled" id="gateSave">Save</button><button class="btn btn-text" id="gateLock">Lock &amp; sign out</button></div>
      <div id="gateStatus"></div>
      <p class="dw-help">After changing it, Connect (or Commit) so everyone gets the new password. A light gate to keep casual visitors out - not strong security.</p>
      <div class="dw-divider"></div>
      <div class="dw-sublabel">Admin lock - protects this Settings panel</div>
      <label class="field-check"><input type="checkbox" id="adminEnable" ${adminOn() ? 'checked' : ''}> Require an admin password to open Settings (only you)</label>
      <div class="field" style="margin-top:10px"><label>Change the admin password</label><input id="adminNew" type="text" autocomplete="off" placeholder="Leave blank to keep the current one"></div>
      <div class="dw-btns"><button class="btn btn-filled" id="adminSave">Save admin password</button></div>
      <div id="adminStatus"></div>
      <p class="dw-help">This one is just for you - teammates use the board password above but can't open Settings without this.</p>
    </section>

    <details class="dw-sec dw-fold"><summary><span class="dw-num">3</span>Customize Markets, Workstreams &amp; Owners</summary>
      <p class="dw-help">Rename or add your own; changes save everywhere. Anything in use can't be deleted until its items are reassigned.</p>
      ${czSection('State', 'markets', statesMeta().flatMap(s => s.markets.map(mk => ({ mk, st: s.code }))))}
      ${czSection('Workstream', 'teams', teams().map(t => ({ mk: t })))}
      ${czOwners()}
    </details>

    <details class="dw-sec dw-fold"><summary><span class="dw-num">4</span>Manage School Openings</summary>
      <p class="dw-help">Every school opening in your portfolio. Use for bulk cleanup at the start of a planning cycle.</p>
      ${schoolsPanel()}
      <div class="ms-bulk">
        <div class="ms-bulk-warn">Bulk delete removes every school opening <b>and</b> every milestone tied to those schools. Milestones with no school attached remain untouched.</div>
        <button class="btn btn-danger-solid" id="msDeleteAll" ${state.data.schools.length ? '' : 'disabled'}>Delete ALL school openings</button>
      </div>
    </details>

    <details class="dw-sec dw-fold"><summary><span class="dw-num">5</span>Back Up &amp; Restore Data</summary>
      <p class="dw-help">Download a copy of everything, or load one back in.</p>
      <div class="dw-btns"><button class="btn" id="expBtn">Export data.json</button><button class="btn" id="impBtn">Import</button><input type="file" id="impFile" accept="application/json" class="hide"></div>
    </details>

    <div class="dw-about">Network Growth Hub · ${M().length} milestones · ${state.data.schools.length} schools · v${meta().version || 1}</div>`;
}

/* ---------- schools management panel (drawer section 4) ---------- */
function schoolsPanel() {
  const schools = state.data.schools.slice().sort((a, b) => (a.openingFY || 0) - (b.openingFY || 0) || a.market.localeCompare(b.market) || a.display_label.localeCompare(b.display_label));
  if (!schools.length) return '<div class="ms-empty">No school openings yet. Add one from the Openings tab.</div>';
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
  const n = state.data.schools.length;
  const nTasks = M().filter(m => (m.schoolIds || []).length).length;
  if (!n) return;
  confirmDialog({
    title: 'Delete every school opening?',
    danger: true,
    confirmLabel: 'Delete ALL',
    requireTyped: 'DELETE ALL',
    message: `This removes <b>${n} school opening${n === 1 ? '' : 's'}</b> and every milestone tied to them (roughly <b>${nTasks} task${nTasks === 1 ? '' : 's'}</b>). Milestones with no school attached remain.`,
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
  const stOpts = statesMeta().map(s => `<option value="${s.code}">${esc(s.code)}</option>`).join('');
  const list = rows.map(r => `<div class="cz-row">
    <input class="cz-name" data-cztype="${type}" data-czold="${esc(r.mk)}" value="${esc(r.mk)}">
    ${type === 'markets' ? `<select class="cz-state" data-czmarket="${esc(r.mk)}">${statesMeta().map(s => `<option value="${s.code}" ${s.code === r.st ? 'selected' : ''}>${esc(s.code)}</option>`).join('')}</select>` : ''}
    <button class="cz-del" data-cztype="${type}" data-czval="${esc(r.mk)}" title="Remove">✕</button></div>`).join('');
  return `<div class="cz-block"><div class="cz-add">
      <input class="cz-new" id="czNew-${type}" placeholder="Add ${esc(label === 'State' ? 'market' : 'team')}…">
      ${type === 'markets' ? `<select id="czNewState">${stOpts}</select>` : ''}
      <button class="btn btn-tonal btn-sm" data-czadd="${type}">Add</button>
    </div>${list}</div>`;
}
function czOwners() {
  const rows = (meta().owners || []).map(o => `<div class="cz-row"><input class="cz-name" data-cztype="owner" data-czold="${esc(o.name)}" value="${esc(o.name)}"><input class="cz-role" data-czowner="${esc(o.name)}" value="${esc(o.role || '')}" placeholder="role"><button class="cz-del" data-cztype="owner" data-czval="${esc(o.name)}" title="Remove">✕</button></div>`).join('');
  return `<div class="cz-block"><h4 style="margin-top:14px">Owners</h4><div class="cz-add"><input class="cz-new" id="czNew-owner" placeholder="Add person…"><input class="cz-new" id="czNewRole" placeholder="role (optional)"><button class="btn btn-tonal btn-sm" data-czadd="owner">Add</button></div>${rows}</div>`;
}
function czInUse(type, val) { return type === 'markets' ? M().filter(m => m.market === val).length + state.data.schools.filter(s => s.market === val).length : M().filter(m => m.functional_area === val).length; }
function czRename(type, oldV, newV) {
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
    (meta().owners || []).forEach(o => { if (o.name === oldV) o.name = newV; });
    M().forEach(m => { if (m.owner === oldV) m.owner = newV; });
  }
  autosave(); rerender(); renderDrawer();
}
function czRemove(type, val) {
  const n = type === 'owner' ? 0 : czInUse(type, val);
  if (n) return toast(`${val} is used by ${n} item(s) - reassign them first`, 'err');
  confirmDialog({ title: `Remove "${esc(val)}"?`, message: `This removes the ${type === 'markets' ? 'market' : type === 'teams' ? 'team' : 'person'} from your lists.`, confirmLabel: 'Remove', danger: true, onConfirm: () => {
    if (type === 'owner') meta().owners = (meta().owners || []).filter(o => o.name !== val);
    else if (type === 'markets') { meta().markets = markets().filter(x => x !== val); statesMeta().forEach(s => s.markets = s.markets.filter(x => x !== val)); }
    else { meta().teams = teams().filter(x => x !== val); meta().functionalAreas = meta().teams; }
    autosave(); rerender(); renderDrawer();
  } });
}
function czAdd(type) {
  const v = ($('#czNew-' + type) || {}).value ? $('#czNew-' + type).value.trim() : '';
  if (!v) return;
  if (type === 'markets') { if (markets().includes(v)) return toast('Already exists', 'err'); const st = $('#czNewState').value; markets().push(v); const s = statesMeta().find(x => x.code === st); if (s) s.markets.push(v); }
  else if (type === 'teams') { if (teams().includes(v)) return toast('Already exists', 'err'); teams().push(v); meta().functionalAreas = teams(); }
  else if (type === 'owner') { (meta().owners = meta().owners || []).push({ name: v, role: ($('#czNewRole') || {}).value || '' }); }
  autosave(); rerender(); renderDrawer();
}
async function commitToGitHub() {
  const repo = $('#ghRepo').value.trim(), branch = $('#ghBranch').value.trim() || 'main', token = $('#ghToken').value.trim(), st = $('#ghStatus');
  lsSet(LS.gh, JSON.stringify({ repo, branch, token }));
  if (!repo || !token) { st.innerHTML = '<div class="status-note err">Enter repo and token.</div>'; return; }
  const [owner, name] = repo.split('/'); const api = `https://api.github.com/repos/${owner}/${name}/contents/data.json`; const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  st.innerHTML = '<div class="status-note warn">Committing…</div>';
  try { let sha = null; const c = await fetch(`${api}?ref=${branch}`, { headers: h }); if (c.ok) sha = (await c.json()).sha; else if (c.status !== 404) throw new Error('Read ' + c.status);
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(state.data, null, 2))));
    const r = await fetch(api, { method: 'PUT', headers: h, body: JSON.stringify({ message: 'Update tracker data', content, branch, sha }) }); if (!r.ok) throw new Error((await r.json()).message || r.status);
    st.innerHTML = '<div class="status-note ok">✓ Committed.</div>'; toast('Committed', 'ok');
  } catch (e) { st.innerHTML = `<div class="status-note err">${esc(e.message)}</div>`; }
}
function exportJson() { const b = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'data.json'; a.click(); URL.revokeObjectURL(a.href); toast('Exported', 'ok'); }
function importJson(file) { const r = new FileReader(); r.onload = () => { try { const d = JSON.parse(r.result); if (!d.milestones) throw 0; state.data = d; autosave(); rerender(); renderDrawer(); toast('Imported', 'ok'); } catch (e) { toast('Invalid file', 'err'); } }; r.readAsText(file); }

/* ---------- toast / theme / nav ---------- */
function toast(msg, kind) { const w = $('#toastWrap'), t = document.createElement('div'); t.className = 'toast' + (kind ? ' ' + kind : ''); t.textContent = msg; w.appendChild(t); setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 2400); }
function applyTheme(mode) { document.documentElement.setAttribute('data-theme', mode); lsSet(LS.theme, mode); $('#themeIcon').innerHTML = mode === 'dark' ? '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>' : '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'; }
const VIEWS = ['progress', 'timeline', 'plan'];
function setView(v, fromPop) {
  if (!VIEWS.includes(v)) v = 'progress';
  if (v === 'reports') v = 'progress';
  state.view = v;
  $$('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  const pg = $('#planGroup'); if (pg) pg.classList.toggle('expanded', v === 'plan');
  $$('.nav-subitem').forEach(x => x.classList.toggle('active', v === 'plan' && (x.dataset.plan === 'focus' ? state.planFocus : (!state.planFocus && state.planGroup === x.dataset.plan))));
  $$('.view').forEach(s => { const on = s.id === 'view-' + v; s.classList.toggle('active', on); if (!on) s.innerHTML = ''; });
  const cbPage = $('#cbPage'); if (cbPage) cbPage.textContent = v === 'progress' ? 'Dashboard' : v === 'timeline' ? 'Openings' : 'Project Plan';
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
      // Manual sidebar nav resets filters so users aren't confused by leftover
      // filters carried in from a KPI drill. Drills call setView() directly.
      if (activeCount()) clearFilters();
      setView(t.dataset.view);
    }
  });
  const nt = $('#navToggle'); if (nt) nt.addEventListener('click', () => { const on = document.body.classList.toggle('nav-collapsed'); lsSet('ngc_nav', on ? '1' : '0'); nt.title = on ? 'Expand menu' : 'Collapse menu'; const lbl = nt.querySelector('.nav-util-lbl'); if (lbl) lbl.textContent = on ? 'Expand' : 'Collapse'; });
  const showDrawer = () => { renderDrawer(); $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); };
  const openDrawer = () => {
    if (adminOn() && !state.adminUnlocked) return promptPassword({ title: 'Admin settings', message: 'Enter the settings password.', verify: v => pwHash(v) === String(meta().adminHash), onOk: () => { state.adminUnlocked = true; showDrawer(); } });
    showDrawer();
  };
  const closeDrawer = () => { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); };
  $('#settingsBtn').addEventListener('click', openDrawer); $('#drawerClose').addEventListener('click', closeDrawer); $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('#modalClose').addEventListener('click', attemptCloseModal); $('#modalCancel').addEventListener('click', attemptCloseModal); $('#modalSave').addEventListener('click', saveModal); $('#modalDelete').addEventListener('click', deleteModal);
  $('#modalBackdrop').addEventListener('click', e => { if (e.target.id === 'modalBackdrop') attemptCloseModal(); });
  // any user edit inside the modal marks it dirty; save/close resets
  $('#modalBody').addEventListener('input', e => { if (e.target.matches('input, textarea, select')) modalDirty = true; });
  $('#modalBody').addEventListener('change', e => { if (e.target.matches('input[type="checkbox"], input[type="radio"], select')) modalDirty = true; });
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
    const ex = e.target.closest('[data-expand]'); if (ex) { if (modalMode === 'school') taskReturnSchool = schoolId; return openModal(ex.dataset.expand); }
  });
  $('#modalBody').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'noteInput') { e.preventDefault(); postNote(e.target.closest('.notes-field')); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCmdk(); if ($('#modalBackdrop').classList.contains('open')) attemptCloseModal(); closeDrawer(); closePopover(); closeConfirm(); } });

  // keep timing colors live vs. the real date (on return-to-tab and hourly rollover)
  let _day = new Date().toDateString();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rerender(); });
  setInterval(() => { const t = new Date().toDateString(); if (t !== _day) { _day = t; rerender(); } }, 3600000);

  document.addEventListener('dragstart', e => { const c = e.target.closest('.kcard'); if (c) { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); } });
  document.addEventListener('dragend', e => { const c = e.target.closest('.kcard'); if (c) c.classList.remove('dragging'); $$('.kcol-body.over').forEach(b => b.classList.remove('over')); });
  document.addEventListener('dragover', e => { const b = e.target.closest('.kcol-body'); if (b) { e.preventDefault(); b.classList.add('over'); } });
  document.addEventListener('dragleave', e => { const b = e.target.closest('.kcol-body'); if (b && !b.contains(e.relatedTarget)) b.classList.remove('over'); });
  document.addEventListener('drop', e => { const b = e.target.closest('.kcol-body'); if (b) { e.preventDefault(); b.classList.remove('over'); const m = findM(e.dataTransfer.getData('text/plain')); if (m && m.stage !== b.dataset.kstage) { snapshotForUndo('Move task: ' + (m.activity || '').slice(0, 30)); logActivity('move', `Moved "${m.activity}" to ${b.dataset.kstage}`, { itemId: m.id }); m.stage = b.dataset.kstage; if (m.stage === 'complete') { m.status = 'complete'; m.progress_percent = 100; } autosave(); refreshResults(); } } });

  $('.container').addEventListener('click', e => {
    const fm = e.target.closest('.fb-menu'); if (fm) return openFilterMenu(fm, fm.dataset.fmenu);
    const oy = e.target.closest('[data-oyear]'); if (oy) { toggleOpeningYear(+oy.dataset.oyear); return rerender(); }
    if (e.target.closest('[data-oyall]')) { state.filters.openingFYs.clear(); return rerender(); }
    if (e.target.closest('#clearFilters')) { clearFilters(); return rerender(); }
    if (e.target.closest('#clearFilters2')) { clearFilters(); return rerender(); }
    if (e.target.closest('#pmExpandAll')) { (state._pmKeys || []).forEach(k => state.expanded[k] = true); return refreshBody(); }
    if (e.target.closest('#pmCollapseAll')) { state.expanded = {}; return refreshBody(); }
    const plv = e.target.closest('[data-planview]'); if (plv) { state.planGroup = plv.dataset.planview === 'board' ? 'stage' : (state._lastListGroup || 'team'); if (plv.dataset.planview !== 'board') state._lastListGroup = state.planGroup; return renderPlan(); }
    const pv = e.target.closest('[data-progressview]'); if (pv) { state.progressView = pv.dataset.progressview; return renderProgress(); }
    const pd = e.target.closest('[data-progressdim]'); if (pd) { state.progressDim = pd.dataset.progressdim; return refreshBody(); }
    const ch = e.target.closest('[data-cohort]'); if (ch) return setDashCohort(ch.dataset.cohort);
    const bd = e.target.closest('[data-dashbd]'); if (bd) { state.dashBreakdown = bd.dataset.dashbd; return refreshBody(); }
    const dr = e.target.closest('[data-drilldim]'); if (dr) return applyDrill(dr.dataset.drilldim, dr.dataset.drillval);
    const gv = e.target.closest('[data-goview]'); if (gv) { window.scrollTo({ top: 0, behavior: 'smooth' }); return setView(gv.dataset.goview); }
    if (e.target.closest('[data-activityall]')) return toggleActivity();
    const as = e.target.closest('[data-addstage]'); if (as) return addItem(as.dataset.addstage);
    const cp = e.target.closest('[data-complete]'); if (cp) { const m = findM(cp.dataset.complete); if (m) { snapshotForUndo('Complete: ' + (m.activity || '').slice(0, 30)); m.status = 'complete'; m.progress_percent = 100; m.stage = 'complete'; logActivity('status', `Completed "${m.activity}"`, { itemId: m.id }); autosave(); rerender(); toast('Marked complete', 'ok'); } return; }
    const sm = e.target.closest('[data-showmore]'); if (sm) { const p = sm.dataset.showmore; if (p === 'focus') state.planFocus = true; else { state.planGroup = p; state.planFocus = false; } return setView('plan'); }
    const tg = e.target.closest('[data-toggle]'); if (tg) { const k = tg.dataset.toggle; state.expanded[k] = !state.expanded[k]; return refreshBody(); }
    const ex = e.target.closest('[data-expand]'); if (ex) return openModal(ex.dataset.expand);
    const oi = e.target.closest('[data-openitem]'); if (oi) return openModal(oi.dataset.openitem);
    if (e.target.closest('[data-drillmine]')) {
      const nm = currentDisplayName();
      if (nm) { state.filters.search = nm; const cb = $('#cbSearch'); if (cb) cb.value = nm; setView('plan'); }
      return;
    }
    const es2 = e.target.closest('[data-editschool]'); if (es2) return openSchoolModal(es2.dataset.editschool);
    const ds = e.target.closest('[data-drillschool]'); if (ds) return openSchoolModal(ds.dataset.drillschool);
    const gp = e.target.closest('[data-goplan]'); if (gp) { const m = findM(gp.dataset.goplan); if (m) { state.filters.search = m.activity; const cb = $('#cbSearch'); if (cb) cb.value = m.activity; } setView('plan'); return; }
    if (e.target.closest('#planFocus')) { state.planFocus = !state.planFocus; return renderPlan(); }
    if (e.target.closest('#planExpandAll')) { (state._planKeys || []).forEach(k => state.expanded[k] = true); return refreshBody(); }
    if (e.target.closest('#planCollapseAll')) { (state._planKeys || []).forEach(k => delete state.expanded[k]); return refreshBody(); }
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
    if (e.target.id === 'sbConnect') { const u = $('#sbUrl').value.trim(), k = $('#sbKey').value.trim(); if (!u || !k) $('#sbStatus').innerHTML = '<div class="status-note err">Enter URL and key.</div>'; else sbConnect(u, k); }
    else if (e.target.id === 'sbDisconnect') sbDisconnect(); else if (e.target.id === 'sbShowSql') $('#sbSqlBox').classList.toggle('hide');
    else if (e.target.id === 'ghSave') commitToGitHub(); else if (e.target.id === 'expBtn') exportJson(); else if (e.target.id === 'impBtn') $('#impFile').click();
    else if (e.target.id === 'gateSave') return saveGateSettings();
    else if (e.target.id === 'adminSave') return saveAdminSettings();
    else if (e.target.id === 'gateLock') return lockNow();
    else if (e.target.id === 'msDeleteAll') return bulkDeleteAllSchools();
    const msE = e.target.closest('[data-msedit]'); if (msE) { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); return openSchoolModal(msE.dataset.msedit); }
    const msD = e.target.closest('[data-msdel]'); if (msD) { const sid = msD.dataset.msdel; const s = schoolById(sid); if (!s) return; const tasks = schoolMs(s); confirmDialog({ title: `Remove ${esc(s.display_label)}?`, message: `Remove <b>${esc(s.display_label)} (${esc(s.market)})</b>` + (tasks.length ? ` and its <b>${tasks.length} task${tasks.length === 1 ? '' : 's'}</b>` : '') + ' from the schedule.', confirmLabel: 'Remove school', danger: true, onConfirm: () => { snapshotForUndo('Remove school: ' + s.display_label); const cd = s.code; state.data.schools = state.data.schools.filter(x => x.id !== sid); state.data.milestones = M().filter(m => { if (!(m.schoolIds || []).includes(sid)) return true; m.schoolIds = m.schoolIds.filter(id => id !== sid); m.schools = (m.schools || []).filter(c => c !== cd); return m.schoolIds.length > 0; }); autosave(); rerender(); renderDrawer(); toast('School removed', 'ok'); } }); return; }
    const cza = e.target.closest('[data-czadd]'); if (cza) return czAdd(cza.dataset.czadd);
    const czd = e.target.closest('.cz-del'); if (czd) return czRemove(czd.dataset.cztype, czd.dataset.czval);
  });
  $('#drawerBody').addEventListener('change', e => {
    if (e.target.id === 'impFile' && e.target.files[0]) return importJson(e.target.files[0]);
    if (e.target.name === 'authMode') { meta().authMode = e.target.value; autosave(); renderDrawer(); toast(e.target.value === 'supabase' ? 'Account mode ON - sign in required next load' : 'Shared-password mode restored', 'ok'); return; }
    if (e.target.classList.contains('cz-name')) return czRename(e.target.dataset.cztype, e.target.dataset.czold, e.target.value);
    if (e.target.classList.contains('cz-state')) { const mk = e.target.dataset.czmarket, to = e.target.value; statesMeta().forEach(s => s.markets = s.markets.filter(x => x !== mk)); const s = statesMeta().find(x => x.code === to); if (s && !s.markets.includes(mk)) s.markets.push(mk); M().forEach(m => { if (m.market === mk) m.state = to; }); state.data.schools.forEach(x => { if (x.market === mk) x.state = to; }); autosave(); rerender(); renderDrawer(); return; }
    if (e.target.classList.contains('cz-role')) { const o = (meta().owners || []).find(x => x.name === e.target.dataset.czowner); if (o) { o.role = e.target.value; autosave(); } return; }
  });
}

/* ---------- shared access gate ----------
   A lightweight shared password to keep casual visitors out of the committee board.
   NOTE: this is client-side only - it deters, it does not encrypt. Anyone technical can
   read past it by viewing source. For real access control, use Supabase Auth. */
/* ============================================================
   SUPABASE AUTH - Phase 1
   Real accounts, session persistence, attribution via DB triggers.
   Toggled by meta.authMode:  'password' (legacy shared gate) | 'supabase' (auth)
   ============================================================ */
function authModeOn() { return meta().authMode === 'supabase'; }
function currentProfile() { return state.auth && state.auth.profile; }
function currentRole() { const p = currentProfile(); return p ? p.role : null; }
function isEditor() { const r = currentRole(); return r === 'editor' || r === 'admin'; }
function isAdmin() { return currentRole() === 'admin'; }

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
    if (sess && sess.user) {
      state.auth.user = sess.user; await loadProfile(sess.user.id);
      // First sign-in in auth mode: pull the board now that RLS lets us
      if (authModeOn() && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
        try { await sbLoadData(client); } catch (e) { console.warn('post-signin data load failed:', e); }
      }
    } else { state.auth.user = null; state.auth.profile = null; }
    updateUserBadge();
    if (authModeOn() && !state.auth.user && state._booted) return showAuthScreen();   // signed out mid-session
  });
  updateUserBadge();
}

async function signInEmail(email, password) {
  const client = state.sb && state.sb.client; if (!client) throw new Error('Supabase is not connected. Ask an admin.');
  const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  state.auth.user = data.user; await loadProfile(data.user.id);
  return data.user;
}
async function signUpEmail(email, password, first, last) {
  const client = state.sb && state.sb.client; if (!client) throw new Error('Supabase is not connected. Ask an admin.');
  first = (first || '').trim(); last = (last || '').trim();
  if (!first || !last) throw new Error('Enter both a first and last name.');
  const fullName = first + ' ' + last;
  const { data, error } = await client.auth.signUp({
    email: email.trim(), password,
    // full_name feeds the handle_new_user trigger → profiles.full_name (what the app shows).
    options: { data: { full_name: fullName, first_name: first, last_name: last } }
  });
  if (error) throw error;
  return data;   // if Confirm email is on, data.session is null until they click the link
}

async function signOutUser() {
  const client = state.sb && state.sb.client; if (!client) return;
  await client.auth.signOut();
  state.auth.user = null; state.auth.profile = null;
  if (authModeOn()) showAuthScreen(); else location.reload();
}

function showAuthScreen(err, mode, info) {
  mode = mode || 'signin';   // 'signin' | 'signup'
  let g = $('#gateScreen');
  if (!g) { g = document.createElement('div'); g.id = 'gateScreen'; g.className = 'gate-screen'; document.body.appendChild(g); }
  const logoSrc = (document.querySelector('.brand-logo') || {}).src || '';
  const isSignup = mode === 'signup';
  g.innerHTML = `<div class="gate-card auth-card">
      <img class="gate-logo" src="${logoSrc}" alt="KIPP">
      <h1>Network Growth Hub</h1>
      <p>${isSignup ? 'Create your account with a KIPP work email.' : 'Sign in with your work email.'}</p>
      <div class="auth-tabs">
        <button type="button" class="auth-tab ${!isSignup ? 'on' : ''}" data-authmode="signin">Sign in</button>
        <button type="button" class="auth-tab ${isSignup ? 'on' : ''}" data-authmode="signup">Create account</button>
      </div>
      <form id="authForm" autocomplete="on">
        ${isSignup ? '<div class="auth-namerow"><input id="authFirst" type="text" placeholder="First name" autocomplete="given-name" required><input id="authLast" type="text" placeholder="Last name" autocomplete="family-name" required></div>' : ''}
        <input id="authEmail" type="email" placeholder="Email (@kippnj.org, @kippteamandfamily.org, @kippmiami.org)" autocomplete="username" required autofocus>
        <input id="authPw" type="password" placeholder="Password (12+ chars)" autocomplete="${isSignup ? 'new-password' : 'current-password'}" required minlength="6">
        <button type="submit" class="btn btn-filled" id="authSubmit">${isSignup ? 'Create account' : 'Sign in'}</button>
      </form>
      ${err ? `<div class="gate-err">${esc(err)}</div>` : ''}
      ${info ? `<div class="gate-info">${esc(info)}</div>` : ''}
      <div class="auth-foot">${isSignup ? 'After signup, verify via the email we send. You start as a viewer; an admin can promote you.' : 'Only KIPP work emails can create accounts.'}</div>
    </div>`;
  g.querySelectorAll('[data-authmode]').forEach(b => b.addEventListener('click', () => showAuthScreen(null, b.dataset.authmode)));
  const f = $('#authForm'), sub = $('#authSubmit');
  f.addEventListener('submit', async e => {
    e.preventDefault();
    sub.disabled = true; sub.textContent = isSignup ? 'Creating…' : 'Signing in…';
    try {
      if (isSignup) {
        const first = ($('#authFirst').value || '').trim(), last = ($('#authLast').value || '').trim();
        if (!first || !last) {
          sub.disabled = false; sub.textContent = 'Create account';
          let ie = $('#authInlineErr'); const msg = 'Enter both a first and last name.';
          if (ie) { ie.textContent = msg; } else { ie = document.createElement('div'); ie.id = 'authInlineErr'; ie.className = 'gate-err'; ie.textContent = msg; f.after(ie); }
          (first ? $('#authLast') : $('#authFirst')).focus();
          return;
        }
        const res = await signUpEmail($('#authEmail').value, $('#authPw').value, first, last);
        if (res.session) {
          g.remove();
          if (!state._booted) { state._booted = true; bootApp(); } else { updateUserBadge(); rerender(); toast('Account created', 'ok'); }
        } else {
          showAuthScreen(null, 'signin', 'Account created - check your email for the verification link, then sign in.');
        }
      } else {
        await signInEmail($('#authEmail').value, $('#authPw').value);
        g.remove();
        if (!state._booted) { state._booted = true; bootApp(); } else { updateUserBadge(); rerender(); toast('Signed in', 'ok'); }
      }
    } catch (ex) {
      sub.disabled = false; sub.textContent = isSignup ? 'Create account' : 'Sign in';
      showAuthScreen(ex.message || (isSignup ? 'Signup failed.' : 'Sign-in failed. Check your email and password.'), mode);
    }
  });
  setTimeout(() => { const i = $(isSignup ? '#authFirst' : '#authEmail'); if (i && !i.value) i.focus(); }, 30);
}

/* ============================================================
   Level-up polish (Aug 22 2026): avatar palette, greeting,
   personalized My-tasks + inline Activity, rich user chip
   ============================================================ */
const _AVATAR_PAL = ['#16357F','#B03A5B','#0F7B6C','#8A5B14','#7A3A9B','#0B4E7F','#B04E00','#3A6B14','#5B2A85','#9B2C55','#155F8A','#7B4600','#0E5D9E','#7B1E3C'];
function avatarColor(seed) { if (!seed) return '#75778B'; let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0; return _AVATAR_PAL[Math.abs(h) % _AVATAR_PAL.length]; }
function paintAvatars(root) {
  (root || document).querySelectorAll('.owner-avatar:not(.unassigned):not(.painted), .dact-avatar:not(.painted), .cb-user-avatar:not(.painted)').forEach(el => {
    const seed = el.getAttribute('data-seed') || el.textContent || '';
    if (!seed) return;
    el.style.background = avatarColor(seed); el.style.color = '#fff'; el.classList.add('painted');
  });
}
function timeGreeting() { const h = new Date().getHours(); return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
function currentDisplayName() { const p = currentProfile(); return (p && (p.full_name || p.email)) || lsGet('ngc_author') || ''; }
function currentRoleLabel() { const p = currentProfile(); if (p && p.role) return p.role; return 'Editor'; }

function updateUserBadge() {
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
    <svg class="sp-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
  btn.title = name ? `${name} · ${role}\nClick for menu` : 'Set your name';
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
    const openings = (state.data && state.data.schools || []).filter(s => s.openingFY);
    const cohorts = new Set(openings.map(s => s.openingFY)).size;
    dateEl.textContent = `${openings.length} schools · ${cohorts} cohorts`;
    line.innerHTML = `<b>Openings</b>`;
  } else if (v === 'plan') {
    const n = (state.data && state.data.milestones || []).length;
    dateEl.textContent = `${n} milestones`;
    line.innerHTML = `<b>Project Plan</b>`;
  } else {
    const first = (currentDisplayName() || '').split(/\s+/)[0];
    dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    line.innerHTML = first ? `${esc(timeGreeting())}, <b>${esc(first)}</b>` : `<b>Welcome</b>`;
  }
}

function openUserMenu(anchor) {
  const p = currentProfile(); if (!p) return;
  closePopover();
  const html = `<div class="user-menu">
      <div class="um-head"><div class="um-name">${esc(p.full_name || p.email)}</div><div class="um-email">${esc(p.email || '')}</div><div class="um-role">Role: <b>${esc(p.role || 'viewer')}</b></div></div>
      <div class="um-actions">
        <button class="um-item" id="umSignOut">Sign out</button>
      </div>
    </div>`;
  const pop = openPopover(anchor, html);
  pop.querySelector('#umSignOut').addEventListener('click', () => { closePopover(); signOutUser(); });
}

/* ---------- shared-password gate (legacy fallback when authMode !== 'supabase') ---------- */
function pwHash(str) { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909); return String(4294967296 * (2097151 & h2) + (h1 >>> 0)); }
function gateOn() { return !!(meta().gateEnabled && meta().gateHash); }
async function gateStart() {
  if (authModeOn()) {
    // Supabase auth mode - needs an active session, not a shared password.
    // sbConnect (from saved cfg) is fired async by bootApp normally; here we need it BEFORE gating.
    let sc = sbSavedCfg();
    if ((!sc || !sc.url || !sc.key) && SB_DEFAULT.url && SB_DEFAULT.key) sc = SB_DEFAULT;
    if (!sc || !sc.url || !sc.key) return showAuthConfigNeeded();
    if (!state.sb.connected) { await sbConnect(sc.url, sc.key, true); }
    // bootstrapAuth (called from sbConnect on success) has now populated state.auth if there's a session
    if (state.auth.user) { state._booted = true; return bootApp(); }
    return showAuthScreen();
  }
  if (!gateOn() || lsGet(LS.gate) === String(meta().gateHash)) return bootApp();
  showGate();
}
function showAuthConfigNeeded() {
  let g = $('#gateScreen');
  if (!g) { g = document.createElement('div'); g.id = 'gateScreen'; g.className = 'gate-screen'; document.body.appendChild(g); }
  g.innerHTML = `<div class="gate-card auth-card">
      <img class="gate-logo" src="${(document.querySelector('.brand-logo') || {}).src || ''}" alt="KIPP">
      <h1>Setup needed</h1>
      <p>Account mode is on, but Supabase isn't configured yet. An admin must connect Supabase in Settings first.</p>
    </div>`;
}
function showGate(err) {
  let g = $('#gateScreen');
  if (!g) { g = document.createElement('div'); g.id = 'gateScreen'; g.className = 'gate-screen'; document.body.appendChild(g); }
  g.innerHTML = `<div class="gate-card">
      <img class="gate-logo" src="${(document.querySelector('.brand-logo') || {}).src || ''}" alt="KIPP">
      <h1>Network Growth Hub</h1>
      <p>Enter the password.</p>
      <form id="gateForm" autocomplete="off"><input id="gatePw" type="password" placeholder="Password" autofocus>
        <button type="submit" class="btn btn-filled">Unlock</button></form>
      ${err ? '<div class="gate-err">Incorrect password. Try again.</div>' : ''}
    </div>`;
  const f = $('#gateForm'), inp = $('#gatePw');
  f.addEventListener('submit', e => { e.preventDefault(); const v = inp.value; if (pwHash(v) === String(meta().gateHash)) { lsSet(LS.gate, String(meta().gateHash)); g.remove(); bootApp(); } else { showGate(true); } });
  setTimeout(() => { const i = $('#gatePw'); if (i) i.focus(); }, 30);
}
function lockNow() { lsDel(LS.gate); location.reload(); }
/* admin gate - protects the ⚙ Settings drawer (admin-only) */
function adminOn() { return !!(meta().adminEnabled && meta().adminHash); }
function promptPassword(opts) {
  closeConfirm();
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  w.innerHTML = `<div class="confirm-box"><div class="confirm-ic">🔒</div><h3>${esc(opts.title)}</h3>
    ${opts.message ? `<div class="confirm-msg">${esc(opts.message)}</div>` : ''}
    <input id="pwPromptInput" type="password" class="pw-prompt" placeholder="${esc(opts.placeholder || 'Password')}" autocomplete="off">
    <div class="pw-prompt-err hide" id="pwPromptErr">That password didn't match.</div>
    <div class="confirm-actions"><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn btn-filled" id="cfgOk">${esc(opts.confirmLabel || 'Unlock')}</button></div></div>`;
  document.body.appendChild(w);
  const input = $('#pwPromptInput');
  const submit = () => { if (opts.verify(input.value)) { closeConfirm(); opts.onOk && opts.onOk(); } else { $('#pwPromptErr').classList.remove('hide'); input.select(); } };
  w.addEventListener('click', e => { if (e.target === w || e.target.id === 'cfgCancel') closeConfirm(); else if (e.target.id === 'cfgOk') submit(); });
  w.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  setTimeout(() => input.focus(), 40);
}
function saveAdminSettings() {
  const enabled = $('#adminEnable').checked, pw = ($('#adminNew').value || '').trim();
  meta().adminEnabled = enabled;
  if (pw) meta().adminHash = pwHash(pw);
  if (enabled && !meta().adminHash) { meta().adminEnabled = false; $('#adminStatus').innerHTML = '<div class="status-note err">Set a password first.</div>'; return; }
  autosave();
  $('#adminStatus').innerHTML = `<div class="status-note ok">✓ Saved${pw ? ' - new admin password set' : ''}. Commit/Export so it applies for you everywhere.</div>`;
  const nb = $('#adminNew'); if (nb) nb.value = '';
}
function saveGateSettings() {
  const enabled = $('#gateEnable').checked, pw = ($('#gateNew').value || '').trim();
  meta().gateEnabled = enabled;
  if (pw) { meta().gateHash = pwHash(pw); lsSet(LS.gate, String(meta().gateHash)); }
  if (!meta().gateHash) { meta().gateEnabled = false; $('#gateStatus').innerHTML = '<div class="status-note err">Set a password first.</div>'; return; }
  autosave();
  $('#gateStatus').innerHTML = `<div class="status-note ok">✓ Saved${pw ? ' - new password set' : ''}. ${enabled ? 'Password is required' : 'Gate is off'}. Commit or Export so everyone gets it.</div>`;
  const nb = $('#gateNew'); if (nb) nb.value = '';
}

/* ============================================================
   UNDO STACK - snapshot before each mutation, Cmd+Z to restore
   ============================================================ */
const undoStack = [];
const UNDO_LIMIT = 30;
function snapshotForUndo(label) {
  undoStack.push({ label, snapshot: JSON.parse(JSON.stringify(state.data)), ts: Date.now() });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}
function undo() {
  if (!undoStack.length) { toast('Nothing to undo'); return; }
  const entry = undoStack.pop();
  state.data = entry.snapshot;
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
    state.auditFeed = data || [];
    return state.auditFeed;
  } catch (e) { console.warn('Team activity (audit) fetch failed - using local log:', e.message || e); return null; }
}
function auditDetail(a) {
  const v = a.action === 'insert' ? 'Created' : a.action === 'delete' ? 'Deleted' : 'Updated';
  if (a.entity_type === 'milestone') { const m = findM(a.entity_id); return `${v} ${m ? '"' + m.activity + '"' : 'a milestone'}`; }
  if (a.entity_type === 'school') { const s = schoolById(a.entity_id); return `${v} ${s ? esc(s.display_label) + ' (' + esc(s.market) + ')' : 'a school'}`; }
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
    try { const n = prompt('Your name (shown on activity and edits):', ''); if (n && n.trim()) { lsSet('ngc_author', n.trim()); if (typeof updateUserBadge === 'function') updateUserBadge(); } } catch (e) {}
  }
  const author = (typeof currentDisplayName === 'function' ? currentDisplayName() : '') || lsGet('ngc_author') || '';
  log.push({ action, detail, author, ts: Date.now(), extra: extra || null });
  if (log.length > 100) log.splice(0, log.length - 100);
  try { lsSet('ngc_activity', JSON.stringify(log)); } catch (e) {}
  renderActivityPanel();
  updateActivityDot();
}
function updateActivityDot() {
  const log = getActivityLog();
  const seen = Number(lsGet('ngc_activity_seen') || 0);
  const last = log.length ? log[log.length - 1].ts : 0;
  const unseen = last > seen;
  const dot = $('#cbActivityDot'); if (dot) dot.hidden = !unseen;
  const pillDot = $('#cbPillDot'); if (pillDot) pillDot.hidden = !unseen;
}

/* ---------- Floating filter bubble: opens the real filter bar as a panel ---------- */
function updateFilterBubble() {
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
    edit:   '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    create: '<path d="M12 5v14M5 12h14"/>',
    delete: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/>',
    status: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    undo:   '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
    move:   '<path d="M5 12h14M12 5l7 7-7 7"/>'
  };
  const p = paths[action] || '<circle cx="12" cy="12" r="2"/>';
  return `<svg class="act-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
function renderActivityPanel() {
  const body = $('#activityBody'); if (!body) return;
  const log = activityEntries(50);
  const scope = activityIsTeam() ? '<div class="activity-scope">Team-wide · all signed-in members</div>' : '';
  if (!log.length) { body.innerHTML = scope + '<div class="activity-empty">No activity yet. Changes you make will appear here.</div>'; return; }
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
  cmdkItems = buildCmdkItems(q);
  if (cmdkIdx >= cmdkItems.length) cmdkIdx = 0;
  body.innerHTML = cmdkItems.map((item, i) => `<div class="cmdk-item ${i === cmdkIdx ? 'active' : ''}" data-cmdk="${i}"><span class="cmdk-ic">${item.icon}</span><div class="cmdk-label"><span class="cmdk-name">${esc(item.name)}</span>${item.hint ? `<span class="cmdk-hint">${esc(item.hint)}</span>` : ''}</div>${item.kbd ? `<kbd class="cmdk-kbd">${item.kbd}</kbd>` : ''}</div>`).join('') || '<div class="cmdk-empty">No results</div>';
}
function buildCmdkItems(q) {
  // Uniform Material outlined SVG icons (1.75 stroke, 18px). No emojis.
  const ic = (p) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const items = [];
  items.push({ icon: ic('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'), name: 'Go to Dashboard', hint: '', kbd: '', action: () => setView('progress') });
  items.push({ icon: ic('<rect x="3" y="3" width="5.5" height="18" rx="1.5"/><rect x="10.25" y="3" width="5.5" height="11" rx="1.5"/><rect x="17.5" y="3" width="3.5" height="15" rx="1.5"/>'), name: 'Go to Project Plan', hint: '', kbd: '', action: () => setView('plan') });
  items.push({ icon: ic('<rect x="3" y="4.5" width="18" height="17" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>'), name: 'Go to Openings', hint: '', kbd: '', action: () => setView('timeline') });
  items.push({ icon: ic('<path d="M12 5v14M5 12h14"/>'), name: 'New milestone', hint: '', kbd: 'N', action: () => addItem() });
  items.push({ icon: ic('<path d="M3 21V9l9-7 9 7v12h-6v-6h-6v6H3z"/>'), name: 'Add school opening', hint: '', kbd: '', action: () => openSchoolModal(null) });
  items.push({ icon: ic('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>'), name: 'Undo last change', hint: undoStack.length ? undoStack[undoStack.length - 1].label : 'nothing to undo', kbd: '⌘Z', action: () => undo() });
  items.push({ icon: ic('<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/>'), name: 'Print / PDF', hint: '', kbd: '', action: () => window.print() });
  items.push({ icon: ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'), name: 'Open settings', hint: '', kbd: '', action: () => { const s = $('#settingsBtn'); if (s) s.click(); } });
  items.push({ icon: ic('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'), name: 'Activity log', hint: '', kbd: '⌃⇧A', action: () => toggleActivity() });

  // Nav/action commands filter on the query text; search results are matched separately.
  const ql = (q || '').toLowerCase();
  const nav = !q ? items : items.filter(it => it.name.toLowerCase().includes(ql) || (it.hint || '').toLowerCase().includes(ql));
  if (ql.length < 2 || !state.data) return nav;

  // ---- Universal search: milestones, school openings, and owners ----
  const results = [];
  const mIc = ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>');
  const sIc = ic('<path d="M3 21V9l9-7 9 7v12h-6v-6h-6v6H3z"/>');
  const oIc = ic('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/>');
  const mils = (state.data.milestones ? M() : []);
  mils.filter(m => `${m.activity} ${m.owner} ${m.market} ${m.functional_area} ${m.workstream || ''} ${(m.tags || []).join(' ')} ${m.notes || ''}`.toLowerCase().includes(ql))
    .slice(0, 6).forEach(m => results.push({ icon: mIc, name: m.activity, hint: `Milestone · ${m.market} · ${m.functional_area}${m.owner ? ' · ' + m.owner : ''}`, kbd: '', action: () => openModal(m.id) }));
  (state.data.schools || []).filter(s => `${s.display_label || ''} ${s.code || ''} ${s.market || ''} ${s.state || ''} ${fyLabel(s.openingFY)}`.toLowerCase().includes(ql))
    .slice(0, 6).forEach(s => results.push({ icon: sIc, name: `${s.market} · ${s.display_label}`, hint: `School opening · ${fyLabel(s.openingFY)}`, kbd: '', action: () => openSchoolModal(s.id) }));
  [...new Set(mils.map(m => m.owner).filter(Boolean))].filter(o => o.toLowerCase().includes(ql)).slice(0, 5).forEach(o => {
    const n = mils.filter(m => m.owner === o).length;
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
    const inInput = e.target.matches('input, textarea, select, [contenteditable]');
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
function autosaveWithUndo(label) {
  if (label) { _lastSaveLabel = label; snapshotForUndo(label); logActivity('edit', label); }
  _origAutosave();
}

async function init() {
  document.documentElement.setAttribute('data-theme', 'light');
  if (lsGet('ngc_nav') === '1') { document.body.classList.add('nav-collapsed'); const nt = $('#navToggle'); if (nt) { nt.title = 'Expand menu'; const lbl = nt.querySelector('.nav-util-lbl'); if (lbl) lbl.textContent = 'Expand'; } }
  const data = await loadData(); if (!data) return; state.data = data;
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
      const name = prompt('Your name (shown on edits):', lsGet('ngc_author') || '');
      if (name !== null) { lsSet('ngc_author', name.trim()); updateUserBadge(); }
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
        document.body.classList.toggle('header-pinned', window.scrollY > 60);
        ticking = false;
      });
      ticking = true;
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Floating bubbles: search (universal ⌘K), filters, alerts.
  const pillSearch = $('#cbPillSearch'); if (pillSearch) pillSearch.addEventListener('click', () => openCmdk());
  const pillAct = $('#cbPillActivity'); if (pillAct) pillAct.addEventListener('click', toggleActivity);
  const pillFilter = $('#cbPillFilter'); if (pillFilter) pillFilter.addEventListener('click', e => { e.stopPropagation(); toggleFilterPanel(); });
  const cbApp = document.querySelector('.cb-app');
  if (cbApp) { cbApp.style.cursor = 'pointer'; cbApp.title = 'Return to Dashboard (clears filters)'; cbApp.addEventListener('click', () => { clearFilters(); setView('progress'); }); }
  const cbPage = $('#cbPage');
  if (cbPage) { cbPage.style.cursor = 'pointer'; cbPage.title = 'Clear active filters on this view'; cbPage.addEventListener('click', () => { if (activeCount()) { clearFilters(); rerender(); toast('Filters cleared', 'ok'); } }); }
}
function bootApp() {
  // Clear any loading skeleton painted by index.html or a prior boot attempt.
  const sk = document.getElementById('bootSkeleton'); if (sk) sk.remove();
  wireEvents();
  wireCmdk();
  wireKeyboard();
  initContentBar();
  const ab = $('#activityBtn'); if (ab) ab.addEventListener('click', toggleActivity);
  const cbAb = $('#cbActivityBtn'); if (cbAb) cbAb.addEventListener('click', toggleActivity);
  updateGreeting();
  const ac = $('#activityClose'); if (ac) ac.addEventListener('click', toggleActivity);
  renderActivityPanel();
  updateActivityDot();
  window.addEventListener('popstate', () => setView((location.hash || '').replace('#', '') || 'progress', true));
  const initial = (location.hash || '').replace('#', '');
  setView(VIEWS.includes(initial) ? initial : 'progress', true);
  if (!location.hash) { try { history.replaceState({ v: state.view }, '', '#' + state.view); } catch (e) {} }
  let sc = sbSavedCfg(); if (SB_DEFAULT.url && (!sc || sc.url === SB_DEFAULT.url)) sc = SB_DEFAULT;
  // In auth mode, gateStart already connected via sbConnect. Avoid a second connect that would recreate the client.
  if (sc && sc.url && sc.key && !state.sb.connected) sbConnect(sc.url, sc.key, true);
}
document.addEventListener('DOMContentLoaded', init);
