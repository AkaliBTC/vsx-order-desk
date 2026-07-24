// Combined "current user" endpoint. Merged from my-roles / referral / prestige /
// free-trial to stay within the Hobby plan's 12-serverless-function limit.
//
//   POST /api/me?action=roles                  -> { owns, loyalty, mod, admin }
//   POST /api/me?action=referral               -> { code, uses }
//   GET  /api/me?action=prestige               -> { level, boost, balance }
//   POST /api/me?action=prestige  { tier }     -> buys the next prestige tier
//   POST /api/me?action=trial     { packageId }-> starts the once-per-life free trial
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
const TRIAL_DAYS = 5;

// Keep in sync with src/data.js PRESTIGE.
const PRESTIGE = [
  { tier: 1, name: 'Prestige I', price: 500, roleId: '1519733465199808745', boost: 0.10 },
  { tier: 2, name: 'Prestige II', price: 1000, roleId: '1519733547462824057', boost: 0.25 },
  { tier: 3, name: 'Prestige III', price: 5000, roleId: '1519733602831568907', boost: 0.50 },
];

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  return `VSX-${block()}-${block()}`;
}

async function dm(userId, content) {
  try {
    const ch = await fetch(`${API}/users/@me/channels`, {
      method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!ch.ok) return false;
    const c = await ch.json();
    const m = await fetch(`${API}/channels/${c.id}/messages`, {
      method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return m.ok;
  } catch (_) { return false; }
}

async function memberRoles(userId) {
  const r = await fetch(`${API}/guilds/${GUILD()}/members/${userId}`, { headers: { Authorization: BOT() } });
  if (r.ok) return (await r.json()).roles || [];
  if (r.status === 404) return [];              // left the server
  throw new Error(`discord ${r.status}`);
}

/* ----------------------------- actions ------------------------------ */

async function actionRoles(decoded, res) {
  const userId = decoded.uid;
  let roles;
  try { roles = await memberRoles(userId); }
  catch (e) { return res.status(502).json({ error: e.message }); }

  let owns = [], loyalty = false;
  try {
    const snap = await getAdmin().firestore().doc('config/catalogue').get();
    const data = snap.exists ? snap.data() : {};
    const pkgs = data.packages || [];
    owns = pkgs.filter((p) => p.roleId && roles.includes(p.roleId)).map((p) => p.id);
    loyalty = !!(data.loyaltyRoleId && roles.includes(data.loyaltyRoleId));
  } catch (_) { /* catalogue not set yet */ }

  const modRoles = (process.env.DISCORD_MOD_ROLE_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  const adminRole = (process.env.DISCORD_ADMIN_ROLE_ID || '').trim();
  return res.json({
    owns, loyalty,
    mod: roles.some((r) => modRoles.includes(r)),
    admin: adminRole ? roles.includes(adminRole) : false,
  });
}

async function actionReferral(decoded, res) {
  const userId = decoded.uid;
  const db = getAdmin().firestore();

  const existing = await db.collection('referrals').where('ownerId', '==', userId).limit(1).get();
  if (!existing.empty) {
    const d = existing.docs[0];
    return res.json({ code: d.id, uses: d.data().uses || 0 });
  }

  let code = '';
  for (let i = 0; i < 6; i++) {
    const c = genCode();
    if (!(await db.collection('referrals').doc(c).get()).exists) { code = c; break; }
  }
  if (!code) return res.status(500).json({ error: 'could not allocate code' });
  await db.collection('referrals').doc(code).set({
    ownerId: userId, ownerTag: decoded.tag || '', uses: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return res.json({ code, uses: 0 });
}

async function actionPrestige(req, decoded, res) {
  const userId = decoded.uid;
  const db = getAdmin().firestore();
  const balSnap = await db.collection('balances').doc(userId).get();
  const balance = balSnap.exists ? (Number(balSnap.data().amount) || 0) : 0;

  let roles = [];
  try { roles = await memberRoles(userId); } catch (_) {}
  let level = 0;
  for (const p of PRESTIGE) if (roles.includes(p.roleId)) level = Math.max(level, p.tier);

  if (req.method === 'GET') {
    const boost = level ? PRESTIGE.find((p) => p.tier === level).boost : 0;
    return res.json({ level, boost, balance });
  }

  const tier = Number((req.body || {}).tier);
  const target = PRESTIGE.find((p) => p.tier === tier);
  if (!target) return res.status(400).json({ error: 'Unknown tier.' });
  if (tier <= level) return res.status(409).json({ error: 'You already hold this tier.' });
  if (tier !== level + 1) return res.status(400).json({ error: `Buy Prestige ${level + 1} first — tiers must be bought in order.` });

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

  const r = await fetch(`${API}/guilds/${GUILD()}/members/${userId}/roles/${target.roleId}`, {
    method: 'PUT', headers: { Authorization: BOT() },
  });
  if (!r.ok && r.status !== 204) {
    await ref.set({ amount: admin.firestore.FieldValue.increment(target.price) }, { merge: true }).catch(() => {});
    const detail = await r.text().catch(() => '');
    return res.status(502).json({ error: `discord ${r.status} ${detail.slice(0, 150)}` });
  }

  await dm(userId,
    `\uD83D\uDC51 **${target.name} unlocked!** \uD83E\uDD0D\n` +
    `Your referral commission is now boosted by **+${Math.round(target.boost * 100)}%**. Thank you for leveling up with VisionX!`);

  return res.json({ ok: true, level: tier, boost: target.boost, balance: newBalance });
}

async function actionTrial(req, decoded, res) {
  const userId = decoded.uid;
  const { packageId } = req.body || {};
  if (!packageId) return res.status(400).json({ error: 'packageId required' });
  if (packageId === 'premium') return res.status(400).json({ error: 'Premium is not eligible for a free trial.' });

  const db = getAdmin().firestore();
  const lockRef = db.collection('trial_used').doc(userId);
  if ((await lockRef.get()).exists) return res.status(409).json({ error: 'You have already used your free trial.' });

  const cat = await db.doc('config/catalogue').get();
  const pkgs = (cat.exists ? cat.data().packages : []) || [];
  const pkg = pkgs.find((p) => p.id === packageId);
  if (!pkg) return res.status(404).json({ error: 'Unknown package.' });
  if (!pkg.roleId) return res.status(400).json({ error: 'This package has no role configured yet.' });

  const r = await fetch(`${API}/guilds/${GUILD()}/members/${userId}/roles/${pkg.roleId}`, {
    method: 'PUT', headers: { Authorization: BOT() },
  });
  if (!r.ok && r.status !== 204) {
    const detail = await r.text().catch(() => '');
    return res.status(502).json({ error: `discord ${r.status} ${detail.slice(0, 150)}` });
  }

  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + TRIAL_DAYS * 24 * 3600 * 1000);
  await db.collection('entitlements').add({
    userId, userTag: decoded.tag || null, roleId: pkg.roleId, label: `${pkg.name} (Trial)`,
    expiresAt, trial: true, createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await lockRef.set({ packageId, at: admin.firestore.FieldValue.serverTimestamp(), userTag: decoded.tag || '' });

  await dm(userId,
    `\uD83C\uDF1F Your **${pkg.name}** free trial is live for the next **${TRIAL_DAYS} days**! \uD83E\uDD0D\n` +
    `Dive in and explore the analysis. When it ends, grab a subscription anytime to keep your access.`);

  return res.json({ ok: true, package: pkg.name, days: TRIAL_DAYS });
}

/* ------------------------------ router ------------------------------- */

export default async function handler(req, res) {
  try {
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);

    const action = (req.query?.action || (req.body || {}).action || '').toString();
    if (action === 'roles') return await actionRoles(decoded, res);
    if (action === 'referral') return await actionReferral(decoded, res);
    if (action === 'prestige') return await actionPrestige(req, decoded, res);
    if (action === 'trial') return await actionTrial(req, decoded, res);
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'me failed' });
  }
}
