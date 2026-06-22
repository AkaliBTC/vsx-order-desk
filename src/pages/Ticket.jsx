import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  doc, onSnapshot, updateDoc, collection, addDoc, query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../auth';
import { PAYMENT, fmt } from '../data';
import { postProofImage } from '../lib';

export default function Ticket() {
  const { id } = useParams();
  const { user } = useAuth();
  const [ticket, setTicket] = useState(undefined);

  useEffect(() => onSnapshot(doc(db, 'tickets', id), (s) => setTicket(s.exists() ? { id: s.id, ...s.data() } : null)), [id]);

  if (ticket === undefined) return <div className="shell" style={{ paddingTop: 40 }}>Loading…</div>;
  if (ticket === null) return <div className="shell" style={{ paddingTop: 40 }}>Ticket not found.</div>;

  return (
    <div className="shell" style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 28, alignItems: 'start' }}>
      <div style={{ display: 'grid', gap: 20 }}>
        <Summary ticket={ticket} />
        <Payment ticket={ticket} />
      </div>
      <Chat ticket={ticket} user={user} />
    </div>
  );
}

function StatusTag({ status }) {
  const map = {
    awaiting_payment: ['warn', 'Awaiting payment'],
    paid: ['ok', 'Paid'],
    closed: ['gold', 'Closed'],
  };
  const [cls, label] = map[status] || ['', status];
  return <span className={`tag ${cls}`}>{label}</span>;
}

function Summary({ ticket }) {
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p className="eyebrow">Ticket #{ticket.id.slice(0, 6)}</p>
        <StatusTag status={ticket.status} />
      </div>
      <div style={{ marginTop: 14 }}>
        {ticket.items.map((it, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--vsx-line)' }}>
            <span>{it.name}</span>
            <span className="mono">{fmt(it.price)}</span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
          <span className="eyebrow">Total</span>
          <span className="mono display" style={{ color: 'var(--vsx-gold)', fontSize: 18 }}>{fmt(ticket.total)}</span>
        </div>
      </div>
    </div>
  );
}

function Payment({ ticket }) {
  const p = ticket.payment || {};
  const paid = ticket.status === 'paid' || ticket.status === 'closed';

  const choose = async (method) => {
    const patch = { 'payment.method': method, 'payment.status': 'awaiting' };
    if (method === 'trc20') {
      const unique = Math.floor(1 + Math.random() * 999) / 1000;
      patch['payment.expectedAmount'] = +(ticket.total + unique).toFixed(3);
      patch['payment.address'] = PAYMENT.tronAddress;
    }
    await updateDoc(doc(db, 'tickets', ticket.id), patch);
  };

  if (paid) {
    return <div className="card"><p className="eyebrow">Payment</p><p style={{ color: 'var(--vsx-ok)', marginTop: 10 }}>Payment confirmed. Thank you!</p></div>;
  }

  if (!p.method) {
    return (
      <div className="card">
        <p className="eyebrow">Choose payment</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
          <button className="btn-ghost" style={{ flex: 1 }} onClick={() => choose('paypal')}>PayPal</button>
          <button className="btn-ghost" style={{ flex: 1 }} onClick={() => choose('trc20')}>USDT · TRC20</button>
        </div>
      </div>
    );
  }

  return <PaymentInstructions ticket={ticket} />;
}

function PaymentInstructions({ ticket }) {
  const p = ticket.payment;
  const [cooldown, setCooldown] = useState(30);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const isTron = p.method === 'trc20';
  const address = isTron ? p.address : PAYMENT.paypalHandle;
  const amount = isTron ? p.expectedAmount : ticket.total;

  const markPaid = async () => {
    const file = fileRef.current?.files?.[0];
    if (file) {
      setUploading(true);
      try {
        await postProofImage({ id: ticket.id, userTag: ticket.userTag, total: ticket.total }, file);
      } catch (e) { console.error('proof', e); }
      setUploading(false);
    }
    await updateDoc(doc(db, 'tickets', ticket.id), {
      'payment.proofSent': !!file,
      'payment.markedPaidAt': serverTimestamp(),
    });
  };

  return (
    <div className="card">
      <p className="eyebrow">{isTron ? 'USDT · TRC20' : 'PayPal'}</p>
      <p style={{ color: 'var(--vsx-muted)', fontSize: 14, marginTop: 8 }}>
        {isTron
          ? 'Send the exact amount shown (including decimals) to the address. The amount is used to match your payment.'
          : 'Send the amount to the PayPal account below and attach a proof screenshot.'}
      </p>

      <div style={{ background: 'var(--vsx-charcoal-3)', borderRadius: 8, padding: 14, marginTop: 14 }}>
        <div className="eyebrow">Amount</div>
        <div className="mono display" style={{ fontSize: 22, color: 'var(--vsx-gold)' }}>
          {isTron ? `${amount.toFixed(3)} USDT` : fmt(amount)}
        </div>
        <div className="eyebrow" style={{ marginTop: 12 }}>{isTron ? 'Address (TRC20)' : 'PayPal'}</div>
        <div className="mono" style={{ wordBreak: 'break-all', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <span>{address}</span>
          <button onClick={() => navigator.clipboard.writeText(address)} style={{ background: 'none', color: 'var(--vsx-gold)', padding: 0 }}>Copy</button>
        </div>
      </div>

      {!isTron && (
        <div style={{ marginTop: 14 }}>
          <label className="eyebrow">Proof screenshot</label>
          <input ref={fileRef} type="file" accept="image/*" style={{ marginTop: 6 }} />
        </div>
      )}

      <button className="btn" style={{ width: '100%', marginTop: 16 }} disabled={cooldown > 0 || uploading} onClick={markPaid}>
        {cooldown > 0 ? `Paid (in ${cooldown}s)` : uploading ? 'Sending…' : 'Paid'}
      </button>
      {isTron && (
        <p style={{ color: 'var(--vsx-muted)', fontSize: 12, marginTop: 10 }}>
          Your payment will be verified and the ticket marked “Paid”.
        </p>
      )}
    </div>
  );
}

function Chat({ ticket, user }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const endRef = useRef();

  useEffect(() => {
    const q = query(collection(db, 'tickets', ticket.id, 'messages'), orderBy('at', 'asc'));
    return onSnapshot(q, (s) => setMessages(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, [ticket.id]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    await addDoc(collection(db, 'tickets', ticket.id, 'messages'), {
      from: user.isMod ? 'mod' : 'customer',
      authorTag: user.tag,
      body,
      at: serverTimestamp(),
    });
  };

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: 560, position: 'sticky', top: 24 }}>
      <p className="eyebrow">Ticket chat</p>
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, margin: '12px 0' }}>
        {messages.map((m) => (
          <div key={m.id} style={{ alignSelf: m.from === 'customer' ? 'flex-start' : 'flex-end', maxWidth: '85%' }}>
            <div className="mono" style={{ fontSize: 10, color: 'var(--vsx-muted)', textAlign: m.from === 'customer' ? 'left' : 'right' }}>
              {m.from === 'system' ? 'SYSTEM' : m.authorTag}
            </div>
            <div style={{
              background: m.from === 'customer' ? 'var(--vsx-charcoal-3)' : 'rgba(212,175,55,.12)',
              border: '1px solid var(--vsx-line)', borderRadius: 8, padding: '8px 12px', fontSize: 14, marginTop: 3,
            }}>{m.body}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {ticket.status !== 'closed' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Message…" />
          <button className="btn" onClick={send}>Send</button>
        </div>
      )}
    </div>
  );
}
