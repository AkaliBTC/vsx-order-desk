// Posts an @here "payment reported" alert to the staff channel via the bot.
// Public (called from the customer's browser when they tap "I've paid"),
// but it can only post one templated message to this single hard-coded channel.
const API = 'https://discord.com/api/v10';
const CHANNEL = '1518924255461642240';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return res.status(500).json({ error: 'no bot token' });

    const { ticketId, userTag, method, amount, paid } = req.body || {};
    const m = method === 'trc20' ? 'USDT · TRC20' : method === 'paypal' ? 'PayPal' : (method || '—');
    const amt = (amount === 0 || amount) ? `$${Number(amount).toFixed(2)}` : '—';
    const content =
      `@here 💸 **Payment reported**\n` +
      `• **Name:** ${userTag || '—'}\n` +
      `• **Ticket:** #${String(ticketId || '').slice(0, 6)}\n` +
      `• **Amount:** ${amt}\n` +
      `• **Method:** ${m}\n` +
      `• **Paid:** ${paid ? '✅ Yes' : '⏳ Pending confirmation'}`;

    const r = await fetch(`${API}/channels/${CHANNEL}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: ['everyone'] } }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `discord ${r.status}`, detail: detail.slice(0, 200) });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'pay-hint failed' });
  }
}
