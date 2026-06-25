// Mod-only: resolve a list of Discord user IDs to their display names via the bot.
import admin from 'firebase-admin';

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin;
}

const API = 'https://discord.com/api/v10';
const BOT = () => `Bot ${process.env.DISCORD_BOT_TOKEN}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    if (decoded.mod !== true && decoded.admin !== true) return res.status(403).json({ error: 'not a mod' });

    const { ids = [] } = req.body || {};
    const uniq = [...new Set(ids.filter(Boolean))].slice(0, 100);
    const names = {};
    await Promise.all(uniq.map(async (id) => {
      try {
        const r = await fetch(`${API}/users/${id}`, { headers: { Authorization: BOT() } });
        if (r.ok) { const u = await r.json(); names[id] = u.global_name || u.username || id; }
      } catch (_) {}
    }));
    res.json({ names });
  } catch (e) {
    res.status(500).json({ error: e.message || 'resolve failed' });
  }
}
