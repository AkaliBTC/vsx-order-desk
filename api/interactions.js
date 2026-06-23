// Discord Interactions endpoint (slash commands).
// Set this URL as the "Interactions Endpoint URL" in the Discord Developer Portal:
//   https://vsx-order-desk.vercel.app/api/interactions
// Signature is verified with Node's built-in crypto (Ed25519) — no external deps.
import crypto from 'crypto';
import admin from 'firebase-admin';

// We need the RAW request body to verify Discord's signature.
export const config = { api: { bodyParser: false } };

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin;
}

async function readRaw(req) {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks).toString('utf8');
  } catch { return ''; }
}

// Verify an Ed25519 signature using Node crypto (wraps the raw 32-byte key into SPKI DER).
function verify(rawBody, signatureHex, timestamp, publicKeyHex) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), // SPKI DER prefix for Ed25519
        Buffer.from(publicKeyHex, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(timestamp + rawBody), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  // GET = quick diagnostic in the browser (does NOT leak the key, just confirms setup).
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      endpoint: 'interactions',
      hasPublicKey: !!process.env.DISCORD_PUBLIC_KEY,
      note: 'Discord posts here. If hasPublicKey is false, set DISCORD_PUBLIC_KEY in Vercel and redeploy.',
    });
  }
  if (req.method !== 'POST') return res.status(405).end('method');

  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];
  const pub = process.env.DISCORD_PUBLIC_KEY;
  if (!sig || !ts || !pub) return res.status(401).end('bad request');

  // Raw body (fallback to re-serialised body if the platform already parsed it).
  let raw = await readRaw(req);
  if (!raw && req.body) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

  if (!verify(raw, sig, ts, pub)) return res.status(401).end('invalid request signature');

  let body = {};
  try { body = JSON.parse(raw); } catch { return res.status(400).end('bad json'); }

  // 1) PING -> PONG (Discord verifies the endpoint with this).
  if (body.type === 1) return res.status(200).json({ type: 1 });

  // 2) Slash command.
  if (body.type === 2) {
    const invokerId = body.member?.user?.id || body.user?.id;
    const invokerRoles = body.member?.roles || [];
    const modRoles = (process.env.DISCORD_MOD_ROLE_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
    const adminRole = (process.env.DISCORD_ADMIN_ROLE_ID || '').trim();
    const isStaff = invokerRoles.some((r) => modRoles.includes(r)) || (!!adminRole && invokerRoles.includes(adminRole));

    const opt = (body.data?.options || []).find((o) => o.name === 'user');
    let userId = invokerId;
    let who = 'Your';
    let whoNo = 'You have';
    if (opt && opt.value && isStaff) {
      userId = opt.value;
      const u = body.data?.resolved?.users?.[opt.value];
      const name = u ? (u.global_name || u.username) : opt.value;
      who = `${name}\u2019s`;
      whoNo = `${name} has`;
    } else if (opt && opt.value && !isStaff) {
      return res.status(200).json({ type: 4, data: { content: 'Only the team can look up other members. Run `/subscription` without a user to see your own. \uD83E\uDD0D', flags: 64 } });
    }

    let text = `${whoNo} no active VisionX subscriptions right now. \uD83E\uDD0D`;
    try {
      const db = getAdmin().firestore();
      const snap = await db.collection('entitlements').where('userId', '==', userId).get();
      const now = Date.now();
      const lines = snap.docs.map((d) => d.data())
        .filter((e) => e.expiresAt && e.expiresAt.toMillis() > now)
        .sort((a, b) => a.expiresAt.toMillis() - b.expiresAt.toMillis())
        .map((e) => {
          const ms = e.expiresAt.toMillis() - now;
          const days = Math.max(0, Math.floor(ms / (24 * 3600 * 1000)));
          const date = new Date(e.expiresAt.toMillis()).toISOString().slice(0, 10);
          return `\u2022 **${e.label || 'Role'}** \u2014 ${days} day${days === 1 ? '' : 's'} left (until ${date})`;
        });
      if (lines.length) text = `**${who} VisionX subscriptions** \uD83E\uDD0D\n${lines.join('\n')}`;
    } catch (e) {
      text = 'Could not look up subscriptions right now \u2014 please try again shortly.';
    }
    return res.status(200).json({ type: 4, data: { content: text, flags: 64, allowed_mentions: { parse: [] } } }); // ephemeral, no pings
  }

  return res.status(200).json({ type: 4, data: { content: 'Unsupported interaction.', flags: 64 } });
}
