// Growth Hub calendar feed for Outlook, Google Calendar and Apple Calendar.
// Deploy as an Edge Function named "growth-calendar" with JWT verification OFF
// (calendar apps can't sign in; the long private token in the link is the key).
// Setup steps: INTEGRATIONS-SETUP.md, part 3.
//
// Link format:  https://<project>.supabase.co/functions/v1/growth-calendar?t=<token>&scope=mine|all

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' };
const LABEL: Record<string, string> = { not_started: 'Not started', on_track: 'On track', at_risk: 'At risk', behind: 'Behind', blocked: 'Blocked', complete: 'Complete' };

type Milestone = { id: string; activity?: string; due_date?: string; status?: string; market?: string; owner?: string; coOwners?: string[]; team?: string };
type School = { id: string; label?: string; market?: string; opening_date?: string };

const esc = (s: unknown) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const ymd = (iso: string) => iso.slice(0, 10).replace(/-/g, '');
const nextDay = (iso: string) => { const d = new Date(iso.slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10).replace(/-/g, ''); };
const enc = new TextEncoder();
// Lines longer than 75 bytes are folded, as the calendar standard requires
function fold(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function allDay(uid: string, date: string, summary: string, description: string, url: string, stamp: string): string[] {
  return ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(date)}`, `DTEND;VALUE=DATE:${nextDay(date)}`,
    `SUMMARY:${esc(summary)}`, `DESCRIPTION:${esc(description)}`, `URL:${url}`, 'TRANSP:TRANSPARENT', 'END:VEVENT'];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const u = new URL(req.url);
  if (u.searchParams.has('ping')) return new Response('ok', { headers: { ...CORS, 'Content-Type': 'text/plain' } });
  const token = u.searchParams.get('t') ?? '';
  const scope = u.searchParams.get('scope') === 'all' ? 'all' : 'mine';

  const headers: Record<string, string> = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  if (SB_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SB_KEY}`;
  const r = await fetch(`${SB_URL}/rest/v1/rpc/growth_calendar_feed`, { method: 'POST', headers, body: JSON.stringify({ p_token: token }) });
  const feed = r.ok ? await r.json() : null;
  if (!feed) return new Response('This calendar link is not valid. Get a new one in Growth Hub.', { status: 404, headers: { ...CORS, 'Content-Type': 'text/plain' } });

  const site: string = feed.site || '';
  const owner: string = (feed.owner || '').toLowerCase();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let items: Milestone[] = feed.milestones || [];
  if (scope === 'mine') items = owner ? items.filter(m => [m.owner, ...(m.coOwners || [])].some(o => String(o || '').toLowerCase() === owner)) : [];

  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//KIPP NGC//Growth Hub//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${scope === 'mine' ? 'Growth Hub: my milestones' : 'Growth Hub: all milestones'}`,
    'X-PUBLISHED-TTL:PT4H', 'REFRESH-INTERVAL;VALUE=DURATION:PT4H'];
  for (const m of items) {
    if (!m.due_date) continue;
    const done = m.status === 'complete';
    const who = [m.owner, ...(m.coOwners || [])].filter(Boolean).join(', ') || 'Unassigned';
    const desc = [`Status: ${LABEL[m.status || ''] || m.status || 'Not set'}`, `Owner: ${who}`, m.market ? `Market: ${m.market}` : '', m.team ? `Team: ${m.team}` : '', '', `Open in Growth Hub: ${site}?m=${m.id}`].filter((x, i) => x || i === 4).join('\n');
    lines.push(...allDay(`m-${m.id}@growth-hub`, m.due_date, `${done ? 'Done' : 'Due'}: ${m.activity || 'Milestone'}`, desc, `${site}?m=${m.id}`, stamp));
  }
  for (const s of (feed.schools || []) as School[]) {
    if (!s.opening_date) continue;
    lines.push(...allDay(`s-${s.id}@growth-hub`, s.opening_date, `Opens: ${[s.market, s.label].filter(Boolean).join(' ')}`, `School opening\n\nGrowth Hub: ${site}`, site, stamp));
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(fold).join('\r\n') + '\r\n', {
    headers: { ...CORS, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="growth-hub.ics"', 'Cache-Control': 'max-age=900' }
  });
});
