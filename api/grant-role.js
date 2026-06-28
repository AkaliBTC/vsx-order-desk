// Called by the Admin panel after a mod confirms payment.
// IMPORTANT: ticket data (grants/services/user) is passed in the request body
// by the Admin client, so this function does NOT need to read Firestore for it.
// - Grants package + PT roles to the buyer for the booked runtime (temp roles).
// - Opens a private ticket channel for Deep Dive / Coaching.
// - Best-effort: stores expiry in Firestore for auto-revoke (won't block if it fails).
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
const VIEW = 1024; // VIEW_CHANNEL permission bit

function chanName(s) {
  const n = (s || 'ticket').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  return n || 'ticket';
}

// Which Discord role to ping in the ticket channel, per service id.
// Which coach (Discord USER id) to ping in the ticket channel, per service id.
const PING_USER = {
  'deepdive': '704243714687631370',
  'coach-michael': '704243714687631370',
  'coach-filip': '880178639436673074',
  'coach-akali': '774014917057314877',
};

// Tracks continuous subscription coverage per user for the auto-loyalty reward.
// A streak survives gaps of up to 3 days; a longer gap resets it.
const LOYALTY_GRACE_MS = 3 * 24 * 3600 * 1000;
async function bumpLoyalty(db, userId, expiresMs) {
  try {
    const ref = db.collection('loyalty_track').doc(userId);
    const now = Date.now();
    const snap = await ref.get();
    let streakStart = now, coveredUntil = expiresMs;
    if (snap.exists) {
      const t = snap.data();
      const prevCovered = t.coveredUntil ? t.coveredUntil.toMillis() : 0;
      const prevStart = t.streakStart ? t.streakStart.toMillis() : now;
      if (now <= prevCovered + LOYALTY_GRACE_MS) { streakStart = prevStart; coveredUntil = Math.max(prevCovered, expiresMs); }
      else { streakStart = now; coveredUntil = expiresMs; }
    }
    await ref.set({
      streakStart: admin.firestore.Timestamp.fromMillis(streakStart),
      coveredUntil: admin.firestore.Timestamp.fromMillis(coveredUntil),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (_) { /* non-fatal */ }
}

// Prestige commission boost (keep role IDs in sync with src/data.js + api/prestige.js).
const PRESTIGE = [
  { tier: 1, roleId: '1519733465199808745', boost: 0.10 },
  { tier: 2, roleId: '1519733547462824057', boost: 0.25 },
  { tier: 3, roleId: '1519733602831568907', boost: 0.50 },
];
async function prestigeBoost(userId) {
  try {
    const m = await fetch(`${API}/guilds/${GUILD()}/members/${userId}`, { headers: { Authorization: BOT() } });
    if (!m.ok) return 0;
    const roles = (await m.json()).roles || [];
    let boost = 0;
    for (const p of PRESTIGE) if (roles.includes(p.roleId)) boost = Math.max(boost, p.boost);
    return boost;
  } catch (_) { return 0; }
}

// Process a referral on a successful purchase: lock the buyer (one referral per life),
// bump the owner's use count, and credit the owner $5 on their balance sheet.
// (The buyer's own 5% discount is applied at checkout, not here.)
const REFERRAL_CREDIT = 5;
async function processReferral(db, referralCode, buyerId) {
  const out = { rewarded: false };
  try {
    if (!referralCode) return out;
    const lockRef = db.collection('referral_used').doc(buyerId);
    if ((await lockRef.get()).exists) return out;               // buyer already used one
    const refRef = db.collection('referrals').doc(referralCode);
    const refSnap = await refRef.get();
    if (!refSnap.exists) return out;
    const owner = refSnap.data().ownerId;
    if (!owner || owner === buyerId) return out;                // no self-referral
    const newUses = (refSnap.data().uses || 0) + 1;
    await refRef.set({ uses: newUses }, { merge: true });
    await lockRef.set({ code: referralCode, ownerId: owner, at: admin.firestore.FieldValue.serverTimestamp() });

    // Credit the owner's balance — base $5, boosted by their prestige tier.
    const boost = await prestigeBoost(owner);
    const credit = Math.round(REFERRAL_CREDIT * (1 + boost) * 100) / 100;
    await db.collection('balances').doc(owner).set({
      amount: admin.firestore.FieldValue.increment(credit),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    const boostNote = boost > 0 ? ` (incl. +${Math.round(boost * 100)}% prestige boost)` : '';
    const msg = `\uD83E\uDD1D Someone just used your referral code \u2014 thank you! \uD83E\uDD0D\n\n` +
      `**$${credit} credit**${boostNote} has been added to your VisionX balance. ` +
      `Redeem it at checkout any time, or let it stack up. Your code has now been used ${newUses}\u00D7.`;
    try {
      const dmCh = await fetch(`${API}/users/@me/channels`, {
        method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: owner }),
      });
      if (dmCh.ok) {
        const c = await dmCh.json();
        await fetch(`${API}/channels/${c.id}/messages`, {
          method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: msg }),
        }).catch(() => {});
      }
    } catch (_) {}
    out.rewarded = true; out.uses = newUses; out.credit = credit;
  } catch (_) {}
  return out;
}

// Deduct redeemed balance from the buyer's sheet on a confirmed purchase.
async function deductBalance(db, buyerId, amount) {
  try {
    const amt = Number(amount);
    if (!(amt > 0)) return 0;
    const ref = db.collection('balances').doc(buyerId);
    const snap = await ref.get();
    const have = snap.exists ? (Number(snap.data().amount) || 0) : 0;
    const use = Math.min(have, amt);
    if (use > 0) {
      await ref.set({
        amount: admin.firestore.FieldValue.increment(-use),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return use;
  } catch (_) { return 0; }
}

// Add/extend an entitlement for (userId, roleId) ADDITIVELY: if the user still has time
// left on that role, the new duration stacks on top of the remaining time instead of
// overwriting it. Consolidates any duplicate entitlements into one. Returns new expiry ms.
async function upsertEntitlement(db, { userId, userTag, roleId, label, durationMs, ticketId }) {
  const now = Date.now();
  const snap = await db.collection('entitlements')
    .where('userId', '==', userId).where('roleId', '==', roleId).get();
  let latest = 0, keep = null;
  snap.docs.forEach((d) => {
    const exp = d.data().expiresAt ? d.data().expiresAt.toMillis() : 0;
    if (exp > latest) { latest = exp; keep = d; }
  });
  const base = latest > now ? latest : now;          // stack onto remaining time
  const newMs = base + durationMs;
  const expiresAt = admin.firestore.Timestamp.fromMillis(newMs);
  if (keep) {
    await keep.ref.set({
      userId, userTag: userTag || keep.data().userTag || null,
      roleId, label: label || keep.data().label || null,
      ticketId: ticketId || keep.data().ticketId || null,
      expiresAt, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    // remove any duplicate entitlements for this role, keeping one consolidated record
    await Promise.all(snap.docs.filter((d) => d.id !== keep.id).map((d) => d.ref.delete()));
  } else {
    await db.collection('entitlements').add({
      userId, userTag: userTag || null, roleId, label: label || null, ticketId: ticketId || null,
      expiresAt, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return newMs;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    // Verify the caller is a mod (Firebase Auth — does not need Firestore).
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    if (decoded.mod !== true && decoded.admin !== true) return res.status(403).json({ error: 'not a mod' });

    const { ticketId, userId, userTag, grants = [], services = [], vouchers = [], referralCode = '', balanceUsed = 0 } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'no userId' });

    const granted = [];
    const failed = [];
    const channels = [];
    const channelErrors = [];
    let expiryWarning = null;
    let voucherDmFailed = false;
    const expiries = [];

    // 1) Temp roles (package + PT roles).
    for (const g of grants) {
      if (!g.roleId) { failed.push(`${g.label} (no role set)`); continue; }
      const r = await fetch(`${API}/guilds/${GUILD()}/members/${userId}/roles/${g.roleId}`, {
        method: 'PUT', headers: { Authorization: BOT() },
      });
      if (r.ok || r.status === 204) {
        granted.push(g.label);
        // Expiry record for the daily auto-revoke cron — stacks onto any remaining time.
        try {
          const durationMs = g.months * 30 * 24 * 3600 * 1000;
          const newMs = await upsertEntitlement(getAdmin().firestore(), {
            userId, userTag, roleId: g.roleId, label: g.label, durationMs, ticketId,
          });
          expiries.push(`${g.label} → ${new Date(newMs).toISOString().slice(0, 10)}`);
          await bumpLoyalty(getAdmin().firestore(), userId, newMs);
        } catch (e) { expiryWarning = e.message; }
      } else {
        failed.push(`${g.label} (discord ${r.status})`);
      }
    }

    // 2) Private ticket channels for Deep Dive / Coaching.
    if (services.length) {
      const cat = process.env.DISCORD_TICKET_CATEGORY_ID;
      if (!cat) {
        channelErrors.push('No DISCORD_TICKET_CATEGORY_ID set');
      } else {
        const modRoles = (process.env.DISCORD_MOD_ROLE_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
        // Compress multiple purchases of the same service type into ONE ticket channel.
        const grouped = Object.values(services.reduce((acc, svc) => {
          const sName = typeof svc === 'string' ? svc : svc.name;
          const sId = typeof svc === 'string' ? '' : (svc.id || '');
          const key = sId || sName;
          if (!acc[key]) acc[key] = { name: sName, id: sId, qty: 0 };
          acc[key].qty += 1;
          return acc;
        }, {}));
        for (const svc of grouped) {
          const sName = svc.name;
          const sId = svc.id;
          const qty = svc.qty;
          const qtyLabel = qty > 1 ? ` ×${qty}` : '';
          const pingUser = PING_USER[sId] || '';
          const name = chanName(`${sName} ${userTag || userId}`);
          const baseOverwrites = [
            { id: GUILD(), type: 0, deny: String(VIEW) },        // @everyone hidden
            { id: userId, type: 1, allow: String(VIEW) },        // customer can see
            ...modRoles.map((rid) => ({ id: rid, type: 0, allow: String(VIEW) })), // team can see
          ];
          const coachOverwrite = pingUser ? [{ id: pingUser, type: 1, allow: String(VIEW) }] : [];

          const createChannel = (overwrites) => fetch(`${API}/guilds/${GUILD()}/channels`, {
            method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, type: 0, parent_id: cat, permission_overwrites: overwrites }),
          });

          // Try with the coach's channel access; if Discord rejects it (e.g. the coach
          // user can't be added as an overwrite), fall back to creating without it.
          let r = await createChannel([...baseOverwrites, ...coachOverwrite]);
          if (!r.ok && coachOverwrite.length) r = await createChannel(baseOverwrites);

          if (r.ok) {
            const ch = await r.json();
            channels.push(name);
            const ping = pingUser ? `<@${pingUser}>` : 'Our team';
            const content =
              `Hey <@${userId}> 👋 — thank you for your trust and your payment for **${sName}${qtyLabel}**! 🤍\n\n` +
              (qty > 1 ? `You booked **${qty}× ${sName}** — we'll handle all of them right here in this one ticket. ` : '') +
              `${ping} will reach out to you right here in just a moment to get everything started. ` +
              `Feel free to drop any details, goals or questions in the meantime so we can hit the ground running. ⭐`;
            const m = await fetch(`${API}/channels/${ch.id}/messages`, {
              method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content,
                allowed_mentions: { users: pingUser ? [userId, pingUser] : [userId] },
              }),
            }).catch(() => null);
            if (!m || !m.ok) {
              const detail = m ? await m.text().catch(() => '') : 'network';
              channelErrors.push(`${sName} message (${m ? m.status : 'net'} ${detail.slice(0, 120)})`);
            }
          } else {
            const detail = await r.text().catch(() => '');
            channelErrors.push(`${sName} channel (discord ${r.status} ${detail.slice(0, 120)})`);
          }
        }
      }
    }

    // 3) DM gift voucher codes to the buyer.
    if (vouchers.length) {
      try {
        const dm = await fetch(`${API}/users/@me/channels`, {
          method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient_id: userId }),
        });
        if (dm.ok) {
          const dmCh = await dm.json();
          for (const v of vouchers) {
            const msg =
              `🎁 **Your VisionX Gift Voucher**\n\n` +
              `Balance: **$${Number(v.amount).toFixed(2)}**\n` +
              `Code: \`${v.code}\`\n` +
              `Valid for **1 year** · **single use**.\n\n` +
              `Redeem it at checkout in the cart's "Discount / voucher code" field.\n\n` +
              `_Please note: gift vouchers are non-refundable, cannot be exchanged for cash, ` +
              `and are single-use. Keep your code private — do not share or forward it._ 🤍`;
            const m = await fetch(`${API}/channels/${dmCh.id}/messages`, {
              method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: msg }),
            });
            if (!m.ok) voucherDmFailed = true;
          }
        } else {
          voucherDmFailed = true;
        }
      } catch (e) { voucherDmFailed = true; }
    }

    const referral = await processReferral(getAdmin().firestore(), referralCode, userId);
    const balanceDeducted = await deductBalance(getAdmin().firestore(), userId, balanceUsed);

    res.json({ granted, failed, channels, channelErrors, expiryWarning, expiries, voucherDmFailed, referral, balanceDeducted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'grant failed' });
  }
}
