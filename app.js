/* ============================================================
   School Opening Timeline & Project Management
   3-tab tool per implementation spec.
   Vanilla JS · auto-save · optional Supabase live sync.
   ============================================================ */
'use strict';

const LS = { theme: 'ngc_theme', data: 'ngc_data', gh: 'ngc_gh', supabase: 'ngc_supabase', ui: 'ngc_ui', gate: 'ngc_gate' };
/* Safe storage — sandboxed iframes (e.g. the published artifact) throw on any localStorage access.
   Never let that break app init / event wiring. */
function lsGet(k) { try { return lsGet(k); } catch (e) { return null; } }
function lsSet(k, v) { try { lsSet(k, v); return true; } catch (e) { return false; } }
function lsDel(k) { try { lsDel(k); } catch (e) {} }

const state = {
  data: null,
  view: 'progress',              // progress(dashboard) | timeline | plan
  planGroup: 'team',             // team | stage | market | year | school  (default: Workstream)
  planFocus: false,              // "Needs attention" quick filter (overdue/due-soon/behind)
  progressView: 'charts',        // charts | list
  progressDim: 'team',           // team | year | market | school | state
  expanded: {},                  // progress section/item expand map
  filters: { states: new Set(), fys: new Set(), types: new Set(), areas: new Set(), markets: new Set(), statuses: new Set(), priorities: new Set(), openingFYs: new Set(), schoolId: '', search: '', timing: '' },
  sb: { connected: false, client: null },
  adminUnlocked: false,
};

/* ---------- palette (spec colors) ---------- */
const STATE_COLOR = { NJ: '#16357F', FL: '#1B6EA5' };
const MARKET_COLOR = { Paterson: '#E1523D', 'Miami-Dade': '#F5A623', Broward: '#D98C10', Newark: '#57C0E9', Orange: '#12357F', Orlando: '#12357F', Camden: '#A4CE4E' };
const TYPE_COLOR = { ES: '#1B6EA5', MS: '#C77400', HS: '#5F3DC4' };
const mkColor = m => MARKET_COLOR[m] || '#5A6B8C';
const stColor = s => STATE_COLOR[s] || '#5A6B8C';
const PRIORITY = { high: { label: 'High', color: '#D62828' }, medium: { label: 'Medium', color: '#FFA500' }, low: { label: 'Low', color: '#6C757D' } };

/* ---------- utils ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const uid = () => Math.random().toString(36).slice(2, 12);
function fyLabel(fy) { return fy ? `${String(fy - 1).slice(-2)}–${String(fy).slice(-2)}` : '—'; }
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
function fmtDate(s) { const d = parseDate(s); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
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
  const items = (log || []).slice().sort((a, b) => a.t - b.t).map(noteItemHtml).join('') || '<div class="note-empty muted">No notes yet — add the first update.</div>';
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
  if (t === 'overdue') return `<span class="due-badge overdue">⚑ Overdue ${Math.abs(d)}d</span>`;
  if (t === 'this_month') return `<span class="due-badge month">⏰ Due this month</span>`;
  if (t === 'soon') return `<span class="due-badge soon">In ${d}d</span>`;
  return '';
}

/* ---------- data load / save ---------- */
async function loadData() {
  let base;
  if (window.__EMBEDDED_DATA__) base = JSON.parse(JSON.stringify(window.__EMBEDDED_DATA__));
  else { try { base = await (await fetch('data.json', { cache: 'no-store' })).json(); } catch (e) { $('.container').innerHTML = '<div class="empty-state">Could not load <span class="mono">data.json</span>. Run a local server (see README).</div>'; return null; } }
  try { const s = JSON.parse(lsGet(LS.data) || 'null'); if (s && s.milestones && s.__baseVersion === (base.meta && base.meta.version)) base = s; } catch (e) {}
  return base;
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
const schoolMs = s => M().filter(m => (m.schools || []).includes(s.code) && m.openingFY === s.openingFY && m.market === s.market);

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
  if (f.schoolId) { const sc = state.data.schools.find(x => x.id === f.schoolId); if (!sc || !((m.schools || []).includes(sc.code) && m.market === sc.market && m.openingFY === sc.openingFY)) return false; }
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
function clearFilters() { ['states', 'fys', 'types', 'areas', 'markets', 'statuses', 'priorities', 'openingFYs'].forEach(k => state.filters[k].clear()); state.filters.schoolId = ''; state.filters.search = ''; state.filters.timing = ''; }
/* which opening cohorts (fiscal years) to display — empty = show all */
function openingYears() { return [...new Set(state.data.schools.filter(s => s.openingFY).map(s => s.openingFY))].sort((a, b) => a - b); }
function oyShown(fy) { return !state.filters.openingFYs.size || state.filters.openingFYs.has(fy); }
function toggleOpeningYear(fy) { const all = openingYears(), f = state.filters.openingFYs; if (!f.size) all.forEach(y => f.add(y)); f.has(fy) ? f.delete(fy) : f.add(fy); if (f.size === all.length) f.clear(); }

/* ============================================================
   TAB 1 — SCHOOL OPENING TIMELINE (Gantt)
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
  const search = opts.search ? `<div class="fb-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="fSearch" autocomplete="off" placeholder="Search…" value="${esc(state.filters.search)}"></div>` : '';
  const btns = menus.map(k => { const n = state.filters[k].size; return `<button class="fb-menu ${n ? 'on' : ''}" data-fmenu="${k}"><span>${FILTER_LABEL[k]}</span>${n ? `<span class="fb-count">${n}</span>` : ''}<svg class="fb-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6"><path d="m6 9 6 6 6-6"/></svg></button>`; }).join('');
  const school = opts.school ? `<select id="dashSchool" class="fb-select"><option value="">All schools</option>${state.data.schools.filter(s => s.openingFY && schoolFacetPass(s, null) && (!state.filters.fys.size || state.filters.fys.has(s.openingFY))).sort((a, b) => (a.openingFY - b.openingFY) || a.market.localeCompare(b.market)).map(s => `<option value="${s.id}" ${state.filters.schoolId === s.id ? 'selected' : ''}>${esc(s.display_label)} · ${esc(s.market)}</option>`).join('')}</select>` : '';
  return `<div class="filterbar" id="filterbar"><span class="fb-label">Filters</span>${search}${btns}${school}<button class="fb-clear ${activeCount() ? '' : 'hide'}" id="clearFilters">Clear all</button><span class="fb-spacer"></span>${opts.right || ''}</div>`;
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
    if (k === 'states' || k === 'markets' || k === 'fys') { rerender(); const btn = $(`.fb-menu[data-fmenu="${k}"]`); if (btn) openFilterMenu(btn, k); else closePopover(); }
    else { updateMenuBadge(k); refreshBody(); }
  });
}
function updateMenuBadge(key) {
  const btn = $(`.fb-menu[data-fmenu="${key}"]`);
  if (btn) { const n = state.filters[key].size; btn.classList.toggle('on', !!n); let c = btn.querySelector('.fb-count'); if (n) { if (!c) { c = document.createElement('span'); c.className = 'fb-count'; btn.insertBefore(c, btn.querySelector('.fb-chev')); } c.textContent = n; } else if (c) c.remove(); }
  const cl = $('#clearFilters'); if (cl) cl.classList.toggle('hide', !activeCount());
}
function refreshBody() { const sec = $('#view-' + state.view); const b = sec ? sec.querySelector('#viewBody') : $('#viewBody'); if (!b) return rerender(); if (state.view === 'timeline') b.innerHTML = ganttBodyHtml(); else if (state.view === 'progress') b.innerHTML = progressBodyHtml(); else b.innerHTML = planBodyHtml(); }
function otCard(s) {
  const sm = schoolMs(s), r = ragReady(sm), n = sm.length;
  return `<article class="ot-card" data-drillschool="${esc(s.id)}" style="--mk:${mkColor(s.market)}" title="Open ${esc(s.display_label)} — ${esc(s.market)}">
      <div class="ot-card-h"><span class="state-badge sm" style="background:${stColor(s.state)}">${esc(s.state)}</span><b>${esc(s.display_label)}</b><span class="ot-type">${esc(s.school_type)}</span><span class="ot-rag" style="background:${r.color}" title="${esc(r.label)}"></span></div>
      <div class="ot-card-mkt"><i style="background:${mkColor(s.market)}"></i>${esc(s.market)}</div>
      <div class="ot-card-f"><span>Opens August ${s.openingFY - 1}</span><span class="muted">${n} task${n === 1 ? '' : 's'}</span></div>
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
    <div class="ot-legend"><span><i class="rag" style="background:${RAG.none}"></i>Not started</span><span><i class="rag" style="background:${RAG.blue}"></i>In progress</span><span><i class="rag" style="background:${RAG.yellow}"></i>At risk</span><span><i class="rag" style="background:${RAG.red}"></i>Behind</span><span><i class="rag" style="background:${RAG.green}"></i>Cleared</span><span class="muted">· click a school to open its tasks</span></div>`;
}
function renderTimeline() {
  $('#view-timeline').innerHTML = `
    <div class="view-head"><div><h2>Openings Timeline</h2></div>
      <button class="btn btn-filled" id="addSchool"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>Add school opening</button>
    </div>
    ${filterBar(['states', 'markets', 'types'])}
    ${openingYearBar()}
    <div id="viewBody">${ganttBodyHtml()}</div>`;
}

/* ============================================================
   TAB 2 — PROGRESS MONITORING (collapsible)
   ============================================================ */
function isExp(k) { return !!state.expanded[k]; }
function chev(open) { return `<svg class="chev ${open ? 'open' : ''}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m9 18 6-6-6-6"/></svg>`; }

function pmItem(m) {
  const open = isExp('it:' + m.id), es = effectiveStatus(m), pcol = SM(es).color;
  return `<div class="pm-item">
    <div class="pm-item-head" data-toggle="it:${m.id}">
      ${chev(open)}${statusDot(es)}
      <span class="pm-title">${m.keyMilestone ? '★ ' : ''}${esc(m.activity)}<span class="dept-chip">${esc(m.functional_area)}</span></span>
      ${personChip(m.owner, 'pchip-sm')}
      <span class="pm-due">${dueBadge(m) || (m.due_date ? `<span class="due-ok">${fmtDate(m.due_date)}</span>` : '<span class="muted">—</span>')}</span>
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
  else if (dim === 'school') { state.data.schools.forEach(s => { const l = list.filter(m => (m.schools || []).includes(s.code) && m.market === s.market && m.openingFY === s.openingFY); if (l.length) g.push({ name: s.display_label + ' · ' + s.market, val: s.id, color: mkColor(s.market), list: l, school: s }); }); g.sort((a, b) => ((a.school && a.school.openingFY) || 9999) - ((b.school && b.school.openingFY) || 9999)); }
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
  return `<div class="colchart">` + fys.map(fy => { const l = map[fy], c = effCounts(l); return `<div class="col drill" data-drilldim="year" data-drillval="${fy}" title="Click to see FY ${fyLabel(fy)} items"><div class="col-n">${l.length}</div><div class="col-bar" style="height:${Math.max(6, 100 * l.length / max)}%">${STATUS_ORDER.filter(s => c[s]).map(s => `<span style="height:${100 * c[s] / l.length}%;background:${SM(s).color}" title="${SM(s).label}: ${c[s]}"></span>`).join('')}</div><div class="col-lbl">${fyLabel(fy)}</div></div>`; }).join('') + `</div>`;
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
  const isCharts = state.progressView === 'charts';
  const toggle = `<div class="segmented"><button class="seg ${isCharts ? 'on' : ''}" data-progressview="charts"><span>Dashboard</span></button><button class="seg ${!isCharts ? 'on' : ''}" data-progressview="list"><span>Detailed View</span></button></div>`;
  const printBtn = isCharts ? `<button class="btn btn-tonal" id="dashPrint"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/></svg>Print / PDF</button>` : '';
  $('#view-progress').innerHTML = `
    <div class="view-head"><div><h2>Dashboard</h2></div><div class="vh-actions">${toggle}${printBtn}</div></div>
    ${isCharts ? northStarHtml() : ''}
    ${filterBar(['states', 'markets', 'areas', 'statuses'], { school: true })}
    ${openingYearBar()}
    <div id="viewBody">${progressBodyHtml()}</div>`;
}

/* ============================================================
   TAB 3 — PROJECT PLAN (Kanban)
   ============================================================ */
function planCard(m) {
  const es = effectiveStatus(m), t = timingLevel(m), scol = SM(es).color;
  const urgent = t === 'overdue' || t === 'this_month';
  const nc = (m.noteLog || []).length;
  return `<div class="kcard ${urgent ? 'urgent' : ''}" draggable="true" data-id="${m.id}" style="border-left-color:${scol}">
    <div class="kc-top"><span class="kc-title" data-expand="${m.id}">${esc(m.activity)}</span></div>
    <div class="kc-foot">${personChip(m.owner)}<span class="kc-foot-r">${nc ? `<span class="kc-notes" title="${nc} note${nc === 1 ? '' : 's'}">💬 ${nc}</span>` : ''}<span class="kc-due">${dueBadge(m) || (m.due_date ? fmtDate(m.due_date) : '')}</span></span></div>
  </div>`;
}
function planFocusHtml() {
  const list = filtered().filter(m => ['overdue', 'this_month'].includes(timingLevel(m)) || ['behind', 'at_risk'].includes(effectiveStatus(m)));
  if (!list.length) return '<div class="empty-state">Nothing needs attention right now — no overdue, due-soon, or off-track tasks in this filter.</div>';
  const rank = m => timingLevel(m) === 'overdue' ? 0 : effectiveStatus(m) === 'behind' ? 1 : timingLevel(m) === 'this_month' ? 2 : 3;
  list.sort((a, b) => rank(a) - rank(b) || (parseDate(a.due_date) || 9e15) - (parseDate(b.due_date) || 9e15));
  return `<div class="plan-focus-note">${list.length} task${list.length === 1 ? '' : 's'} overdue, due this month, or off-track — sorted by urgency.</div><div class="plan-cards">${list.map(planCard).join('')}</div>`;
}
function planKanbanHtml() {
  const list = filtered();
  return '<div class="kanban">' + meta().stages.map(([sk, label]) => {
    const cards = list.filter(m => (m.stage || 'to_do') === sk);
    const ck = 'kc:' + sk, open = !state.expanded[ck];
    return `<div class="kcol ${open ? '' : 'collapsed'}"><div class="kcol-head stage-${sk}" data-toggle="${esc(ck)}" title="${open ? 'Collapse' : 'Expand'} column"><span class="kcol-name">${esc(label)}</span><span class="kcount">${cards.length}</span></div>
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
    if (gb === 'school') { const s = state.data.schools.find(x => (m.schools || []).includes(x.code) && x.market === m.market && x.openingFY === m.openingFY); return s ? s.display_label + ' · ' + s.market : 'Not tied to a school'; }
    return m.functional_area;
  };
  list.forEach(m => { const k = keyOf(m) || '—'; (g[k] = g[k] || []).push(m); });
  const keys = Object.keys(g).sort((a, b) => gb === 'year' ? (order[a] || 9999) - (order[b] || 9999) : a.localeCompare(b));
  if (!keys.length) return '<div class="empty-state">No tasks match the filters.</div>';
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
  const focusBtn = `<button class="btn btn-focus ${state.planFocus ? 'on' : ''}" id="planFocus" title="Show only overdue, due-soon, and off-track tasks">Needs attention${focusN ? ` <span class="focus-n">${focusN}</span>` : ''}</button>`;
  const viewSel = `<label class="tb-group ${state.planFocus ? 'is-dim' : ''}">Group by
    <select id="planGroupSel" ${state.planFocus ? 'disabled' : ''}>${[['team', 'Workstream'], ['school', 'School opening'], ['market', 'Market'], ['year', 'Year'], ['stage', 'Kanban (stages)']].map(([v, l]) => `<option value="${v}" ${state.planGroup === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const expandBtns = (!state.planFocus && state.planGroup !== 'stage') ? `<button class="btn btn-ghost btn-sm" id="planExpandAll">Expand all</button><button class="btn btn-ghost btn-sm" id="planCollapseAll">Collapse all</button>` : '';
  const right = `${focusBtn}${viewSel}${expandBtns}<button class="btn btn-filled" id="newItem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>New task</button>`;
  $('#view-plan').innerHTML = `
    <div class="view-head"><div><h2>Project Plan</h2></div></div>
    ${filterBar(['states', 'markets', 'fys', 'areas'], { search: true, school: true, right })}
    <div id="viewBody">${planBodyHtml()}</div>`;
}

/* ============================================================
   EDIT ENGINE + cross-tab
   ============================================================ */
function rerender() { if (state.view === 'timeline') renderTimeline(); else if (state.view === 'progress') renderProgress(); else renderPlan(); }

/* ============================================================
   TAB 0 — EXECUTIVE SUMMARY (board / chiefs readout, print-ready)
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
function ragDot(st, title) { const c = st === 'x' ? '#C9CDD6' : SM(st).color; return `<span class="rag" style="background:${c}" title="${esc(title || (st === 'x' ? 'no tasks' : SM(st).label))}"></span>`; }
/* consistent R/Y/G by milestone completion: <50% red · ≥50% yellow · all complete green */
/* greenlight/gating status per domain — deliberately distinct from market brand colors.
   grey = not started · blue = in progress · green = cleared (gate met) · amber/red = off-track */
const RAG = { green: '#16A34A', blue: '#2563EB', yellow: '#EAB308', red: '#DC2626', none: '#C7CCD6' };
function ragProgress(list) {
  if (!list.length) return { key: 'none', color: RAG.none, label: 'No tasks yet', pct: null };
  const done = list.filter(m => effectiveStatus(m) === 'complete').length, pctc = Math.round(100 * done / list.length);
  if (done === list.length) return { key: 'green', color: RAG.green, label: 'All complete', pct: 100 };
  if (done * 2 >= list.length) return { key: 'yellow', color: RAG.yellow, label: pctc + '% complete', pct: pctc };
  return { key: 'red', color: RAG.red, label: pctc + '% complete', pct: pctc };
}
function ragDotP(list, prefix) { const r = ragProgress(list); return `<span class="rag" style="background:${r.color}" title="${esc((prefix ? prefix + ' — ' : '') + r.label)}"></span>`; }
/* readiness = are we ON SCHEDULE (timing-aware), with % complete kept in the tooltip */
function ragReady(list) {
  if (!list.length) return { key: 'none', color: RAG.none, label: 'Not started' };
  const eff = list.map(effectiveStatus), done = eff.filter(s => s === 'complete').length, pctc = Math.round(100 * done / list.length);
  if (done === list.length) return { key: 'green', color: RAG.green, label: 'Cleared · gate met' };
  if (eff.some(s => s === 'behind' || s === 'blocked')) return { key: 'red', color: RAG.red, label: 'Behind · ' + pctc + '% cleared' };
  if (eff.some(s => s === 'at_risk')) return { key: 'yellow', color: RAG.yellow, label: 'At risk · ' + pctc + '% cleared' };
  if (eff.some(s => s === 'on_track' || s === 'complete')) return { key: 'blue', color: RAG.blue, label: 'In progress · ' + pctc + '% cleared' };
  return { key: 'none', color: RAG.none, label: 'Not started' };
}
function ragDotR(list, prefix) { const r = ragReady(list); return `<span class="rag" style="background:${r.color}" title="${esc((prefix ? prefix + ' — ' : '') + r.label)}"></span>`; }
function exLi(m, flag) { return `<div class="ex-li nodot" data-expand="${m.id}"><span class="ex-li-t">${flag || ''}${esc(m.activity)}</span><span class="ex-li-m muted">${esc(m.market)} · ${esc(m.functional_area)}</span><span class="ex-li-d muted">${m.due_date ? fmtDate(m.due_date) : ''}</span></div>`; }
// NORTH STAR — the charter's stakeholder answer, rendered ABOVE the filters so a busy exec
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
function dashboardHtml(list) {
  const schools = schoolsInView();
  const total = schools.length;
  const rags = schools.map(s => ({ s, r: ragReady(schoolMs(s)) }));
  const cnt = k => rags.filter(x => x.r.key === k).length;
  const g = cnt('green'), y = cnt('yellow'), r = cnt('red'), none = cnt('none');
  const tms = teams();
  const seg = (v, c) => v ? `<span style="flex:${v};background:${c}"></span>` : '';

  // HERO — how ready is each UPCOMING opening batch (by fiscal-year cohort)?
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
  const nextS = nextC && nextC.cs.slice().sort((a, b) => parseDate(a.opening_date) - parseDate(b.opening_date))[0];
  // charter tracks active prep from ~24 months out; further-out cohorts read as roadmap, not "0% done"
  const cohortCard = c => {
    const active = c.mo <= 24;
    const sum = c.ms.length === 0 ? 'Not yet scoped'
      : active ? `${c.prep}% of pre-opening work cleared`
      : `On the roadmap · prep begins ~${c.fy - 3}`;
    const bar = active && c.ms.length ? `<div class="dash-cohort-bar"><span style="width:${c.prep}%"></span></div>` : '';
    return `<div class="dash-cohort drill ${active ? '' : 'is-roadmap'}" data-drilldim="year" data-drillval="${c.fy}" title="See Fall ${c.fy - 1} openings">
      <div class="dash-cohort-top"><span class="dash-cohort-fy">Fall ${c.fy - 1}</span><span class="dash-cohort-mo">${c.mo <= 0 ? 'opening' : c.mo + ' mo out'}</span></div>
      <div class="dash-cohort-n">${c.cs.length} <span>school${c.cs.length === 1 ? '' : 's'}</span></div>
      <div class="dash-cohort-mkts">${esc(c.mkts.join(' · '))}</div>
      ${bar}
      <div class="dash-cohort-sum">${sum}</div></div>`;
  };
  const hero = `<section class="dash-hero">
    <div class="dash-hero-head"><div class="dash-hero-eyebrow">Upcoming school openings</div></div>
    <div class="dash-cohorts">${cohorts.map(cohortCard).join('') || '<div class="muted" style="opacity:.8">No upcoming openings in view.</div>'}</div></section>`;


  // READINESS INDEX — where every opening stands, by workstream (full width)
  const grid = statesMeta().map(st => {
    const rows = rags.filter(x => x.s.state === st.code);
    if (!rows.length) return '';
    const body = rows.map(({ s }) => {
      const sm = schoolMs(s);
      const cells = tms.map(t => { const tl = sm.filter(m => m.functional_area === t); return `<td>${tl.length ? ragDotR(tl, t) : ragDot('x')}</td>`; }).join('');
      return `<tr class="ex-grow" data-drillschool="${esc(s.id)}"><td class="ex-sch"><b>${esc(s.display_label)}</b> <span class="muted">${esc(s.market)}</span></td>
        <td class="ex-open">${esc(fyLabel(s.openingFY))}</td><td>${ragDotR(sm, 'Overall')}</td>${cells}</tr>`;
    }).join('');
    return `<tr class="ex-band"><td colspan="${3 + tms.length}"><span class="state-badge" style="background:${stColor(st.code)}">${st.code}</span> ${esc(st.name)} <span class="muted">· ${rows.length} openings</span></td></tr>${body}`;
  }).join('');
  const rOpen = !state.expanded['dash:readiness'];
  const readiness = `<section class="ex-card"><div class="ex-card-head toggle" data-toggle="dash:readiness"><div class="ex-cardhead-l">${chev(rOpen)}<h3>Greenlight Readiness</h3></div><span class="muted ex-hint">Gate status by domain · click a row to open</span></div>
    <div class="ex-card-body ${rOpen ? '' : 'hide'}"><div class="ex-legend ex-legend-top"><span><i class="rag" style="background:${RAG.none}"></i>Not started</span><span><i class="rag" style="background:${RAG.blue}"></i>In progress</span><span><i class="rag" style="background:${RAG.yellow}"></i>At risk</span><span><i class="rag" style="background:${RAG.red}"></i>Behind</span><span><i class="rag" style="background:${RAG.green}"></i>Cleared</span></div>
    <div class="ex-grid-wrap"><table class="ex-grid"><thead><tr><th>School</th><th>Opens</th><th>Overall</th>${tms.map(t => `<th class="ex-th-team"><span>${esc(t)}</span></th>`).join('')}</tr></thead><tbody>${grid}</tbody></table></div></div></section>`;

  // PRIORITIES & RISKS
  const soon = Date.now() + 90 * 864e5;
  const upcoming = list.filter(m => (m.keyMilestone || m.greenlight || m.transition) && m.due_date && parseDate(m.due_date) <= soon && effectiveStatus(m) !== 'complete')
    .sort((a, b) => parseDate(a.due_date) - parseDate(b.due_date)).slice(0, 8);
  const stuck = list.filter(m => (m.status === 'blocked' || timingLevel(m) === 'overdue') && effectiveStatus(m) !== 'complete').sort(bySortUrgency);
  const risksOpen = !state.expanded.dashrisks_collapsed;
  const pOpen = !state.expanded['dash:priorities'];
  const prCard = `<section class="ex-card"><div class="ex-card-head toggle" data-toggle="dash:priorities"><div class="ex-cardhead-l">${chev(pOpen)}<h3>Priorities &amp; Risks</h3></div></div>
    <div class="ex-card-body ${pOpen ? '' : 'hide'}"><div class="dash-block-h">Key milestones &amp; greenlights · next 90 days<span class="dash-count">${upcoming.length}</span></div>
    ${upcoming.length ? `<div class="ex-list">${upcoming.map(m => exLi(m, m.greenlight ? '◆ ' : m.transition ? '⇄ ' : '')).join('')}</div>` : '<div class="muted ex-empty">Nothing in the next 90 days.</div>'}
    <div class="dash-block-h toggle" data-toggle="dashrisks_collapsed">${chev(risksOpen)}Blocked or past due<span class="dash-count ${stuck.length ? 'bad' : ''}">${stuck.length}</span></div>
    <div class="ex-risks ${risksOpen ? '' : 'hide'}">${stuck.length ? `<div class="ex-list">${stuck.slice(0, 20).map(m => exLi(m, m.status === 'blocked' ? '⛔ ' : '')).join('')}${stuck.length > 20 ? `<div class="muted ex-empty">+ ${stuck.length - 20} more</div>` : ''}</div>` : '<div class="muted ex-empty">Nothing blocked or overdue.</div>'}</div></div></section>`;

  // GROWTH FUNDRAISING
  const camps = (state.data.campaigns || []).filter(c => !state.filters.states.size || state.filters.states.has(c.state));
  const fOpen = !state.expanded['dash:fund'];
  const capital = camps.length ? `<section class="ex-card"><div class="ex-card-head toggle" data-toggle="dash:fund"><div class="ex-cardhead-l">${chev(fOpen)}<h3>Growth Fundraising</h3></div></div><div class="ex-card-body ${fOpen ? '' : 'hide'}"><div class="ex-caps">${camps.map(c => {
    const p = c.target ? Math.min(100, Math.round(100 * c.raised / c.target)) : 0;
    return `<div class="ex-cap"><div class="ex-cap-top"><b>${esc(c.name)}</b><span>${fmtMoney(c.raised)} <span class="muted">/ ${fmtMoney(c.target)}</span></span></div>
      <div class="ex-cap-bar"><span style="width:${p}%"></span></div><div class="ex-cap-foot muted">${p}% raised</div></div>`;
  }).join('')}</div></div></section>` : '';

  // WORKLOAD — pacing across fiscal years
  const wOpen = !state.expanded['dash:workload'];
  const workload = `<section class="ex-card"><div class="ex-card-head toggle" data-toggle="dash:workload"><div class="ex-cardhead-l">${chev(wOpen)}<h3>Milestones Due by Fiscal Year</h3></div></div><div class="ex-card-body ${wOpen ? '' : 'hide'}">${columnChart(list)}</div></section>`;

  return `<div class="dash">${hero}${readiness}${prCard}<div class="ex-cols2 ex-cols-even">${capital}${workload}</div></div>`;
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
  state.progressView = 'list'; renderProgress(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
function refreshResults() { refreshBody(); }

function addItem() {
  const m = { id: uid(), state: 'NJ', market: 'Paterson', team: teams()[0], functional_area: teams()[0], workstream: 'General', activity: 'New task', schools: [], targetFY: currentFY(), targetQuarter: '', openingFY: null, due_date: null, status: 'not_started', stage: 'to_do', progress_percent: 0, priority: 'medium', owner: '', dependency: '', keyMilestone: false, greenlight: false, transition: false, notes: '', tags: [] };
  M().push(m); autosave(); openModal(m.id);
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
  modalMode = 'task'; modalId = id; const m = findM(id); if (!m) return;
  $('#modalTitle').textContent = 'Task details';
  const opt = (arr, val) => arr.map(x => Array.isArray(x) ? `<option value="${x[0]}" ${x[0] === val ? 'selected' : ''}>${esc(x[1])}</option>` : `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const schoolChecks = state.data.schools.filter(s => s.market === m.market).map(s => `<label class="field-check"><input type="checkbox" class="m-school" value="${esc(s.code)}" ${(m.schools || []).includes(s.code) ? 'checked' : ''}> ${esc(s.display_label)}</label>`).join('') || '<span class="muted">No schools in this market.</span>';
  $('#modalBody').innerHTML = `
    <div class="field"><label>Title</label><textarea id="mAct">${esc(m.activity)}</textarea></div>
    <div class="field-row"><div class="field"><label>Market / location</label><select id="mMarket">${opt(markets(), m.market)}</select></div><div class="field"><label>Workstream</label><select id="mTeam">${opt(teams(), m.functional_area)}</select></div></div>
    <div class="field"><label>Workstream</label><input id="mWs" value="${esc(m.workstream)}"></div>
    <div class="field"><label>Schools</label><div id="mSchools" class="check-box">${schoolChecks}</div></div>
    <div class="field-row"><div class="field"><label>Target FY</label><select id="mFy"><option value="">—</option>${fyList().map(fy => `<option value="${fy}" ${m.targetFY === fy ? 'selected' : ''}>${fyLabel(fy)}</option>`).join('')}</select></div><div class="field"><label>Quarter</label><select id="mQ">${opt(['', 'Q1', 'Q2', 'Q3', 'Q4'], m.targetQuarter)}</select></div></div>
    <div class="field-row"><div class="field"><label>Status (health)</label><select id="mStatus">${opt(meta().statuses.map(s => [s, SM(s).label]), m.status)}</select></div><div class="field"><label>Stage (workflow)</label><select id="mStage">${opt(meta().stages, m.stage || 'to_do')}</select></div></div>
    <div class="field-row"><div class="field"><label>Priority</label><select id="mPri">${opt([['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], m.priority)}</select></div><div class="field"><label>Progress %</label><input id="mProg" type="number" min="0" max="100" value="${m.progress_percent || 0}"></div></div>
    <div class="field-row"><div class="field"><label>Owner</label><input id="mOwner" value="${esc(m.owner)}"></div><div class="field"><label>Due date</label><input id="mDue" type="date" value="${esc(m.due_date || '')}"></div></div>
    <div class="field"><label>Dependency / blockers</label><input id="mDep" value="${esc(m.dependency)}"></div>
    <div class="field"><label>Notes / next steps</label><textarea id="mNotes">${esc(m.notes)}</textarea></div>
    <div class="field-row"><label class="field-check"><input type="checkbox" id="mKey" ${m.keyMilestone ? 'checked' : ''}> ★ Key milestone</label><label class="field-check"><input type="checkbox" id="mTrans" ${m.transition ? 'checked' : ''}> ⇄ Transition to Regional Ops</label></div>
    ${notesSection('task', m.id, m.noteLog)}`;
  $('#modalBackdrop').classList.add('open');
}
function saveModal() {
  if (modalMode === 'school') return saveSchool();
  const m = findM(modalId); if (!m) return;
  m.activity = $('#mAct').value.trim() || m.activity; m.market = $('#mMarket').value; m.state = stateOfMarket(m.market) || m.state;
  m.team = $('#mTeam').value; m.functional_area = m.team; m.workstream = $('#mWs').value.trim() || 'General';
  m.schools = $$('#mSchools .m-school').filter(x => x.checked).map(x => x.value);
  m.targetFY = $('#mFy').value ? +$('#mFy').value : null; m.targetQuarter = $('#mQ').value;
  m.status = $('#mStatus').value; m.stage = $('#mStage').value; m.priority = $('#mPri').value;
  m.progress_percent = Math.max(0, Math.min(100, +$('#mProg').value || 0));
  m.owner = $('#mOwner').value.trim(); m.due_date = $('#mDue').value || null; m.dependency = $('#mDep').value.trim();
  m.notes = $('#mNotes').value.trim(); m.keyMilestone = $('#mKey').checked; m.transition = $('#mTrans').checked;
  const os = state.data.schools.find(s => s.market === m.market && m.schools.includes(s.code)); if (os) m.openingFY = os.openingFY;
  autosave(); closeModal(); rerender(); toast('Saved', 'ok');
}
function deleteModal() {
  if (modalMode === 'school') return deleteSchool();
  if (!modalId) return; const m = findM(modalId), id = modalId;
  confirmDialog({ title: 'Delete this task?', message: `“${esc(m ? m.activity : 'this task')}” will be permanently removed.`, confirmLabel: 'Delete task', danger: true, onConfirm: () => { state.data.milestones = M().filter(x => x.id !== id); autosave(); closeModal(); rerender(); toast('Task deleted', 'ok'); } });
}
let taskReturnSchool = null;
function closeModal() { $('#modalBackdrop').classList.remove('open'); modalId = null; const ret = taskReturnSchool; taskReturnSchool = null; if (ret) setTimeout(() => openSchoolModal(ret), 0); }

/* reusable confirmation popup (native confirm() is blocked in sandboxed iframes) */
function closeConfirm() { const w = $('#confirmBackdrop'); if (w) w.remove(); }
function confirmDialog(opts) {
  closeConfirm();
  const shared = state.sb && state.sb.connected;
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  w.innerHTML = `<div class="confirm-box">
    <div class="confirm-ic ${opts.danger ? 'danger' : ''}">${opts.danger ? '⚠' : '?'}</div>
    <h3>${esc(opts.title)}</h3>
    <div class="confirm-msg">${opts.message}</div>
    ${opts.danger ? `<div class="confirm-shared">${shared ? 'This deletes it for <b>everyone</b> on the shared board' : 'This can’t be undone'} — please confirm.</div>` : ''}
    <div class="confirm-actions"><button class="btn btn-tonal" id="cfgCancel">Cancel</button><button class="btn ${opts.danger ? 'btn-danger-solid' : 'btn-filled'}" id="cfgOk">${esc(opts.confirmLabel || 'Confirm')}</button></div>
  </div>`;
  document.body.appendChild(w);
  const done = ok => { closeConfirm(); if (ok && opts.onConfirm) opts.onConfirm(); };
  w.addEventListener('click', e => { if (e.target === w || e.target.id === 'cfgCancel') done(false); else if (e.target.id === 'cfgOk') done(true); });
  setTimeout(() => { const btn = $('#cfgOk'); if (btn) btn.focus(); }, 0);
}

/* ============================================================
   SCHOOL MANAGEMENT — add / edit / remove openings + their tasks
   ============================================================ */
function schoolById(id) { return state.data.schools.find(s => s.id === id); }
function typeFromCode(code) { const m = /^([A-Za-z]+)(\d+)?/.exec(code || ''); const t = (m ? m[1] : '').toUpperCase(); return t === 'HS' ? 'HS' : t === 'ES' ? 'ES' : 'MS'; }
function openSchoolModal(id) {
  modalMode = 'school'; schoolId = id;
  const isNew = !id;
  const s = id ? schoolById(id) : { id: uid(), display_label: '', code: '', school_type: 'ES', pod_number: null, market: markets()[0], state: stateOfMarket(markets()[0]), openingFY: currentFY() + 1, openingQuarter: 'Q1', priority: false, confirmed: true, _new: true };
  $('#modalTitle').textContent = isNew ? 'Add a school opening' : `${s.display_label} — tasks & milestones`;
  const opt = (arr, val) => arr.map(x => Array.isArray(x) ? `<option value="${x[0]}" ${x[0] === val ? 'selected' : ''}>${esc(x[1])}</option>` : `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const sm = isNew ? [] : schoolMs(s);
  const roll = sm.length ? rollupStatus(sm) : 'not_started';
  const taskList = sm.length ? sm.slice().sort(bySortUrgency).map(m => `<div class="sm-task" data-expand="${m.id}">${statusDot(effectiveStatus(m))}<span class="sm-t-title">${esc(m.activity)}</span><span class="sm-t-team">${esc(m.functional_area || '')}</span><span class="sm-t-due">${dueBadge(m) || (m.due_date ? fmtDate(m.due_date) : '—')}</span></div>`).join('') : '<div class="muted" style="font-size:12.5px">No tasks yet — add the first one below.</div>';
  const summary = isNew ? '' : `<div class="sm-summary">
    <span><b>${esc(s.market)}</b> · ${esc(s.school_type)}</span><span class="muted">Opens August ${s.openingFY - 1}</span><span class="muted">${sm.length} task${sm.length === 1 ? '' : 's'}</span></div>`;
  const fyField = `<div class="field"><label>Opening fiscal year</label><select id="sFy">${fyList().map(fy => `<option value="${fy}" ${s.openingFY === fy ? 'selected' : ''}>${fyLabel(fy)}</option>`).join('')}</select></div>`;
  const qField = `<div class="field"><label>Opening quarter</label><select id="sQ">${opt(['Q1', 'Q2', 'Q3', 'Q4'], s.openingQuarter || 'Q1')}</select></div>`;
  const labelField = `<div class="field-row"><div class="field"><label>Label (e.g., ES4)</label><input id="sLabel" value="${esc(s.display_label || s.code || '')}" placeholder="ES4"></div><div class="field"><label>School type</label><select id="sType">${opt([['ES', 'Elementary (ES)'], ['MS', 'Middle (MS)'], ['HS', 'High (HS)']], s.school_type)}</select></div></div>`;
  const marketField = `<div class="field-row"><div class="field"><label>Market / location</label><select id="sMarket">${opt(markets(), s.market)}</select></div><div class="field"><label>Pod #</label><input id="sPod" type="number" min="1" value="${s.pod_number || ''}" placeholder="4"></div></div>`;
  const confField = `<label class="field-check"><input type="checkbox" id="sConf" ${s.confirmed !== false ? 'checked' : ''}> Opening confirmed</label>`;
  $('#modalBody').innerHTML = isNew ? `
    ${labelField}
    ${marketField}
    <div class="field-row">${fyField}${qField}</div>
    <div class="field-row">${confField}</div>
    <div class="help-text">Save the school first, then add its tasks, deadlines &amp; owners.</div>`
    : `
    ${summary}
    <div class="reschedule">
      <div class="rs-head">Reschedule opening <span class="muted">— push it back or pull it forward as plans change</span></div>
      <div class="field-row">${fyField}${qField}</div>
      <label class="field-check"><input type="checkbox" id="sShift" checked> Also move this school’s ${sm.length} task deadline${sm.length === 1 ? '' : 's'} by the same shift</label>
    </div>
    <div class="field"><label>Tasks &amp; milestones — click any task to open it</label><div class="sm-tasks">${taskList}</div>
      <button class="btn btn-tonal btn-sm" id="addTaskForSchool" style="margin-top:8px">+ Add task for this school</button></div>
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
  else if (old.code && (old.code !== s.code || old.market !== s.market || old.openingFY !== s.openingFY)) {
    // keep this school's tasks linked after code/market/opening changes; optionally slide their deadlines
    M().forEach(m => {
      if (m.market === old.market && m.openingFY === old.openingFY && (m.schools || []).includes(old.code)) {
        m.schools = m.schools.map(c => c === old.code ? s.code : c); m.market = s.market; m.state = s.state; m.openingFY = s.openingFY;
        if (shift) {
          if (m.targetFY) m.targetFY += shift;
          if (m.due_date) m.due_date = shiftDateYears(m.due_date, shift);
          m.tags = (m.tags || []).map(t => /^FY\d\d$/.test(t) ? 'FY' + String(s.openingFY).slice(-2) : t);
        }
      }
    });
  }
  autosave(); const nid = s.id;
  if (isNew) { closeModal(); rerender(); toast('School added — now add its tasks', 'ok'); setTimeout(() => openSchoolModal(nid), 60); }
  else { closeModal(); rerender(); const msg = shift ? `Opening moved ${shift > 0 ? 'back' : 'earlier'} ${Math.abs(shift)} yr — tasks shifted` : 'School saved'; toast(msg, 'ok'); }
}
function deleteSchool() {
  const s = schoolById(schoolId); if (!s) return; const tasks = schoolMs(s), sid = s.id, mk = s.market, ofy = s.openingFY, cd = s.code;
  confirmDialog({ title: `Remove ${esc(s.display_label)}?`, message: `Remove <b>${esc(s.display_label)} (${esc(s.market)})</b> from the opening schedule.` + (tasks.length ? ` Its <b>${tasks.length} task(s)</b> will also be deleted.` : ''), confirmLabel: 'Remove school', danger: true, onConfirm: () => {
    state.data.schools = state.data.schools.filter(x => x.id !== sid);
    state.data.milestones = M().filter(m => !(m.market === mk && m.openingFY === ofy && (m.schools || []).includes(cd)));
    autosave(); closeModal(); rerender(); toast('School removed', 'ok');
  } });
}
function addTaskForSchool() {
  const s = schoolById(schoolId); if (!s) return;
  const m = { id: uid(), state: s.state, market: s.market, team: teams()[0], functional_area: teams()[0], workstream: 'General', activity: 'New task', schools: [s.code], targetFY: s.openingFY, targetQuarter: '', openingFY: s.openingFY, due_date: null, status: 'not_started', stage: 'to_do', progress_percent: 0, priority: s.priority ? 'high' : 'medium', owner: '', dependency: '', keyMilestone: false, greenlight: false, transition: false, notes: '', tags: [s.state, s.code, 'FY' + String(s.openingFY).slice(-2)] };
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
    client.channel('gm_rt').on('postgres_changes', { event: '*', schema: 'public', table: SB_TABLE.m }, sbOnRemote).subscribe();
    client.channel('gs_rt').on('postgres_changes', { event: '*', schema: 'public', table: SB_TABLE.s }, sbOnRemote).subscribe();
    state.sb = { connected: true, client }; lsSet(LS.supabase, JSON.stringify({ url, key })); autosaveWriteLocal(); rerender();
    const b = $('#saveState'); if (b) { b.textContent = 'Synced • live'; b.className = 'save-state saved'; }
    if (s) s.innerHTML = '<div class="status-note ok">✓ Connected. Edits &amp; schools sync live to everyone on this project.</div>'; renderDrawer(); return true;
  } catch (e) { state.sb = { connected: false, client: null }; if (s) s.innerHTML = `<div class="status-note err">Couldn't connect: ${esc(e.message || e)}. Check URL/key and that you ran the SQL.</div>`; return false; }
}
function sbDisconnect() { try { if (state.sb.client) state.sb.client.removeAllChannels(); } catch (e) {} state.sb = { connected: false, client: null }; lsDel(LS.supabase); renderDrawer(); toast('Disconnected', 'ok'); }
function sbOnRemote(p) {
  try {
    const isSchool = p.table === SB_TABLE.s;
    const arr = isSchool ? S() : M(), last = isSchool ? sbLastSchools : sbLastPushed;
    if (p.eventType === 'DELETE') { const id = p.old && p.old.id; if (id) { const na = arr.filter(x => x.id !== id); if (isSchool) state.data.schools = na; else state.data.milestones = na; last.delete(id); } }
    else { const doc = p.new && p.new.doc; if (!doc) return; const j = JSON.stringify(doc); if (last.get(doc.id) === j) return; const i = arr.findIndex(x => x.id === doc.id); if (i >= 0) arr[i] = doc; else arr.push(doc); last.set(doc.id, j); }
    autosaveWriteLocal(); if (!$('#popover') && !$('#modalBackdrop').classList.contains('open')) rerender();
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
      ${connected ? `<div class="status-note ok">● Live — everyone connected to <span class="mono">${esc((sc.url || '').replace(/^https?:\/\//, ''))}</span> shares this board.</div><div class="dw-btns"><button class="btn btn-tonal" id="sbDisconnect">Disconnect</button></div>`
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
      <div class="dw-h"><span class="dw-num">2</span><h4>Access Password</h4></div>
      <label class="field-check"><input type="checkbox" id="gateEnable" ${gateOn() ? 'checked' : ''}> Require a shared password to open the board</label>
      <div class="field" style="margin-top:10px"><label>Change the password</label><input id="gateNew" type="text" autocomplete="off" placeholder="Leave blank to keep the current one"></div>
      <div class="dw-btns"><button class="btn btn-filled" id="gateSave">Save</button><button class="btn btn-text" id="gateLock">Lock &amp; sign out</button></div>
      <div id="gateStatus"></div>
      <p class="dw-help">After changing it, Connect (or Commit) so everyone gets the new password. A light gate to keep casual visitors out — not strong security.</p>
      <div class="dw-divider"></div>
      <div class="dw-sublabel">Admin lock — protects this Settings panel</div>
      <label class="field-check"><input type="checkbox" id="adminEnable" ${adminOn() ? 'checked' : ''}> Require an admin password to open Settings (only you)</label>
      <div class="field" style="margin-top:10px"><label>Change the admin password</label><input id="adminNew" type="text" autocomplete="off" placeholder="Leave blank to keep the current one"></div>
      <div class="dw-btns"><button class="btn btn-filled" id="adminSave">Save admin password</button></div>
      <div id="adminStatus"></div>
      <p class="dw-help">This one is just for you — teammates use the board password above but can’t open Settings without this.</p>
    </section>

    <details class="dw-sec dw-fold"><summary><span class="dw-num">3</span>Customize Markets, Workstreams &amp; Owners</summary>
      <p class="dw-help">Rename or add your own; changes save everywhere. Anything in use can’t be deleted until its items are reassigned.</p>
      ${czSection('State', 'markets', statesMeta().flatMap(s => s.markets.map(mk => ({ mk, st: s.code }))))}
      ${czSection('Workstream', 'teams', teams().map(t => ({ mk: t })))}
      ${czOwners()}
    </details>

    <details class="dw-sec dw-fold"><summary><span class="dw-num">4</span>Back Up &amp; Restore Data</summary>
      <p class="dw-help">Download a copy of everything, or load one back in.</p>
      <div class="dw-btns"><button class="btn" id="expBtn">Export data.json</button><button class="btn" id="impBtn">Import</button><input type="file" id="impFile" accept="application/json" class="hide"></div>
    </details>

    <div class="dw-about">Network Growth Hub · ${M().length} milestones · ${state.data.schools.length} schools · v${meta().version || 1}</div>`;
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
  if (n) return toast(`${val} is used by ${n} item(s) — reassign them first`, 'err');
  confirmDialog({ title: `Remove “${esc(val)}”?`, message: `This removes the ${type === 'markets' ? 'market' : type === 'teams' ? 'team' : 'person'} from your lists.`, confirmLabel: 'Remove', danger: true, onConfirm: () => {
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
const VIEWS = ['timeline', 'progress', 'plan'];
function setView(v, fromPop) {
  if (!VIEWS.includes(v)) v = 'timeline';
  state.view = v;
  $$('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  // Only the active section keeps content — otherwise all three sections coexist with
  // duplicate ids (#viewBody, #filterbar, #clearFilters…) and refreshBody() targets the wrong one.
  $$('.view').forEach(s => { const on = s.id === 'view-' + v; s.classList.toggle('active', on); if (!on) s.innerHTML = ''; });
  rerender();
  if (!fromPop) { try { if (location.hash !== '#' + v) history.pushState({ v }, '', '#' + v); } catch (e) {} }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function wireEvents() {
  $('#navTabs').addEventListener('click', e => { const t = e.target.closest('.nav-tab'); if (t) setView(t.dataset.view); });
  $('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  const showDrawer = () => { renderDrawer(); $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); };
  const openDrawer = () => {
    if (adminOn() && !state.adminUnlocked) return promptPassword({ title: 'Admin settings', message: 'Enter the settings password.', verify: v => pwHash(v) === String(meta().adminHash), onOk: () => { state.adminUnlocked = true; showDrawer(); } });
    showDrawer();
  };
  const closeDrawer = () => { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); };
  $('#settingsBtn').addEventListener('click', openDrawer); $('#drawerClose').addEventListener('click', closeDrawer); $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('#modalClose').addEventListener('click', closeModal); $('#modalCancel').addEventListener('click', closeModal); $('#modalSave').addEventListener('click', saveModal); $('#modalDelete').addEventListener('click', deleteModal);
  $('#modalBackdrop').addEventListener('click', e => { if (e.target.id === 'modalBackdrop') closeModal(); });
  // the modal lives outside .container, so clicks inside it need their own delegation
  $('#modalBody').addEventListener('click', e => {
    if (e.target.closest('#noteAdd')) return postNote(e.target.closest('.notes-field'));
    if (e.target.closest('#addTaskForSchool')) { taskReturnSchool = schoolId; return addTaskForSchool(); }
    const ex = e.target.closest('[data-expand]'); if (ex) { if (modalMode === 'school') taskReturnSchool = schoolId; return openModal(ex.dataset.expand); }
  });
  $('#modalBody').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'noteInput') { e.preventDefault(); postNote(e.target.closest('.notes-field')); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeDrawer(); closePopover(); closeConfirm(); } });

  // keep timing colors live vs. the real date (on return-to-tab and hourly rollover)
  let _day = new Date().toDateString();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rerender(); });
  setInterval(() => { const t = new Date().toDateString(); if (t !== _day) { _day = t; rerender(); } }, 3600000);

  document.addEventListener('dragstart', e => { const c = e.target.closest('.kcard'); if (c) { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); } });
  document.addEventListener('dragend', e => { const c = e.target.closest('.kcard'); if (c) c.classList.remove('dragging'); $$('.kcol-body.over').forEach(b => b.classList.remove('over')); });
  document.addEventListener('dragover', e => { const b = e.target.closest('.kcol-body'); if (b) { e.preventDefault(); b.classList.add('over'); } });
  document.addEventListener('dragleave', e => { const b = e.target.closest('.kcol-body'); if (b && !b.contains(e.relatedTarget)) b.classList.remove('over'); });
  document.addEventListener('drop', e => { const b = e.target.closest('.kcol-body'); if (b) { e.preventDefault(); b.classList.remove('over'); const m = findM(e.dataTransfer.getData('text/plain')); if (m && m.stage !== b.dataset.kstage) { m.stage = b.dataset.kstage; if (m.stage === 'complete') { m.status = 'complete'; m.progress_percent = 100; } autosave(); refreshResults(); } } });

  $('.container').addEventListener('click', e => {
    const fm = e.target.closest('.fb-menu'); if (fm) return openFilterMenu(fm, fm.dataset.fmenu);
    const oy = e.target.closest('[data-oyear]'); if (oy) { toggleOpeningYear(+oy.dataset.oyear); return rerender(); }
    if (e.target.closest('[data-oyall]')) { state.filters.openingFYs.clear(); return rerender(); }
    if (e.target.closest('#clearFilters')) { clearFilters(); return rerender(); }
    if (e.target.closest('#clearFilters2')) { clearFilters(); return rerender(); }
    if (e.target.closest('#pmExpandAll')) { (state._pmKeys || []).forEach(k => state.expanded[k] = true); return refreshBody(); }
    if (e.target.closest('#pmCollapseAll')) { state.expanded = {}; return refreshBody(); }
    const pv = e.target.closest('[data-progressview]'); if (pv) { state.progressView = pv.dataset.progressview; return renderProgress(); }
    const pd = e.target.closest('[data-progressdim]'); if (pd) { state.progressDim = pd.dataset.progressdim; return refreshBody(); }
    const dr = e.target.closest('[data-drilldim]'); if (dr) return applyDrill(dr.dataset.drilldim, dr.dataset.drillval);
    const tg = e.target.closest('[data-toggle]'); if (tg) { const k = tg.dataset.toggle; state.expanded[k] = !state.expanded[k]; return refreshBody(); }
    const ex = e.target.closest('[data-expand]'); if (ex) return openModal(ex.dataset.expand);
    const es2 = e.target.closest('[data-editschool]'); if (es2) return openSchoolModal(es2.dataset.editschool);
    const ds = e.target.closest('[data-drillschool]'); if (ds) return openSchoolModal(ds.dataset.drillschool);
    const gp = e.target.closest('[data-goplan]'); if (gp) { const m = findM(gp.dataset.goplan); state.filters.search = m ? m.workstream : ''; setView('plan'); return; }
    if (e.target.closest('#planFocus')) { state.planFocus = !state.planFocus; return renderPlan(); }
    if (e.target.closest('#planExpandAll')) { (state._planKeys || []).forEach(k => state.expanded[k] = true); return refreshBody(); }
    if (e.target.closest('#planCollapseAll')) { (state._planKeys || []).forEach(k => delete state.expanded[k]); return refreshBody(); }
    if (e.target.closest('#addSchool')) return openSchoolModal(null);
    if (e.target.closest('#addTaskForSchool')) return addTaskForSchool();
    if (e.target.closest('#newItem')) return addItem();
    if (e.target.closest('#dashPrint')) return window.print();
  });
  $('.container').addEventListener('change', e => {
    if (e.target.id === 'planGroupSel') { state.planGroup = e.target.value; refreshBody(); }
    else if (e.target.id === 'dashSchool') { state.filters.schoolId = e.target.value; refreshBody(); const cl = $('#clearFilters'); if (cl) cl.classList.toggle('hide', !activeCount()); }
  });
  $('.container').addEventListener('input', e => { if (e.target.id === 'fSearch') { state.filters.search = e.target.value; refreshBody(); const cl = $('#clearFilters'); if (cl) cl.classList.toggle('hide', !activeCount()); } });

  $('#drawerBody').addEventListener('click', e => {
    if (e.target.id === 'sbConnect') { const u = $('#sbUrl').value.trim(), k = $('#sbKey').value.trim(); if (!u || !k) $('#sbStatus').innerHTML = '<div class="status-note err">Enter URL and key.</div>'; else sbConnect(u, k); }
    else if (e.target.id === 'sbDisconnect') sbDisconnect(); else if (e.target.id === 'sbShowSql') $('#sbSqlBox').classList.toggle('hide');
    else if (e.target.id === 'ghSave') commitToGitHub(); else if (e.target.id === 'expBtn') exportJson(); else if (e.target.id === 'impBtn') $('#impFile').click();
    else if (e.target.id === 'gateSave') return saveGateSettings();
    else if (e.target.id === 'adminSave') return saveAdminSettings();
    else if (e.target.id === 'gateLock') return lockNow();
    const cza = e.target.closest('[data-czadd]'); if (cza) return czAdd(cza.dataset.czadd);
    const czd = e.target.closest('.cz-del'); if (czd) return czRemove(czd.dataset.cztype, czd.dataset.czval);
  });
  $('#drawerBody').addEventListener('change', e => {
    if (e.target.id === 'impFile' && e.target.files[0]) return importJson(e.target.files[0]);
    if (e.target.classList.contains('cz-name')) return czRename(e.target.dataset.cztype, e.target.dataset.czold, e.target.value);
    if (e.target.classList.contains('cz-state')) { const mk = e.target.dataset.czmarket, to = e.target.value; statesMeta().forEach(s => s.markets = s.markets.filter(x => x !== mk)); const s = statesMeta().find(x => x.code === to); if (s && !s.markets.includes(mk)) s.markets.push(mk); M().forEach(m => { if (m.market === mk) m.state = to; }); state.data.schools.forEach(x => { if (x.market === mk) x.state = to; }); autosave(); rerender(); renderDrawer(); return; }
    if (e.target.classList.contains('cz-role')) { const o = (meta().owners || []).find(x => x.name === e.target.dataset.czowner); if (o) { o.role = e.target.value; autosave(); } return; }
  });
}

/* ---------- shared access gate ----------
   A lightweight shared password to keep casual visitors out of the committee board.
   NOTE: this is client-side only — it deters, it does not encrypt. Anyone technical can
   read past it by viewing source. For real access control, use Supabase Auth. */
function pwHash(str) { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909); return String(4294967296 * (2097151 & h2) + (h1 >>> 0)); }
function gateOn() { return !!(meta().gateEnabled && meta().gateHash); }
function gateStart() {
  if (!gateOn() || lsGet(LS.gate) === String(meta().gateHash)) return bootApp();
  showGate();
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
      ${err ? '<div class="gate-err">That password didn’t match. Try again.</div>' : ''}
    </div>`;
  const f = $('#gateForm'), inp = $('#gatePw');
  f.addEventListener('submit', e => { e.preventDefault(); const v = inp.value; if (pwHash(v) === String(meta().gateHash)) { lsSet(LS.gate, String(meta().gateHash)); g.remove(); bootApp(); } else { showGate(true); } });
  setTimeout(() => { const i = $('#gatePw'); if (i) i.focus(); }, 30);
}
function lockNow() { lsDel(LS.gate); location.reload(); }
/* admin gate — protects the ⚙ Settings drawer (admin-only) */
function adminOn() { return !!(meta().adminEnabled && meta().adminHash); }
function promptPassword(opts) {
  closeConfirm();
  const w = document.createElement('div'); w.className = 'confirm-backdrop'; w.id = 'confirmBackdrop';
  w.innerHTML = `<div class="confirm-box"><div class="confirm-ic">🔒</div><h3>${esc(opts.title)}</h3>
    ${opts.message ? `<div class="confirm-msg">${esc(opts.message)}</div>` : ''}
    <input id="pwPromptInput" type="password" class="pw-prompt" placeholder="${esc(opts.placeholder || 'Password')}" autocomplete="off">
    <div class="pw-prompt-err hide" id="pwPromptErr">That password didn’t match.</div>
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
  $('#adminStatus').innerHTML = `<div class="status-note ok">✓ Saved${pw ? ' — new admin password set' : ''}. Commit/Export so it applies for you everywhere.</div>`;
  const nb = $('#adminNew'); if (nb) nb.value = '';
}
function saveGateSettings() {
  const enabled = $('#gateEnable').checked, pw = ($('#gateNew').value || '').trim();
  meta().gateEnabled = enabled;
  if (pw) { meta().gateHash = pwHash(pw); lsSet(LS.gate, String(meta().gateHash)); }
  if (!meta().gateHash) { meta().gateEnabled = false; $('#gateStatus').innerHTML = '<div class="status-note err">Set a password first.</div>'; return; }
  autosave();
  $('#gateStatus').innerHTML = `<div class="status-note ok">✓ Saved${pw ? ' — new password set' : ''}. ${enabled ? 'Password is required' : 'Gate is off'}. Commit or Export so everyone gets it.</div>`;
  const nb = $('#gateNew'); if (nb) nb.value = '';
}

async function init() {
  applyTheme(lsGet(LS.theme) || 'light');   // default to light on first load
  const data = await loadData(); if (!data) return; state.data = data;
  state.data.schools.forEach(s => { if (!s.id) s.id = uid(); });   // stable ids for school management
  gateStart();
}
function bootApp() {
  wireEvents();
  window.addEventListener('popstate', () => setView((location.hash || '').replace('#', '') || 'progress', true));
  const initial = (location.hash || '').replace('#', '');
  setView(VIEWS.includes(initial) ? initial : 'progress', true);
  if (!location.hash) { try { history.replaceState({ v: state.view }, '', '#' + state.view); } catch (e) {} }
  let sc = sbSavedCfg(); if (SB_DEFAULT.url && (!sc || sc.url === SB_DEFAULT.url)) sc = SB_DEFAULT; if (sc && sc.url && sc.key) sbConnect(sc.url, sc.key, true);
}
document.addEventListener('DOMContentLoaded', init);
