const crypto = require('crypto');

const COOKIE = 'ss_session';
const DAYS = 60;
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', process.env.SESSION_SECRET).update(s).digest('base64url');
const sha = (x) => crypto.createHash('sha256').update(x).digest();

function makeToken(name) {
  const p = b64(JSON.stringify({ n: name, e: Date.now() + DAYS * 864e5 }));
  return p + '.' + sign(p);
}
function readToken(t) {
  if (!t) return null;
  const [p, s] = t.split('.');
  if (!p || !s) return null;
  const e = sign(p);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.e > Date.now() ? d.n : null;
  } catch { return null; }
}

const users = () => JSON.parse(process.env.USERS);
function findByCode(code) {
  const c = sha(code);
  let found = null;
  for (const [k, v] of Object.entries(users())) if (crypto.timingSafeEqual(sha(k), c)) found = v;
  return found;
}
const findByName = (n) => Object.values(users()).find((u) => u.name === n) || null;

async function redis(...cmd) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: JSON.stringify(cmd) });
  return (await r.json()).result;
}
async function load(name) {
  const raw = await redis('GET', 'wl:' + name);
  return raw ? JSON.parse(raw) : { gifts: [], color: '#ffffff' };
}

async function notify(name, how) {
  if (!process.env.DISCORD_WEBHOOK) return;
  const text = how === 'code' ? 'logged in with their code' : 'returned with a saved cookie';
  try {
    await fetch(process.env.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${name}** ${text}\n<t:${Math.floor(Date.now() / 1000)}:f>` }),
    });
  } catch {}
}

const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
function clean(d) {
  if (!d || !Array.isArray(d.gifts) || d.gifts.length > 5) return null;
  if (!/^#[0-9a-f]{6}$/i.test(String(d.color))) return null;
  const gifts = [];
  for (const g of d.gifts) {
    const o = { name: s(g && g.name, 80), description: s(g && g.description, 300), price: s(g && g.price, 20), link: s(g && g.link, 500) };
    if (!o.name || !o.description || !o.price || !/^https?:\/\/[^\s]+$/i.test(o.link)) return null;
    gifts.push(o);
  }
  return { gifts, color: String(d.color).toLowerCase() };
}

async function me(name) {
  const u = findByName(name);
  if (!u) return null;
  return { name: u.name, target: u.gift, theirs: await load(u.gift), mine: await load(u.name) };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const b = req.body || {};
  const jar = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) jar[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  });
  const setCookie = (v, age) =>
    res.setHeader('Set-Cookie', `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`);
  const who = readToken(jar[COOKIE]);

  try {
    switch (b.action) {
      case 'login': {
        const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
        const n = await redis('INCR', 'rl:' + ip);
        if (n === 1) await redis('EXPIRE', 'rl:' + ip, 600);
        if (n > 10) return res.status(429).json({ error: 'too many attempts. wait a few minutes and try again.' });
        const code = String(b.code || '').trim().toLowerCase().slice(0, 40);
        const u = findByCode(code);
        if (!u) return res.status(401).json({ error: 'that code is not valid.' });
        setCookie(makeToken(u.name), DAYS * 86400);
        await notify(u.name, 'code');
        return res.json(await me(u.name));
      }
      case 'session': {
        if (!who) return res.json({ user: null });
        const data = await me(who);
        if (!data) { setCookie('', 0); return res.json({ user: null }); }
        if (b.notify) await notify(who, 'cookie');
        return res.json({ user: data });
      }
      case 'logout':
        setCookie('', 0);
        return res.json({ ok: true });
      case 'save': {
        if (!who) return res.status(401).json({ error: 'not signed in.' });
        const d = clean(b.data);
        if (!d) return res.status(400).json({ error: 'every field is required for each gift, and the link must start with http.' });
        await redis('SET', 'wl:' + who, JSON.stringify(d));
        return res.json({ ok: true, mine: d });
      }
      default:
        return res.status(400).json({ error: 'bad request' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'something went wrong on the server.' });
  }
};
