import { useEffect, useState } from 'react';
import {
  collection, query, orderBy, onSnapshot, doc, updateDoc, getDocs, deleteDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../auth';
import { postTranscript, checkTronPayment } from '../lib';
import { PAYMENT } from '../data';

export default function Admin() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    const q = query(collection(db, 'tickets'), orderBy('createdAt', 'desc'));
    return onSnapshot(q, (s) => setTickets(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, []);

  const active = tickets.find((t) => t.id === selected);

  return (
    <div className="shell" style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 24, alignItems: 'start' }}>
      <aside className="card" style={{ position: 'sticky', top: 24 }}>
        <p className="eyebrow">Offene Tickets</p>
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {tickets.length === 0 && <p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>Keine offenen Tickets.</p>}
          {tickets.map((t) => (
            <button key={t.id} onClick={() => setSelected(t.id)} style={{
              textAlign: 'left', background: selected === t.id ? 'var(--vsx-charcoal-3)' : 'transparent',
              border: '1px solid var(--vsx-line)', borderRadius: 8, padding: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="mono" style={{ fontSize: 12 }}>#{t.id.slice(0, 6)}</span>
                <span className={`tag ${t.status === 'paid' ? 'ok' : 'warn'}`}>{t.status === 'paid' ? 'bezahlt' : 'offen'}</span>
              </div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{t.userTag}</div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--vsx-gold)' }}>{t.total?.toFixed(2)} €</div>
            </button>
          ))}
        </div>
      </aside>

      <main>
        {!active ? (
          <div className="card"><p style={{ color: 'var(--vsx-muted)' }}>Ticket links auswählen.</p></div>
        ) : (
          <AdminDetail ticket={active} modTag={user.tag} />
        )}
      </main>
    </div>
  );
}

function AdminDetail({ ticket, modTag }) {
  const p = ticket.payment || {};

  const confirmPayment = () =>
    updateDoc(doc(db, 'tickets', ticket.id), {
      status: 'paid',
      'payment.status': 'paid',
      'payment.confirmedBy': modTag,
      'payment.confirmedAt': serverTimestamp(),
    });

  const closeTicket = async () => {
    if (!confirm('Ticket schließen? Transcript geht ins Archiv, danach wird das Ticket gelöscht.')) return;
    const msgsRef = collection(db, 'tickets', ticket.id, 'messages');
    let messages = [];
    try {
      const snap = await getDocs(msgsRef);
      messages = snap.docs.map((d) => d.data())
        .sort((a, b) => (a.at?.seconds || 0) - (b.at?.seconds || 0));
      await postTranscript({ ...ticket, status: 'closed' }, messages);
      // Aufräumen: erst Nachrichten, dann das Ticket selbst löschen → forget.
      const snap2 = await getDocs(msgsRef);
      await Promise.all(snap2.docs.map((d) => deleteDoc(d.ref)));
      await deleteDoc(doc(db, 'tickets', ticket.id));
    } catch (e) {
      alert('Schließen fehlgeschlagen: ' + e.message);
    }
  };

  const [checking, setChecking] = useState(false);
  const checkChain = async () => {
    setChecking(true);
    try {
      const tx = await checkTronPayment(PAYMENT.tronAddress, p.expectedAmount);
      if (tx) {
        await updateDoc(doc(db, 'tickets', ticket.id), {
          status: 'paid', 'payment.status': 'paid', 'payment.txHash': tx,
          'payment.confirmedBy': 'auto:tron', 'payment.confirmedAt': serverTimestamp(),
        });
      } else {
        alert('Noch kein passender USDT-Eingang gefunden.');
      }
    } catch (e) { alert('Prüfung fehlgeschlagen: ' + e.message); }
    setChecking(false);
  };

  return (
    <div className="card" style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p className="eyebrow">Ticket #{ticket.id.slice(0, 6)} · {ticket.userTag}</p>
          <h2 style={{ fontSize: 22 }}>{ticket.total?.toFixed(2)} €</h2>
        </div>
        <span className={`tag ${ticket.status === 'paid' ? 'ok' : 'warn'}`}>{ticket.status}</span>
      </div>

      <div>
        <p className="eyebrow">Positionen</p>
        {ticket.items.map((it, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--vsx-line)' }}>
            <span>{it.name}{it.runtimeLabel ? ` · ${it.runtimeLabel}` : ''}</span>
            <span className="mono">{it.price.toFixed(2)} €</span>
          </div>
        ))}
      </div>

      <div>
        <p className="eyebrow">Zahlung</p>
        <div className="mono" style={{ fontSize: 13, color: 'var(--vsx-muted)' }}>
          Methode: {p.method || '—'} · Status: {p.status || '—'}
          {p.method === 'trc20' && p.expectedAmount ? ` · erwartet: ${p.expectedAmount} USDT` : ''}
          {p.txHash ? ` · tx: ${p.txHash.slice(0, 10)}…` : ''}
        </div>
        {p.proofSent && (
          <div className="mono" style={{ fontSize: 12, color: 'var(--vsx-muted)', marginTop: 8 }}>
            Beweis-Screenshot wurde in #tickets gepostet.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {p.method === 'trc20' && ticket.status !== 'paid' && (
          <button className="btn-ghost" onClick={checkChain} disabled={checking}>
            {checking ? 'Prüfe…' : 'On-Chain prüfen'}
          </button>
        )}
        {ticket.status !== 'paid' && (
          <button className="btn-ghost" onClick={confirmPayment}>Zahlung bestätigen</button>
        )}
        <button className="btn" onClick={closeTicket}>Ticket schließen &amp; archivieren</button>
      </div>

      <p className="mono" style={{ fontSize: 12, color: 'var(--vsx-muted)' }}>
        Zum Chatten: <a href={`/ticket/${ticket.id}`}>Ticket-Ansicht öffnen ↗</a>
      </p>
    </div>
  );
}
