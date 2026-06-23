// Mod-only: manually grant or remove a subscription (Discord role + Firestore entitlement).
import admin from 'firebase-admin';

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin;
}

const API = 'https://discord.com/api/v10';
const BOT = () => `Bot ${process.env.DISCORD_BOT_TOKEN}`;
const GUILD = () => process.env.DISCORD_GUILD_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    if (decoded.mod !== true && decoded.admin !== true) return res.status(403).json({ error: 'not a mod' });

    const { action, userId, roleId, label, months, id } = req.body || {};
    const db = getAdmin().firestore();

    if (action === 'add') {
      if (!userId || !roleId) return res.status(400).json({ error: 'userId and roleId required' });
      const r = await fetch(`${API}/guilds/${GUILD()}/members/${userId}/roles/${roleId}`, {
        method: 'PUT', headers: { Authorization: BOT() },
      });
      if (!r.ok && r.status !== 204) {
        const detail = await r.text().catch(() => '');
        return res.status(502).json({ error: `discord ${r.status} ${detail.slice(0, 150)}` });
      }
      const m = Number(months) || 1;
      const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + m * 30 * 24 * 3600 * 1000);
      await db.collection('entitlements').add({
        userId, roleId, label: label || 'Role', expiresAt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(), grantedBy: decoded.uid,
      });
      return res.json({ ok: true });
    }

    if (action === 'remove') {
      if (!userId || !roleId) return res.status(400).json({ error: 'userId and roleId required' });
      await fetch(`${API}/guilds/${GUILD()}/members/${userId}/roles/${roleId}`, {
        method: 'DELETE', headers: { Authorization: BOT() },
      }).catch(() => {});
      if (id) {
        await db.collection('entitlements').doc(id).delete().catch(() => {});
      } else {
        // remove any matching entitlements for this user+role
        const snap = await db.collection('entitlements').where('userId', '==', userId).where('roleId', '==', roleId).get();
        await Promise.all(snap.docs.map((d) => d.ref.delete()));
      }
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'manage-sub failed' });
  }
}
