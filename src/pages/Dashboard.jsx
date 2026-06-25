import { useEffect, useState } from 'react';
import { collection, query, where, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useAuth } from '../auth';
import { fmt, PRESTIGE } from '../data';

export default function Dashboard() {
  const { user } = useAuth();
  const [tx, setTx] = useState(null);
  const [txErr, setTxErr] = useState('');
  const [ref, setRef] = useState(null);
  const [refErr, setRefErr] = useState('');
  const [balance, setBalance] = useState(0);
  const [vouchers, setVouchers] = useState([]);
  const [copied, setCopied] = useState('');
  const [prestige, setPrestige] = useState({ level: 0, boost: 0 });
  const [pBusy, setPBusy] = useState(false);
  const [pMsg, setPMsg] = useState('');

  // The customer's full order history. Single-field query, no index needed.
  useEffect(() => {
    if (!user?.uid) return;
    const q = query(collection(db, 'tickets'), where('userId', '==', user.uid));
    return onSnapshot(q, (snap) => {
      setTxErr('');
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setTx(all.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
    }, (e) => { setTxErr(e.code || 'load failed'); setTx([]); });
  }, [user?.uid]);

  // Balance sheet.
  useEffect(() => {
    if (!user?.uid) return;
    (async () => {
      try { const b = await getDoc(doc(db, 'balances', user.uid)); setBalance(b.exists() ? (Number(b.data().amount) || 0) : 0); } catch (_) {}
    })();
  }, [user?.uid]);

  // Vouchers issued to me (active, unused).
  useEffect(() => {
    if (!user?.uid) return;
    const q = query(collection(db, 'vouchers'), where('ownerId', '==', user.uid));
    return onSnapshot(q, (snap) => {
      const now = Date.now();
      setVouchers(snap.docs.map((d) => ({ code: d.id, ...d.data() }))
        .filter((v) => !v.used && (!v.expiresAt || v.expiresAt.toMillis() > now)));
    }, () => setVouchers([]));
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

  // Prestige status (level + boost + authoritative balance).
  useEffect(() => {
    (async () => {
      try {
        const idToken = await auth.currentUser.getIdToken();
        const r = await fetch('/api/prestige', { headers: { Authorization: `Bearer ${idToken}` } });
        const d = await r.json();
        if (r.ok) { setPrestige({ level: d.level || 0, boost: d.boost || 0 }); if (typeof d.balance === 'number') setBalance(d.balance); }
      } catch (_) {}
    })();
  }, []);

  const buyPrestige = async (tier) => {
    setPMsg(''); setPBusy(true);
    try {
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/prestige', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ tier }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      setPrestige({ level: d.level, boost: d.boost });
      if (typeof d.balance === 'number') setBalance(d.balance);
      setPMsg(`Prestige ${d.level} unlocked! Commission boost now +${Math.round(d.boost * 100)}%.`);
    } catch (e) { setPMsg('Could not buy: ' + e.message); }
    setPBusy(false);
  };

  const copy = async (text, id) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(''), 1500); } catch (_) {}
  };

  return (
    <div className="shell" style={{ display: 'grid', gap: 22, maxWidth: 820 }}>
      <div>
        <p className="eyebrow">Dashboard</p>
        <h1 style={{ fontSize: 30, margin: '4px 0' }}>Hi {user.tag || 'there'} <span style={{ color: 'var(--vsx-gold)' }}>🤍</span></h1>
      </div>

      <div className="card" style={{ display: 'grid', gap: 12, border: '1px solid var(--vsx-gold)' }}>
        <p className="eyebrow" style={{ margin: 0 }}>Your referral code</p>
        {refErr && <p style={{ color: 'var(--vsx-err)', fontSize: 13 }}>{refErr}</p>}
        {!ref && !refErr && <p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>Loading…</p>}
        {ref && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <span className="mono" style={{ color: 'var(--vsx-gold)', fontSize: 26, fontWeight: 600, letterSpacing: 1 }}>{ref.code}</span>
              <button className="btn-ghost" onClick={() => copy(ref.code, 'ref')} style={{ fontSize: 13 }}>{copied === 'ref' ? 'Copied' : 'Copy'}</button>
            </div>
            <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: 0 }}>
              Share it with friends. They get <b>5% off</b> their order, and you get <b>$5 credit</b> on your
              balance for every redemption — redeem it at checkout or let it stack up.
            </p>
            <div style={{ display: 'flex', gap: 24, marginTop: 4 }}>
              <div><div style={{ fontSize: 26, fontWeight: 600, color: 'var(--vsx-gold)' }}>{fmt(balance)}</div><div style={{ fontSize: 11, color: 'var(--vsx-muted)' }}>balance</div></div>
              <div><div style={{ fontSize: 26, fontWeight: 600 }}>{ref.uses}</div><div style={{ fontSize: 11, color: 'var(--vsx-muted)' }}>times used</div></div>
            </div>
          </>
        )}
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <p className="eyebrow" style={{ margin: 0 }}>Prestige</p>
          <span style={{ fontSize: 12, color: 'var(--vsx-muted)' }}>
            Commission per referral: <span className="mono" style={{ color: 'var(--vsx-gold)' }}>{fmt(5 * (1 + prestige.boost))}</span>
            {prestige.level > 0 ? ` · Tier ${prestige.level} (+${Math.round(prestige.boost * 100)}%)` : ''}
          </span>
        </div>
        <div className="card" style={{ display: 'grid', gap: 4 }}>
          <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: '0 0 6px' }}>
            Spend your referral balance to level up. Each tier boosts the credit you earn per referral.
            Tiers must be bought in order.
          </p>
          {PRESTIGE.map((p) => {
            const owned = prestige.level >= p.tier;
            const isNext = prestige.level === p.tier - 1;
            const canAfford = balance >= p.price;
            return (
              <div key={p.tier} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--vsx-line)' }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  <span className="mono" style={{ fontSize: 12, marginLeft: 10, color: 'var(--vsx-gold)' }}>+{Math.round(p.boost * 100)}% commission</span>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--vsx-muted)', marginTop: 2 }}>{fmt(p.price)} balance</div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  {owned ? (
                    <span className="tag gold" style={{ fontSize: 11 }}>Owned</span>
                  ) : isNext ? (
                    <button className="btn" disabled={pBusy || !canAfford} onClick={() => buyPrestige(p.tier)}>
                      {canAfford ? `Buy · ${fmt(p.price)}` : `Need ${fmt(p.price - balance)} more`}
                    </button>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--vsx-muted)' }}>Buy Prestige {p.tier - 1} first</span>
                  )}
                </div>
              </div>
            );
          })}
          {pMsg && <p style={{ fontSize: 13, marginTop: 8, color: pMsg.startsWith('Prestige') ? 'var(--vsx-ok)' : 'var(--vsx-err)' }}>{pMsg}</p>}
        </div>
      </div>

      {vouchers.length > 0 && (
        <div>
          <p className="eyebrow" style={{ marginBottom: 10 }}>Your vouchers</p>
          <div className="card" style={{ display: 'grid', gap: 4 }}>
            {vouchers.map((v) => {
              const value = v.percent ? `${v.percent}% off` : fmt(Number(v.amount) || 0);
              const exp = v.expiresAt ? new Date(v.expiresAt.toMillis()).toLocaleDateString() : null;
              return (
                <div key={v.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--vsx-line)' }}>
                  <div style={{ minWidth: 0 }}>
                    <span className="mono" style={{ color: 'var(--vsx-gold)', fontSize: 15 }}>{v.code}</span>
                    <span className="mono" style={{ fontSize: 12, marginLeft: 10, color: 'var(--vsx-muted)' }}>{value}{exp ? ` · until ${exp}` : ''}</span>
                  </div>
                  <button className="btn-ghost" onClick={() => copy(v.code, v.code)} style={{ fontSize: 12, flexShrink: 0 }}>{copied === v.code ? 'Copied' : 'Copy'}</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <p className="eyebrow" style={{ marginBottom: 10 }}>Your purchases</p>
        {txErr && <div className="card"><p style={{ color: 'var(--vsx-err)', fontSize: 13 }}>Couldn't load your purchases — {txErr}. Please reload; if it persists, let the team know.</p></div>}
        {tx === null && !txErr && <div className="card"><p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>Loading…</p></div>}
        {tx && tx.length === 0 && !txErr && <div className="card"><p style={{ color: 'var(--vsx-muted)', fontSize: 14 }}>No orders yet.</p></div>}
        {tx && tx.map((t) => {
          const paid = t.status === 'paid' || t.payment?.status === 'paid';
          const date = t.payment?.confirmedAt?.seconds || t.createdAt?.seconds;
          const dateStr = date ? new Date(date * 1000).toLocaleDateString() : '';
          const statusLabel = paid ? 'paid' : t.status === 'awaiting_payment' ? 'awaiting payment' : (t.status || 'open');
          return (
            <div key={t.id} className="card" style={{ marginBottom: 12, opacity: paid ? 1 : 0.85 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <span className="mono" style={{ fontSize: 12, color: 'var(--vsx-muted)' }}>#{t.id.slice(0, 6)} · {dateStr}</span>
                <span className={paid ? 'tag ok' : 'tag'} style={{ fontSize: 11, color: paid ? undefined : 'var(--vsx-muted)' }}>{statusLabel}</span>
              </div>
              {(t.items || []).map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', color: it.price < 0 ? 'var(--vsx-gold)' : 'inherit' }}>
                  <span>{it.name}</span><span className="mono">{fmt(it.price)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--vsx-line)', marginTop: 8, paddingTop: 8, fontWeight: 600 }}>
                <span>Total</span><span className="mono" style={{ color: 'var(--vsx-gold)' }}>{fmt(t.total)}</span>
              </div>
              {!paid && t.status === 'awaiting_payment' && (
                <a href={`/ticket/${t.id}`} style={{ fontSize: 12, color: 'var(--vsx-gold)', textDecoration: 'none', display: 'inline-block', marginTop: 8 }}>Open ticket →</a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
