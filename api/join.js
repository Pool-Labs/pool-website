/* Pool early access sign-up with invite tracking (Vercel serverless function, POST /api/join).

   Body (JSON): { email, name?, age?, school?, interests?, groups?, wish?, ref?, company? }
   company is a hidden honeypot; bots fill it, people never see it. name goes to Loops firstName/lastName; the optional
   answers from the early access page go to the custom properties ageRange, school, interests, groupCount and wishlist.
   Reply:       { ok, already, tracking, code? }

   With LOOPS_API_KEY set (Vercel > Project > Settings > Environment Variables), every person gets an 8-letter invite
   code, stored in Loops as both the contact's userId and the custom property referralCode. When someone joins with
   ?ref=<code>, their contact gets referredBy=<code> and the inviter's `invites` count goes up by one. Ordering the
   early access list (most invites first, then sign-up date) and the droplet multiplier both read `invites`.
   The three custom properties are created in Loops on first use if they don't exist yet.

   Without the key, the function posts to the same Loops form the site used before, so sign-ups are saved either way;
   it just can't hand out invite links. LOOPS_LIST_ID (optional) adds new contacts to that Loops mailing list. */

const crypto = require('crypto');

const LOOPS = 'https://app.loops.so/api/v1';
const FORM = 'https://app.loops.so/api/newsletter-form/cmwl3l3fe00og0jyopp1idia0';
const SOURCE = 'Website waitlist';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE = /^[a-z2-9]{8}$/;
const ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
const PROPS = [['referralCode', 'string'], ['referredBy', 'string'], ['invites', 'number'], ['ageRange', 'string'], ['school', 'string'], ['interests', 'string'], ['groupCount', 'string'], ['wishlist', 'string']];

function clip(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n); }

function profile(b) {
  const out = {};
  const name = clip(b.name, 80);
  if (name) { const parts = name.split(/\s+/); out.firstName = parts[0]; if (parts.length > 1) out.lastName = parts.slice(1).join(' '); }
  const interests = Array.isArray(b.interests) ? b.interests.map(x => clip(x, 40)).filter(Boolean).slice(0, 10).join(', ') : clip(b.interests, 400);
  const map = { ageRange: clip(b.age, 20), school: clip(b.school, 120), interests, groupCount: clip(b.groups, 20), wishlist: clip(b.wish, 600) };
  for (const k in map) if (map[k]) out[k] = map[k];
  return out;
}

let ready = null;

function newCode() {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += ABC[b % ABC.length];
  return s;
}

async function loops(path, key, init) {
  const r = await fetch(LOOPS + path, Object.assign({}, init, {
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  }));
  let body = null;
  try { body = await r.json(); } catch (e) { /* empty reply */ }
  return { ok: r.ok, status: r.status, body };
}

async function ensureProps(key) {
  const r = await loops('/contacts/properties?list=custom', key);
  const have = new Set((Array.isArray(r.body) ? r.body : []).map(p => p.key || p.name));
  for (const [name, type] of PROPS) {
    if (!have.has(name)) await loops('/contacts/properties', key, { method: 'POST', body: JSON.stringify({ name, type }) });
  }
}

async function find(key, query) {
  const r = await loops('/contacts/find?' + query, key);
  return Array.isArray(r.body) && r.body.length ? r.body[0] : null;
}

function update(key, fields) {
  return loops('/contacts/update', key, { method: 'PUT', body: JSON.stringify(fields) });
}

async function viaForm(email, p) {
  const r = await fetch(FORM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=' + encodeURIComponent(email) + '&source=' + encodeURIComponent(SOURCE) +
      (p.firstName ? '&firstName=' + encodeURIComponent(p.firstName) : '') + (p.lastName ? '&lastName=' + encodeURIComponent(p.lastName) : '')
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* empty reply */ }
  const already = /already/i.test(j.message || '');
  return { status: r.status, ok: !!j.success || already, already };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method' }); return; }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  if (b.company) { res.status(200).json({ ok: true, already: false, tracking: false }); return; }

  const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
  if (!EMAIL.test(email)) { res.status(400).json({ ok: false, error: 'email' }); return; }
  const ref = CODE.test(String(b.ref || '')) ? String(b.ref) : '';
  const key = process.env.LOOPS_API_KEY;
  const prof = profile(b);

  try {
    if (!key) {
      const f = await viaForm(email, prof);
      if (f.status === 429) { res.status(429).json({ ok: false, error: 'busy' }); return; }
      res.status(f.ok ? 200 : 502).json({ ok: f.ok, already: f.already, tracking: false });
      return;
    }

    if (!ready) ready = ensureProps(key).catch(() => { ready = null; });
    await ready;

    const me = await find(key, 'email=' + encodeURIComponent(email));
    if (me) {
      let code = CODE.test(me.referralCode || '') ? me.referralCode : (CODE.test(me.userId || '') ? me.userId : '');
      const fix = Object.assign({}, prof);
      if (!code) { code = newCode(); fix.referralCode = code; if (!me.userId) fix.userId = code; }
      if (Object.keys(fix).length) await update(key, Object.assign({ email }, fix));
      res.status(200).json({ ok: true, already: true, tracking: true, code });
      return;
    }

    const code = newCode();
    const inviter = ref ? await find(key, 'userId=' + ref) : null;
    const by = inviter && inviter.email !== email ? ref : '';
    const fields = Object.assign({ email, source: SOURCE, subscribed: true, userId: code, referralCode: code, referredBy: by, invites: 0 }, prof);
    if (process.env.LOOPS_LIST_ID) fields.mailingLists = { [process.env.LOOPS_LIST_ID]: true };
    const made = await loops('/contacts/create', key, { method: 'POST', body: JSON.stringify(fields) });
    if (made.status === 429) { res.status(429).json({ ok: false, error: 'busy' }); return; }
    if (!made.ok) { res.status(502).json({ ok: false, error: 'upstream' }); return; }

    if (by) await update(key, { email: inviter.email, invites: (Number(inviter.invites) || 0) + 1 });
    res.status(200).json({ ok: true, already: false, tracking: true, code });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'upstream' });
  }
};
