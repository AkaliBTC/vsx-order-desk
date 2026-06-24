import { useEffect, useState } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useAuth } from '../auth';
import { fmt } from '../data';

export default function Dashboard() {
  const { user } = useAuth();
  const [tx, setTx] = useState(null);
  const [ref, setRef] = useState(null);
  const [refErr, setRefErr] = useState('');
  const [copied, setCopied] = useState(false);

  // Past successful transactions (own paid tickets). Single-field query → no index needed.
  useEffect(() => {
    if (!user?.uid) return;
    const q = query(collection(db, 'tickets'), where('userId', '==', user.uid));
    return onSnapshot(q, (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setTx(all.filter((t) => t.status === 'paid')
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
    }, () => setTx([]));
  }, [user?.uid]);

  // Referral code (created on first load).
  useEffect(() => {
    (async () => {
      try {
        const idToken = await auth.currentUser.getIdToken();
        const r = await fetch('/api/referral', { method: 'POST', headers: { Authorization: `Bearer ${idToken}` } });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'failed');
        setRef(d);
      } catch (e) { setRefErr('Could not load your referral code.'); }
    })();
  }, []);

  const copy = async () => {
    try { await navigator.clipboard.writeText(ref.code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (_) {}
  };

  const toNext = ref ? (10 - (ref.uses % 10)) : 0;

  return (
    <div className="shell" style={{ display: 'grid', gap: 22, maxWidth: 820 }}>
      <div>
        <p className="eyebrow">Dashboard</p>
        <h1 style={{ fontSize: 30, margin: '4px 0' }}>Hi {user.tag || 'there'} <span style={{ color: 'var(--vsx-gold)' }}>🤍</span></h1>
      </div>

      {/* Referral card */}
      <div className="card" style={{ display: 'grid', gap: 12, border: '1px solid var(--vsx-gold)' }}>
        <p className="eyebrow" style={{ margin: 0 }}>Your referral code</p>
        {refErr && <p style={{ color: 'var(--vsx-err)', fontSize: 13 }}>{refErr}</p>}
        {!ref && !refErr && <p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>Loading…</p>}
        {ref && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <span className="mono" style={{ color: 'var(--vsx-gold)', fontSize: 26, fontWeight: 600, letterSpacing: 1 }}>{ref.code}</span>
              <button className="btn-ghost" onClick={copy} style={{ fontSize: 13 }}>{copied ? 'Copied ✓' : 'Copy'}</button>
            </div>
            <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: 0 }}>
              Share it with friends. When they redeem it at checkout you get <b>5% off</b> your next order —
              and every <b>10th</b> use earns you a <b>$25</b> gift code by DM.
            </p>
            <div style={{ display: 'flex', gap: 24, marginTop: 4 }}>
              <div><div style={{ fontSize: 26, fontWeight: 600, color: 'var(--vsx-gold)' }}>{ref.uses}</div><div style={{ fontSize: 11, color: 'var(--vsx-muted)' }}>times used</div></div>
              <div><div style={{ fontSize: 26, fontWeight: 600 }}>{toNext}</div><div style={{ fontSize: 11, color: 'var(--vsx-muted)' }}>until next $25</div></div>
            </div>
          </>
        )}
      </div>

      {/* Transactions */}
      <div>
        <p className="eyebrow" style={{ marginBottom: 10 }}>Your purchases</p>
        {tx === null && <div className="card"><p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>Loading…</p></div>}
        {tx && tx.length === 0 && <div className="card"><p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>No purchases yet.</p></div>}
        {tx && tx.map((t) => {
          const date = t.payment?.confirmedAt?.seconds || t.createdAt?.seconds;
          const dateStr = date ? new Date(date * 1000).toLocaleDateString() : '';
          return (
            <div key={t.id} className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <span className="mono" style={{ fontSize: 12, color: 'var(--vsx-muted)' }}>#{t.id.slice(0, 6)} · {dateStr}</span>
                <span className="tag ok" style={{ fontSize: 11 }}>paid</span>
              </div>
              {(t.items || []).map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', color: it.price < 0 ? 'var(--vsx-gold)' : 'inherit' }}>
                  <span>{it.name}</span><span className="mono">{fmt(it.price)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--vsx-line)', marginTop: 8, paddingTop: 8, fontWeight: 600 }}>
                <span>Total</span><span className="mono" style={{ color: 'var(--vsx-gold)' }}>{fmt(t.total)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
