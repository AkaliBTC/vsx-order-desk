// Notify the customer by DM that the team replied in their ticket.
// Throttled server-side: at most one DM per ticket per 15 minutes.
import admin from 'firebase-admin';

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin;
}

const API = 'https://discord.com/api/v10';
const BOT = () => `Bot ${process.env.DISCORD_BOT_TOKEN}`;
const SHOP = () => process.env.DISCORD_REDIRECT_URI || 'https://vsx-order-desk.vercel.app';
const THROTTLE_MS = 15 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    if (decoded.mod !== true && decoded.admin !== true) return res.status(403).json({ error: 'not a mod' });

    const { ticketId } = req.body || {};
    if (!ticketId) return res.status(400).json({ error: 'ticketId required' });

    const db = getAdmin().firestore();
    const ref = db.collection('tickets').doc(ticketId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'ticket not found' });
    const t = snap.data();
    const customerId = t.userId;
    if (!customerId) return res.status(400).json({ error: 'ticket has no user' });
    if (customerId === decoded.uid) return res.json({ sent: false, reason: 'self' });

    // Throttle: only DM if the last notification is older than 15 minutes.
    const last = t.lastModDmAt ? t.lastModDmAt.toMillis() : 0;
    if (Date.now() - last < THROTTLE_MS) return res.json({ sent: false, reason: 'throttled' });

    // Reserve the slot first so two quick messages can't both send.
    await ref.set({ lastModDmAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    const link = `${SHOP()}/ticket/${ticketId}`;
    const content =
      `\uD83D\uDCAC **New message from the VisionX team** in your ticket \`#${ticketId.slice(0, 6)}\`.\n\n` +
      `Open it here to read and reply:\n${link}\n\nWe're looking forward to hearing from you! \uD83E\uDD0D`;

    let sent = false;
    try {
      const dmCh = await fetch(`${API}/users/@me/channels`, {
        method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: customerId }),
      });
      if (dmCh.ok) {
        const c = await dmCh.json();
        const m = await fetch(`${API}/channels/${c.id}/messages`, {
          method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        sent = m.ok;
      }
    } catch (_) {}

    res.json({ sent });
  } catch (e) {
    res.status(500).json({ error: e.message || 'ticket-dm failed' });
  }
}
