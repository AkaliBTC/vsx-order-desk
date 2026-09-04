// Lets a customer ping the team from inside their own ticket.
//
// Public endpoint (called from the customer's browser), same exposure model as
// api/pay-hint.js: it can only post one templated message to one hard-coded
// staff channel, and it never echoes anything the customer typed.
//
// Because it is public AND it pings, it is rate limited server-side against the
// ticket document: one ping per ticket per COOLDOWN_MS. The client also hides
// the button after a ping, but the client is not the thing standing between a
// bored customer and an @here loop, so the check lives here.
import admin from 'firebase-admin';

const API = 'https://discord.com/api/v10';
const CHANNEL = '1518924255461642240'; // same staff channel as pay-hint
const COOLDOWN_MS = 10 * 60 * 1000;

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return res.status(500).json({ error: 'no bot token' });

    const { ticketId } = req.body || {};
    if (!ticketId) return res.status(400).json({ error: 'no ticketId' });

    // Read the ticket server-side. This also means a made-up ticket id cannot
    // be used to trigger a ping.
    const db = getAdmin().firestore();
    const ref = db.collection('tickets').doc(String(ticketId));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'unknown ticket' });

    const t = snap.data() || {};
    const last = t.support?.lastPingAt?.toMillis ? t.support.lastPingAt.toMillis() : 0;
    const waited = Date.now() - last;
    if (last && waited < COOLDOWN_MS) {
      return res.status(429).json({
        error: 'cooldown',
        retryInMs: COOLDOWN_MS - waited,
      });
    }

    const total = typeof t.total === 'number' ? `$${t.total.toFixed(2)}` : '—';
    const method = t.payment?.method === 'trc20' ? 'USDT · TRC20'
      : t.payment?.method === 'paypal' ? 'PayPal'
      : (t.payment?.method || 'not chosen');
    const content =
      `@here 🆘 **Support requested**\n` +
      `• **Name:** ${t.userTag || '—'}\n` +
      `• **Ticket:** #${String(ticketId).slice(0, 6)}\n` +
      `• **Total:** ${total}\n` +
      `• **Method:** ${method}\n` +
      `• **Status:** ${t.status || '—'}\n` +
      `Please open this ticket in the Order Desk.`;

    const r = await fetch(`${API}/channels/${CHANNEL}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: ['everyone'] } }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `discord ${r.status}`, detail: detail.slice(0, 200) });
    }

    // Stamp the cooldown and leave a trace in the ticket thread so whoever
    // picks it up can see the customer asked, and when.
    await ref.set({
      support: {
        lastPingAt: admin.firestore.FieldValue.serverTimestamp(),
        pings: (t.support?.pings || 0) + 1,
      },
    }, { merge: true });

    await ref.collection('messages').add({
      from: 'system',
      authorTag: 'SYSTEM',
      body: 'Customer requested support. The team has been notified.',
      at: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'support ping failed' });
  }
}
