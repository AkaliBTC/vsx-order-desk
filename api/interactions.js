// Discord Interactions endpoint (slash commands).
// Set this URL as the "Interactions Endpoint URL" in the Discord Developer Portal:
//   https://vsx-order-desk.vercel.app/api/interactions
import nacl from 'tweetnacl';
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('method');

  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];
  const pub = process.env.DISCORD_PUBLIC_KEY;
  if (!sig || !ts || !pub) return res.status(401).end('bad request');

  // Raw body (fallback to re-serialised body if the platform already parsed it).
  let raw = await readRaw(req);
  if (!raw && req.body) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

  let verified = false;
  try {
    verified = nacl.sign.detached.verify(
      Buffer.from(ts + raw),
      Buffer.from(sig, 'hex'),
      Buffer.from(pub, 'hex'),
    );
  } catch { verified = false; }
  if (!verified) return res.status(401).end('invalid request signature');

  let body = {};
  try { body = JSON.parse(raw); } catch { return res.status(400).end('bad json'); }

  // 1) PING → PONG (Discord verifies the endpoint with this).
  if (body.type === 1) return res.status(200).json({ type: 1 });

  // 2) Slash command.
  if (body.type === 2) {
    const userId = body.member?.user?.id || body.user?.id;
    let text = 'You have no active VisionX subscriptions right now. 🤍';
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
          return `• **${e.label || 'Role'}** — ${days} day${days === 1 ? '' : 's'} left (until ${date})`;
        });
      if (lines.length) text = `**Your VisionX subscriptions** 🤍\n${lines.join('\n')}`;
    } catch (e) {
      text = 'Could not look up your subscriptions right now — please try again shortly.';
    }
    return res.status(200).json({ type: 4, data: { content: text, flags: 64 } }); // 64 = ephemeral
  }

  return res.status(200).json({ type: 4, data: { content: 'Unsupported interaction.', flags: 64 } });
}
