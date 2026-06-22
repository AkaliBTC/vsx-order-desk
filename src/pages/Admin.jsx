import { useEffect, useState } from 'react';
import {
  collection, query, orderBy, onSnapshot, doc, updateDoc, setDoc,
  getDocs, deleteDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { db, auth } from '../firebase';
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
        <button className={view === 'discounts' ? 'btn' : 'btn-ghost'} onClick={() => setView('discounts')}>Discounts</button>
      </div>
      {view === 'tickets' && <Tickets user={user} />}
      {view === 'catalogue' && <CatalogueEditor />}
      {view === 'discounts' && <DiscountsEditor />}
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

  const grantRoles = async () => {
    try {
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/grant-role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ ticketId: ticket.id }),
      });
      const data = await r.json();
      if (!r.ok) { alert('Role grant failed: ' + (data.error || r.status)); return; }
      if ((data.failed || []).length) alert('Some roles failed: ' + data.failed.join(', '));
    } catch (e) { alert('Role grant failed: ' + e.message); }
  };

  const confirmPayment = async () => {
    await updateDoc(doc(db, 'tickets', ticket.id), {
      status: 'paid', 'payment.status': 'paid', 'payment.confirmedBy': modTag, 'payment.confirmedAt': serverTimestamp(),
    });
    await grantRoles();
  };

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
        await grantRoles();
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
  const [saveErr, setSaveErr] = useState('');

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
    setSaveErr('');
    try {
      await setDoc(doc(db, 'config', 'catalogue'), form);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setSaveErr(e.message || 'Save failed (check Firestore rules).');
    }
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
      {saveErr && (
        <div style={{ background: 'rgba(192,83,63,.12)', border: '1px solid #5b2e26', borderRadius: 10, padding: '10px 14px', color: '#e7a08f', fontSize: 13 }}>
          <b>Save failed:</b> <span className="mono">{saveErr}</span>
        </div>
      )}

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

      <p className="eyebrow" style={{ marginTop: 10 }}>Loyalty</p>
      <div className="card">
        <label style={lbl}>Loyalty Discord role ID (10% off analysis packages)</label>
        <input style={inp} value={form.loyaltyRoleId || ''} placeholder="leave empty to disable"
          onChange={(e) => setForm((f) => ({ ...f, loyaltyRoleId: e.target.value }))} />
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

/* --------------------------- Discounts editor ------------------------- */
function DiscountsEditor() {
  const [codes, setCodes] = useState([]);
  const [code, setCode] = useState('');
  const [percent, setPercent] = useState(10);
  const [expiry, setExpiry] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => onSnapshot(collection(db, 'discounts'),
    (s) => setCodes(s.docs.map((d) => ({ id: d.id, ...d.data() })))), []);

  const addCode = async () => {
    const id = code.trim().toUpperCase();
    setErr('');
    if (!id) { setErr('Enter a code.'); return; }
    if (!(percent > 0 && percent <= 100)) { setErr('Percent must be 1–100.'); return; }
    try {
      await setDoc(doc(db, 'discounts', id), {
        percent: Number(percent),
        expiresAt: expiry ? Timestamp.fromDate(new Date(expiry + 'T23:59:59')) : null,
        active: true,
        createdAt: serverTimestamp(),
      });
      setCode(''); setPercent(10); setExpiry('');
    } catch (e) { setErr(e.message); }
  };

  const inp = { marginTop: 4 };
  const lbl = { fontSize: 11, color: 'var(--vsx-muted)', display: 'block' };

  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 720 }}>
      <div>
        <p className="eyebrow">Discounts</p>
        <h2 style={{ fontSize: 24 }}>Discount codes</h2>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 13 }}>
          Codes apply a percentage off the whole cart at checkout. Leave the date empty for no expiry.
        </p>
      </div>

      <div className="card" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr auto', gap: 12, alignItems: 'end' }}>
        <div><label style={lbl}>Code</label><input style={{ ...inp, textTransform: 'uppercase' }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="WELCOME10" /></div>
        <div><label style={lbl}>Percent (%)</label><input style={inp} type="number" value={percent} onChange={(e) => setPercent(e.target.value)} /></div>
        <div><label style={lbl}>Expires (optional)</label><input style={inp} type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
        <button className="btn" onClick={addCode}>Add</button>
      </div>
      {err && <p style={{ color: 'var(--vsx-err)', fontSize: 13 }}>{err}</p>}

      <div className="card">
        <p className="eyebrow" style={{ marginBottom: 10 }}>Active codes</p>
        {codes.length === 0 && <p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>No codes yet.</p>}
        {codes.map((c) => {
          const exp = c.expiresAt ? new Date(c.expiresAt.toMillis()) : null;
          const expired = exp && exp.getTime() < Date.now();
          return (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--vsx-line)' }}>
              <div>
                <span className="mono" style={{ color: 'var(--vsx-gold)' }}>{c.id}</span>
                <span className="mono" style={{ color: 'var(--vsx-muted)', fontSize: 12, marginLeft: 10 }}>
                  −{c.percent}% · {exp ? `until ${exp.toLocaleDateString()}` : 'no expiry'}{expired ? ' · EXPIRED' : ''}
                </span>
              </div>
              <button onClick={() => deleteDoc(doc(db, 'discounts', c.id))} style={{ background: 'none', color: 'var(--vsx-muted)', fontSize: 12, padding: 0 }}>delete</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
