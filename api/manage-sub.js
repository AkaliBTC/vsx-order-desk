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

// Additive entitlement upsert: stacks new time onto remaining time, consolidates dupes.
async function upsertEntitlement(db, { userId, userTag, roleId, label, durationMs, grantedBy }) {
  const now = Date.now();
  const snap = await db.collection('entitlements')
    .where('userId', '==', userId).where('roleId', '==', roleId).get();
  let latest = 0, keep = null;
  snap.docs.forEach((d) => {
    const exp = d.data().expiresAt ? d.data().expiresAt.toMillis() : 0;
    if (exp > latest) { latest = exp; keep = d; }
  });
  const base = latest > now ? latest : now;
  const newMs = base + durationMs;
  const expiresAt = admin.firestore.Timestamp.fromMillis(newMs);
  if (keep) {
    await keep.ref.set({
      userId, userTag: userTag || keep.data().userTag || null, roleId,
      label: label || keep.data().label || null, expiresAt, grantedBy: grantedBy || keep.data().grantedBy || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await Promise.all(snap.docs.filter((d) => d.id !== keep.id).map((d) => d.ref.delete()));
  } else {
    await db.collection('entitlements').add({
      userId, userTag: userTag || null, roleId, label: label || 'Role', expiresAt, grantedBy: grantedBy || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return newMs;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    if (decoded.mod !== true && decoded.admin !== true) return res.status(403).json({ error: 'not a mod' });

    const { action, userId, userTag, roleId, label, months, durationDays, id } = req.body || {};
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
      // Variable duration: explicit days if given, else months × 30.
      const days = Number(durationDays) > 0 ? Number(durationDays) : (Number(months) || 1) * 30;
      const durationMs = days * 24 * 3600 * 1000;
      const ms = await upsertEntitlement(db, {
        userId, userTag, roleId, label: label || 'Role', durationMs, grantedBy: decoded.uid,
      });
      // Extend the loyalty streak (continuous-coverage tracking).
      try {
        const ref = db.collection('loyalty_track').doc(userId);
        const now = Date.now();
        const snap = await ref.get();
        let streakStart = now, coveredUntil = ms;
        if (snap.exists) {
          const t = snap.data();
          const prevCovered = t.coveredUntil ? t.coveredUntil.toMillis() : 0;
          const prevStart = t.streakStart ? t.streakStart.toMillis() : now;
          if (now <= prevCovered + 3 * 24 * 3600 * 1000) { streakStart = prevStart; coveredUntil = Math.max(prevCovered, ms); }
          else { streakStart = now; coveredUntil = ms; }
        }
        await ref.set({
          streakStart: admin.firestore.Timestamp.fromMillis(streakStart),
          coveredUntil: admin.firestore.Timestamp.fromMillis(coveredUntil),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (_) { /* non-fatal */ }
      return res.json({ ok: true, expiresAt: ms });
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
