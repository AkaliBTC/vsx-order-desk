// Runs daily via Vercel Cron (see vercel.json). Removes temp roles whose
// entitlement has expired and deletes the entitlement record.
import admin from 'firebase-admin';

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin;
}

const API = 'https://discord.com/api/v10';

export default async function handler(req, res) {
  // Protect: if CRON_SECRET is set, require Vercel's cron auth header.
  if (process.env.CRON_SECRET) {
    const ok = (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}`;
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const db = getAdmin().firestore();
    const now = admin.firestore.Timestamp.now();
    const snap = await db.collection('entitlements').where('expiresAt', '<=', now).get();

    let removed = 0;
    for (const d of snap.docs) {
      const e = d.data();
      await fetch(`${API}/guilds/${process.env.DISCORD_GUILD_ID}/members/${e.userId}/roles/${e.roleId}`, {
        method: 'DELETE', headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      }).catch(() => {});
      await d.ref.delete();
      removed += 1;
    }
    res.json({ removed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'revoke failed' });
  }
}
