// Called by the Admin panel after a mod confirms payment.
// Grants the package roles to the buyer for the booked runtime (temp roles),
// stores expiry for later revocation, and posts a fulfillment ping for services.
import admin from 'firebase-admin';

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin;
}

const API = 'https://discord.com/api/v10';
const GUILD = () => process.env.DISCORD_GUILD_ID;
const BOT = () => `Bot ${process.env.DISCORD_BOT_TOKEN}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    // Verify the caller is a mod.
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    if (decoded.mod !== true) return res.status(403).json({ error: 'not a mod' });

    const { ticketId } = req.body || {};
    if (!ticketId) return res.status(400).json({ error: 'no ticketId' });

    const db = getAdmin().firestore();
    const snap = await db.doc(`tickets/${ticketId}`).get();
    if (!snap.exists) return res.status(404).json({ error: 'ticket not found' });
    const t = snap.data();
    const userId = t.userId; // Discord user id (= Firebase uid)

    const granted = [];
    const failed = [];

    // 1) Temp roles for analysis packages.
    for (const g of (t.grants || [])) {
      if (!g.roleId) { failed.push(`${g.pkgId} (no role set)`); continue; }
      const r = await fetch(`${API}/guilds/${GUILD()}/members/${userId}/roles/${g.roleId}`, {
        method: 'PUT', headers: { Authorization: BOT() },
      });
      if (r.ok || r.status === 204) {
        const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + g.months * 30 * 24 * 3600 * 1000);
        await db.collection('entitlements').add({
          userId, roleId: g.roleId, pkgId: g.pkgId, ticketId, expiresAt,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        granted.push(g.pkgId);
      } else {
        failed.push(`${g.pkgId} (discord ${r.status})`);
      }
    }

    // 2) Fulfillment ping for Deep Dive / Coaching.
    if ((t.services || []).length && process.env.WEBHOOK_FULFILL) {
      await fetch(process.env.WEBHOOK_FULFILL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `🎯 **Fulfillment needed** — <@${userId}> (${t.userTag})\n` +
            (t.services).map((s) => `• ${s}`).join('\n') +
            `\nTicket #${ticketId.slice(0, 6)}`,
        }),
      });
    }

    res.json({ granted, failed, services: t.services || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'grant failed' });
  }
}
