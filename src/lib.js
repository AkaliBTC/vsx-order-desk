// Läuft komplett im Browser — wie das Webhook-Posting im Position Tracker.
const WEBHOOK_TICKETS = import.meta.env.VITE_WEBHOOK_TICKETS;
const WEBHOOK_ARCHIVE = import.meta.env.VITE_WEBHOOK_ARCHIVE;

// Pings @here in the staff channel the moment a customer reports a payment.
// Posted by the bot server-side (api/pay-hint). Returns a result so the caller
// can surface why it failed (e.g. the bot can't post in that channel).
export async function postPayHint({ id, userTag, method, paid }) {
  try {
    const r = await fetch('/api/pay-hint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketId: id, userTag, method, paid: !!paid }),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok && data.ok === true, status: r.status, error: data.error, detail: data.detail };
  } catch (e) { return { ok: false, error: e.message }; }
}
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export async function postTicketEmbed(ticket) {
  if (!WEBHOOK_TICKETS) return;
  const lines = ticket.items
    .map((i) => `• ${i.name}${i.runtimeLabel ? ` (${i.runtimeLabel})` : ''} — $${i.price.toFixed(2)}`)
    .join('\n');
  await fetch(WEBHOOK_TICKETS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: `New ticket #${ticket.id.slice(0, 6)}`,
        color: 0xd4af37,
        description: `**${ticket.userTag}**\n${lines}\n\n**Total:** $${ticket.total.toFixed(2)}`,
        url: `${window.location.origin}/admin`,
        footer: { text: 'VisionX Order Desk' },
      }],
    }),
  });
}

export async function postProofImage(ticket, file) {
  if (!WEBHOOK_TICKETS) return;
  const form = new FormData();
  form.append('payload_json', JSON.stringify({
    content: `Payment proof · Ticket #${ticket.id.slice(0, 6)} · ${ticket.userTag} · $${ticket.total.toFixed(2)}`,
  }));
  form.append('files[0]', file, file.name);
  await fetch(WEBHOOK_TICKETS, { method: 'POST', body: form });
}

export async function postTranscript(ticket, messages) {
  if (!WEBHOOK_ARCHIVE) return;
  const html = renderTranscript(ticket, messages);
  const form = new FormData();
  form.append('payload_json', JSON.stringify({
    content: `Ticket #${ticket.id.slice(0, 6)} archived · ${ticket.userTag} · $${ticket.total.toFixed(2)}`,
  }));
  form.append('files[0]', new Blob([html], { type: 'text/html' }), `ticket-${ticket.id.slice(0, 6)}.html`);
  await fetch(WEBHOOK_ARCHIVE, { method: 'POST', body: form });
}

function renderTranscript(t, messages) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rows = messages.map((m) =>
    `<div class="msg ${m.from}"><span class="who">${esc(m.from === 'system' ? 'SYSTEM' : m.authorTag)}</span><span>${esc(m.body)}</span></div>`).join('');
  const items = t.items.map((i) =>
    `<tr><td>${esc(i.name)}${i.runtimeLabel ? ' · ' + esc(i.runtimeLabel) : ''}</td><td>$${i.price.toFixed(2)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{background:#121212;color:#FDFDFD;font-family:Arial,sans-serif;max-width:720px;margin:0 auto;padding:40px}
    h1{color:#D4AF37;text-transform:uppercase}.eyebrow{font-family:monospace;letter-spacing:.2em;color:#B99C64;font-size:11px;text-transform:uppercase}
    table{width:100%;border-collapse:collapse;margin:12px 0}td{border-bottom:1px solid #2a2a2a;padding:6px 0;font-size:14px}
    .msg{margin:8px 0;padding:8px 12px;border:1px solid #2a2a2a;border-radius:8px}.msg.mod{background:rgba(212,175,55,.1)}
    .who{font-family:monospace;font-size:10px;color:#8a8a86;display:block;text-transform:uppercase}</style></head><body>
    <p class="eyebrow">VisionX · Ticket transcript</p><h1>Ticket #${t.id.slice(0, 6)}</h1>
    <p>Customer: ${esc(t.userTag)} · Status: ${esc(t.status)}</p>
    <table>${items}<tr><td><b>Total</b></td><td><b>$${t.total.toFixed(2)}</b></td></tr></table>
    <p class="eyebrow">Payment</p><p>${esc(t.payment?.method || '—')} · ${esc(t.payment?.status || '—')}${t.payment?.txHash ? ' · tx ' + esc(t.payment.txHash) : ''}</p>
    <p class="eyebrow">History</p>${rows || '<p>No messages.</p>'}</body></html>`;
}

// On-chain Check (Browser): findet einen passenden USDT-Eingang. Gibt txHash oder null.
export async function checkTronPayment(address, expectedAmount) {
  const since = Date.now() - 3 * 60 * 60 * 1000;
  const url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20` +
    `?only_to=true&limit=100&contract_address=${USDT}&min_timestamp=${since}`;
  const data = await (await fetch(url)).json();
  const hit = (data.data || []).find((tx) => Math.abs(Number(tx.value) / 1e6 - expectedAmount) < 0.0005);
  return hit ? hit.transaction_id : null;
}
