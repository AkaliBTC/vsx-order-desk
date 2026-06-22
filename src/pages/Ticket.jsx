import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  doc, onSnapshot, updateDoc, collection, addDoc, query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../auth';
import { PAYMENT } from '../data';
import { postProofImage } from '../lib';

export default function Ticket() {
  const { id } = useParams();
  const { user } = useAuth();
  const [ticket, setTicket] = useState(undefined);

  useEffect(() => onSnapshot(doc(db, 'tickets', id), (s) => setTicket(s.exists() ? { id: s.id, ...s.data() } : null)), [id]);

  if (ticket === undefined) return <div className="shell" style={{ paddingTop: 40 }}>Lädt…</div>;
  if (ticket === null) return <div className="shell" style={{ paddingTop: 40 }}>Ticket nicht gefunden.</div>;

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
    awaiting_payment: ['warn', 'Zahlung offen'],
    paid: ['ok', 'Bezahlt'],
    closed: ['gold', 'Geschlossen'],
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
            <span>{it.name}{it.runtimeLabel ? <span className="mono" style={{ color: 'var(--vsx-muted)' }}> · {it.runtimeLabel}</span> : null}</span>
            <span className="mono">{it.price.toFixed(2)} €</span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
          <span className="eyebrow">Summe</span>
          <span className="mono display" style={{ color: 'var(--vsx-gold)', fontSize: 18 }}>{ticket.total.toFixed(2)} €</span>
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
      // Unique sub-cent amount so the verifier can match the on-chain transfer.
      const unique = Math.floor(1 + Math.random() * 999) / 1000;
      patch['payment.expectedAmount'] = +(ticket.total + unique).toFixed(3);
      patch['payment.address'] = PAYMENT.tronAddress;
    }
    await updateDoc(doc(db, 'tickets', ticket.id), patch);
  };

  if (paid) {
    return <div className="card"><p className="eyebrow">Zahlung</p><p style={{ color: 'var(--vsx-ok)', marginTop: 10 }}>Zahlung bestätigt. Danke!</p></div>;
  }

  if (!p.method) {
    return (
      <div className="card">
        <p className="eyebrow">Zahlung wählen</p>
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
      // Screenshot direkt nach Discord (#tickets) — nichts wird bei uns gespeichert.
      try {
        await postProofImage({ id: ticket.id, userTag: ticket.userTag, total: ticket.total }, file);
      } catch (e) { console.error('proof', e); }
      setUploading(false);
    }
    await updateDoc(doc(db, 'tickets', ticket.id), {
      'payment.proofSent': !!file,
      'payment.markedPaidAt': serverTimestamp(),
    });
    // PayPal: Mod bestätigt im Panel. TRC20: Mod prüft per "On-Chain prüfen".
  };

  return (
    <div className="card">
      <p className="eyebrow">{isTron ? 'USDT · TRC20' : 'PayPal'}</p>
      <p style={{ color: 'var(--vsx-muted)', fontSize: 14, marginTop: 8 }}>
        {isTron
          ? 'Sende exakt den angezeigten Betrag (inkl. Nachkommastellen) an die Adresse. Der Betrag dient der eindeutigen Zuordnung.'
          : 'Sende den Betrag an folgendes PayPal-Konto und hänge einen Beweis-Screenshot an.'}
      </p>

      <div style={{ background: 'var(--vsx-charcoal-3)', borderRadius: 8, padding: 14, marginTop: 14 }}>
        <div className="eyebrow">Betrag</div>
        <div className="mono display" style={{ fontSize: 22, color: 'var(--vsx-gold)' }}>
          {amount.toFixed(isTron ? 3 : 2)} {isTron ? 'USDT' : '€'}
        </div>
        <div className="eyebrow" style={{ marginTop: 12 }}>{isTron ? 'Adresse (TRC20)' : 'PayPal'}</div>
        <div className="mono" style={{ wordBreak: 'break-all', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <span>{address}</span>
          <button onClick={() => navigator.clipboard.writeText(address)} style={{ background: 'none', color: 'var(--vsx-gold)', padding: 0 }}>Kopieren</button>
        </div>
      </div>

      {!isTron && (
        <div style={{ marginTop: 14 }}>
          <label className="eyebrow">Beweis-Screenshot</label>
          <input ref={fileRef} type="file" accept="image/*" style={{ marginTop: 6 }} />
        </div>
      )}

      <button className="btn" style={{ width: '100%', marginTop: 16 }} disabled={cooldown > 0 || uploading} onClick={markPaid}>
        {cooldown > 0 ? `Paid (in ${cooldown}s)` : uploading ? 'Lädt…' : 'Paid'}
      </button>
      {isTron && (
        <p style={{ color: 'var(--vsx-muted)', fontSize: 12, marginTop: 10 }}>
          Dein Eingang wird geprüft und das Ticket danach auf „Bezahlt" gesetzt.
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
      <p className="eyebrow">Ticket-Chat</p>
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
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Nachricht…" />
          <button className="btn" onClick={send}>Senden</button>
        </div>
      )}
    </div>
  );
}
