'use strict';
// اختبار بمحاكي تيليجرام (من غير إنترنت): node test.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TG_PORT = 4311, APP_PORT = 4312;
const sent = []; let queue = [], uid = 0;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const m = req.url.split('/').pop(), body = JSON.parse(b || '{}');
    const ok = (result) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
    if (m === 'getMe') return ok({ username: 'yawm_test_bot' });
    if (m === 'sendMessage') { sent.push(body); return ok({ message_id: 1 }); }
    if (m === 'getUpdates') {
      const give = () => { const u = queue; queue = []; return u; };
      if (queue.length) return ok(give());
      const t = setTimeout(() => ok(give()), 400); res.on('close', () => clearTimeout(t)); return;
    }
    ok({});
  });
}).listen(TG_PORT);

process.env.TELEGRAM_BOT_TOKEN = 'TEST';
process.env.TELEGRAM_API = `http://127.0.0.1:${TG_PORT}`;
process.env.PORT = APP_PORT;
process.env.DATA_FILE = path.join(os.tmpdir(), 'yawm-test-' + Date.now() + '.json');
process.env.MORNING_HOUR = '0';
const app = require('./server.js');

const api = async (p, method, body) => {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null), text: null, res: r };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const pass = (m) => console.log('PASS', m, ++n);

(async () => {
  await app.start(); await sleep(300);
  const code = 'abcDEF1234567890xyzQ';

  let r = await api('/api/status?code=bad', 'GET'); assert.strictEqual(r.status, 400); pass('invalid code rejected');
  r = await api('/api/status?code=' + code, 'GET'); assert.strictEqual(r.json.linked, false); assert.strictEqual(r.json.bot, 'yawm_test_bot'); pass('status: bot name, not linked');

  const now = Date.now();
  const lessons = [
    { id: 'L1', at: now + 30 * 60000, t: 'تاريخ — تانية ثانوي', topic: 'الحملة الفرنسية', place: 'سنتر النور', link: '' },
    { id: 'L2', at: now + 5 * 3600000, t: 'دراسات — تالتة إعدادي', topic: '', place: 'أونلاين', link: 'https://zoom.us/j/1' },
    { id: 'L3', at: now - 3 * 3600000, t: 'قديمة', topic: '', place: '', link: '' },
  ];
  r = await api('/api/sync', 'POST', { code, remindMin: 60, morning: true, lessons }); assert.ok(r.json.ok && r.json.count === 3 && r.json.linked === false); pass('sync accepted before linking');
  await app.tick(); assert.strictEqual(sent.length, 0); pass('nothing sent before linking');

  r = await api('/api/test', 'POST', { code }); assert.strictEqual(r.status, 400); pass('test message refused when not linked');

  queue.push({ update_id: 1, message: { text: '/start wrongcode123456789012', chat: { id: 77 } } });
  await sleep(900); assert.ok(sent.some((m) => /افتح صفحة/.test(m.text))); pass('unknown code gets guidance, not linked');
  assert.ok(!app.db.users[code].chat); pass('still unlinked after wrong code');

  queue.push({ update_id: 2, message: { text: '/start ' + code, chat: { id: 555 } } });
  await sleep(900); assert.strictEqual(app.db.users[code].chat, 555); assert.ok(sent.some((m) => m.chat_id === 555 && /اتربط/.test(m.text))); pass('/start CODE links chat');
  r = await api('/api/status?code=' + code, 'GET'); assert.strictEqual(r.json.linked, true); pass('status shows linked');

  sent.length = 0; await app.tick();
  const rem = sent.filter((m) => /⏰/.test(m.text)); assert.strictEqual(rem.length, 1); assert.ok(/الحملة الفرنسية/.test(rem[0].text) && /سنتر النور/.test(rem[0].text)); pass('reminder sent only for lesson within lead time');
  assert.ok(!sent.some((m) => /قديمة/.test(m.text) && /⏰/.test(m.text))); pass('old lesson not reminded');
  const morning = sent.filter((m) => /☀️/.test(m.text)); assert.ok(morning.length <= 1); pass('morning summary at most once (' + morning.length + ')');
  const c1 = sent.length; await app.tick(); assert.strictEqual(sent.length, c1); pass('no duplicate on next tick');

  await api('/api/sync', 'POST', { code, remindMin: 60, morning: true, lessons }); sent.length = 0; await app.tick(); assert.strictEqual(sent.filter((m) => /⏰/.test(m.text)).length, 0); pass('resync does not re-send (dedupe persists)');

  r = await api('/api/sync', 'POST', { code, remindMin: 400, lessons: [lessons[1]] }); sent.length = 0; await app.tick();
  assert.strictEqual(sent.filter((m) => /⏰/.test(m.text)).length, 1); assert.ok(sent.some((m) => /zoom\.us/.test(m.text))); pass('longer lead time + online link in reminder');

  r = await api('/api/sync', 'POST', { code, lessons: [] }); sent.length = 0; await app.tick(); assert.strictEqual(sent.length, 0); pass('cancelled/removed lessons are dropped');

  r = await api('/api/test', 'POST', { code }); assert.strictEqual(r.status, 200); assert.ok(sent.some((m) => /تجريبي/.test(m.text))); pass('test message delivered');

  r = await api('/api/sync', 'POST', { code: 'short', lessons: [] }); assert.strictEqual(r.status, 400); pass('sync with bad code rejected');
  r = await api('/api/nope', 'GET'); assert.strictEqual(r.status, 404); pass('unknown api 404');
  const big = await fetch(`http://127.0.0.1:${APP_PORT}/api/sync`, { method: 'POST', body: JSON.stringify({ code, pad: 'x'.repeat(300000) }) }).catch(() => ({ status: 0 }));
  assert.ok(big.status === 413 || big.status === 0); pass('oversized body rejected');
  const tr = await fetch(`http://127.0.0.1:${APP_PORT}/..%2f..%2fetc%2fpasswd`); assert.ok(tr.status === 403 || tr.status === 404); pass('path traversal blocked');

  r = await api('/api/unlink', 'POST', { code }); assert.ok(!app.db.users[code]); pass('unlink removes data');

  console.log('\nALL ' + n + ' PASSED'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
