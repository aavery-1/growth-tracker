/* ============================================================
   School Opening Timeline & Project Management
   3-tab tool per implementation spec.
   Vanilla JS · auto-save · optional Supabase live sync.
   ============================================================ */
'use strict';

const LS = { theme: 'ngc_theme', data: 'ngc_data', gh: 'ngc_gh', supabase: 'ngc_supabase', ui: 'ngc_ui' };

const state = {
  data: null,
  view: 'timeline',              // timeline | progress | plan
  planGroup: 'stage',            // stage | team | school | priority
  progressView: 'charts',        // charts | list
  progressDim: 'team',           // team | year | market | school | state
  expanded: {},                  // progress section/item expand map
  filters: { states: new Set(), fys: new Set(), types: new Set(), areas: new Set(), markets: new Set(), statuses: new Set(), priorities: new Set(), schoolId: '', search: '' },
  sb: { connected: false, client: null },
};

/* ---------- palette (spec colors) ---------- */
const STATE_COLOR = { NJ: '#16357F', FL: '#1B6EA5' };
const MARKET_COLOR = { Paterson: '#E1523D', 'Miami-Dade': '#F5A623', Broward: '#D98C10', Newark: '#57C0E9', Orlando: '#12357F', Camden: '#A4CE4E' };
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
function fmtMoney(n) { return n >= 1e6 ? '$' + (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + n; }
function parseDate(s) { return s ? new Date(s + 'T00:00:00') : null; }
function daysUntil(s) { const d = parseDate(s); if (!d) return null; return Math.round((d - new Date(new Date().toDateString())) / 86400000); }
function fmtDate(s) { const d = parseDate(s); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }

/* ---------- status meta ---------- */
const SM = k => (state.data.meta.statusMeta[k] || { label: k, color: '#ccc', text: '#000' });
function statusPill(k) { const m = SM(k); return `<span class="stpill" style="background:${m.color}22;color:${m.color === '#E0E0E0' ? '#5A5A5A' : m.color}"><i style="background:${m.color}"></i>${esc(m.label)}</span>`; }
function statusDot(k) { return `<i class="stdot" style="background:${SM(k).color}"></i>`; }

/* ---------- timing (live, date-driven urgency) ---------- */
const SEV = { not_started: 0, on_track: 1, at_risk: 2, behind: 3, complete: 9 };
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
  try { const s = JSON.parse(localStorage.getItem(LS.data) || 'null'); if (s && s.milestones && s.__baseVersion === (base.meta && base.meta.version)) base = s; } catch (e) {}
  return base;
}
let saveTimer = null;
function autosaveWriteLocal() { try { const c = JSON.parse(JSON.stringify(state.data)); c.__baseVersion = state.data.meta && state.data.meta.version; localStorage.setItem(LS.data, JSON.stringify(c)); return true; } catch (e) { return false; } }
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
}
function clearFilters() { ['states', 'fys', 'types', 'areas', 'markets', 'statuses', 'priorities'].forEach(k => state.filters[k].clear()); state.filters.schoolId = ''; state.filters.search = ''; }

/* ============================================================
   TAB 1 — SCHOOL OPENING TIMELINE (Gantt)
   ============================================================ */
function ganttSchools() {
  const f = state.filters;
  return state.data.schools.filter(s => s.openingFY)
    .filter(s => !f.states.size || f.states.has(s.state))
    .filter(s => !f.types.size || f.types.has(s.school_type))
    .filter(s => !f.markets.size || f.markets.has(s.market))
    .filter(s => !f.fys.size || f.fys.has(s.openingFY));
}
function chipRow(label, items) {
  return `<div class="chiprow"><span class="chiprow-label">${esc(label)}</span>${items}</div>`;
}
function fchip(key, val, label, color) {
  const on = state.filters[key].has(val);
  return `<button class="fchip ${on ? 'on' : ''}" data-fkey="${key}" data-fval="${esc(val)}" ${key === 'fys' ? 'data-num="1"' : ''}>${color ? `<i style="background:${color}"></i>` : ''}${esc(label)}</button>`;
}

/* ---------- unified filter bar (dropdown menus, live counts) ---------- */
const FILTER_LABEL = { states: 'State', types: 'Type', markets: 'Market', fys: 'Year', areas: 'Team', statuses: 'Status', priorities: 'Priority' };
function filterOpts(key) {
  if (key === 'states') return statesMeta().map(s => [s.code, s.name, stColor(s.code)]);
  if (key === 'types') return [['ES', 'Elementary (ES)'], ['MS', 'Middle (MS)'], ['HS', 'High (HS)']];
  if (key === 'markets') return markets().map(m => [m, m, mkColor(m)]);
  if (key === 'fys') return fyList().filter(fy => M().some(m => m.targetFY === fy) || state.data.schools.some(s => s.openingFY === fy)).map(fy => [String(fy), fyLabel(fy)]);
  if (key === 'areas') return teams().map(t => [t, t]);
  if (key === 'statuses') return meta().statuses.map(s => [s, SM(s).label, SM(s).color]);
  if (key === 'priorities') return ['high', 'medium', 'low'].map(p => [p, PRIORITY[p].label, PRIORITY[p].color]);
  return [];
}
function activeCount() { let n = 0; ['states', 'types', 'markets', 'fys', 'areas', 'statuses', 'priorities'].forEach(k => n += state.filters[k].size); if (state.filters.schoolId) n++; if (state.filters.search) n++; return n; }
function filterBar(menus, opts = {}) {
  const search = opts.search ? `<div class="fb-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="fSearch" autocomplete="off" placeholder="Search…" value="${esc(state.filters.search)}"></div>` : '';
  const btns = menus.map(k => { const n = state.filters[k].size; return `<button class="fb-menu ${n ? 'on' : ''}" data-fmenu="${k}"><span>${FILTER_LABEL[k]}</span>${n ? `<span class="fb-count">${n}</span>` : ''}<svg class="fb-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6"><path d="m6 9 6 6 6-6"/></svg></button>`; }).join('');
  const school = opts.school ? `<select id="dashSchool" class="fb-select"><option value="">All schools</option>${state.data.schools.filter(s => s.openingFY).sort((a, b) => (a.openingFY - b.openingFY) || a.market.localeCompare(b.market)).map(s => `<option value="${s.id}" ${state.filters.schoolId === s.id ? 'selected' : ''}>${esc(s.display_label)} · ${esc(s.market)}</option>`).join('')}</select>` : '';
  return `<div class="filterbar" id="filterbar"><span class="fb-label">Filters</span>${search}${btns}${school}<button class="fb-clear ${activeCount() ? '' : 'hide'}" id="clearFilters">Clear all</button><span class="fb-spacer"></span>${opts.right || ''}</div>`;
}
function openFilterMenu(anchor, key) {
  const set = state.filters[key];
  const html = `<div class="pop-title">${FILTER_LABEL[key]}</div><div class="pop-list pop-checks">${filterOpts(key).map(([v, l, color]) => { const on = set.has(key === 'fys' ? Number(v) : v); return `<label class="pop-check"><input type="checkbox" data-fkey="${key}" data-fval="${esc(v)}" ${on ? 'checked' : ''}>${color ? `<i class="fdot" style="background:${color}"></i>` : ''}${esc(l)}</label>`; }).join('')}</div>`;
  const p = openPopover(anchor, html);
  p.addEventListener('change', e => { const cb = e.target.closest('[data-fkey]'); if (cb) { toggleFilter(cb.dataset.fkey, cb.dataset.fval, cb.dataset.fkey === 'fys' ? Number : null); updateMenuBadge(cb.dataset.fkey); refreshBody(); } });
}
function updateMenuBadge(key) {
  const btn = $(`.fb-menu[data-fmenu="${key}"]`);
  if (btn) { const n = state.filters[key].size; btn.classList.toggle('on', !!n); let c = btn.querySelector('.fb-count'); if (n) { if (!c) { c = document.createElement('span'); c.className = 'fb-count'; btn.insertBefore(c, btn.querySelector('.fb-chev')); } c.textContent = n; } else if (c) c.remove(); }
  const cl = $('#clearFilters'); if (cl) cl.classList.toggle('hide', !activeCount());
}
function refreshBody() { const b = $('#viewBody'); if (!b) return rerender(); if (state.view === 'timeline') b.innerHTML = ganttBodyHtml(); else if (state.view === 'progress') b.innerHTML = progressBodyHtml(); else b.innerHTML = planBodyHtml(); }
function ganttBodyHtml() {
  const fys = fyList().filter(fy => state.data.schools.some(s => s.openingFY === fy) || fy <= currentFY() + 2).slice(0, 7);
  const minFy = fys[0], nFy = fys.length;
  const list = ganttSchools();
  const headCells = fys.map(fy => `<div class="g-col ${fy === currentFY() ? 'now' : ''}">${fyLabel(fy)}<span class="g-col-sub">FY${String(fy).slice(-2)}</span></div>`).join('');

  let body = '';
  statesMeta().forEach(st => {
    const rows = list.filter(s => s.state === st.code).sort((a, b) => (a.openingFY - b.openingFY) || (parseDate(a.opening_date) - parseDate(b.opening_date)) || a.market.localeCompare(b.market));
    if (!rows.length) return;
    body += `<div class="g-stateband" style="--sc:${stColor(st.code)}"><span class="state-badge" style="background:${stColor(st.code)}">${st.code}</span> ${esc(st.name)} <span class="muted">· ${rows.length} openings</span></div>`;
    rows.forEach(s => {
      const sm = schoolMs(s), roll = rollupStatus(sm);
      const startFy = Math.max(minFy, Math.min(s.openingFY - 2, ...(sm.map(m => m.targetFY).filter(Boolean).concat([s.openingFY]))));
      const c1 = Math.max(1, startFy - minFy + 1), c2 = Math.min(nFy, s.openingFY - minFy + 1);
      const lead = (sm[0] || {}).owner || '';
      const tip = `${s.name} · ${s.school_type} · ${s.location}\nOpens ${fmtDate(s.opening_date)}\nStatus: ${SM(roll).label}${lead ? '\nTeam lead: ' + lead : ''}`;
      body += `<div class="g-row" style="grid-template-columns:210px repeat(${nFy},1fr)">
        <div class="g-label"><button class="g-edit" data-editschool="${esc(s.id)}" title="Edit / remove this school & its tasks"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>${s.priority ? '<span class="prio-star">★</span>' : ''}<b>${esc(s.display_label)}</b> <span class="muted">${esc(s.location)} · ${esc(s.school_type)}</span></div>
        <div class="g-track" style="grid-column:2 / ${nFy + 2};grid-template-columns:repeat(${nFy},1fr)">
          <div class="g-bar" style="grid-column:${c1} / ${c2 + 1};background:${mkColor(s.market)}" data-goschool="${esc(s.code)}|${esc(s.market)}" title="${esc(tip)}">
            <span class="g-bar-label">${esc(s.display_label)} · ${esc(s.location)}</span>
            <span class="g-bar-dot" style="background:${SM(roll).color}" title="${SM(roll).label}"></span>
          </div>
        </div>
      </div>`;
    });
  });

  return `<div class="gantt card">
      <div class="g-row g-head" style="grid-template-columns:210px repeat(${nFy},1fr)"><div class="g-label">School</div><div class="g-track" style="grid-column:2 / ${nFy + 2};grid-template-columns:repeat(${nFy},1fr)">${headCells}</div></div>
      ${body || '<div class="empty-state">No schools match the filters.</div>'}
    </div>
    <div class="rag-legend" style="margin-top:12px">${['not_started','on_track','at_risk','behind','complete'].map(k => `<span class="lg">${statusDot(k)}${SM(k).label}</span>`).join('')}<span class="muted">· ★ = Fall 2027 priority · bar = development window through opening</span></div>`;
}
function renderTimeline() {
  $('#view-timeline').innerHTML = `
    <div class="view-head"><div><h2>Openings Timeline</h2></div>
      <button class="btn btn-filled" id="addSchool"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>Add school opening</button>
    </div>
    ${filterBar(['states', 'types', 'markets', 'fys'])}
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
      <span class="pm-title">${m.keyMilestone ? '★ ' : ''}${esc(m.activity)}</span>
      <span class="pm-due">${dueBadge(m) || (m.due_date ? `<span class="due-ok">${fmtDate(m.due_date)}</span>` : '<span class="muted">—</span>')}</span>
      <span class="stpill" style="background:${pcol}22;color:${pcol === '#E0E0E0' ? '#5A5A5A' : pcol}">${SM(es).label}</span>
      <span class="pm-owner" title="${esc(m.owner)}">${m.owner ? `<span class="owner-avatar sm">${esc(initials(m.owner))}</span>` : ''}</span>
      <div class="pm-prog"><span style="width:${m.progress_percent || 0}%;background:${pcol}"></span></div>
      <span class="pm-pct">${m.progress_percent || 0}%</span>
    </div>
    <div class="pm-body ${open ? '' : 'hide'}">
      <div class="pm-meta"><b>Area:</b> ${esc(m.functional_area)} · <b>Market:</b> ${esc(m.market)} · <b>Workstream:</b> ${esc(m.workstream)}${m.owner ? ' · <b>Owner:</b> ' + esc(m.owner) : ''}</div>
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
const STATUS_ORDER = ['complete', 'on_track', 'at_risk', 'behind', 'not_started'];
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
  const dims = [['team', 'Team'], ['year', 'Year'], ['school', 'School opening'], ['market', 'Market'], ['state', 'State']];
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
  const prio = list.filter(m => m.keyMilestone && (m.targetFY === 2027 || state.data.schools.some(s => s.priority && (m.schools || []).includes(s.code)) || m.functional_area === 'Advancement — Capital'));
  state._pmKeys = ['sec:prio', 'prio:all', 'sec:area', ...byArea.map(s => s.key), 'sec:nj', ...byNJ.map(s => s.key), 'sec:fl', ...byFL.map(s => s.key)];
  const overdue = list.filter(m => timingLevel(m) === 'overdue').length, month = list.filter(m => timingLevel(m) === 'this_month').length;
  const kpis = `<div class="kpi-grid" style="margin-bottom:16px">
      <div class="kpi tone-b"><div class="kpi-value">${list.length}</div><div class="kpi-label">Milestones shown</div><div class="kpi-foot">${M().length} total in plan</div></div>
      <div class="kpi tone-g"><div class="kpi-value">${pct(list)}%</div><div class="kpi-label">Complete</div><div class="kpi-foot">${list.filter(m => m.status === 'complete').length} done</div></div>
      <div class="kpi ${overdue ? 'tone-r' : 'tone-g'}"><div class="kpi-value">${overdue}</div><div class="kpi-label">Overdue</div><div class="kpi-foot">${month} due this month</div></div>
      <div class="kpi tone-y"><div class="kpi-value">${list.filter(m => ['behind', 'at_risk'].includes(effectiveStatus(m))).length}</div><div class="kpi-label">At risk / behind</div><div class="kpi-foot">need attention</div></div>
    </div>`;
  if (state.progressView === 'charts') return kpis + chartsHtml(list);
  return kpis + `<div class="pm-urgency"><span class="tb-spacer"></span><button class="btn btn-text btn-sm" id="pmExpandAll">Expand all</button><button class="btn btn-text btn-sm" id="pmCollapseAll">Collapse all</button></div>
    ${section('sec:prio', 'FY27 Priorities', [{ key: 'prio:all', name: 'Key milestones for FY27', list: prio }], 'Fall 2027 readiness · Growth capital · Expansion pathway')}
    ${section('sec:area', 'By Functional Area', byArea)}
    ${section('sec:nj', 'By Market (New Jersey)', byNJ)}
    ${section('sec:fl', 'By Market (Florida)', byFL)}`;
}
function renderProgress() {
  const isCharts = state.progressView === 'charts';
  const toggle = `<div class="segmented"><button class="seg ${isCharts ? 'on' : ''}" data-progressview="charts"><span>Charts</span></button><button class="seg ${!isCharts ? 'on' : ''}" data-progressview="list"><span>Details</span></button></div>`;
  $('#view-progress').innerHTML = `
    <div class="view-head"><div><h2>Progress Dashboard</h2></div>${toggle}</div>
    ${filterBar(['states', 'markets', 'areas', 'fys', 'statuses'], { school: true })}
    <div id="viewBody">${progressBodyHtml()}</div>`;
}

/* ============================================================
   TAB 3 — PROJECT PLAN (Kanban)
   ============================================================ */
function planCard(m) {
  const pr = PRIORITY[m.priority] || PRIORITY.medium, es = effectiveStatus(m), t = timingLevel(m);
  const tags = (m.tags || []).slice(0, 3).map(t => `<span class="ptag">${esc(t)}</span>`).join('');
  const urgent = t === 'overdue' || t === 'this_month';
  const flag = (es === 'behind' || es === 'at_risk') ? `<span class="kc-status" style="background:${SM(es).color}1c;color:${SM(es).color}"><i style="background:${SM(es).color}"></i>${SM(es).label}</span>` : '';
  return `<div class="kcard ${urgent ? 'urgent' : ''} ${es === 'behind' ? 'is-behind' : ''}" draggable="true" data-id="${m.id}" style="border-left-color:${(es === 'behind' || es === 'at_risk') ? SM(es).color : pr.color}">
    <div class="kc-top"><span class="pri-dot" style="background:${pr.color}" title="${pr.label} priority"></span><span class="kc-title" data-expand="${m.id}">${m.keyMilestone ? '★ ' : ''}${esc(m.activity)}</span></div>
    <div class="kc-tags">${flag}${tags}</div>
    <div class="kc-foot">${m.owner ? `<span class="owner-avatar sm">${esc(initials(m.owner))}</span><span class="kc-owner">${esc(m.owner)}</span>` : '<span class="muted">Unassigned</span>'}<span class="kc-due">${dueBadge(m) || (m.due_date ? fmtDate(m.due_date) : '')}</span></div>
  </div>`;
}
function planKanbanHtml() {
  const list = filtered();
  return '<div class="kanban">' + meta().stages.map(([sk, label]) => {
    const cards = list.filter(m => (m.stage || 'to_do') === sk);
    return `<div class="kcol"><div class="kcol-head stage-${sk}"><span>${esc(label)}</span><span class="kcount">${cards.length}</span></div>
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
  return keys.map(k => `<div class="plan-group"><div class="plan-group-head">${esc(k)}<span class="pm-gcount">${g[k].length}</span></div><div class="plan-cards">${g[k].map(planCard).join('')}</div></div>`).join('');
}
function planBodyHtml() { return state.planGroup === 'stage' ? planKanbanHtml() : planListHtml(); }
function renderPlan() {
  const list = filtered();
  const risk = list.filter(m => ['behind', 'at_risk'].includes(effectiveStatus(m))).length;
  const viewSel = `<label class="tb-group">Group by
    <select id="planGroupSel">${[['stage', 'Kanban (stages)'], ['team', 'Team'], ['market', 'Market'], ['year', 'Year'], ['school', 'School opening']].map(([v, l]) => `<option value="${v}" ${state.planGroup === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const right = `${viewSel}<button class="btn btn-filled" id="newItem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>New task</button>`;
  $('#view-plan').innerHTML = `
    <div class="view-head"><div><h2>Project Plan</h2></div>
      <span class="muted" style="font-size:13px">${risk} at risk/behind · ${list.length} of ${M().length}</span></div>
    ${filterBar(['statuses', 'priorities'], { search: true, right })}
    <div id="viewBody">${planBodyHtml()}</div>`;
}

/* ============================================================
   EDIT ENGINE + cross-tab
   ============================================================ */
function rerender() { if (state.view === 'timeline') renderTimeline(); else if (state.view === 'progress') renderProgress(); else renderPlan(); }
function applyDrill(dim, val) {
  if (dim === 'team') state.filters.areas = new Set([val]);
  else if (dim === 'market') state.filters.markets = new Set([val]);
  else if (dim === 'state') state.filters.states = new Set([val]);
  else if (dim === 'year') state.filters.fys = new Set([Number(val)]);
  else if (dim === 'school') state.filters.schoolId = val;
  else if (dim === 'status') state.filters.statuses = new Set([val]);
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
    <div class="field-row"><div class="field"><label>Market / location</label><select id="mMarket">${opt(markets(), m.market)}</select></div><div class="field"><label>Functional area / team</label><select id="mTeam">${opt(teams(), m.functional_area)}</select></div></div>
    <div class="field"><label>Workstream</label><input id="mWs" value="${esc(m.workstream)}"></div>
    <div class="field"><label>Schools</label><div id="mSchools" class="check-box">${schoolChecks}</div></div>
    <div class="field-row"><div class="field"><label>Target FY</label><select id="mFy"><option value="">—</option>${fyList().map(fy => `<option value="${fy}" ${m.targetFY === fy ? 'selected' : ''}>${fyLabel(fy)}</option>`).join('')}</select></div><div class="field"><label>Quarter</label><select id="mQ">${opt(['', 'Q1', 'Q2', 'Q3', 'Q4'], m.targetQuarter)}</select></div></div>
    <div class="field-row"><div class="field"><label>Status (health)</label><select id="mStatus">${opt(meta().statuses.map(s => [s, SM(s).label]), m.status)}</select></div><div class="field"><label>Stage (workflow)</label><select id="mStage">${opt(meta().stages, m.stage || 'to_do')}</select></div></div>
    <div class="field-row"><div class="field"><label>Priority</label><select id="mPri">${opt([['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], m.priority)}</select></div><div class="field"><label>Progress %</label><input id="mProg" type="number" min="0" max="100" value="${m.progress_percent || 0}"></div></div>
    <div class="field-row"><div class="field"><label>Owner</label><input id="mOwner" value="${esc(m.owner)}"></div><div class="field"><label>Due date</label><input id="mDue" type="date" value="${esc(m.due_date || '')}"></div></div>
    <div class="field"><label>Dependency / blockers</label><input id="mDep" value="${esc(m.dependency)}"></div>
    <div class="field"><label>Notes / next steps</label><textarea id="mNotes">${esc(m.notes)}</textarea></div>
    <div class="field-row"><label class="field-check"><input type="checkbox" id="mKey" ${m.keyMilestone ? 'checked' : ''}> ★ Key milestone</label><label class="field-check"><input type="checkbox" id="mTrans" ${m.transition ? 'checked' : ''}> ⇄ Transition to Regional Ops</label></div>`;
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
function closeModal() { $('#modalBackdrop').classList.remove('open'); modalId = null; }

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
  $('#modalTitle').textContent = isNew ? 'Add a school opening' : 'Edit school opening';
  const opt = (arr, val) => arr.map(x => Array.isArray(x) ? `<option value="${x[0]}" ${x[0] === val ? 'selected' : ''}>${esc(x[1])}</option>` : `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const sm = isNew ? [] : schoolMs(s);
  const taskList = sm.length ? sm.slice().sort(bySortUrgency).map(m => `<div class="sm-task" data-expand="${m.id}">${statusDot(effectiveStatus(m))}<span class="sm-t-title">${m.keyMilestone ? '★ ' : ''}${esc(m.activity)}</span><span class="sm-t-due">${dueBadge(m) || (m.due_date ? fmtDate(m.due_date) : '—')}</span>${m.owner ? `<span class="owner-avatar sm" title="${esc(m.owner)}">${esc(initials(m.owner))}</span>` : ''}</div>`).join('') : '<div class="muted" style="font-size:12.5px">No tasks yet.</div>';
  $('#modalBody').innerHTML = `
    <div class="field-row"><div class="field"><label>Label (e.g., ES4)</label><input id="sLabel" value="${esc(s.display_label || s.code || '')}" placeholder="ES4"></div><div class="field"><label>School type</label><select id="sType">${opt([['ES', 'Elementary (ES)'], ['MS', 'Middle (MS)'], ['HS', 'High (HS)']], s.school_type)}</select></div></div>
    <div class="field-row"><div class="field"><label>Market / location</label><select id="sMarket">${opt(markets(), s.market)}</select></div><div class="field"><label>Pod #</label><input id="sPod" type="number" min="1" value="${s.pod_number || ''}" placeholder="4"></div></div>
    <div class="field-row"><div class="field"><label>Opening fiscal year</label><select id="sFy">${fyList().map(fy => `<option value="${fy}" ${s.openingFY === fy ? 'selected' : ''}>${fyLabel(fy)}</option>`).join('')}</select></div><div class="field"><label>Opening quarter</label><select id="sQ">${opt(['Q1', 'Q2', 'Q3', 'Q4'], s.openingQuarter || 'Q1')}</select></div></div>
    <div class="field-row"><label class="field-check"><input type="checkbox" id="sPrio" ${s.priority ? 'checked' : ''}> ★ Fall 2027 priority</label><label class="field-check"><input type="checkbox" id="sConf" ${s.confirmed !== false ? 'checked' : ''}> Opening confirmed</label></div>
    ${isNew ? '<div class="help-text">Save the school first, then add its tasks, deadlines & owners.</div>' : `
      <div class="field"><label>Tasks &amp; milestones for this school</label><div class="sm-tasks">${taskList}</div>
        <button class="btn btn-tonal btn-sm" id="addTaskForSchool" style="margin-top:8px">+ Add task for this school</button></div>`}`;
  $('#modalDelete').style.display = isNew ? 'none' : '';
  $('#modalBackdrop').classList.add('open');
}
function saveSchool() {
  const isNew = !schoolById(schoolId);
  const s = isNew ? { id: schoolId || uid() } : schoolById(schoolId);
  const old = { code: s.code, market: s.market, openingFY: s.openingFY };
  const label = ($('#sLabel').value.trim() || 'NEW').toUpperCase().replace(/\s+/g, '');
  s.display_label = label; s.code = label; s.school_type = $('#sType').value;
  s.pod_number = $('#sPod').value ? +$('#sPod').value : null;
  s.market = $('#sMarket').value; s.location = s.market; s.state = stateOfMarket(s.market);
  s.openingFY = +$('#sFy').value; s.fiscal_year = s.openingFY; s.openingQuarter = $('#sQ').value;
  s.opening_date = `${s.openingFY - 1}-09-01`; s.priority = $('#sPrio').checked; s.confirmed = $('#sConf').checked;
  if (isNew) { delete s._new; state.data.schools.push(s); }
  else if (old.code && (old.code !== s.code || old.market !== s.market || old.openingFY !== s.openingFY)) {
    // keep this school's tasks linked after code/market/opening changes
    M().forEach(m => { if (m.market === old.market && m.openingFY === old.openingFY && (m.schools || []).includes(old.code)) { m.schools = m.schools.map(c => c === old.code ? s.code : c); m.market = s.market; m.state = s.state; m.openingFY = s.openingFY; } });
  }
  autosave(); const nid = s.id;
  if (isNew) { closeModal(); rerender(); toast('School added — now add its tasks', 'ok'); setTimeout(() => openSchoolModal(nid), 60); }
  else { closeModal(); rerender(); toast('School saved', 'ok'); }
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
const SB_SQL = `-- run once in Supabase → SQL Editor
create table if not exists growth_milestones (id text primary key, doc jsonb not null, updated_at timestamptz default now());
create table if not exists growth_schools    (id text primary key, doc jsonb not null, updated_at timestamptz default now());
alter table growth_milestones enable row level security;
alter table growth_schools    enable row level security;
create policy "rw_m" on growth_milestones for all using (true) with check (true);
create policy "rw_s" on growth_schools    for all using (true) with check (true);
alter publication supabase_realtime add table growth_milestones;
alter publication supabase_realtime add table growth_schools;`;
function sbSavedCfg() { try { return JSON.parse(localStorage.getItem(LS.supabase) || 'null'); } catch (e) { return null; } }
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
    state.sb = { connected: true, client }; localStorage.setItem(LS.supabase, JSON.stringify({ url, key })); autosaveWriteLocal(); rerender();
    const b = $('#saveState'); if (b) { b.textContent = 'Synced • live'; b.className = 'save-state saved'; }
    if (s) s.innerHTML = '<div class="status-note ok">✓ Connected. Edits &amp; schools sync live to everyone on this project.</div>'; renderDrawer(); return true;
  } catch (e) { state.sb = { connected: false, client: null }; if (s) s.innerHTML = `<div class="status-note err">Couldn't connect: ${esc(e.message || e)}. Check URL/key and that you ran the SQL.</div>`; return false; }
}
function sbDisconnect() { try { if (state.sb.client) state.sb.client.removeAllChannels(); } catch (e) {} state.sb = { connected: false, client: null }; localStorage.removeItem(LS.supabase); renderDrawer(); toast('Disconnected', 'ok'); }
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
function ghConfig() { try { return JSON.parse(localStorage.getItem(LS.gh) || '{}'); } catch (e) { return {}; } }
function renderDrawer() {
  const cfg = ghConfig(), sc = sbSavedCfg() || {}, connected = state.sb && state.sb.connected;
  $('#drawerBody').innerHTML = `
    <div class="status-note ok">✓ Every edit saves automatically. Turn on live sync to share one board across the whole committee.</div>
    <h4>Live sync (Supabase)</h4>
    ${connected ? `<div class="status-note ok">● Live — <span class="mono">${esc((sc.url || '').replace(/^https?:\/\//, ''))}</span></div><button class="btn btn-tonal" id="sbDisconnect" style="margin-top:10px">Disconnect</button>`
      : `<div class="help-text" style="margin-bottom:10px">Paste your Supabase Project URL and <b>anon</b> public key. One-time: run the SQL (button) in Supabase → SQL Editor.</div>
         <div class="field"><label>Project URL</label><input id="sbUrl" class="mono" placeholder="https://xxxx.supabase.co" value="${esc(sc.url || '')}"></div>
         <div class="field"><label>Anon public key</label><input id="sbKey" type="password" class="mono" value="${esc(sc.key || '')}"></div>
         <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn btn-filled" id="sbConnect">Connect &amp; go live</button><button class="btn btn-tonal" id="sbShowSql">Show SQL setup</button></div>
         <pre class="sql-box hide" id="sbSqlBox">${esc(SB_SQL)}</pre>`}
    <div id="sbStatus"></div>
    <h4>Or publish via GitHub</h4>
    <div class="field"><label>Repository (owner/repo)</label><input id="ghRepo" class="mono" placeholder="kippnj/ngc-tracker" value="${esc(cfg.repo || '')}"></div>
    <div class="field-row"><div class="field"><label>Branch</label><input id="ghBranch" class="mono" value="${esc(cfg.branch || 'main')}"></div><div class="field"><label>Token</label><input id="ghToken" type="password" class="mono" value="${esc(cfg.token || '')}"></div></div>
    <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-filled" id="ghSave">Commit</button></div><div id="ghStatus"></div>
    <h4>Customize (markets, teams, owners)</h4>
    <div class="help-text" style="margin-bottom:8px">Rename or add your own. Changes update everywhere and save automatically. A market or team in use can't be deleted until its items are reassigned.</div>
    ${czSection('State', 'markets', statesMeta().flatMap(s => s.markets.map(mk => ({ mk, st: s.code }))))}
    ${czSection('Team', 'teams', teams().map(t => ({ mk: t })))}
    ${czOwners()}
    <h4>Backup</h4><div style="display:flex;gap:8px"><button class="btn" id="expBtn">Export data.json</button><button class="btn" id="impBtn">Import</button><input type="file" id="impFile" accept="application/json" class="hide"></div>
    <h4>About</h4><div class="help-text">School Opening Timeline &amp; PM · ${M().length} items · ${state.data.schools.length} schools · v${meta().version || 1}.</div>`;
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
  localStorage.setItem(LS.gh, JSON.stringify({ repo, branch, token }));
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
function applyTheme(mode) { document.documentElement.setAttribute('data-theme', mode); localStorage.setItem(LS.theme, mode); $('#themeIcon').innerHTML = mode === 'dark' ? '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>' : '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'; }
const VIEWS = ['timeline', 'progress', 'plan'];
function setView(v, fromPop) {
  if (!VIEWS.includes(v)) v = 'timeline';
  state.view = v;
  $$('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  rerender();
  if (!fromPop) { try { if (location.hash !== '#' + v) history.pushState({ v }, '', '#' + v); } catch (e) {} }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function wireEvents() {
  $('#navTabs').addEventListener('click', e => { const t = e.target.closest('.nav-tab'); if (t) setView(t.dataset.view); });
  $('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  const openDrawer = () => { renderDrawer(); $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); };
  const closeDrawer = () => { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); };
  $('#settingsBtn').addEventListener('click', openDrawer); $('#drawerClose').addEventListener('click', closeDrawer); $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('#modalClose').addEventListener('click', closeModal); $('#modalCancel').addEventListener('click', closeModal); $('#modalSave').addEventListener('click', saveModal); $('#modalDelete').addEventListener('click', deleteModal);
  $('#modalBackdrop').addEventListener('click', e => { if (e.target.id === 'modalBackdrop') closeModal(); });
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
    if (e.target.closest('#clearFilters')) { clearFilters(); return rerender(); }
    if (e.target.closest('#pmExpandAll')) { (state._pmKeys || []).forEach(k => state.expanded[k] = true); return refreshBody(); }
    if (e.target.closest('#pmCollapseAll')) { state.expanded = {}; return refreshBody(); }
    const pv = e.target.closest('[data-progressview]'); if (pv) { state.progressView = pv.dataset.progressview; return renderProgress(); }
    const pd = e.target.closest('[data-progressdim]'); if (pd) { state.progressDim = pd.dataset.progressdim; return refreshBody(); }
    const dr = e.target.closest('[data-drilldim]'); if (dr) return applyDrill(dr.dataset.drilldim, dr.dataset.drillval);
    const tg = e.target.closest('[data-toggle]'); if (tg) { const k = tg.dataset.toggle; state.expanded[k] = !state.expanded[k]; return refreshBody(); }
    const ex = e.target.closest('[data-expand]'); if (ex) return openModal(ex.dataset.expand);
    const gs = e.target.closest('[data-goschool]'); if (gs) { const code = gs.dataset.goschool.split('|')[0]; state.filters.search = code; setView('plan'); return; }
    const gp = e.target.closest('[data-goplan]'); if (gp) { const m = findM(gp.dataset.goplan); state.filters.search = m ? m.workstream : ''; setView('plan'); return; }
    const es2 = e.target.closest('[data-editschool]'); if (es2) return openSchoolModal(es2.dataset.editschool);
    if (e.target.closest('#addSchool')) return openSchoolModal(null);
    if (e.target.closest('#addTaskForSchool')) return addTaskForSchool();
    if (e.target.closest('#newItem')) return addItem();
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

async function init() {
  applyTheme(localStorage.getItem(LS.theme) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const data = await loadData(); if (!data) return; state.data = data;
  state.data.schools.forEach(s => { if (!s.id) s.id = uid(); });   // stable ids for school management
  wireEvents();
  window.addEventListener('popstate', () => setView((location.hash || '').replace('#', '') || 'timeline', true));
  const initial = (location.hash || '').replace('#', '');
  setView(VIEWS.includes(initial) ? initial : 'timeline', true);
  if (!location.hash) { try { history.replaceState({ v: state.view }, '', '#' + state.view); } catch (e) {} }
  const sc = sbSavedCfg(); if (sc && sc.url && sc.key) sbConnect(sc.url, sc.key, true);
}
document.addEventListener('DOMContentLoaded', init);
