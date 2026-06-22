import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../auth';
import { useCatalogue } from '../catalogue';
import { postTicketEmbed } from '../lib';
import { RUNTIMES, DISCLAIMERS, runtimeByKey, fmt } from '../data';

export default function Shop() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const cat = useCatalogue();
  const [basket, setBasket] = useState([]);
  const [consentOpen, setConsentOpen] = useState(false);

  const owns = user.owns || [];
  const pkgById = (id) => cat.packages.find((p) => p.id === id);
  const svcById = (id) => cat.services.find((s) => s.id === id);

  const buyingIds = new Set(basket.filter((b) => b.kind === 'package').map((b) => b.pkgId));
  const hasPremiumPlus = basket.some((b) => b.kind === 'premiumplus');
  const ownsPremium = owns.includes('premium') || buyingIds.has('premium');

  // PT eligible: package supports tracker AND (premium owner/buyer, or owns this
  // package's role, or is buying this package now).
  const ptEligible = (id) => {
    const p = pkgById(id);
    return p && p.tracker && (ownsPremium || owns.includes(id) || buyingIds.has(id));
  };

  const add = (item) => setBasket((b) => [...b, item]);
  const remove = (i) => setBasket((b) => b.filter((_, idx) => idx !== i));

  const lineItems = basket.flatMap((b) => {
    const rt = runtimeByKey(b.runtimeKey);
    if (b.kind === 'package') {
      const p = pkgById(b.pkgId);
      const out = [{ name: `${p.name} · ${rt.label}`, price: Number(p.prices[b.runtimeKey]) || 0, disc: 'analysis' }];
      if (b.withTracker && p.tracker && !hasPremiumPlus) {
        out.push({ name: `Portfolio Tracker · ${p.name} · ${rt.label}`, price: cat.tracker.perPackage * rt.months, disc: 'tracker' });
      }
      return out;
    }
    if (b.kind === 'trackerOnly') {
      const p = pkgById(b.pkgId);
      return [{ name: `Portfolio Tracker · ${p.name} · ${rt.label}`, price: cat.tracker.perPackage * rt.months, disc: 'tracker' }];
    }
    if (b.kind === 'premiumplus') {
      return [{ name: `Premium+ · Portfolio Tracker (all) · ${rt.label}`, price: cat.tracker.premiumPlus * rt.months, disc: 'tracker' }];
    }
    const s = svcById(b.serviceId);
    return [{ name: `${s.name}${s.unit ? ` ${s.unit}` : ''}`, price: Number(s.price) || 0, disc: s.id === 'deepdive' ? 'deepdive' : 'coaching' }];
  });

  const total = lineItems.reduce((s, x) => s + x.price, 0);
  const discKeys = [...new Set(lineItems.map((x) => x.disc))];

  // Packages the user can add a standalone tracker for (owns role, not buying now).
  const ownedTrackable = hasPremiumPlus ? [] : cat.packages.filter(
    (p) => p.tracker && !buyingIds.has(p.id) && (ownsPremium || owns.includes(p.id)),
  );

  return (
    <div className="shell" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 28, alignItems: 'start' }}>
      <section>
        <p className="eyebrow">Catalog</p>
        <h1 style={{ fontSize: 32, margin: '8px 0 14px' }}>Analysis Packages</h1>

        <div className="card" style={{ padding: '14px 18px', marginBottom: 22, borderColor: 'var(--vsx-gold-2)' }}>
          <p className="eyebrow" style={{ marginBottom: 8 }}>Included free</p>
          {cat.freebies.map((f, i) => <div key={i} style={{ fontSize: 14 }}>★ {f}</div>)}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {cat.packages.map((p) => (
            <PackageCard key={p.id} pkg={p} trackerPrice={cat.tracker.perPackage}
              allowTracker={p.tracker && !hasPremiumPlus} onAdd={add} />
          ))}
        </div>

        {ownedTrackable.length > 0 && (
          <>
            <p className="eyebrow" style={{ marginTop: 30 }}>Your packages</p>
            <h2 style={{ fontSize: 22, margin: '6px 0 6px' }}>Add Portfolio Tracker</h2>
            <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: '0 0 14px' }}>
              For packages you already own — {fmt(cat.tracker.perPackage)}/mo each.
            </p>
            <div style={{ display: 'grid', gap: 10 }}>
              {ownedTrackable.map((p) => (
                <OwnedTrackerRow key={p.id} pkg={p} price={cat.tracker.perPackage} onAdd={add} />
              ))}
            </div>
          </>
        )}

        <PremiumPlusCard price={cat.tracker.premiumPlus} enabled={ownsPremium}
          active={hasPremiumPlus} onAdd={add} />

        <p className="eyebrow" style={{ marginTop: 30 }}>Services</p>
        <h2 style={{ fontSize: 24, margin: '6px 0 14px' }}>Deep Dives & Coaching</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {cat.services.map((s) => (
            <div key={s.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <h3 style={{ fontSize: 18 }}>{s.name}</h3>
                <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: '4px 0 0' }}>{s.desc}</p>
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div className="mono display" style={{ fontSize: 18, color: 'var(--vsx-gold)' }}>
                  {fmt(s.price)}<span style={{ fontSize: 12, color: 'var(--vsx-muted)' }}>{s.unit || ''}</span>
                </div>
                <button className="btn-ghost" style={{ marginTop: 8 }} onClick={() => add({ kind: 'service', serviceId: s.id })}>Add</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <aside>
        <div className="card" style={{ position: 'sticky', top: 24 }}>
          <p className="eyebrow">Cart</p>
          {lineItems.length === 0 && <p style={{ color: 'var(--vsx-muted)', fontSize: 14, marginTop: 14 }}>Empty. Add packages or services.</p>}
          {lineItems.map((it, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--vsx-line)', gap: 8 }}>
              <div style={{ fontSize: 13 }}>{it.name}</div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div className="mono" style={{ fontSize: 13 }}>{fmt(it.price)}</div>
                <button onClick={() => remove(i)} style={{ background: 'none', color: 'var(--vsx-muted)', fontSize: 11, padding: 0 }}>remove</button>
              </div>
            </div>
          ))}
          {lineItems.length > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
                <span className="eyebrow">Total</span>
                <span className="mono display" style={{ color: 'var(--vsx-gold)', fontSize: 18 }}>{fmt(total)}</span>
              </div>
              <button className="btn" style={{ width: '100%', marginTop: 16 }} onClick={() => setConsentOpen(true)}>Open ticket</button>
            </>
          )}
        </div>
      </aside>

      {consentOpen && (
        <ConsentModal discKeys={discKeys} total={total} onClose={() => setConsentOpen(false)}
          onConfirm={async () => {
            const ref = await addDoc(collection(db, 'tickets'), {
              userId: user.uid, userTag: user.tag, userAvatar: user.avatar,
              items: lineItems.map(({ disc, ...rest }) => rest), total,
              consent: { accepted: true, at: serverTimestamp(), disclaimers: discKeys },
              payment: { method: null, status: 'unpaid' },
              status: 'awaiting_payment', createdAt: serverTimestamp(),
            });
            try { await postTicketEmbed({ id: ref.id, userTag: user.tag, items: lineItems, total }); } catch (_) {}
            navigate(`/ticket/${ref.id}`);
          }} />
      )}
    </div>
  );
}

function PackageCard({ pkg, trackerPrice, allowTracker, onAdd }) {
  const [rtKey, setRtKey] = useState('1M');
  const [tracker, setTracker] = useState(false);
  const price = pkg.prices[rtKey];
  const soon = price == null || price === '';

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, borderColor: pkg.highlight ? 'var(--vsx-gold-2)' : 'var(--vsx-line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 19 }}>{pkg.name}</h3>
        {pkg.highlight && <span className="tag gold">Premium</span>}
      </div>
      <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: 0, minHeight: 34 }}>{pkg.desc}</p>
      <select value={rtKey} onChange={(e) => setRtKey(e.target.value)}>
        {RUNTIMES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
      </select>
      <div className="mono display" style={{ fontSize: 22, color: soon ? 'var(--vsx-muted)' : 'var(--vsx-gold)' }}>
        {soon ? 'Coming soon' : fmt(price)}
      </div>
      {allowTracker && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--vsx-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={tracker} onChange={(e) => setTracker(e.target.checked)} style={{ width: 16 }} />
          + Portfolio Tracker ({fmt(trackerPrice)}/mo)
        </label>
      )}
      <button className="btn" disabled={soon}
        onClick={() => onAdd({ kind: 'package', pkgId: pkg.id, runtimeKey: rtKey, withTracker: tracker })}>Add</button>
    </div>
  );
}

function OwnedTrackerRow({ pkg, price, onAdd }) {
  const [rtKey, setRtKey] = useState('1M');
  return (
    <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
      <div style={{ fontWeight: 500 }}>{pkg.name}</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <select value={rtKey} onChange={(e) => setRtKey(e.target.value)} style={{ width: 'auto' }}>
          {RUNTIMES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <button className="btn-ghost" onClick={() => onAdd({ kind: 'trackerOnly', pkgId: pkg.id, runtimeKey: rtKey })}>
          Add tracker
        </button>
      </div>
    </div>
  );
}

function PremiumPlusCard({ price, enabled, active, onAdd }) {
  const [rtKey, setRtKey] = useState('1M');
  return (
    <div className="card" style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, borderColor: 'var(--vsx-gold-2)', opacity: enabled ? 1 : 0.6 }}>
      <div>
        <p className="eyebrow">Add-on</p>
        <h3 style={{ fontSize: 19, marginTop: 4 }}>Premium+ · Portfolio Tracker</h3>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: '4px 0 0' }}>
          {enabled
            ? `Portfolio Tracker for all your packages — ${fmt(price)}/mo.`
            : 'Requires Premium — own the Premium role or add Premium to your cart.'}
        </p>
      </div>
      <div style={{ textAlign: 'right' }}>
        <select value={rtKey} onChange={(e) => setRtKey(e.target.value)} style={{ width: 'auto', marginBottom: 8 }} disabled={!enabled}>
          {RUNTIMES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <button className="btn" disabled={!enabled || active} onClick={() => onAdd({ kind: 'premiumplus', runtimeKey: rtKey })}>
          {active ? 'In cart' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function ConsentModal({ discKeys, total, onClose, onConfirm }) {
  const [checked, setChecked] = useState({});
  const all = discKeys.every((_, i) => checked[i]);
  return (
    <div style={{ position: 'absolute', inset: 0, minHeight: '100vh', background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '60px 20px', zIndex: 20 }}>
      <div className="card" style={{ maxWidth: 560, width: '100%' }}>
        <p className="eyebrow">Consent</p>
        <h2 style={{ fontSize: 24, margin: '8px 0 4px' }}>Confirm disclaimers</h2>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 14, marginTop: 0 }}>Please confirm the disclaimers below to open your ticket.</p>
        <div style={{ display: 'grid', gap: 14, margin: '18px 0' }}>
          {discKeys.map((k, i) => (
            <label key={k} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--vsx-charcoal-3)', padding: 14, borderRadius: 8, cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 18, marginTop: 3 }} checked={!!checked[i]} onChange={(e) => setChecked((c) => ({ ...c, [i]: e.target.checked }))} />
              <span style={{ color: 'var(--vsx-muted)', fontSize: 13 }}>{DISCLAIMERS[k]}</span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!all} onClick={onConfirm}>Open ticket · {fmt(total)}</button>
        </div>
      </div>
    </div>
  );
}
