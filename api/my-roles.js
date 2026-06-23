// Returns the caller's CURRENT package ownership, read live from Discord via the
// bot — so removing a role in Discord takes effect immediately, without a re-login.
import admin from 'firebase-admin';

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin;
}

const API = 'https://discord.com/api/v10';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });

    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    const userId = decoded.uid; // Firebase uid == Discord user id (set at login)

    // Current roles, live from Discord.
    let roles = [];
    const r = await fetch(`${API}/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`, {
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
    });
    if (r.ok) {
      const member = await r.json();
      roles = member.roles || [];
    } else if (r.status !== 404) {
      return res.status(502).json({ error: `discord ${r.status}` });
    } // 404 = left the server → no roles

    // Map roles → owned package ids using the live catalogue.
    let owns = [];
    let loyalty = false;
    try {
      const snap = await getAdmin().firestore().doc('config/catalogue').get();
      const data = snap.exists ? snap.data() : {};
      const pkgs = data.packages || [];
      owns = pkgs.filter((p) => p.roleId && roles.includes(p.roleId)).map((p) => p.id);
      loyalty = !!(data.loyaltyRoleId && roles.includes(data.loyaltyRoleId));
    } catch (_) { /* catalogue not set yet */ }

    res.json({ owns, loyalty });
  } catch (e) {
    res.status(500).json({ error: e.message || 'my-roles failed' });
  }
}
