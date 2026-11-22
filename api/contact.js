// Vercel serverless function: the contact form on /contact.
//
// GET  -> { ready: true|false }  (the page shows the form only when this is true)
// POST -> body (JSON): { name, email, topic?, message, company? }   ("company" is a honeypot that people never fill in)
//
// Sends the message to the team as a Loops transactional email. Needs, in Vercel's environment variables:
//   LOOPS_API_KEY     (already set for the waitlist)
//   LOOPS_CONTACT_ID  the ID of a published Loops transactional email that uses the data variables
//                     name, email, topic and message (Loops needs a verified sending domain before it can send)
//   CONTACT_TO        optional, where messages go; defaults to hello@poolapp.co
// Nothing is added to the mailing list: the sender is only used to reply.

const LOOPS = 'https://app.loops.so/api/v1';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+$/g, '').slice(0, n);

module.exports = async function handler(req, res) {
  const key = process.env.LOOPS_API_KEY, id = process.env.LOOPS_CONTACT_ID;
  const ready = !!(key && id);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ ready });
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false }); }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  if (b.company) return res.status(200).json({ ok: true }); // a bot filled the hidden field
  const email = clip(b.email, 254).trim(), name = clip(b.name, 80).trim(), message = clip(b.message, 4000).trim();
  if (!EMAIL_RE.test(email) || !name || message.length < 2) return res.status(400).json({ ok: false, error: 'invalid' });
  if (!ready) return res.status(503).json({ ok: false, error: 'not_configured' });

  try {
    const r = await fetch(LOOPS + '/transactional', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactionalId: id,
        email: process.env.CONTACT_TO || 'hello@poolapp.co',
        addToAudience: false,
        dataVariables: { name, email, replyTo: email, topic: clip(b.topic, 60).trim() || 'Not given', message }
      })
    });
    if (!r.ok) {
      console.error('contact: Loops answered', r.status, (await r.text().catch(() => '')).slice(0, 300));
      return res.status(502).json({ ok: false });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('contact: send failed', e && e.message);
    return res.status(502).json({ ok: false });
  }
};
