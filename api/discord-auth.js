// Vercel Serverless Function — deployt automatisch mit dem Repo, kein Terminal.
// Tauscht den Discord-Code (mit geheimem Schlüssel, serverseitig) und gibt ein
// Firebase Custom Token zurück, inkl. mod-Claim aus dem Rollen-Check.
import admin from 'firebase-admin';

// Lazy-Init, damit ein fehlerhafter Service-Account eine lesbare Fehlermeldung gibt.
function getAdmin() {
  if (!admin.apps.length) {
    let creds;
    try {
      creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    }
    admin.initializeApp({ credential: admin.credential.cert(creds) });
  }
  return admin;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const { code, redirectUri } = req.body || {};
    if (!code) return res.status(400).json({ error: 'missing code' });

    // 1) Code -> Access Token (Client Secret bleibt hier auf dem Server)
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
      }),
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      throw new Error('Discord token exchange failed: ' + t.slice(0, 120));
    }
    const { access_token } = await tokenRes.json();

    // 2) Profil
    const me = await (await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    })).json();

    // 3) Rollen im VisionX-Server (braucht den guilds.members.read Scope)
    let roles = [];
    try {
      const member = await (await fetch(
        `https://discord.com/api/users/@me/guilds/${process.env.DISCORD_GUILD_ID}/member`,
        { headers: { Authorization: `Bearer ${access_token}` } },
      )).json();
      roles = member.roles || [];
    } catch (_) { /* nicht im Server */ }

    const modRoles = (process.env.DISCORD_MOD_ROLE_ID || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const adminRole = (process.env.DISCORD_ADMIN_ROLE_ID || '').trim();

    // Which packages does this customer already own? Match Discord roles
    // against each package's roleId in the live catalogue (config/catalogue).
    let owns = [];
    let loyalty = false;
    try {
      const snap = await getAdmin().firestore().doc('config/catalogue').get();
      const data = snap.exists ? snap.data() : {};
      const pkgs = data.packages || [];
      owns = pkgs.filter((p) => p.roleId && roles.includes(p.roleId)).map((p) => p.id);
      loyalty = !!(data.loyaltyRoleId && roles.includes(data.loyaltyRoleId));
    } catch (_) { /* catalogue not set yet */ }

    const token = await getAdmin().auth().createCustomToken(me.id, {
      mod: roles.some((r) => modRoles.includes(r)),
      admin: adminRole ? roles.includes(adminRole) : false,
      tag: me.global_name || me.username,
      avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : null,
      owns,
      loyalty,
    });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'auth failed' });
  }
}
