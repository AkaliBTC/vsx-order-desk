// Visit once in the browser to (re)register the /subscription slash command in your
// guild (guild commands appear instantly):
//   https://vsx-order-desk.vercel.app/api/register-commands
// If CRON_SECRET is set, append ?key=YOUR_CRON_SECRET.
const API = 'https://discord.com/api/v10';

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const key = (req.query && req.query.key) || '';
    if (key !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const appId = process.env.DISCORD_CLIENT_ID;
    const guildId = process.env.DISCORD_GUILD_ID;
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!appId || !guildId || !token) return res.status(500).json({ error: 'missing env (CLIENT_ID / GUILD_ID / BOT_TOKEN)' });

    const command = {
      name: 'subscription',
      description: 'See how long your VisionX roles are still active',
      type: 1,
      options: [
        { name: 'user', description: '(Team only) check another member\u2019s subscriptions', type: 6, required: false },
      ],
    };

    const r = await fetch(`${API}/applications/${appId}/guilds/${guildId}/commands`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const detail = await r.text();
    if (!r.ok) return res.status(502).json({ error: `discord ${r.status}`, detail: detail.slice(0, 300) });
    res.status(200).json({ ok: true, registered: '/subscription' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'register failed' });
  }
}
