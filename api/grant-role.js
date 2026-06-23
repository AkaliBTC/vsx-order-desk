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
const PING_ROLE = {
  'deepdive': '704243714687631370',
  'coach-michael': '704243714687631370',
  'coach-filip': '880178639436673074',
  'coach-akali': '774014917057314877',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    // Verify the caller is a mod (Firebase Auth — does not need Firestore).
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    if (decoded.mod !== true) return res.status(403).json({ error: 'not a mod' });

    const { ticketId, userId, userTag, grants = [], services = [], vouchers = [] } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'no userId' });

    const granted = [];
    const failed = [];
    const channels = [];
    const channelErrors = [];
    let expiryWarning = null;
    let voucherDmFailed = false;

    // 1) Temp roles (package + PT roles).
    for (const g of grants) {
      if (!g.roleId) { failed.push(`${g.label} (no role set)`); continue; }
      const r = await fetch(`${API}/guilds/${GUILD()}/members/${userId}/roles/${g.roleId}`, {
        method: 'PUT', headers: { Authorization: BOT() },
      });
      if (r.ok || r.status === 204) {
        granted.push(g.label);
        // Best-effort expiry record (for the daily auto-revoke cron).
        try {
          const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + g.months * 30 * 24 * 3600 * 1000);
          await getAdmin().firestore().collection('entitlements').add({
            userId, roleId: g.roleId, label: g.label || null, ticketId: ticketId || null,
            expiresAt, createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
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
        for (const svc of services) {
          const sName = typeof svc === 'string' ? svc : svc.name;
          const sId = typeof svc === 'string' ? '' : svc.id;
          const pingRole = PING_ROLE[sId] || '';
          const name = chanName(`${sName} ${userTag || userId}`);
          const overwrites = [
            { id: GUILD(), type: 0, deny: String(VIEW) },        // @everyone hidden
            { id: userId, type: 1, allow: String(VIEW) },        // customer can see
            ...modRoles.map((rid) => ({ id: rid, type: 0, allow: String(VIEW) })), // team can see
            ...(pingRole ? [{ id: pingRole, type: 0, allow: String(VIEW) }] : []),  // responsible team
          ];
          const r = await fetch(`${API}/guilds/${GUILD()}/channels`, {
            method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, type: 0, parent_id: cat, permission_overwrites: overwrites }),
          });
          if (r.ok) {
            const ch = await r.json();
            channels.push(name);
            const ping = pingRole ? `<@&${pingRole}>` : 'Our team';
            const content =
              `Hey <@${userId}> 👋 — thank you for your trust and your payment for **${sName}**! 🤍\n\n` +
              `${ping} will reach out to you right here in just a moment to get everything started. ` +
              `Feel free to drop any details, goals or questions in the meantime so we can hit the ground running. ⭐`;
            await fetch(`${API}/channels/${ch.id}/messages`, {
              method: 'POST', headers: { Authorization: BOT(), 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content,
                allowed_mentions: { users: [userId], roles: pingRole ? [pingRole] : [] },
              }),
            }).catch(() => {});
          } else {
            channelErrors.push(`${sName} (discord ${r.status})`);
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

    res.json({ granted, failed, channels, channelErrors, expiryWarning, voucherDmFailed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'grant failed' });
  }
}
