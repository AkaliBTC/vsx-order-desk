// Runs daily via Vercel Cron (see vercel.json):
//  • removes temp roles whose entitlement has expired (+ DMs the customer)
//  • DMs the customer once, ~3 days before a role expires
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
  } catch { return false; }
}

export default async function handler(req, res) {
  // Protect: if CRON_SECRET is set, require Vercel's cron auth header.
  if (process.env.CRON_SECRET) {
    const ok = (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}`;
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const db = getAdmin().firestore();
    const now = admin.firestore.Timestamp.now();
    const in3d = admin.firestore.Timestamp.fromMillis(Date.now() + 3 * 24 * 3600 * 1000);

    // 1) Expired → remove role + DM the customer, UNLESS another entitlement still keeps
    //    that same role alive (stacked durations / legacy duplicates).
    const expired = await db.collection('entitlements').where('expiresAt', '<=', now).get();
    let removed = 0;
    for (const d of expired.docs) {
      const e = d.data();
      const others = await db.collection('entitlements')
        .where('userId', '==', e.userId).where('roleId', '==', e.roleId).get();
      const stillActive = others.docs.some((o) => o.id !== d.id
        && o.data().expiresAt && o.data().expiresAt.toMillis() > Date.now());
      if (!stillActive) {
        await fetch(`${API}/guilds/${process.env.DISCORD_GUILD_ID}/members/${e.userId}/roles/${e.roleId}`, {
          method: 'DELETE', headers: { Authorization: BOT() },
        }).catch(() => {});
        await dm(e.userId,
          `⌛ Your VisionX **${e.label || 'subscription'}** has now expired and the role was removed.\n\n` +
          `Thank you for being part of VisionX! 🤍 You can renew anytime here:\n${SHOP()}`);
        removed += 1;
      }
      await d.ref.delete();
    }

    // 2) Expiring within ~3 days, not yet reminded → DM once.
    const soon = await db.collection('entitlements')
      .where('expiresAt', '>', now).where('expiresAt', '<=', in3d).get();
    let reminded = 0;
    for (const d of soon.docs) {
      const e = d.data();
      if (e.reminded3d) continue;
      const msLeft = e.expiresAt.toMillis() - Date.now();
      const days = Math.max(1, Math.ceil(msLeft / (24 * 3600 * 1000)));
      const date = new Date(e.expiresAt.toMillis()).toISOString().slice(0, 10);
      await dm(e.userId,
        `⏳ Heads up — your VisionX **${e.label || 'subscription'}** expires in ` +
        `**${days} day${days > 1 ? 's' : ''}** (${date}).\n\n` +
        `Renew anytime to keep your access:\n${SHOP()} 🤍`);
      await d.ref.update({ reminded3d: true });
      reminded += 1;
    }

    // 3) Loyalty auto-grant: 1 year of continuous coverage (gaps ≤ 3 days), still covered now.
    let loyaltyGranted = 0;
    let loyaltyRoleId = '';
    try {
      const cat = await db.doc('config/catalogue').get();
      loyaltyRoleId = (cat.exists ? cat.data().loyaltyRoleId : '') || '';
    } catch (_) {}
    if (loyaltyRoleId) {
      const YEAR = 365 * 24 * 3600 * 1000;
      const GRACE = 3 * 24 * 3600 * 1000;
      const tracks = await db.collection('loyalty_track').get();
      for (const d of tracks.docs) {
        const t = d.data();
        if (t.granted) continue;
        const start = t.streakStart ? t.streakStart.toMillis() : Date.now();
        const covered = t.coveredUntil ? t.coveredUntil.toMillis() : 0;
        const stillCovered = covered >= Date.now() - GRACE;     // streak hasn't lapsed
        const yearReached = (Date.now() - start) >= YEAR;        // continuous for ≥ 1 year
        if (stillCovered && yearReached) {
          const r = await fetch(`${API}/guilds/${process.env.DISCORD_GUILD_ID}/members/${d.id}/roles/${loyaltyRoleId}`, {
            method: 'PUT', headers: { Authorization: BOT() },
          });
          if (r.ok || r.status === 204) {
            await d.ref.set({ granted: true, grantedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            await dm(d.id,
              `🏆 **One year with VisionX!** Thank you for staying with us for a full year. 🤍\n\n` +
              `Your **Loyalty** status is now active — enjoy **10% off** all analysis from here on.`);
            loyaltyGranted += 1;
          }
        }
      }
    }

    res.json({ removed, reminded, loyaltyGranted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'revoke failed' });
  }
}
