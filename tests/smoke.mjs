// Smoke test: drives headless Chrome over CDP against the live wall (and the offline snapshot).
// Fails on any page error, on "undefined"/"NaN" leaking into the UI, or on a missing panel.
// Usage: node --experimental-websocket tests/smoke.mjs [port]
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
const port = process.argv[2] || '4848', dbg = 9800 + Math.floor(Math.random() * 400);
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${dbg}`, '--window-size=1920,1080', `--user-data-dir=/tmp/boyd-wall-smoke-${dbg}`, 'about:blank'], {stdio: 'ignore'});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(); let errors = [];
async function connect() {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${dbg}/json`); const t = (await r.json()).find((x) => x.type === 'page'); if (t) return t.webSocketDebuggerUrl; } catch {} await sleep(200); }
  throw new Error('chrome did not start');
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id: i, method, params})); });
async function ev(expr) { const r = await send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true}); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result?.result?.value; }
const checks = [];
const check = (name, ok, detail = '') => { checks.push({name, ok: !!ok}); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`); };
async function open(url, wait = 2500) { errors = []; await send('Page.navigate', {url}); await sleep(wait); }
try {
  // server API first
  const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  check('server /api/health ok', h.ok, `uptime ${h.uptime}s`);
  const w = await (await fetch(`http://127.0.0.1:${port}/api/wall`)).json();
  check('wall has all sections', ['spacex', 'sports', 'weather', 'fleet', 'usage', 'jim'].every((k) => k in w));
  for (const [k, st] of [['spacex.upcoming', w.spacex?.status?.upcoming], ['spacex.previous', w.spacex?.status?.previous], ['spacex.starship', w.spacex?.status?.starship], ['weather', w.weather?.status], ['fleet', w.fleet?.status], ...(w.sports?.teams || []).map((t) => ['sports.' + t.key, t.status])])
    console.log(`   · source ${k}: ${st?.state}${st?.error ? ' (' + st.error + ')' : ''}`);
  const k = await fetch(`http://127.0.0.1:${port}/kiosk`, {redirect: 'manual'});
  check('/kiosk redirects to kiosk URL', k.status === 302 && /kiosk=1/.test(k.headers.get('location')));

  ws = new WebSocket(await connect());
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon/.test(d.params.entry.url || '')) errors.push(d.params.entry.text); };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  await open(`http://127.0.0.1:${port}/`);
  check('data loaded', await ev('!!WALL.data && !!WALL.data.generatedAt'));
  check('clock shows ET time', /^\d{1,2}:\d\d$/.test(await ev(`document.getElementById('clkHM').textContent`)), await ev(`document.getElementById('clkHM').textContent + document.getElementById('clkAP').textContent`));
  const heroTxt = await ev(`document.getElementById('hero').innerText`);
  check('SpaceX hero renders (launch or explicit unavailable)', /T[−+]|NET|DATA UNAVAILABLE/.test(heroTxt), heroTxt.split('\n').slice(1, 2).join(''));
  const c1 = await ev(`document.querySelector('#hero [data-cd] .cdu:last-child .v')?.textContent || ''`); await sleep(1300);
  const c2 = await ev(`document.querySelector('#hero [data-cd] .cdu:last-child .v')?.textContent || ''`);
  check('countdown ticks', !c1 || c1 !== c2, `${c1} → ${c2}`);
  check('4 team cards', await ev(`document.querySelectorAll('#teamStage .team').length`) === 4);
  check('next-up games listed', await ev(`document.querySelectorAll('#nextUp .nu').length`) >= 1, await ev(`[...document.querySelectorAll('#nextUp .m')].map(e=>e.textContent).join(' | ')`));
  check('weather renders (temp or explicit unavailable)', await ev(`/°F|unavailable/i.test(document.getElementById('wxNow').innerText)`));
  check('fleet ticker has bots', await ev(`document.querySelectorAll('#ticker .bot').length / 2`) >= 5, `${await ev(`document.querySelectorAll('#ticker .bot').length / 2`)} bots`);
  check('fuel gauge renders', await ev(`/left|unavailable/i.test(document.getElementById('fuel').innerText)`));
  check('no "undefined"/"NaN" leaked into the UI', !(await ev(`/\\bundefined\\b|\\bNaN\\b|Invalid Date/.test(document.getElementById('stage').innerText)`)), '');
  check('60 s data refresh does not reset the ticker, hero or team cards', await ev(`(async () => { const a = document.querySelector('#ticker .bot'), h = document.querySelector('#hero .mission'), t = document.querySelector('#teamStage .team'); await load(); return a === document.querySelector('#ticker .bot') && h === document.querySelector('#hero .mission') && t === document.querySelector('#teamStage .team'); })()`));
  // rotation + ambient
  const before = await ev('WALL.teamIdx'); await ev(`rotateTeam(1, true)`); await sleep(300);
  check('team card rotates', (await ev('WALL.teamIdx')) !== before);
  await ev(`dispatchEvent(new KeyboardEvent('keydown', {key: 'a'}))`); await sleep(200);
  check('A toggles ambient mode', await ev(`document.body.classList.contains('ambient')`));
  check('ambient shows clock + next items', await ev(`document.getElementById('ambLines').children.length`) >= 1);
  // failure rendering: simulate every source down
  await ev(`(() => { const st = {state: 'unavailable', error: 'simulated outage', fetchedAt: null};
    WALL.data = {generatedAt: new Date().toISOString(), spacex: {upcoming: [], previous: [], starship: null, starshipInList: [], status: {upcoming: st, previous: st, starship: st}},
      sports: {teams: [{key: 'ravens', name: 'Ravens', full: 'Baltimore Ravens', colors: ['#4c1d95', '#facc15'], status: st}], verifiedGames: [], notes: []},
      weather: {status: st}, fleet: {bots: [], status: st}, usage: {data: null, status: st}, jim: {space: [], sports: {}}};
    document.body.classList.remove('ambient'); render(); })()`);
  const down = await ev(`document.getElementById('stage').innerText`);
  check('outage → explicit DATA UNAVAILABLE states', (down.match(/DATA UNAVAILABLE/g) || []).length >= 4, `${(down.match(/DATA UNAVAILABLE/g) || []).length} panels`);
  check('outage → no invented numbers (no °F, no T− countdown)', !/\d+°F|T−\d/.test(down));
  check('no page errors (live)', errors.length === 0, errors.join(' | '));
  // kiosk
  await open(`http://127.0.0.1:${port}/kiosk`, 2000);
  check('kiosk mode hides cursor', await ev(`document.body.classList.contains('kiosk') && getComputedStyle(document.body).cursor === 'none'`));
  // offline snapshot
  const snap = resolve('dist/boyd-wall-snapshot.html');
  if (existsSync(snap)) {
    await open('file://' + snap, 2500);
    check('snapshot loads offline with banner', /OFFLINE SNAPSHOT/.test(await ev(`document.getElementById('banner').textContent`)));
    check('snapshot has baked data', await ev('!!window.__WALL_SNAPSHOT__ && !!WALL.data.spacex'));
    check('snapshot images inlined (no /img/ requests)', await ev(`[...document.images].every(i => !i.src || i.src.startsWith('data:'))`));
    check('no page errors (snapshot)', errors.length === 0, errors.join(' | '));
  } else check('snapshot exists', false, 'run python3 export_snapshot.py');
} catch (e) { check('smoke run', false, e.stack || String(e)); }
finally { chrome.kill('SIGKILL'); }
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
