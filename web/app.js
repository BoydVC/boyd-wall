/* Boyd Wall: mission-control dashboard. Plain JS, no dependencies.
   Data comes from /api/wall (live server) or window.__WALL_SNAPSHOT__ (offline snapshot).
   Rule: never invent numbers. Missing sources render an explicit "data unavailable" state. */
'use strict';
const Q = new URLSearchParams(location.search);
const SNAP = window.__WALL_SNAPSHOT__ || null;
const TZ = 'America/New_York';
const S = {
  data: null, kiosk: Q.has('kiosk'), ambient: Q.get('mode') === 'ambient', ambientAuto: Q.get('ambient') === 'auto',
  teamIdx: 0, teamTimer: null, wireIdx: 0, todayIdx: 0, fetchErr: null, lastOk: 0, teamDur: +(Q.get('rotate') || 12) * 1000,
  now: () => Q.get('now') ? FIXED_NOW + (performance.now() - T0) : Date.now(),
};
const T0 = performance.now();
const FIXED_NOW = Q.get('now') ? Date.parse(Q.get('now')) : 0;  // for screenshots/tests: ?now=2026-10-07T23:00:00-04:00

// ------------------------------------------------------------------ helpers
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmt = (opts) => new Intl.DateTimeFormat('en-US', {timeZone: TZ, ...opts});
const F = {
  hm: fmt({hour: 'numeric', minute: '2-digit'}), wd: fmt({weekday: 'short'}), wdl: fmt({weekday: 'long'}),
  md: fmt({month: 'short', day: 'numeric'}), full: fmt({weekday: 'long', month: 'long', day: 'numeric'}),
  wmd: fmt({weekday: 'short', month: 'short', day: 'numeric'}), ymd: fmt({year: 'numeric', month: '2-digit', day: '2-digit'}),
  my: fmt({month: 'short', year: 'numeric'}), hour: fmt({hour: 'numeric'}),
};
const etDay = (t) => F.ymd.format(t);  // "10/07/2026"
function relDay(t) {
  const n = S.now();
  if (etDay(t) === etDay(n)) return 'Today';
  if (etDay(t) === etDay(n + 864e5)) return 'Tomorrow';
  if (t > n && t - n < 6 * 864e5) return F.wdl.format(t);
  return F.wmd.format(t);
}
const timeET = (t) => F.hm.format(t) + ' ET';
const pad = (n) => String(n).padStart(2, '0');
function parts(ms) {
  const neg = ms < 0; ms = Math.abs(ms);
  const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
  return {neg, d, h, m, s};
}
function cdShort(ms) {  // "2d 04:11:09" / "04:11:09"
  const p = parts(ms);
  const core = `${pad(p.h)}:${pad(p.m)}:${pad(p.s)}`;
  return (p.neg ? '+' : '') + (p.d ? `${p.d}d ` : '') + core;
}
function cdWords(ms) {  // "in 2d 4h" / "in 41m"
  const p = parts(ms);
  if (p.neg) return 'started';
  if (p.d) return `in ${p.d}d ${p.h}h`;
  if (p.h) return `in ${p.h}h ${p.m}m`;
  return `in ${p.m}m ${pad(p.s)}s`;
}
function ago(sec) {
  if (sec == null) return '';
  const s = Math.max(0, S.now() / 1000 - sec);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const pt = (s) => Date.parse(s && s.length === 16 ? s + ':00-04:00' : s);  // tolerate legacy offset-less times
// Assign innerHTML only when it changed (keeps long CSS animations like the hero pan from restarting every refresh).
function setHTML(el, html) { if (el._h !== html) { el._h = html; el.innerHTML = html; } }
function img(p) { if (!p) return ''; if (SNAP) return (SNAP.images || {})[p] || ''; return p; }
function chip(st, label) {
  if (!st) return `<span class="chip unavailable">NO DATA</span>`;
  const state = st.state || 'unavailable';
  const txt = state === 'live' ? `${SNAP ? 'SNAPSHOT' : 'LIVE'} · ${ago(st.fetchedAt)}` : state === 'stale' ? `CACHED · ${ago(st.fetchedAt)}` : 'DATA UNAVAILABLE';
  const title = st.error ? ` title="${esc(st.error)}"` : '';
  return `<span class="chip ${state}"${title}>${label ? esc(label) + ' · ' : ''}${txt}</span>`;
}
function unavailable(what, st, extra = '') {
  return `<div class="unavail"><b>DATA UNAVAILABLE</b>${esc(what)}${extra}${st && st.error ? `<small>${esc(st.error)}</small>` : ''}</div>`;
}
// Launch Library precision → how much of the time we can honestly show.
function precisionKind(L) {
  const p = (L.precision || '').toLowerCase();
  if (!p || p === 'second' || p === 'minute') return 'exact';
  if (p.startsWith('hour')) return 'hour';
  if (p === 'day' || p.startsWith('morning') || p.startsWith('afternoon')) return 'day';
  return 'vague';  // week, month, quarter, half, year
}
function netLabel(L) {
  const t = Date.parse(L.net), k = precisionKind(L);
  if (k === 'exact') return `${relDay(t)} · ${timeET(t)}`;
  if (k === 'hour') return `${relDay(t)} · ~${F.hour.format(t)} ET`;
  if (k === 'day') return `NET ${F.wmd.format(t)}`;
  const p = (L.precision || '').toLowerCase();
  if (p.startsWith('quarter') || p.startsWith('q')) return `NET ${L.precision.replace('Quarter ', 'Q')} ${new Date(t).getUTCFullYear()}`;
  return `NET ${F.my.format(t)}`;
}
function statusPill(L) {
  const a = (L.status || '').toUpperCase();
  const cls = a === 'GO' ? 'go' : a === 'TBC' ? 'tbc' : a === 'SUCCESS' ? 'success' : (a === 'FAILURE' || a === 'PARTIAL FAILURE') ? 'failure' : a === 'IN FLIGHT' ? 'flight' : 'tbd';
  return `<span class="pill ${cls}" title="${esc(L.statusName || '')}">${esc(a || '—')}</span>`;
}
const shortName = (L) => (L.mission || L.name || '').replace(/^(Starlink Group )/, 'Starlink ');

// ------------------------------------------------------------------ data
async function load() {
  if (SNAP) { S.data = SNAP.data; S.lastOk = Date.now(); render(); return; }
  try {
    const r = await fetch('/api/wall', {cache: 'no-store'});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!d || !d.generatedAt) throw new Error('empty');
    S.data = Q.get('simulate') === 'outage' ? simulateOutage(d) : d; S.fetchErr = null; S.lastOk = Date.now();
    render();
  } catch (e) {
    S.fetchErr = String(e.message || e);
    banner();
    if (!S.data) render();
  }
}
// ?simulate=outage: every source reported down, to preview (and test) the "data unavailable" design.
function simulateOutage(d) {
  const st = {state: 'unavailable', error: 'simulated outage (?simulate=outage)', fetchedAt: null};
  return {generatedAt: d.generatedAt, spacex: {upcoming: [], previous: [], starship: null, starshipInList: [], status: {upcoming: st, previous: st, starship: st}},
    sports: {teams: (d.sports.teams || []).map((t) => ({key: t.key, name: t.name, full: t.full, abbr: t.abbr, colors: t.colors, status: st})), verifiedGames: d.sports.verifiedGames || [], notes: []},
    weather: {status: st}, fleet: {bots: [], status: st}, usage: d.usage, jim: d.jim};
}
function banner() {
  const b = $('banner');
  if (SNAP) { b.className = 'banner show snap'; b.textContent = `OFFLINE SNAPSHOT · DATA AS OF ${F.wmd.format(Date.parse(SNAP.takenAt)).toUpperCase()} ${timeET(Date.parse(SNAP.takenAt))}`; return; }
  if (S.fetchErr) { b.className = 'banner show err'; b.textContent = `WALL SERVER UNREACHABLE (${S.fetchErr}) · SHOWING LAST DATA FROM ${S.lastOk ? timeET(S.lastOk) : 'NEVER'}`; return; }
  b.className = 'banner';
}

// ------------------------------------------------------------------ render: SpaceX
function heroLaunch(sp) {
  const n = S.now();
  return (sp.upcoming || []).find((L) => Date.parse(L.net) > n - 3 * 36e5) || null;
}
function renderSpace() {
  const sp = (S.data && S.data.spacex) || {};
  const st = sp.status || {};
  $('spaceStatus').innerHTML = chip(st.upcoming, 'LL2');
  const L = heroLaunch(sp);
  const hero = $('hero');
  if (!L) {
    setHTML(hero, `<div class="content">${unavailable('No upcoming SpaceX launches from Launch Library 2 right now.', st.upcoming)}</div>`);
  } else {
    const k = precisionKind(L);
    const bg = img(L.imageLocal);
    const where = [L.pad, L.location].filter(Boolean).join(' · ');
    const cd = (k === 'exact' || k === 'hour')
      ? `<div class="cd" data-cd="${esc(L.net)}" data-cd-style="hero"></div>`
      : `<div class="cd"><div class="tm">${esc(netLabel(L))}</div></div>`;
    setHTML(hero, `${bg ? `<div class="bg" style="background-image:url('${bg}')"></div>` : ''}<div class="shade"></div><div class="glow"></div>
      <div class="content">
        <div class="kicker"><span class="phase">NEXT SPACEX LAUNCH</span> ${L.orbit ? `<span>· ${esc(L.orbit)}</span>` : ''} ${L.missionType ? `<span>· ${esc(L.missionType.toUpperCase())}</span>` : ''}</div>
        <div class="mission">${esc(shortName(L))}</div>
        <div class="vehicle">${esc(L.rocket || '')}${where ? ' · ' + esc(where) : ''}</div>
        <div class="when"><b>${esc(netLabel(L))}</b>${k === 'hour' ? ' <span style="color:var(--faint)">(hour precision)</span>' : ''}</div>
        ${cd}
      </div>
      <div class="pills">${statusPill(L)}${L.probability != null ? `<span class="pill">WX ${L.probability}% GO</span>` : ''}${L.webcastLive ? '<span class="pill flight">WEBCAST LIVE</span>' : ''}</div>
      ${bg && L.imageCredit ? `<div class="credit">Image: ${esc(L.imageCredit)} via Launch Library 2</div>` : ''}`);
  }
  // up next
  const rest = (sp.upcoming || []).filter((x) => x !== L && Date.parse(x.net) > S.now() - 3 * 36e5).slice(0, 5);
  $('upList').innerHTML = rest.length ? rest.map((x) => {
    const t = Date.parse(x.net), k = precisionKind(x);
    const d = k === 'vague' ? `<b>${esc(netLabel(x).replace('NET ', ''))}</b>NET` : `<b>${esc(F.wmd.format(t))}</b>${k === 'day' ? 'time TBD' : esc(timeET(t))}`;
    const c = (k === 'exact' || k === 'hour') ? `<span data-cd="${esc(x.net)}" data-cd-style="short"></span>` : `<span style="color:var(--faint)">—</span>`;
    return `<div class="row"><div class="d">${d}</div><div class="n">${esc(shortName(x))}<small>${esc((x.rocket || '').replace(' Block 5', ''))} · ${esc(x.pad || 'pad TBD')}</small></div><div class="c">${c}<br>${statusPill(x)}</div></div>`;
  }).join('') : (st.upcoming && st.upcoming.state === 'unavailable' ? unavailable('Upcoming launch list unavailable.', st.upcoming) : '<div class="unavail">No further launches listed.</div>');
  renderStarship(sp);
  // recent results
  const prev = (sp.previous || []).slice(0, 3);
  $('recent').innerHTML = prev.length ? prev.map((x) => `<div class="r"><span class="dt">${esc(F.md.format(Date.parse(x.net)))}</span><span class="nm">${esc(shortName(x))} <span style="color:var(--faint);font-size:12px">${esc((x.rocket || '').replace(' Block 5', ''))}</span></span>${statusPill(x)}</div>`).join('')
    : unavailable('Recent results from Launch Library 2 not loaded yet; the wall retries automatically (free tier is rate-limited).', st.previous);
  renderWire();
}
function renderStarship(sp) {
  const el = $('starship'), ss = sp.starship, st = (sp.status || {}).starship;
  const jimSS = ((S.data.jim || {}).space || []).filter((n) => /Starship/i.test(n.text));
  const jimLine = jimSS[0] ? `<div class="ss-note"><span class="k">JIM ${esc(((S.data.jim || {}).date || '').slice(5).replace('-', '/'))}</span>${esc(noteText(jimSS[0]))}</div>` : '';
  if (ss && (ss.upcomingLaunches.length || ss.previousLaunches.length || ss.upcomingEvents.length)) {
    const nx = ss.upcomingLaunches[0], pv = ss.previousLaunches[0];
    const lines = [];
    const ok = (x) => /success/i.test(x.status) ? '<span style="color:var(--green)">✓</span>' : /fail/i.test(x.status) ? '<span style="color:var(--red)">✗</span>' : esc(x.status || '');
    const fl = (x) => esc(shortName(x).replace(/^.*\((.*)\)$/, '$1').replace(/^Starship /, ''));
    if (pv) lines.push(`<div><span class="k">LAST</span>${fl(pv)} · ${esc(F.md.format(Date.parse(pv.net)))} ${ok(pv)}${ss.previousLaunches.slice(1, 3).map((x) => ` · ${fl(x)} ${ok(x)}`).join('')}</div>`);
    const pe = (ss.previousEvents || [])[0];
    if (pe) lines.push(`<div><span class="k">TEST</span>${esc(pe.name.replace(/^SpaceX Starship /, ''))} · ${esc(F.md.format(Date.parse(pe.date)))}</div>`);
    for (const e of ss.upcomingEvents.slice(0, 1)) lines.push(`<div><span class="k">NEXT</span>${esc(e.name)}${e.date ? ' · ' + esc(F.md.format(Date.parse(e.date))) : ''}</div>`);
    for (const c of ss.roadClosures.slice(0, 1)) lines.push(`<div><span class="k">ROAD</span>${esc(c.title)} · ${esc(c.status || '')}</div>`);
    if (ss.activeHardware && ss.activeHardware.length) lines.push(`<div><span class="k">ACTIVE</span>${esc(ss.activeHardware.slice(0, 6).join(' · '))}</div>`);
    const head = nx ? `<div class="ss-row"><div class="ss-big">${esc(shortName(nx))}</div><div class="ss-cd">${precisionKind(nx) === 'exact' ? `<span data-cd="${esc(nx.net)}" data-cd-style="short"></span>` : `<span class="ss-net">${esc(netLabel(nx))}</span>`} ${statusPill(nx)}</div></div>` : `<div class="ss-big">No Starship launch listed in LL2</div>`;
    el.innerHTML = `${head}<div class="ss-list">${lines.join('')}</div>${jimLine}<div class="ss-src">Launch Library 2 Starship dashboard · ${esc(ago(st && st.fetchedAt))}</div>`;
    return;
  }
  const inList = (sp.starshipInList || [])[0];
  if (inList) {
    el.innerHTML = `<div class="ss-row"><div class="ss-big">${esc(shortName(inList))}</div></div><div class="ss-sub">${esc(netLabel(inList))} · ${statusPill(inList)}</div><div class="ss-src">Launch Library 2</div>`;
    return;
  }
  const jim = S.data.jim || {};
  if (jimSS.length) {
    el.innerHTML = `<div class="ss-row"><div class="ss-big" style="font-size:19px">Starship · Flight status</div><span class="pill tbd">NOTES</span></div>
      <div class="ss-list" style="white-space:normal">${jimSS.slice(0, 2).map((n) => `<div style="white-space:normal;margin-top:4px;color:var(--text)">${esc(noteText(n))}</div>`).join('')}</div>
      <div class="ss-src">From Jim's Interest Journal (${esc(jim.file || '')}), not live · LL2 dashboard: ${esc(st ? st.state : 'not loaded')}</div>`;
    return;
  }
  el.innerHTML = unavailable('Starship program status unavailable.', st);
}
const noteText = (n) => n.text.length < 70 && n.detail ? `${n.text}: ${n.detail}` : n.text;
function renderWire() {
  const jim = (S.data && S.data.jim) || {};
  const items = jim.space || [];
  const el = $('wire');
  if (!items.length) { el.innerHTML = `<span class="tag">SPACE WIRE</span><div class="txt"><div class="item on" style="color:var(--faint)">No research notes found.</div></div>`; return; }
  el.innerHTML = `<span class="tag">SPACE WIRE</span><div class="txt">${items.map((n, i) => `<div class="item${i === S.wireIdx % items.length ? ' on' : ''}"><i>${esc(n.group.toUpperCase())}</i>${esc(noteText(n))}</div>`).join('')}</div>
    <div class="src">Jim's Interest Journal<br>${esc(jim.date ? F.wmd.format(Date.parse(jim.date + 'T12:00:00-04:00')) : '')}</div>`;
}

// ------------------------------------------------------------------ render: sports
const teamColor = (t) => (t.colors || ['#334'])[0];
function gameLine(t, g) {
  const where = g.home ? 'vs' : '@';
  return `${t.name} ${where} ${g.oppShort || g.opp}`;
}
function verifiedFor(t, g) {
  const v = ((S.data.sports || {}).verifiedGames || []).filter((x) => x.team === t.name);
  const gt = Date.parse(g.date);
  const m = v.find((x) => Math.abs(Date.parse(x.startET) - gt) < 36 * 36e5);
  if (!m) return null;
  return {match: Math.abs(Date.parse(m.startET) - gt) < 6e4, v: m};
}
function allNextGames() {
  const sp = S.data.sports || {};
  const out = [];
  const n = S.now();
  for (const t of sp.teams || []) {
    const evs = (t.live || []).concat(t.next || []);
    if (evs.length) for (const g of evs.slice(0, 2)) out.push({t, g, t0: Date.parse(g.date), src: 'espn'});
    else if (t.status && t.status.state === 'unavailable') {  // ESPN down for this team: fall back to Bot Island's verified list
      for (const v of (sp.verifiedGames || []).filter((x) => x.team === t.name && Date.parse(x.startET) > n - 4 * 36e5).slice(0, 2))
        out.push({t, g: {date: v.startET, timeValid: true, label: v.label, tv: [v.tv], venue: v.note}, t0: Date.parse(v.startET), src: 'verified'});
    }
  }
  return out.filter((x) => x.t0 > n - 4 * 36e5).sort((a, b) => a.t0 - b.t0);
}
function renderNextUp() {
  const games = allNextGames().slice(0, 4);
  $('nextUp').innerHTML = games.length ? games.map(({t, g, t0, src}) => {
    const live = g.state === 'in';
    const when = g.timeValid === false ? `${F.wmd.format(t0)} · time TBD` : `${relDay(t0)} · ${timeET(t0)}`;
    const c = live ? `<span style="color:var(--red)">LIVE ${esc(g.score)}–${esc(g.oppScore)}</span>` : g.timeValid === false ? `<span>${esc(cdWords(t0 - S.now()).replace(/ \d+h$/, ''))}</span>` : `<span data-cd="${esc(g.date)}" data-cd-style="words"></span>`;
    return `<div class="nu"><div class="bar" style="background:${teamColor(t)}"></div><div><div class="m">${esc(g.label || gameLine(t, g))}</div><div class="w">${esc(when)}${g.tv && g.tv[0] ? ' · ' + esc(g.tv[0]) : ''}</div></div><div class="c">${c}<small>${src === 'verified' ? 'VERIFIED LIST' : esc(t.name.toUpperCase())}</small></div></div>`;
  }).join('') : unavailable('No upcoming games found for Ravens, Terps or Chelsea.', null);
}
function standingsTable(sd) {
  if (!sd || !sd.rows || !sd.rows.length) return '';
  return `<div class="stand-label">${esc(sd.label.toUpperCase())}</div><table class="stand"><tr><th>TEAM</th>${sd.cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${sd.rows.map((r) => r.gap ? `<tr class="gap"><td colspan="${sd.cols.length + 1}">⋯</td></tr>`
    : `<tr class="${r.me ? 'me' : ''}"><td>${r.rank ? `<span class="rk">${r.rank}</span>` : ''}${esc(r.team)}</td>${(r.cells || []).map((c) => `<td>${esc(c ?? '—')}</td>`).join('')}</tr>`).join('')}</table>`;
}
function teamCard(t) {
  const c = t.colors || ['#333', '#999'];
  const logo = img(t.logo);
  const jimT = (((S.data.jim || {}).sports || {})[t.key]) || null;
  const band = `<div class="band" style="background:linear-gradient(110deg, ${c[0]} 0%, ${c[0]}cc 45%, ${c[1]}33 100%)">
      <div class="logo">${logo ? `<img src="${logo}" alt="">` : `<span class="ab">${esc(t.abbr || t.name.slice(0, 3))}</span>`}</div>
      <div class="tn"><div class="n">${esc(t.full || t.name)}</div><div class="s">${esc(t.standingSummary || '')}</div></div>
      <div class="rec"><div class="v">${esc(t.record || '—')}</div><div class="l">${t.offseason || t.key === 'orioles' ? 'FINAL RECORD' : 'RECORD'}</div></div></div>`;
  const note = jimT && (jimT.items[0] || jimT.heading) ? `<div class="note"><i>JIM'S NOTES${(S.data.jim || {}).date ? ' · ' + esc(F.md.format(Date.parse(S.data.jim.date + 'T12:00:00-04:00')).toUpperCase()) : ''}</i>${esc(jimT.items[0] || jimT.heading)}</div>` : '';
  if (t.status && t.status.state === 'unavailable' && !t.record) {
    return band + `<div class="offseason">${unavailable(`ESPN data for the ${t.name} is unavailable.`, t.status)}${note}</div>`;
  }
  if (t.key === 'orioles') {
    const bi = ((S.data.sports || {}).notes || []).find((x) => x.team === 'Orioles');
    return band + `<div class="offseason"><div class="big">Offseason</div><p>${esc(bi ? bi.note : 'No games scheduled.')}</p>
      <p style="font-family:var(--mono);font-size:12px;color:var(--faint)">ESPN: ${esc(t.record || '—')} · ${esc(t.standingSummary || '')} · no upcoming games listed</p>${note}</div>`;
  }
  const g = (t.live || [])[0] || (t.next || [])[0];
  let gameHtml = '';
  if (g) {
    const t0 = Date.parse(g.date), live = g.state === 'in';
    const opplogo = img(g.oppLogoLocal);
    const ver = verifiedFor(t, g);
    gameHtml = `<div class="game ${live ? 'live-g' : ''}"><div class="k">${live ? 'LIVE NOW' : 'NEXT GAME'}${g.competition && t.sport === 'soccer' ? ' · ' + esc(String(g.competition).toUpperCase()) : g.week ? ' · ' + esc(g.week.toUpperCase()) : ''}</div>
      <div class="vs">${opplogo ? `<img src="${opplogo}" alt="">` : ''}<div class="o">${g.home ? 'vs' : '@'} ${esc(g.opp)}</div></div>
      ${live ? `<div class="score">${esc(g.score)} – ${esc(g.oppScore)}</div><div class="t">${esc(g.statusDetail || '')}</div>`
        : `<div class="t"><b>${esc(g.timeValid === false ? F.wmd.format(t0) + ' · time TBD' : relDay(t0) + ' · ' + timeET(t0))}</b>${g.tv && g.tv.length ? ' · ' + esc(g.tv.join(', ')) : ''}</div>
           <div class="t" style="font-size:13px;margin-top:3px">${esc([g.venue, g.city].filter(Boolean).join(', '))}</div>
           ${g.timeValid === false ? '' : `<div class="cd" data-cd="${esc(g.date)}" data-cd-style="game"></div>`}
           ${ver ? `<div class="ver ${ver.match ? '' : 'warn'}">${ver.match ? '✓ matches Bot Island\'s verified schedule' : `⚠ verified list says ${esc(timeET(Date.parse(ver.v.startET)))}`}</div>` : ''}`}
      </div>`;
  } else {
    gameHtml = `<div class="game"><div class="k">NEXT GAME</div><div class="t">No upcoming game listed by ESPN.</div></div>`;
  }
  const last = (t.last || []).slice(0, 3);
  const res = last.length ? `<div class="results">${last.map((e) => `<div class="res"><div class="wl ${esc(e.result || '')}">${esc(e.result || '·')}</div><div class="sc">${esc(e.score)}–${esc(e.oppScore)}</div><div class="op">${e.home ? 'v' : '@'} ${esc(e.oppAbbr || '')} · ${esc(F.md.format(Date.parse(e.date)))}</div></div>`).join('')}</div>` : '';
  return band + `<div class="body"><div>${gameHtml}${res}</div><div>${standingsTable(t.standings) || (t.standingsStatus && t.standingsStatus.state === 'unavailable' ? unavailable('Standings unavailable.', t.standingsStatus) : '')}${note}</div></div>`;
}
function renderSports() {
  const sp = (S.data && S.data.sports) || {};
  const teams = sp.teams || [];
  const worst = teams.map((t) => t.status).filter(Boolean).sort((a, b) => ['live', 'stale', 'unavailable'].indexOf(b.state) - ['live', 'stale', 'unavailable'].indexOf(a.state))[0];
  $('sportsStatus').innerHTML = chip(worst, 'ESPN');
  renderNextUp();
  const stage = $('teamStage');
  if (!teams.length) { stage.innerHTML = unavailable('Sports data unavailable.', null); return; }
  S.teamIdx %= teams.length;
  const liveIdx = teams.findIndex((t) => (t.live || []).length);
  if (liveIdx >= 0 && !S.liveLocked) { S.teamIdx = liveIdx; S.liveLocked = true; }
  if (liveIdx < 0) S.liveLocked = false;
  // Only touch the DOM when the content changed, so the 60 s data refresh never interrupts a crossfade.
  const html = teams.map((t, i) => `<div class="team" data-i="${i}">${teamCard(t)}</div>`).join('');
  if (html !== S.teamHtml) {
    S.teamHtml = html; stage.innerHTML = html;
    stage.children[S.teamIdx] && stage.children[S.teamIdx].classList.add('on');
    $('teamDots').innerHTML = teams.map((t, i) => `<span class="${i === S.teamIdx ? 'on' : ''}" style="--dur:${S.teamDur}ms"></span>`).join('');
  }
}
function rotateTeam(dir = 1, manual = false) {
  const cards = [...document.querySelectorAll('#teamStage .team')];
  if (cards.length < 2) return;
  const liveIdx = ((S.data.sports || {}).teams || []).findIndex((t) => (t.live || []).length);
  if (!manual && liveIdx >= 0 && liveIdx === S.teamIdx) return;  // a game is on: keep its card up
  const cur = cards[S.teamIdx];
  S.teamIdx = (S.teamIdx + dir + cards.length) % cards.length;
  cur.classList.remove('on'); cur.classList.add('off');
  setTimeout(() => cur.classList.remove('off'), 1000);
  cards[S.teamIdx].classList.add('on');
  $('teamDots').innerHTML = cards.map((c, i) => `<span class="${i === S.teamIdx ? 'on' : ''}" style="--dur:${S.teamDur}ms"></span>`).join('');
  tick();
}

// ------------------------------------------------------------------ render: weather
function renderWeather() {
  const w = (S.data && S.data.weather) || {};
  $('wxStatus').innerHTML = chip(w.status, w.provider === 'nws' ? 'NWS' : 'OPEN-METEO');
  const cur = w.current;
  if (!cur) {
    $('wxNow').innerHTML = `<div class="meta">Weather<br><b style="color:var(--red)">unavailable</b></div>`;
    $('wxBody').innerHTML = `<div style="grid-column:1/-1">${unavailable('Open-Meteo and the National Weather Service both failed.', w.status)}</div>`;
    return;
  }
  const today = (w.daily || [])[0] || {};
  const sun = today.sunset ? `Sunset ${timeET(pt(today.sunset)).replace(' ET', '')}` : '';
  $('wxNow').innerHTML = `<div class="meta"><b>${esc(cur.text || '')}</b><br>${today.hi != null ? `H ${Math.round(today.hi)}° · L ${Math.round(today.lo)}°` : ''}${cur.feels != null ? ` · Feels ${Math.round(cur.feels)}°` : ''}<br>${esc(sun)}${w.aqi != null ? ` · AQI ${w.aqi}` : ''}</div>
    <div class="ic">${cur.icon || ''}</div><div class="t">${cur.temp != null ? Math.round(cur.temp) : '—'}<sup>°F</sup></div>`;
  const hrs = (w.hourly || []).slice(0, 24);
  let spark = '';
  if (hrs.length > 2) {
    const W = Math.round(($('wxBody').clientWidth || 710) - 400), H = 150, top = 24, bot = 44;
    const temps = hrs.map((h) => h.temp), lo = Math.min(...temps), hi = Math.max(...temps), rng = Math.max(4, hi - lo);
    const x = (i) => 14 + i * (W - 28) / (hrs.length - 1), y = (v) => top + (1 - (v - lo) / rng) * (H - top - bot);
    const pts = hrs.map((h, i) => `${x(i).toFixed(1)},${y(h.temp).toFixed(1)}`);
    const area = `M${x(0)},${H - bot} L${pts.join(' L')} L${x(hrs.length - 1)},${H - bot} Z`;
    const bars = hrs.map((h, i) => h.pop ? `<rect x="${x(i) - 5}" y="${H - bot - h.pop * 0.4}" width="10" height="${h.pop * 0.4}" rx="2" fill="rgba(125,211,252,.35)"/>` : '').join('');
    const labels = hrs.map((h, i) => i % 3 === 0 ? `<text x="${x(i)}" y="${y(h.temp) - 9}" text-anchor="middle" style="fill:var(--text)">${Math.round(h.temp)}°</text><text x="${x(i)}" y="${H - 4}" text-anchor="middle">${esc(F.hour.format(pt(h.time)).replace(' ', '').toLowerCase())}</text><text x="${x(i)}" y="${H - 22}" text-anchor="middle" font-size="14">${h.icon || ''}</text>` : '').join('');
    spark = `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><defs><linearGradient id="tg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="rgba(251,191,36,.35)"/><stop offset="1" stop-color="rgba(251,191,36,0)"/></linearGradient></defs>
      ${bars}<path d="${area}" fill="url(#tg)"/><polyline points="${pts.join(' ')}" fill="none" stroke="var(--amber)" stroke-width="2.5" stroke-linejoin="round"/>${labels}
      <circle cx="${x(0)}" cy="${y(hrs[0].temp)}" r="4.5" fill="var(--amber)"><animate attributeName="r" values="4;7;4" dur="2.4s" repeatCount="indefinite"/></circle></svg>`;
  }
  const evByDay = weekEvents();
  const days = (w.daily || []).slice(0, 6).map((d, i) => {
    const key = etDay(Date.parse(d.date + 'T12:00:00-04:00'));
    const evs = (evByDay[key] || []).slice(0, 3);
    return `<div class="day"><div class="dn">${key === etDay(S.now()) ? 'TODAY' : esc(F.wd.format(Date.parse(d.date + 'T12:00:00-04:00')).toUpperCase())}</div><div class="di">${d.icon || ''}</div>
      <div class="hl">${d.hi != null ? Math.round(d.hi) + '°' : '—'} <span>${d.lo != null ? Math.round(d.lo) + '°' : ''}</span></div><div class="pp">${d.pop ? '💧' + Math.round(d.pop) + '%' : ''}</div>
      <div class="evs">${evs.map((e) => `<span class="ev" style="background:${e.color}" title="${esc(e.title)}">${esc(e.label)}</span>`).join('')}</div></div>`;
  }).join('');
  $('wxBody').innerHTML = `<div>${spark || '<div class="unavail">Hourly forecast unavailable.</div>'}</div><div class="days">${days}</div>`;
}

// Launches and games keyed by ET calendar day, for the week-ahead strip.
function weekEvents() {
  const out = {}, add = (t, e) => { (out[etDay(t)] = out[etDay(t)] || []).push({...e, t}); };
  const sp = (S.data && S.data.spacex) || {};
  for (const L of (sp.upcoming || [])) { const k = precisionKind(L); if (k === 'exact' || k === 'hour') add(Date.parse(L.net), {label: '🚀', color: 'rgba(94,234,212,.22)', title: `${shortName(L)} ${timeET(Date.parse(L.net))}`}); }
  for (const {t, g, t0} of (S.data && S.data.sports ? allNextGames() : [])) add(t0, {label: t.key === 'ravens' ? 'BAL' : t.key === 'terps' ? 'UMD' : (t.abbr || t.name.slice(0, 3)), color: (t.colors || ['#334'])[0], title: `${g.label || gameLine(t, g)} ${timeET(t0)}`});
  for (const k in out) out[k].sort((a, b) => a.t - b.t);
  return out;
}

// ------------------------------------------------------------------ render: fleet strip
const BOT_COLORS = {red: '#f87171', blue: '#60a5fa', green: '#4ade80', yellow: '#facc15', orange: '#fb923c', violet: '#a78bfa', cyan: '#22d3ee', magenta: '#f472b6', gray: '#94a3b8', pink: '#f472b6', purple: '#a78bfa'};
function renderFleet() {
  const f = (S.data && S.data.fleet) || {};
  const u = ((S.data && S.data.usage) || {}).data;
  // fuel gauge
  if (u && u.used_pct != null) {
    const used = +u.used_pct, left = Math.max(0, 100 - used);
    const R = 29, C = 2 * Math.PI * R;
    const resetT = u.reset_at ? Date.parse(u.reset_at) : (u.reset_date ? Date.parse(u.reset_date + 'T00:00:00Z') : null);
    $('fuel').innerHTML = `<svg class="gauge" viewBox="0 0 70 70"><circle cx="35" cy="35" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="8"/>
        <circle cx="35" cy="35" r="${R}" fill="none" stroke="url(#fg)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(C * left / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 35 35)"/>
        <defs><linearGradient id="fg"><stop offset="0" stop-color="#f472b6"/><stop offset="1" stop-color="#fbbf24"/></linearGradient></defs>
        <text x="35" y="40" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="15" font-weight="700" fill="#e8eefc">${left}%</text></svg>
      <div><div class="ft">TOKENMAX FUEL · GROK BOT WEEKLY</div><div class="fv">${left}% left <span>· ${used}% used</span></div>
      <div class="fr">${resetT && resetT < S.now() ? `Reset window opened ${esc(timeET(resetT))} · awaiting next usage check` : resetT ? `${u.reset_at ? 'Resets' : 'Resets ≥'} ${relDay(resetT) === 'Today' ? '' : esc(relDay(resetT)) + ' '}${esc(timeET(resetT))} · <span data-cd="${new Date(resetT).toISOString()}" data-cd-style="words"></span>` : 'Reset time unknown'}</div>
      <div class="ft" style="margin-top:3px">checked ${esc(u.checked_at ? timeET(Date.parse(u.checked_at)) : '?')}</div></div>`;
  } else {
    $('fuel').innerHTML = unavailable('TokenMax usage file not found.', ((S.data && S.data.usage) || {}).status);
  }
  const bots = f.bots || [];
  if (!bots.length) { S.tickerHtml = null; $('ticker').innerHTML = `<div style="padding:0 20px">${unavailable('Bot Island fleet data unavailable.', f.status)}</div>`; $('ticker').style.animation = 'none'; }
  else {
    const one = bots.map((b) => {
      const col = BOT_COLORS[b.color] || '#94a3b8';
      let s;
      if (b.state === 'working') s = `● working${b.doing ? ': ' + esc(b.doing) : ''}`;
      else if (b.next) s = `next ${esc(relDay(Date.parse(b.next)) === 'Today' ? '' : relDay(Date.parse(b.next)).slice(0, 3) + ' ')}${esc(timeET(Date.parse(b.next)).replace(' ET', ''))} · ${esc(b.nextName || '')}`;
      else s = b.lastActive ? `idle · last active ${esc(ago(Date.parse(b.lastActive) / 1000))}` : 'on call (no routines)';
      return `<div class="bot ${b.state}"><div class="av" style="background:${col}">${esc(b.name.replace(/^Boyd /, '').slice(0, 1))}</div><div><div class="bn">${esc(b.name)}</div><div class="bs">${s}</div></div></div>`;
    }).join('');
    if (S.tickerHtml !== one) { S.tickerHtml = one; $('ticker').innerHTML = one + one; }  // duplicated for a seamless loop; untouched if unchanged
    $('ticker').style.setProperty('--tdur', Math.max(40, bots.length * 7) + 's');
  }
  const d = f.doctor;
  const working = bots.filter((b) => b.state === 'working').length;
  $('doctor').innerHTML = d ? `<div><div class="l">FLEET DOCTOR</div><div class="sc" style="color:${d.score >= 80 ? 'var(--green)' : d.score >= 60 ? 'var(--amber)' : 'var(--red)'}">${d.score}</div></div>
      <div><div class="c">${bots.length} bots · ${working} working</div><div class="c">${d.counts ? `${d.counts.high || 0} high · ${d.counts.medium || 0} med` : ''}</div>${chip(f.status)}</div>`
    : `<div><div class="l">FLEET</div><div class="c">${bots.length} bots · ${working} working</div>${chip(f.status)}</div>`;
}

// ------------------------------------------------------------------ today line + ambient
function todayItems() {
  const items = [];
  const d = S.data || {}, n = S.now();
  const L = d.spacex ? heroLaunch(d.spacex) : null;
  if (L) items.push(`<span class="em">🚀</span>${esc(shortName(L).replace('Transport Layer', 'T-Layer'))} · <b>${esc(netLabel(L))}</b>`);
  const g = d.sports ? allNextGames()[0] : null;
  if (g) items.push(`<span class="em">${g.t.sport === 'soccer' ? '⚽' : g.t.sport === 'baseball' ? '⚾' : '🏈'}</span>Next up: ${esc(g.g.label || gameLine(g.t, g.g))} · <b>${esc(relDay(g.t0))} ${esc(timeET(g.t0))}</b>`);
  const w = d.weather || {}, today = (w.daily || [])[0];
  if (w.current && today) items.push(`<span class="em">${w.current.icon || '🌡️'}</span>${esc(today.text || w.current.text)}, high <b>${Math.round(today.hi)}°</b>, low ${Math.round(today.lo)}°${today.pop ? ` · ${Math.round(today.pop)}% rain` : ''}${today.sunset ? ' · sunset ' + esc(timeET(pt(today.sunset))) : ''}`);
  const bots = (d.fleet || {}).bots || [];
  const tonight = bots.filter((b) => b.next && etDay(Date.parse(b.next)) === etDay(n)).sort((a, b) => a.next.localeCompare(b.next));
  if (bots.length) items.push(`<span class="em">🤖</span>${tonight.length ? `${tonight.length} bot routine${tonight.length > 1 ? 's' : ''} left today · next <b>${esc(tonight[0].name)} ${esc(timeET(Date.parse(tonight[0].next)))}</b>` : `${bots.length} bots on the island · no more routines today`}`);
  const u = (d.usage || {}).data;
  if (u && u.used_pct != null) items.push(`<span class="em">⛽</span><b>${100 - u.used_pct}%</b> of Grok Bot weekly usage left · resets ${esc(u.reset_at ? timeET(Date.parse(u.reset_at)) : 'as early as ' + timeET(Date.parse(u.reset_date + 'T00:00:00Z')))}`);
  const jim = d.jim || {};
  const ss = (jim.space || [])[0];
  if (ss) items.push(`<span class="em">📰</span>${esc(ss.text.split(/(?<=\.)\s/)[0])}`);
  return items.length ? items : ['<span class="em">🛰️</span>Waiting for data…'];
}
function renderToday() {
  const items = todayItems();
  S.todayIdx %= items.length;
  $('todayLine').innerHTML = items.map((h, i) => `<div class="item${i === S.todayIdx ? ' on' : ''}">${h}</div>`).join('');
}
function renderAmbient() {
  const d = S.data || {};
  const w = d.weather || {}, today = (w.daily || [])[0];
  $('ambWx').innerHTML = w.current ? `${w.current.icon || ''} ${Math.round(w.current.temp)}°F · ${esc(w.current.text || '')}${today ? ` · H ${Math.round(today.hi)}° L ${Math.round(today.lo)}°` : ''}` : 'Weather unavailable';
  const lines = [];
  const L = d.spacex ? heroLaunch(d.spacex) : null;
  if (L) lines.push(`<div class="amb-line"><div class="k">NEXT LAUNCH</div><div class="v">${esc(shortName(L))}</div>${precisionKind(L) === 'exact' ? `<div class="c" data-cd="${esc(L.net)}" data-cd-style="short"></div>` : `<div class="c">${esc(netLabel(L))}</div>`}</div>`);
  const g = d.sports ? allNextGames()[0] : null;
  if (g) lines.push(`<div class="amb-line"><div class="k">NEXT GAME · ${esc(relDay(g.t0).toUpperCase())} ${esc(timeET(g.t0))}</div><div class="v">${esc(g.g.label || gameLine(g.t, g.g))}</div><div class="c" data-cd="${esc(g.g.date)}" data-cd-style="game"></div></div>`);
  $('ambLines').innerHTML = lines.join('');
}

// ------------------------------------------------------------------ render + tick
function render() {
  if (!S.data) return;
  banner();
  for (const fn of [renderSpace, renderSports, renderWeather, renderFleet, renderToday, renderAmbient]) {
    try { fn(); } catch (e) { console.error(fn.name, e); }
  }
  tick();
}
function tick() {
  const n = S.now();
  const hm = F.hm.formatToParts(n);
  const h = hm.find((p) => p.type === 'hour').value, m = hm.find((p) => p.type === 'minute').value, ap = (hm.find((p) => p.type === 'dayPeriod') || {}).value || '';
  const s = pad(new Date(n).getSeconds());
  $('clkHM').textContent = `${h}:${m}`; $('clkS').textContent = `:${s}`; $('clkAP').textContent = ap;
  $('clkDate').textContent = F.full.format(n);
  $('ambClock').innerHTML = `${h}:${m}<span class="ap">${ap}</span>`; $('ambDate').textContent = F.full.format(n);
  for (const el of document.querySelectorAll('[data-cd]')) {
    if (el.closest('.team:not(.on)')) continue;
    const t = Date.parse(el.dataset.cd), ms = t - n, style = el.dataset.cdStyle;
    if (style === 'hero') {
      const p = parts(ms);
      const hero = $('hero');
      hero.classList.toggle('imminent', ms > 0 && ms < 36e5);
      hero.classList.toggle('liftoff', ms <= 0);
      const kick = hero.querySelector('.kicker .phase');
      if (kick) kick.textContent = ms <= 0 ? 'LIFTOFF WINDOW · AWAITING RESULT' : ms < 36e5 ? 'LAUNCH WITHIN THE HOUR' : 'NEXT SPACEX LAUNCH';
      const unit = (v, u) => `<div class="cdu"><div class="v">${v}</div><div class="u">${u}</div></div>`;
      const label = ms >= 0 ? 'T−' : 'T+';
      el.innerHTML = `<div class="tm">${label}</div>${p.d ? unit(pad(p.d), 'DAYS') + '<div class="cdsep">:</div>' : ''}${unit(pad(p.h), 'HRS')}<div class="cdsep">:</div>${unit(pad(p.m), 'MIN')}<div class="cdsep">:</div>${unit(pad(p.s), 'SEC')}`;
    } else if (style === 'words') el.textContent = ms < 0 ? (ms > -4 * 36e5 ? 'under way' : 'passed') : cdWords(ms);
    else if (style === 'game') el.textContent = ms < 0 ? 'under way' : cdShort(ms).replace(/^(\d+)d /, '$1d · ');
    else el.textContent = ms < 0 ? `T+${cdShort(ms).slice(1)}` : `T−${cdShort(ms)}`;
  }
  // ambient auto: late night / early morning
  if (S.ambientAuto) {
    const hr = +fmt({hour: 'numeric', hour12: false}).format(n) % 24;
    setAmbient(hr >= 23 || hr < 6);
  }
}
function setAmbient(on) {
  if (S.ambient === on && document.body.classList.contains('ambient') === on) return;
  S.ambient = on; document.body.classList.toggle('ambient', on);
}

// ------------------------------------------------------------------ stage scaling + burn-in shift
function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  const st = $('stage');
  st.style.transform = `scale(${s})`;
  st.style.left = `${(innerWidth - 1920 * s) / 2}px`; st.style.top = `${(innerHeight - 1080 * s) / 2}px`;
  const c = $('sky'); c.width = innerWidth; c.height = innerHeight;
}
function shift() { const a = Math.random() * Math.PI * 2, r = 3; $('stage').style.translate = `${(Math.cos(a) * r).toFixed(1)}px ${(Math.sin(a) * r).toFixed(1)}px`; }

// ------------------------------------------------------------------ starfield (cheap, ~24 fps)
const stars = [];
function sky() {
  const c = $('sky'), g = c.getContext('2d');
  if (!stars.length) for (let i = 0; i < 220; i++) stars.push({x: Math.random(), y: Math.random(), z: Math.random() * .8 + .2, tw: Math.random() * 6.28});
  let shoot = null, last = 0;
  const frame = (t) => {
    requestAnimationFrame(frame);
    if (t - last < 42) return; last = t;
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const drift = t * 0.000004;
    for (const s of stars) {
      const x = ((s.x + drift * s.z) % 1) * W, y = s.y * H;
      const a = (0.25 + 0.55 * s.z) * (0.75 + 0.25 * Math.sin(t * 0.0012 * s.z + s.tw)) * (S.ambient ? 1 : 0.7);
      g.fillStyle = `rgba(200,220,255,${a.toFixed(3)})`;
      g.fillRect(x, y, s.z * 1.7, s.z * 1.7);
    }
    if (!shoot && Math.random() < 0.0025) shoot = {x: Math.random() * W * .7, y: Math.random() * H * .4, vx: 9 + Math.random() * 6, vy: 3 + Math.random() * 3, life: 0};
    if (shoot) {
      shoot.life++; shoot.x += shoot.vx; shoot.y += shoot.vy;
      const grad = g.createLinearGradient(shoot.x, shoot.y, shoot.x - shoot.vx * 10, shoot.y - shoot.vy * 10);
      grad.addColorStop(0, 'rgba(255,255,255,.8)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.strokeStyle = grad; g.lineWidth = 1.6; g.beginPath(); g.moveTo(shoot.x, shoot.y); g.lineTo(shoot.x - shoot.vx * 10, shoot.y - shoot.vy * 10); g.stroke();
      if (shoot.life > 40) shoot = null;
    }
  };
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot
function boot() {
  if (S.kiosk) document.body.classList.add('kiosk');
  if (S.ambient) document.body.classList.add('ambient');
  if (Q.get('team')) S.teamIdx = Math.max(0, ['ravens', 'terps', 'chelsea', 'orioles'].indexOf(Q.get('team')));
  fit(); addEventListener('resize', fit);
  sky();
  load();
  setInterval(tick, 250);
  if (!SNAP) setInterval(load, 60e3);
  if (!Q.has('still')) {
    S.teamTimer = setInterval(() => rotateTeam(1), S.teamDur);
    setInterval(() => { S.wireIdx++; const it = document.querySelectorAll('#wire .item'); it.forEach((e, i) => e.classList.toggle('on', i === S.wireIdx % it.length)); }, 9000);
    setInterval(() => { S.todayIdx++; renderToday(); }, 7000);
    setInterval(shift, 60e3);
  }
  setInterval(renderAmbient, 30e3);
  if (S.kiosk && !SNAP) setTimeout(() => location.reload(), 6 * 36e5);  // daily-ish refresh keeps a TV tab healthy
  if (!S.kiosk) { $('hint').classList.add('show'); setTimeout(() => $('hint').classList.remove('show'), 8000); }
  addEventListener('keydown', (e) => {
    if (e.key === 'a' || e.key === 'A') { S.ambientAuto = false; setAmbient(!S.ambient); }
    else if (e.key === 'f' || e.key === 'F') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}); }
    else if (e.key === 'r' || e.key === 'R') { if (!SNAP) fetch('/api/refresh').then(() => setTimeout(load, 4000)); load(); }
    else if (e.key === 'ArrowRight') { clearInterval(S.teamTimer); rotateTeam(1, true); S.teamTimer = setInterval(() => rotateTeam(1), S.teamDur); }
    else if (e.key === 'ArrowLeft') { clearInterval(S.teamTimer); rotateTeam(-1, true); S.teamTimer = setInterval(() => rotateTeam(1), S.teamDur); }
  });
  document.addEventListener('dblclick', () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); });
  window.WALL = S;  // for tests
}
boot();
