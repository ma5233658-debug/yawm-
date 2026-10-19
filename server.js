'use strict';
/**
 * سيرفر «يوم رحيم»: بيستضيف الصفحة وبيبعت تذكيرات الحصص على تيليجرام.
 * من غير مكتبات خارجية. محتاج Node 18 أو أحدث.
 *
 * متغيرات البيئة:
 *   TELEGRAM_BOT_TOKEN  توكن البوت من @BotFather (مطلوب)
 *   PORT                المنفذ (افتراضي 3000)
 *   DATA_FILE           مكان حفظ ملف البيانات (افتراضي ./data.json)
 *   TELEGRAM_API        للاختبار فقط (افتراضي https://api.telegram.org)
 *   TZ_NAME             المنطقة الزمنية لملخص الصبح (افتراضي Africa/Cairo)
 *   MORNING_HOUR        ساعة ملخص الصبح (افتراضي 8)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
const PORT = +process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const TZ = process.env.TZ_NAME || 'Africa/Cairo';
const MORNING_HOUR = process.env.MORNING_HOUR === undefined ? 8 : +process.env.MORNING_HOUR;
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const MAX_BODY = 256 * 1024, MAX_LESSONS = 400;
const CODE_RE = /^[A-Za-z0-9]{20,64}$/;

/* ---------- storage ---------- */
let db = { users: {} }; // users[code] = {chat, remindMin, morning, lessons:[], sent:{}, morningSent:'', updated}
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); if (!db.users) db.users = {}; } catch (e) { /* first run */ }
let dirty = false;
function persist() {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { console.error('save failed', e.message); }
}
setInterval(persist, 5000).unref();
const touch = () => { dirty = true; };

/* ---------- telegram ---------- */
let botName = '';
async function tg(method, body) {
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || res.status}`);
  return j.result;
}
const sendMsg = (chat, text) => tg('sendMessage', { chat_id: chat, text, disable_web_page_preview: true });

async function pollUpdates() {
  let offset = 0;
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      for (const u of ups) {
        offset = u.update_id + 1;
        const m = u.message; if (!m || !m.text || !m.chat) continue;
        const mt = m.text.trim().match(/^\/start(?:@\w+)?\s+([A-Za-z0-9]{20,64})$/);
        if (mt && db.users[mt[1]]) {
          db.users[mt[1]].chat = m.chat.id; touch(); persist();
          await sendMsg(m.chat.id, 'تمام ✅ اتربط البوت بحسابك. هتوصلك هنا تذكيرات الحصص قبلها بالوقت اللي حددته، وملخص اليوم الصبح.').catch(() => {});
        } else if (/^\/start/.test(m.text)) {
          await sendMsg(m.chat.id, 'أهلًا 👋 افتح صفحة «يوم رحيم» ← المزيد ← التذكيرات، واضغط «اربط تيليجرام» وهيفتحلك الرابط الصح.').catch(() => {});
        }
      }
    } catch (e) {
      console.error('poll:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/* ---------- time helpers ---------- */
function partsIn(ts) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const o = {}; for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return { date: `${o.year}-${o.month}-${o.day}`, hour: +o.hour, hm: `${o.hour}:${o.minute}` };
}
const fmtTime = (ts) => { const p = partsIn(ts), h = +p.hm.slice(0, 2); return `${((h + 11) % 12) + 1}:${p.hm.slice(3)} ${h < 12 ? 'ص' : 'م'}`; };

function lessonLine(l) {
  return `• ${l.t}${l.topic ? ' — ' + l.topic : ''}\n  ${fmtTime(l.at)}${l.place ? ' · ' + l.place : ''}`;
}

/* ---------- reminders ---------- */
async function tick() {
  const now = Date.now();
  for (const [code, u] of Object.entries(db.users)) {
    if (!u.chat) continue;
    // reminders
    for (const l of u.lessons || []) {
      const key = l.id + '@' + l.at, lead = (u.remindMin || 60) * 60000;
      if (u.sent[key]) continue;
      if (now >= l.at - lead && now < l.at + 5 * 60000) {
        u.sent[key] = now; touch();
        const mins = Math.max(0, Math.round((l.at - now) / 60000));
        try { await sendMsg(u.chat, `⏰ ${mins > 1 ? 'بعد ' + mins + ' دقيقة' : 'دلوقتي'}\n${lessonLine(l)}${l.link ? '\n' + l.link : ''}`); }
        catch (e) { delete u.sent[key]; console.error('send:', e.message); }
      }
    }
    // morning summary
    const p = partsIn(now);
    if (u.morning && p.hour >= MORNING_HOUR && u.morningSent !== p.date) {
      u.morningSent = p.date; touch();
      const today = (u.lessons || []).filter((l) => partsIn(l.at).date === p.date).sort((a, b) => a.at - b.at);
      if (today.length) {
        try { await sendMsg(u.chat, `☀️ حصص النهارده (${today.length})\n` + today.map(lessonLine).join('\n')); }
        catch (e) { u.morningSent = ''; console.error('send:', e.message); }
      }
    }
    // cleanup old sent keys
    for (const k of Object.keys(u.sent)) if (now - u.sent[k] > 3 * 864e5) { delete u.sent[k]; touch(); }
  }
}
setInterval(() => tick().catch((e) => console.error('tick', e.message)), 20000).unref();

/* ---------- http ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 60000);
  h.push(now); hits.set(ip, h); return h.length > 60;
}
setInterval(() => hits.clear(), 300000).unref();

const server = http.createServer(async (req, res) => {
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const url = new URL(req.url, 'http://x');
    const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress;
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (limited(ip)) return send(429, { error: 'محاولات كتير. استنى شوية.' });

      if (url.pathname === '/api/status' && req.method === 'GET') {
        const code = url.searchParams.get('code') || '';
        if (!CODE_RE.test(code)) return send(400, { error: 'كود غلط' });
        const u = db.users[code];
        return send(200, { bot: botName, linked: !!(u && u.chat), configured: !!TOKEN, lessons: u ? u.lessons.length : 0 });
      }
      if (url.pathname === '/api/sync' && req.method === 'POST') {
        const b = await readBody(req);
        if (!CODE_RE.test(b.code || '')) return send(400, { error: 'كود غلط' });
        const lessons = Array.isArray(b.lessons) ? b.lessons.slice(0, MAX_LESSONS).filter((l) => l && typeof l.id === 'string' && Number.isFinite(l.at)).map((l) => ({
          id: l.id.slice(0, 40), at: Math.floor(l.at), t: String(l.t || '').slice(0, 120), topic: String(l.topic || '').slice(0, 200), place: String(l.place || '').slice(0, 150),
          link: /^https?:\/\//i.test(l.link || '') ? String(l.link).slice(0, 500) : '',
        })) : [];
        const rm = Math.min(1440, Math.max(5, Math.floor(+b.remindMin || 60)));
        const u = db.users[b.code] || (db.users[b.code] = { chat: null, sent: {}, morningSent: '' });
        u.lessons = lessons; u.remindMin = rm; u.morning = b.morning !== false; u.updated = Date.now(); touch();
        return send(200, { ok: true, linked: !!u.chat, count: lessons.length });
      }
      if (url.pathname === '/api/test' && req.method === 'POST') {
        const b = await readBody(req);
        const u = CODE_RE.test(b.code || '') && db.users[b.code];
        if (!u || !u.chat) return send(400, { error: 'لسه ما اتربطش تيليجرام.' });
        await sendMsg(u.chat, '🔔 ده تذكير تجريبي من «يوم رحيم». لو وصلك يبقى كل حاجة تمام.');
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/unlink' && req.method === 'POST') {
        const b = await readBody(req);
        if (CODE_RE.test(b.code || '') && db.users[b.code]) { delete db.users[b.code]; touch(); persist(); }
        return send(200, { ok: true });
      }
      return send(404, { error: 'مش موجود' });
    }
    // static
    let rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
  } catch (e) {
    const st = e.status || (/telegram/.test(e.message) ? 502 : 500);
    send(st, { error: st === 413 ? 'الطلب كبير' : st === 400 ? 'طلب غلط' : st === 502 ? 'تيليجرام مردّش. جرّب تاني.' : 'خطأ في السيرفر' });
    if (st >= 500) console.error(e.message);
  }
});

async function start() {
  if (TOKEN) {
    try { botName = (await tg('getMe')).username; console.log('bot: @' + botName); pollUpdates(); }
    catch (e) { console.error('التوكن غلط أو تيليجرام مش متاح:', e.message); }
  } else console.warn('تنبيه: TELEGRAM_BOT_TOKEN مش متحدد، التذكيرات مش هتشتغل.');
  server.listen(PORT, () => console.log('listening on ' + PORT));
}
if (require.main === module) start();
module.exports = { server, tick, db, start, _setBot: (n) => { botName = n; } };
