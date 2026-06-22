import { useEffect, useState } from 'react';
import {
  collection, query, orderBy, onSnapshot, doc, updateDoc, setDoc,
  getDocs, deleteDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../auth';
import { useCatalogue } from '../catalogue';
import { postTranscript, checkTronPayment } from '../lib';
import { PAYMENT, RUNTIMES, fmt } from '../data';

export default function Admin() {
  const { user } = useAuth();
  const [view, setView] = useState('tickets');
  return (
    <div className="shell">
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <button className={view === 'tickets' ? 'btn' : 'btn-ghost'} onClick={() => setView('tickets')}>Tickets</button>
        <button className={view === 'catalogue' ? 'btn' : 'btn-ghost'} onClick={() => setView('catalogue')}>Catalogue</button>
      </div>
      {view === 'tickets' ? <Tickets user={user} /> : <CatalogueEditor />}
    </div>
  );
}

/* ------------------------------ Tickets ------------------------------- */
function Tickets({ user }) {
  const [tickets, setTickets] = useState([]);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    const q = query(collection(db, 'tickets'), orderBy('createdAt', 'desc'));
    return onSnapshot(q, (s) => setTickets(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, []);

  const active = tickets.find((t) => t.id === selected);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 24, alignItems: 'start' }}>
      <aside className="card" style={{ position: 'sticky', top: 24 }}>
        <p className="eyebrow">Open tickets</p>
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {tickets.length === 0 && <p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>No open tickets.</p>}
          {tickets.map((t) => (
            <button key={t.id} onClick={() => setSelected(t.id)} style={{
              textAlign: 'left', background: selected === t.id ? 'var(--vsx-charcoal-3)' : 'transparent',
              border: '1px solid var(--vsx-line)', borderRadius: 8, padding: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="mono" style={{ fontSize: 12 }}>#{t.id.slice(0, 6)}</span>
                <span className={`tag ${t.status === 'paid' ? 'ok' : 'warn'}`}>{t.status === 'paid' ? 'paid' : 'open'}</span>
              </div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{t.userTag}</div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--vsx-gold)' }}>{fmt(t.total)}</div>
            </button>
          ))}
        </div>
      </aside>
      <main>
        {!active ? <div className="card"><p style={{ color: 'var(--vsx-muted)' }}>Select a ticket on the left.</p></div>
          : <AdminDetail ticket={active} modTag={user.tag} />}
      </main>
    </div>
  );
}

function AdminDetail({ ticket, modTag }) {
  const p = ticket.payment || {};
  const [checking, setChecking] = useState(false);

  const confirmPayment = () => updateDoc(doc(db, 'tickets', ticket.id), {
    status: 'paid', 'payment.status': 'paid', 'payment.confirmedBy': modTag, 'payment.confirmedAt': serverTimestamp(),
  });

  const closeTicket = async () => {
    if (!confirm('Close ticket? A transcript is sent to the archive, then the ticket is deleted.')) return;
    const msgsRef = collection(db, 'tickets', ticket.id, 'messages');
    try {
      const snap = await getDocs(msgsRef);
      const messages = snap.docs.map((d) => d.data()).sort((a, b) => (a.at?.seconds || 0) - (b.at?.seconds || 0));
      await postTranscript({ ...ticket, status: 'closed' }, messages);
      const snap2 = await getDocs(msgsRef);
      await Promise.all(snap2.docs.map((d) => deleteDoc(d.ref)));
      await deleteDoc(doc(db, 'tickets', ticket.id));
    } catch (e) { alert('Closing failed: ' + e.message); }
  };

  const checkChain = async () => {
    setChecking(true);
    try {
      const tx = await checkTronPayment(PAYMENT.tronAddress, p.expectedAmount);
      if (tx) {
        await updateDoc(doc(db, 'tickets', ticket.id), {
          status: 'paid', 'payment.status': 'paid', 'payment.txHash': tx,
          'payment.confirmedBy': 'auto:tron', 'payment.confirmedAt': serverTimestamp(),
        });
      } else { alert('No matching USDT payment found yet.'); }
    } catch (e) { alert('Check failed: ' + e.message); }
    setChecking(false);
  };

  return (
    <div className="card" style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p className="eyebrow">Ticket #{ticket.id.slice(0, 6)} · {ticket.userTag}</p>
          <h2 style={{ fontSize: 22 }}>{fmt(ticket.total)}</h2>
        </div>
        <span className={`tag ${ticket.status === 'paid' ? 'ok' : 'warn'}`}>{ticket.status}</span>
      </div>
      <div>
        <p className="eyebrow">Items</p>
        {ticket.items.map((it, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--vsx-line)' }}>
            <span>{it.name}</span><span className="mono">{fmt(it.price)}</span>
          </div>
        ))}
      </div>
      <div>
        <p className="eyebrow">Payment</p>
        <div className="mono" style={{ fontSize: 13, color: 'var(--vsx-muted)' }}>
          Method: {p.method || '—'} · Status: {p.status || '—'}
          {p.method === 'trc20' && p.expectedAmount ? ` · expected: ${p.expectedAmount} USDT` : ''}
          {p.txHash ? ` · tx: ${p.txHash.slice(0, 10)}…` : ''}
        </div>
        {p.proofSent && <div className="mono" style={{ fontSize: 12, color: 'var(--vsx-muted)', marginTop: 8 }}>Proof screenshot was posted to #tickets.</div>}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {p.method === 'trc20' && ticket.status !== 'paid' && (
          <button className="btn-ghost" onClick={checkChain} disabled={checking}>{checking ? 'Checking…' : 'Check on-chain'}</button>
        )}
        {ticket.status !== 'paid' && <button className="btn-ghost" onClick={confirmPayment}>Confirm payment</button>}
        <button className="btn" onClick={closeTicket}>Close &amp; archive ticket</button>
      </div>
      <p className="mono" style={{ fontSize: 12, color: 'var(--vsx-muted)' }}>
        To chat: <a href={`/ticket/${ticket.id}`}>open ticket view ↗</a>
      </p>
    </div>
  );
}

/* --------------------------- Catalogue editor ------------------------- */
function CatalogueEditor() {
  const live = useCatalogue();
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (!form) setForm(JSON.parse(JSON.stringify(live))); }, [live, form]);
  if (!form) return <div className="card">Loading…</div>;

  const setPkg = (i, key, val) => setForm((f) => {
    const packages = f.packages.map((p, idx) => idx === i ? { ...p, [key]: val } : p);
    return { ...f, packages };
  });
  const setPkgPrice = (i, rk, val) => setForm((f) => {
    const packages = f.packages.map((p, idx) => idx === i
      ? { ...p, prices: { ...p.prices, [rk]: val === '' ? null : Number(val) } } : p);
    return { ...f, packages };
  });
  const setSvc = (i, key, val) => setForm((f) => {
    const services = f.services.map((s, idx) => idx === i ? { ...s, [key]: key === 'price' ? Number(val) : val } : s);
    return { ...f, services };
  });

  const save = async () => {
    await setDoc(doc(db, 'config', 'catalogue'), form);
    setSaved(true); setTimeout(() => setSaved(false), 2500);
  };

  const inp = { marginTop: 4 };
  const lbl = { fontSize: 11, color: 'var(--vsx-muted)', display: 'block' };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p className="eyebrow">Catalogue</p>
          <h2 style={{ fontSize: 24 }}>Edit prices & texts</h2>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {saved && <span className="tag ok">Saved</span>}
          <button className="btn" onClick={save}>Save changes</button>
        </div>
      </div>

      <p className="eyebrow">Packages</p>
      {form.packages.map((p, i) => (
        <div key={p.id} className="card" style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="mono" style={{ color: 'var(--vsx-gold)' }}>{p.id}</span>
            <label style={{ fontSize: 12, color: 'var(--vsx-muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={!!p.tracker} onChange={(e) => setPkg(i, 'tracker', e.target.checked)} /> Tracker available
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><label style={lbl}>Name</label><input style={inp} value={p.name} onChange={(e) => setPkg(i, 'name', e.target.value)} /></div>
            <div><label style={lbl}>Discord role ID (ownership)</label><input style={inp} value={p.roleId || ''} onChange={(e) => setPkg(i, 'roleId', e.target.value)} placeholder="leave empty if none" /></div>
          </div>
          <div><label style={lbl}>Description</label><input style={inp} value={p.desc} onChange={(e) => setPkg(i, 'desc', e.target.value)} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {RUNTIMES.map((r) => (
              <div key={r.key}>
                <label style={lbl}>{r.label} ($)</label>
                <input style={inp} type="number" value={p.prices[r.key] ?? ''} placeholder="—"
                  onChange={(e) => setPkgPrice(i, r.key, e.target.value)} />
              </div>
            ))}
          </div>
        </div>
      ))}

      <p className="eyebrow" style={{ marginTop: 10 }}>Tracker pricing ($/month)</p>
      <div className="card" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div><label style={lbl}>Per package</label>
          <input style={inp} type="number" value={form.tracker.perPackage}
            onChange={(e) => setForm((f) => ({ ...f, tracker: { ...f.tracker, perPackage: Number(e.target.value) } }))} /></div>
        <div><label style={lbl}>Premium+ (all)</label>
          <input style={inp} type="number" value={form.tracker.premiumPlus}
            onChange={(e) => setForm((f) => ({ ...f, tracker: { ...f.tracker, premiumPlus: Number(e.target.value) } }))} /></div>
      </div>

      <p className="eyebrow" style={{ marginTop: 10 }}>Services</p>
      {form.services.map((s, i) => (
        <div key={s.id} className="card" style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr', gap: 10, alignItems: 'end' }}>
          <div><label style={lbl}>Name</label><input style={inp} value={s.name} onChange={(e) => setSvc(i, 'name', e.target.value)} /></div>
          <div><label style={lbl}>Description</label><input style={inp} value={s.desc} onChange={(e) => setSvc(i, 'desc', e.target.value)} /></div>
          <div><label style={lbl}>Price ($)</label><input style={inp} type="number" value={s.price} onChange={(e) => setSvc(i, 'price', e.target.value)} /></div>
          <div><label style={lbl}>Unit</label><input style={inp} value={s.unit || ''} placeholder="/hr" onChange={(e) => setSvc(i, 'unit', e.target.value)} /></div>
        </div>
      ))}

      <p className="eyebrow" style={{ marginTop: 10 }}>Included free (one per line)</p>
      <div className="card">
        <textarea rows={3} value={form.freebies.join('\n')}
          onChange={(e) => setForm((f) => ({ ...f, freebies: e.target.value.split('\n').filter((x) => x.trim()) }))} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        {saved && <span className="tag ok">Saved</span>}
        <button className="btn" onClick={save}>Save changes</button>
      </div>
    </div>
  );
}
