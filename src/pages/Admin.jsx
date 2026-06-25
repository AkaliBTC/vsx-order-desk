import { useEffect, useState } from 'react';
import {
  collection, query, orderBy, onSnapshot, doc, getDoc, updateDoc, setDoc,
  getDocs, deleteDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useAuth } from '../auth';
import { postTranscript, checkTronPayment } from '../lib';
import { Chat } from './Ticket';
import { PAYMENT, RUNTIMES, fmt, DEFAULT_CATALOGUE } from '../data';

// Resolve a set of Discord user IDs to live display names via the bot (mod endpoint).
function useResolvedNames(ids) {
  const [map, setMap] = useState({});
  const key = [...new Set((ids || []).filter(Boolean))].sort().join(',');
  useEffect(() => {
    const need = key ? key.split(',') : [];
    if (!need.length) return;
    (async () => {
      try {
        const idToken = await auth.currentUser.getIdToken();
        const r = await fetch('/api/resolve-names', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ ids: need }),
        });
        const d = await r.json();
        if (r.ok && d.names) setMap((p) => ({ ...p, ...d.names }));
      } catch (_) {}
    })();
  }, [key]);
  return map;
}

// Build a userId -> display tag map from tickets + referral owner tags.
function useUserNames() {
  const [names, setNames] = useState({});
  useEffect(() => {
    const unsubs = [];
    unsubs.push(onSnapshot(collection(db, 'tickets'), (s) => {
      setNames((prev) => {
        const next = { ...prev };
        s.docs.forEach((d) => { const t = d.data(); if (t.userId && t.userTag) next[t.userId] = t.userTag; });
        return next;
      });
    }, () => {}));
    unsubs.push(onSnapshot(collection(db, 'referrals'), (s) => {
      setNames((prev) => {
        const next = { ...prev };
        s.docs.forEach((d) => { const r = d.data(); if (r.ownerId && r.ownerTag) next[r.ownerId] = r.ownerTag; });
        return next;
      });
    }, () => {}));
    return () => unsubs.forEach((u) => u && u());
  }, []);
  return names;
}

// Readable one-time voucher code, e.g. VSX-7K3M-9QF2 (no ambiguous chars).
function genVoucherCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  return `VSX-${block()}-${block()}`;
}

export default function Admin() {
  const { user } = useAuth();
  const [view, setView] = useState('tickets');
  return (
    <div className="shell">
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className={view === 'tickets' ? 'btn' : 'btn-ghost'} onClick={() => setView('tickets')}>Tickets</button>
        <button className={view === 'catalogue' ? 'btn' : 'btn-ghost'} onClick={() => setView('catalogue')}>Catalogue</button>
        <button className={view === 'discounts' ? 'btn' : 'btn-ghost'} onClick={() => setView('discounts')}>Discounts</button>
        <button className={view === 'vouchers' ? 'btn' : 'btn-ghost'} onClick={() => setView('vouchers')}>Vouchers</button>
        <button className={view === 'subs' ? 'btn' : 'btn-ghost'} onClick={() => setView('subs')}>Subscriptions</button>
        <button className={view === 'referrals' ? 'btn' : 'btn-ghost'} onClick={() => setView('referrals')}>Referrals</button>
      </div>
      {view === 'tickets' && <Tickets user={user} />}
      {view === 'catalogue' && <CatalogueEditor />}
      {view === 'discounts' && <DiscountsEditor />}
      {view === 'vouchers' && <VouchersManager />}
      {view === 'subs' && <SubscriptionsManager />}
      {view === 'referrals' && <ReferralsManager />}
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
    <div className="cols-admin">
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
          : <AdminDetail ticket={active} modTag={user.tag} user={user} />}
      </main>
    </div>
  );
}

function AdminDetail({ ticket, modTag, user }) {
  const p = ticket.payment || {};
  const [checking, setChecking] = useState(false);

  const grantRoles = async (vouchers = []) => {
    try {
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/grant-role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          ticketId: ticket.id,
          userId: ticket.userId,
          userTag: ticket.userTag,
          grants: ticket.grants || [],
          services: ticket.services || [],
          vouchers,
          referralCode: ticket.referralCode || '',
          balanceUsed: Number(ticket.balanceUsed) || 0,
        }),
      });
      const d = await r.json();
      if (!r.ok) { alert('Fulfillment failed: ' + (d.error || r.status)); return; }
      const lines = [];
      if (d.granted?.length) lines.push('Roles granted: ' + d.granted.join(', '));
      if (d.expiries?.length) lines.push('⏳ Auto-expires: ' + d.expiries.join(' · '));
      if (d.expiryWarning) lines.push('⚠ Roles are PERMANENT — expiry not saved (' + d.expiryWarning + ')');
      if (d.channels?.length) lines.push('Ticket channels: ' + d.channels.join(', '));
      if (vouchers.length) lines.push('Voucher codes: ' + vouchers.map((v) => v.code).join(', '));
      if (d.voucherDmFailed) lines.push('⚠ Could not DM the voucher (buyer may have DMs closed) — codes: ' + vouchers.map((v) => v.code).join(', '));
      if (d.referral?.rewarded) lines.push(`Referral: owner credited ${fmt(d.referral.credit || 5)} (use #${d.referral.uses})`);
      if (d.balanceDeducted > 0) lines.push(`Balance used: ${fmt(d.balanceDeducted)}`);
      if (d.failed?.length) lines.push('Roles failed: ' + d.failed.join(', '));
      if (d.channelErrors?.length) lines.push('Channels failed: ' + d.channelErrors.join(', '));
      if (lines.length) alert(lines.join('\n'));
    } catch (e) { alert('Fulfillment failed: ' + e.message); }
  };

  // Generate & persist purchased gift vouchers, mark a redeemed voucher used,
  // then run the Discord fulfillment (roles, channels, voucher DM).
  const fulfil = async () => {
    const vouchers = [];
    for (const amount of (ticket.voucherPurchases || [])) {
      const code = genVoucherCode();
      const expiresAt = Timestamp.fromMillis(Date.now() + 365 * 24 * 3600 * 1000);
      try {
        await setDoc(doc(db, 'vouchers', code), {
          amount: Number(amount), expiresAt, used: false,
          buyerId: ticket.userId, ticketId: ticket.id, createdAt: serverTimestamp(),
        });
        vouchers.push({ code, amount: Number(amount) });
      } catch (e) { alert('Could not create voucher: ' + e.message); }
    }
    if (ticket.redeemedVoucher) {
      try {
        await setDoc(doc(db, 'vouchers', ticket.redeemedVoucher),
          { used: true, usedAt: serverTimestamp(), usedTicket: ticket.id }, { merge: true });
      } catch (e) { /* non-fatal */ }
    }
    await grantRoles(vouchers);
  };

  const confirmPayment = async () => {
    await updateDoc(doc(db, 'tickets', ticket.id), {
      status: 'paid', 'payment.status': 'paid', 'payment.confirmedBy': modTag, 'payment.confirmedAt': serverTimestamp(),
    });
    await fulfil();
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

  const deleteTicket = async () => {
    if (!confirm('Delete ticket permanently? No transcript is saved — this cannot be undone.')) return;
    const msgsRef = collection(db, 'tickets', ticket.id, 'messages');
    try {
      const snap = await getDocs(msgsRef);
      await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
      await deleteDoc(doc(db, 'tickets', ticket.id));
    } catch (e) { alert('Delete failed: ' + e.message); }
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
        await fulfil();
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
        {p.markedPaidAt && <div className="mono" style={{ fontSize: 12, color: 'var(--vsx-ok)', marginTop: 8 }}>Customer reported payment.</div>}
        {p.alertError && <div className="mono" style={{ fontSize: 12, color: 'var(--vsx-err)', marginTop: 8 }}>⚠ Staff @here alert failed: {p.alertError}</div>}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {p.method === 'trc20' && ticket.status !== 'paid' && (
          <button className="btn-ghost" onClick={checkChain} disabled={checking}>{checking ? 'Checking…' : 'Check on-chain'}</button>
        )}
        {ticket.status !== 'paid' && <button className="btn-ghost" onClick={confirmPayment}>Confirm payment</button>}
        <button className="btn" onClick={closeTicket}>Close &amp; archive ticket</button>
        <button className="btn-ghost" onClick={deleteTicket} style={{ color: 'var(--vsx-err)', borderColor: '#5b2e26' }}>Delete (no archive)</button>
      </div>
      <div>
        <p className="eyebrow" style={{ marginBottom: 10 }}>Chat with customer</p>
        <Chat ticket={ticket} user={user} />
      </div>
    </div>
  );
}

/* --------------------------- Catalogue editor ------------------------- */
function CatalogueEditor() {
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [loadErr, setLoadErr] = useState('');

  // Read the SAVED catalogue once. Important: never seed the form from the
  // in-memory default before the real document has loaded, otherwise saving
  // would overwrite your stored prices/role IDs with blanks.
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'config', 'catalogue'));
        const data = snap.exists() ? snap.data() : {};
        setForm({ ...JSON.parse(JSON.stringify(DEFAULT_CATALOGUE)), ...data });
      } catch (e) {
        setLoadErr(e.message || 'Could not load catalogue');
      }
    })();
  }, []);

  if (loadErr) return <div className="card" style={{ color: 'var(--vsx-err)' }}>Load failed: {loadErr}</div>;
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
  const removePkg = (i) => setForm((f) => ({ ...f, packages: f.packages.filter((_, idx) => idx !== i) }));

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
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: 'var(--vsx-muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={!!p.tracker} onChange={(e) => setPkg(i, 'tracker', e.target.checked)} /> Tracker available
              </label>
              <button onClick={() => removePkg(i)} style={{ background: 'none', color: 'var(--vsx-err)', fontSize: 12, padding: 0 }}>remove package</button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><label style={lbl}>Name</label><input style={inp} value={p.name} onChange={(e) => setPkg(i, 'name', e.target.value)} /></div>
            <div><label style={lbl}>Description</label><input style={inp} value={p.desc} onChange={(e) => setPkg(i, 'desc', e.target.value)} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><label style={lbl}>Discord role ID — ownership</label><input style={inp} value={p.roleId || ''} onChange={(e) => setPkg(i, 'roleId', e.target.value)} placeholder="role granted on purchase" /></div>
            <div><label style={lbl}>Discord role ID — Portfolio Tracker</label><input style={inp} value={p.ptRoleId || ''} onChange={(e) => setPkg(i, 'ptRoleId', e.target.value)} placeholder="PT role for this package" /></div>
          </div>
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
      <div className="card">
        <label style={lbl}>Premium+ Discord role ID (Portfolio Tracker for all packages)</label>
        <input style={inp} value={form.premiumPlusRoleId || ''} placeholder="PT-all role"
          onChange={(e) => setForm((f) => ({ ...f, premiumPlusRoleId: e.target.value }))} />
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
  const CATS = [['analysis', 'Analysis'], ['tracker', 'Tracker'], ['deepdive', 'Deep Dive'], ['coaching', 'Coaching']];
  const [codes, setCodes] = useState([]);
  const [code, setCode] = useState('');
  const [percent, setPercent] = useState(10);
  const [expiry, setExpiry] = useState('');
  const [scope, setScope] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => onSnapshot(collection(db, 'discounts'),
    (s) => setCodes(s.docs.map((d) => ({ id: d.id, ...d.data() })))), []);

  const toggle = (k) => setScope((sc) => sc.includes(k) ? sc.filter((x) => x !== k) : [...sc, k]);

  const addCode = async () => {
    const id = code.trim().toUpperCase();
    setErr('');
    if (!id) { setErr('Enter a code.'); return; }
    if (!(percent > 0 && percent <= 100)) { setErr('Percent must be 1–100.'); return; }
    try {
      await setDoc(doc(db, 'discounts', id), {
        percent: Number(percent),
        scope, // empty = applies to everything (except gift-voucher purchases)
        expiresAt: expiry ? Timestamp.fromDate(new Date(expiry + 'T23:59:59')) : null,
        active: true,
        createdAt: serverTimestamp(),
      });
      setCode(''); setPercent(10); setExpiry(''); setScope([]);
    } catch (e) { setErr(e.message); }
  };

  const inp = { marginTop: 4 };
  const lbl = { fontSize: 11, color: 'var(--vsx-muted)', display: 'block' };
  const catLabel = (k) => (CATS.find((c) => c[0] === k) || [k, k])[1];

  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 720 }}>
      <div>
        <p className="eyebrow">Discounts</p>
        <h2 style={{ fontSize: 24 }}>Discount codes</h2>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 13 }}>
          Codes apply a percentage off at checkout. Pick which products a code applies to —
          leave all unchecked to apply it to the whole cart. Leave the date empty for no expiry.
        </p>
      </div>

      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr auto', gap: 12, alignItems: 'end' }}>
          <div><label style={lbl}>Code</label><input style={{ ...inp, textTransform: 'uppercase' }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="WELCOME10" /></div>
          <div><label style={lbl}>Percent (%)</label><input style={inp} type="number" value={percent} onChange={(e) => setPercent(e.target.value)} /></div>
          <div><label style={lbl}>Expires (optional)</label><input style={inp} type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
          <button className="btn" onClick={addCode}>Add</button>
        </div>
        <div>
          <label style={lbl}>Applies to (none = whole cart)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 6 }}>
            {CATS.map(([k, label]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 16 }} checked={scope.includes(k)} onChange={() => toggle(k)} /> {label}
              </label>
            ))}
          </div>
        </div>
      </div>
      {err && <p style={{ color: 'var(--vsx-err)', fontSize: 13 }}>{err}</p>}

      <div className="card">
        <p className="eyebrow" style={{ marginBottom: 10 }}>Active codes</p>
        {codes.length === 0 && <p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>No codes yet.</p>}
        {codes.map((c) => {
          const exp = c.expiresAt ? new Date(c.expiresAt.toMillis()) : null;
          const expired = exp && exp.getTime() < Date.now();
          const sc = Array.isArray(c.scope) && c.scope.length ? c.scope.map(catLabel).join(', ') : 'Whole cart';
          return (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--vsx-line)' }}>
              <div>
                <span className="mono" style={{ color: 'var(--vsx-gold)' }}>{c.id}</span>
                <span className="mono" style={{ color: 'var(--vsx-muted)', fontSize: 12, marginLeft: 10 }}>
                  −{c.percent}% · {sc} · {exp ? `until ${exp.toLocaleDateString()}` : 'no expiry'}{expired ? ' · EXPIRED' : ''}
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

// ---------- Gift voucher management ----------
function VouchersManager() {
  const [list, setList] = useState([]);
  const names = useUserNames();
  const nameOf = (id) => names[id] || id;
  const [gAmount, setGAmount] = useState(25);
  const [gExpiry, setGExpiry] = useState('');
  const [gCode, setGCode] = useState('');
  const [gErr, setGErr] = useState('');
  useEffect(() => onSnapshot(collection(db, 'vouchers'),
    (s) => setList(s.docs.map((d) => ({ code: d.id, ...d.data() })))), []);

  const generate = async () => {
    setGErr(''); setGCode('');
    const amt = Number(gAmount);
    if (!(amt > 0)) { setGErr('Enter a $ amount above 0.'); return; }
    try {
      let code = '';
      for (let i = 0; i < 6; i++) { const c = genVoucherCode(); const sn = await getDoc(doc(db, 'vouchers', c)); if (!sn.exists()) { code = c; break; } }
      if (!code) { setGErr('Could not allocate a code, try again.'); return; }
      await setDoc(doc(db, 'vouchers', code), {
        amount: amt, used: false, source: 'giveaway',
        expiresAt: gExpiry ? Timestamp.fromDate(new Date(gExpiry + 'T23:59:59')) : null,
        createdAt: serverTimestamp(),
      });
      setGCode(code);
    } catch (e) { setGErr(e.message); }
  };

  const deactivate = async (code) => {
    if (!confirm(`Deactivate voucher ${code}? It can no longer be redeemed.`)) return;
    try { await setDoc(doc(db, 'vouchers', code), { used: true, usedAt: serverTimestamp() }, { merge: true }); }
    catch (e) { alert('Failed: ' + e.message); }
  };
  const remove = async (code) => {
    if (!confirm(`Delete voucher ${code} permanently?`)) return;
    try { await deleteDoc(doc(db, 'vouchers', code)); } catch (e) { alert('Failed: ' + e.message); }
  };

  const inp = { marginTop: 4 };
  const lbl = { fontSize: 11, color: 'var(--vsx-muted)', display: 'block' };
  const sorted = [...list].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  const valueOf = (v) => v.percent ? `${v.percent}%` : fmt(Number(v.amount) || 0);
  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 760 }}>
      <div>
        <p className="eyebrow">Vouchers</p>
        <h2 style={{ fontSize: 24 }}>Gift vouchers</h2>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 13 }}>Generate a code for a giveaway, or manage every voucher ever issued. Deactivate blocks redemption; delete removes it entirely.</p>
      </div>

      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <p className="eyebrow" style={{ marginBottom: 2 }}>Generate giveaway code</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr auto', gap: 12, alignItems: 'end' }}>
          <div><label style={lbl}>Value ($)</label><input style={inp} type="number" value={gAmount} onChange={(e) => setGAmount(e.target.value)} /></div>
          <div><label style={lbl}>Expires (optional)</label><input style={inp} type="date" value={gExpiry} onChange={(e) => setGExpiry(e.target.value)} /></div>
          <button className="btn" onClick={generate}>Generate</button>
        </div>
        {gErr && <p style={{ color: 'var(--vsx-err)', fontSize: 13 }}>{gErr}</p>}
        {gCode && (
          <div style={{ background: 'rgba(212,175,55,.1)', border: '1px solid var(--vsx-gold)', borderRadius: 10, padding: '10px 14px' }}>
            New giveaway code: <span className="mono" style={{ color: 'var(--vsx-gold)', fontSize: 16, fontWeight: 600 }}>{gCode}</span>
            <span style={{ fontSize: 12, color: 'var(--vsx-muted)', marginLeft: 10 }}>single use · {fmt(Number(gAmount))}</span>
          </div>
        )}
      </div>

      <div className="card">
        <p className="eyebrow" style={{ marginBottom: 10 }}>All vouchers</p>
        {sorted.length === 0 && <p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>No vouchers issued yet.</p>}
        {sorted.map((v) => {
          const exp = v.expiresAt ? new Date(v.expiresAt.toMillis()) : null;
          const expired = exp && exp.getTime() < Date.now();
          const status = v.used ? 'USED / OFF' : expired ? 'EXPIRED' : 'ACTIVE';
          const color = v.used || expired ? 'var(--vsx-muted)' : 'var(--vsx-ok)';
          const origin = v.source === 'referral' ? 'referral 5%' : v.source === 'referral-milestone' ? 'referral $25' : v.source === 'giveaway' ? 'giveaway' : (v.buyerId ? `buyer ${nameOf(v.buyerId)}` : 'gift purchase');
          return (
            <div key={v.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--vsx-line)' }}>
              <div style={{ minWidth: 0 }}>
                <span className="mono" style={{ color: 'var(--vsx-gold)' }}>{v.code}</span>
                <span className="mono" style={{ fontSize: 12, marginLeft: 10 }}>{valueOf(v)}</span>
                <span className="mono" style={{ fontSize: 12, marginLeft: 10, color }}>{status}</span>
                <div className="mono" style={{ fontSize: 11, color: 'var(--vsx-muted)', marginTop: 2 }}>
                  {origin}{exp ? ` · until ${exp.toLocaleDateString()}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
                {!v.used && <button onClick={() => deactivate(v.code)} style={{ background: 'none', color: 'var(--vsx-muted)', fontSize: 12, padding: 0 }}>deactivate</button>}
                <button onClick={() => remove(v.code)} style={{ background: 'none', color: 'var(--vsx-err)', fontSize: 12, padding: 0 }}>delete</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Subscription (role) management ----------
function SubscriptionsManager() {
  const [ents, setEnts] = useState([]);
  const [cat, setCat] = useState(DEFAULT_CATALOGUE);
  const [uid, setUid] = useState('');
  const [roleIdx, setRoleIdx] = useState('0');
  const [rtKey, setRtKey] = useState('1M');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const names = useUserNames();
  const resolved = useResolvedNames(ents.map((e) => e.userId));
  const nameOf = (id) => resolved[id] || names[id] || id;

  useEffect(() => onSnapshot(collection(db, 'entitlements'),
    (s) => setEnts(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => setMsg('Cannot read subscriptions: ' + e.code)), []);
  useEffect(() => { (async () => {
    try { const sn = await getDoc(doc(db, 'config', 'catalogue')); if (sn.exists()) setCat(sn.data()); } catch (_) {}
  })(); }, []);

  const roleOptions = [];
  (cat.packages || []).forEach((p) => {
    if (p.roleId) roleOptions.push({ label: p.name, roleId: p.roleId });
    if (p.ptRoleId) roleOptions.push({ label: `${p.name} · Tracker`, roleId: p.ptRoleId });
  });
  if (cat.premiumPlusRoleId) roleOptions.push({ label: 'Premium+ · Tracker', roleId: cat.premiumPlusRoleId });
  if (cat.loyaltyRoleId) roleOptions.push({ label: 'Loyalty', roleId: cat.loyaltyRoleId });

  const call = async (payload) => {
    const idToken = await auth.currentUser.getIdToken();
    const r = await fetch('/api/manage-sub', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  };

  const add = async () => {
    setMsg('');
    const userId = uid.trim();
    const opt = roleOptions[Number(roleIdx)];
    if (!userId) { setMsg('Enter a Discord user ID.'); return; }
    if (!opt) { setMsg('Pick a role.'); return; }
    const months = (RUNTIMES.find((r) => r.key === rtKey) || { months: 1 }).months;
    setBusy(true);
    try {
      await call({ action: 'add', userId, roleId: opt.roleId, label: opt.label, months });
      setUid(''); setMsg(`✓ Granted ${opt.label} to ${userId} for ${months} month(s).`);
    } catch (e) { setMsg('Failed: ' + e.message); }
    setBusy(false);
  };

  const remove = async (e) => {
    setMsg('');
    setBusy(true);
    try { await call({ action: 'remove', id: e.id, userId: e.userId, roleId: e.roleId }); setMsg('✓ Removed.'); }
    catch (err) { setMsg('Failed: ' + err.message); }
    setBusy(false);
  };

  const inp = { marginTop: 4 };
  const lbl = { fontSize: 11, color: 'var(--vsx-muted)', display: 'block' };
  const term = q.trim().toLowerCase();
  const sorted = [...ents].filter((e) => e.expiresAt)
    .filter((e) => !term || nameOf(e.userId).toLowerCase().includes(term) || (e.userId || '').includes(term) || (e.label || '').toLowerCase().includes(term))
    .sort((a, b) => a.expiresAt.toMillis() - b.expiresAt.toMillis());

  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 820 }}>
      <div>
        <p className="eyebrow">Subscriptions</p>
        <h2 style={{ fontSize: 24 }}>Active subscriptions</h2>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 13 }}>Grant or remove a role + its expiry manually. Removing takes the Discord role away immediately.</p>
      </div>

      <div className="card" style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.4fr 1fr auto', gap: 12, alignItems: 'end' }}>
        <div><label style={lbl}>Discord user ID</label><input style={inp} value={uid} onChange={(e) => setUid(e.target.value)} placeholder="123456789012345678" /></div>
        <div><label style={lbl}>Role</label>
          <select style={inp} value={roleIdx} onChange={(e) => setRoleIdx(e.target.value)}>
            {roleOptions.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
          </select>
        </div>
        <div><label style={lbl}>Duration</label>
          <select style={inp} value={rtKey} onChange={(e) => setRtKey(e.target.value)}>
            {RUNTIMES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </div>
        <button className="btn" disabled={busy} onClick={add}>Grant</button>
      </div>
      {msg && <p style={{ fontSize: 13, color: msg.startsWith('✓') ? 'var(--vsx-ok)' : 'var(--vsx-err)' }}>{msg}</p>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
          <p className="eyebrow" style={{ margin: 0 }}>Currently active ({sorted.length})</p>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name…" style={{ width: 'auto', minWidth: 180 }} />
        </div>
        {sorted.length === 0 && <p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>No active subscriptions.</p>}
        {sorted.map((e) => {
          const ms = e.expiresAt.toMillis() - Date.now();
          const days = Math.max(0, Math.floor(ms / (24 * 3600 * 1000)));
          const date = new Date(e.expiresAt.toMillis()).toLocaleDateString();
          return (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--vsx-line)' }}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>{e.label || 'Role'}</span>
                <span className="mono" style={{ fontSize: 12, marginLeft: 10, color: 'var(--vsx-gold)' }}>{days}d left</span>
                <div className="mono" style={{ fontSize: 11, color: 'var(--vsx-muted)', marginTop: 2 }}>{nameOf(e.userId)} · until {date}</div>
              </div>
              <button onClick={() => remove(e)} disabled={busy} style={{ background: 'none', color: 'var(--vsx-err)', fontSize: 12, padding: 0 }}>remove</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Referral overview (who referred how many) ----------
function ReferralsManager() {
  const [list, setList] = useState([]);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => onSnapshot(collection(db, 'referrals'),
    (s) => setList(s.docs.map((d) => ({ code: d.id, ...d.data() }))),
    (e) => setErr('Cannot read referrals: ' + e.code)), []);

  const resolved = useResolvedNames(list.map((r) => r.ownerId));
  const tagById = {}; list.forEach((r) => { if (r.ownerTag) tagById[r.ownerId] = r.ownerTag; });
  const nameOf = (id) => resolved[id] || tagById[id] || id;

  const term = q.trim().toLowerCase();
  const sorted = [...list]
    .filter((r) => !term || nameOf(r.ownerId).toLowerCase().includes(term) || (r.ownerId || '').includes(term) || r.code.toLowerCase().includes(term))
    .sort((a, b) => (b.uses || 0) - (a.uses || 0));
  const total = list.reduce((s, r) => s + (r.uses || 0), 0);
  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 760 }}>
      <div>
        <p className="eyebrow">Referrals</p>
        <h2 style={{ fontSize: 24 }}>Referral usage</h2>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 13 }}>
          Every customer has one referral code. This shows how often each was used —
          {' '}{total} successful referral{total === 1 ? '' : 's'} so far.
        </p>
      </div>
      {err && <p style={{ color: 'var(--vsx-err)', fontSize: 13 }}>{err}</p>}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name…" style={{ width: 'auto', minWidth: 180 }} />
        </div>
        {sorted.length === 0 && <p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>No referral codes yet.</p>}
        {sorted.map((r) => (
          <div key={r.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--vsx-line)' }}>
            <div style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 500 }}>{nameOf(r.ownerId)}</span>
              <div className="mono" style={{ fontSize: 11, color: 'var(--vsx-gold)', marginTop: 2 }}>{r.code}</div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--vsx-gold)' }}>{r.uses || 0}</div>
              <div style={{ fontSize: 10, color: 'var(--vsx-muted)' }}>uses · {fmt((r.uses || 0) * 5)} earned</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
