// Free trial: once per lifetime, a user may try ONE analysis package (not Premium)
// free for 5 days. Grants the package role for 5 days and locks the user forever.
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
const TRIAL_DAYS = 5;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    const userId = decoded.uid;
    const userTag = decoded.tag || '';
    const { packageId } = req.body || {};
    if (!packageId) return res.status(400).json({ error: 'packageId required' });
    if (packageId === 'premium') return res.status(400).json({ error: 'Premium is not eligible for a free trial.' });

    const db = getAdmin().firestore();

    // One trial per lifetime.
    const lockRef = db.collection('trial_used').doc(userId);
    if ((await lockRef.get()).exists) return res.status(409).json({ error: 'You have already used your free trial.' });

    // Look up the package + its role from the live catalogue.
    const cat = await db.doc('config/catalogue').get();
    const pkgs = (cat.exists ? cat.data().packages : []) || [];
    const pkg = pkgs.find((p) => p.id === packageId);
    if (!pkg) return res.status(404).json({ error: 'Unknown package.' });
    if (!pkg.roleId) return res.status(400).json({ error: 'This package has no role configured yet.' });

    // Grant the role.
    const r = await fetch(`${API}/guilds/${GUILD()}/members/${userId}/roles/${pkg.roleId}`, {
      method: 'PUT', headers: { Authorization: BOT() },
    });
    if (!r.ok && r.status !== 204) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `discord ${r.status} ${detail.slice(0, 150)}` });
    }

    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + TRIAL_DAYS * 24 * 3600 * 1000);
    await db.collection('entitlements').add({
      userId, roleId: pkg.roleId, label: `${pkg.name} (Trial)`, expiresAt, trial: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await lockRef.set({ packageId, at: admin.firestore.FieldValue.serverTimestamp(), userTag });

    // DM the user.
    try {
      const dmCh = await fetch(`${API}/users/@me/channels`, {
        method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: userId }),
      });
      if (dmCh.ok) {
        const c = await dmCh.json();
        await fetch(`${API}/channels/${c.id}/messages`, {
          method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `\uD83C\uDF1F Your **${pkg.name}** free trial is live for the next **${TRIAL_DAYS} days**! \uD83E\uDD0D\n` +
              `Dive in and explore the analysis. When it ends, grab a subscription anytime to keep your access.`,
          }),
        }).catch(() => {});
      }
    } catch (_) {}

    res.json({ ok: true, package: pkg.name, days: TRIAL_DAYS });
  } catch (e) {
    res.status(500).json({ error: e.message || 'free-trial failed' });
  }
}
