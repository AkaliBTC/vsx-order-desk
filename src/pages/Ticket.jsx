import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
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

  const changeMethod = () => updateDoc(doc(db, 'tickets', ticket.id), { 'payment.method': null, 'payment.status': 'unpaid' });

  if (paid) {
    return (
      <motion.div className="card" style={{ textAlign: 'center', padding: '34px 20px' }}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <motion.div
          initial={{ scale: 0 }} animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 14, delay: 0.05 }}
          style={{ width: 76, height: 76, borderRadius: '50%', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(84,192,138,.12)', border: '2px solid var(--vsx-ok)' }}>
          <motion.svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="var(--vsx-ok)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <motion.path d="M20 6L9 17l-5-5"
              initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.4, delay: 0.25, ease: 'easeOut' }} />
          </motion.svg>
        </motion.div>
        <h2 style={{ fontSize: 24, margin: '0 0 6px' }}>Payment confirmed</h2>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 14, margin: 0 }}>
          Thank you! Your order is being processed — your roles and access are on the way.
        </p>
      </motion.div>
    );
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

  return <PaymentInstructions ticket={ticket} onChangeMethod={changeMethod} />;
}

function PaymentInstructions({ ticket, onChangeMethod }) {
  const p = ticket.payment;
  const [cooldown, setCooldown] = useState(15);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const isTron = p.method === 'trc20';
  const address = isTron ? p.address : PAYMENT.paypalHandle;
  const amount = isTron ? p.expectedAmount : ticket.total;
  const reported = !!p.markedPaidAt || submitting;

  const markPaid = async () => {
    if (reported) return;
    setSubmitting(true);
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p className="eyebrow">{isTron ? 'USDT · TRC20' : 'PayPal'}</p>
        {!reported && (
          <button onClick={onChangeMethod} style={{ background: 'none', color: 'var(--vsx-muted)', fontSize: 12, padding: 0 }}>← Change method</button>
        )}
      </div>
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

      {!isTron && !reported && (
        <div style={{ marginTop: 14 }}>
          <label className="eyebrow">Proof screenshot</label>
          <input ref={fileRef} type="file" accept="image/*" style={{ marginTop: 6 }} />
        </div>
      )}

      {reported ? (
        <div style={{ marginTop: 16, background: 'rgba(84,192,138,.10)', border: '1px solid #2e5b46', borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--vsx-ok)', fontSize: 18 }}>✓</span>
          <span style={{ color: 'var(--vsx-ok)', fontSize: 14 }}>Payment reported — the team will confirm it shortly. You'll see a confirmation here.</span>
        </div>
      ) : (
        <button className="btn" style={{ width: '100%', marginTop: 16 }} disabled={cooldown > 0 || uploading} onClick={markPaid}>
          {uploading ? 'Sending…' : cooldown > 0 ? `I've paid (${cooldown}s)` : "I've paid"}
        </button>
      )}
    </div>
  );
}

export function Chat({ ticket, user }) {
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
        {messages.map((m) => {
          const role = m.from; // 'mod' | 'customer' | 'system'
          if (role === 'system') {
            return (
              <div key={m.id} className="mono" style={{ alignSelf: 'center', fontSize: 11, color: 'var(--vsx-muted)', padding: '2px 0' }}>{m.body}</div>
            );
          }
          const isTeam = role === 'mod';
          const mine = role === (user.isMod ? 'mod' : 'customer');
          return (
            <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '78%', display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
              <div className="mono" style={{ fontSize: 10, color: isTeam ? 'var(--vsx-gold-2)' : 'var(--vsx-muted)', margin: '0 8px 3px' }}>
                {m.authorTag}{isTeam ? ' · Team' : ''}
              </div>
              <div style={{
                background: isTeam ? 'linear-gradient(180deg, rgba(212,175,55,.20), rgba(212,175,55,.10))' : 'var(--vsx-charcoal-3)',
                border: isTeam ? '1px solid var(--vsx-gold-2)' : '1px solid var(--vsx-line)',
                color: 'var(--vsx-offwhite)',
                borderRadius: mine ? '16px 16px 5px 16px' : '16px 16px 16px 5px',
                padding: '9px 13px', fontSize: 14, lineHeight: 1.45, boxShadow: 'var(--shadow-soft)', wordBreak: 'break-word',
              }}>{m.body}</div>
            </div>
          );
        })}
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
