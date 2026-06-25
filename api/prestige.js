// Prestige tiers — bought ONLY with referral balance, one level at a time.
// GET  -> { level, boost, balance } for the caller.
// POST { tier } -> buys the next tier if balance covers it and the previous tier is owned.
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

// Keep in sync with src/data.js PRESTIGE.
const PRESTIGE = [
  { tier: 1, name: 'Prestige I', price: 500, roleId: '1519733465199808745', boost: 0.10 },
  { tier: 2, name: 'Prestige II', price: 1000, roleId: '1519733547462824057', boost: 0.25 },
  { tier: 3, name: 'Prestige III', price: 5000, roleId: '1519733602831568907', boost: 0.50 },
];

async function levelOf(userId) {
  const m = await fetch(`${API}/guilds/${GUILD()}/members/${userId}`, { headers: { Authorization: BOT() } });
  if (!m.ok) return 0;
  const roles = (await m.json()).roles || [];
  let level = 0;
  for (const p of PRESTIGE) if (roles.includes(p.roleId)) level = Math.max(level, p.tier);
  return level;
}

export default async function handler(req, res) {
  try {
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    const userId = decoded.uid;
    const db = getAdmin().firestore();

    const balSnap = await db.collection('balances').doc(userId).get();
    const balance = balSnap.exists ? (Number(balSnap.data().amount) || 0) : 0;

    if (req.method === 'GET') {
      const level = await levelOf(userId);
      const boost = level ? PRESTIGE.find((p) => p.tier === level).boost : 0;
      return res.json({ level, boost, balance });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    const tier = Number((req.body || {}).tier);
    const target = PRESTIGE.find((p) => p.tier === tier);
    if (!target) return res.status(400).json({ error: 'Unknown tier.' });

    const level = await levelOf(userId);
    if (tier <= level) return res.status(409).json({ error: 'You already hold this tier.' });
    if (tier !== level + 1) return res.status(400).json({ error: `Buy Prestige ${level + 1} first — tiers must be bought in order.` });

    // Deduct the price atomically from the balance.
    const ref = db.collection('balances').doc(userId);
    let newBalance = balance;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const have = snap.exists ? (Number(snap.data().amount) || 0) : 0;
        if (have < target.price) throw new Error('INSUFFICIENT');
        newBalance = have - target.price;
        tx.set(ref, { amount: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
    } catch (e) {
      if (e.message === 'INSUFFICIENT') return res.status(402).json({ error: 'Not enough balance for this tier.' });
      throw e;
    }

    // Grant the prestige role.
    const r = await fetch(`${API}/guilds/${GUILD()}/members/${userId}/roles/${target.roleId}`, {
      method: 'PUT', headers: { Authorization: BOT() },
    });
    if (!r.ok && r.status !== 204) {
      // Refund on failure.
      await ref.set({ amount: admin.firestore.FieldValue.increment(target.price) }, { merge: true }).catch(() => {});
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `discord ${r.status} ${detail.slice(0, 150)}` });
    }

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
            content: `\uD83D\uDC51 **${target.name} unlocked!** \uD83E\uDD0D\n` +
              `Your referral commission is now boosted by **+${Math.round(target.boost * 100)}%**. Thank you for leveling up with VisionX!`,
          }),
        }).catch(() => {});
      }
    } catch (_) {}

    res.json({ ok: true, level: tier, boost: target.boost, balance: newBalance });
  } catch (e) {
    res.status(500).json({ error: e.message || 'prestige failed' });
  }
}
