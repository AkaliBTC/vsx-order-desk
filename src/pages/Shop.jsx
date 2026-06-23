import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { collection, addDoc, doc, getDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useAuth } from '../auth';
import { useCatalogue } from '../catalogue';
import { postTicketEmbed } from '../lib';
import { RUNTIMES, DISCLAIMERS, DISCLAIMER_PDF, runtimeByKey, fmt } from '../data';

export default function Shop() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const cat = useCatalogue();
  const [basket, setBasket] = useState([]);
  const [consentOpen, setConsentOpen] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [applied, setApplied] = useState(null);   // {type:'percent',code,percent} | {type:'voucher',code,amount}
  const [codeError, setCodeError] = useState('');

  const applyCode = async () => {
    const code = codeInput.trim().toUpperCase();
    setCodeError('');
    if (!code) return;
    try {
      // 1) gift voucher (fixed $ balance)?
      const vs = await getDoc(doc(db, 'vouchers', code));
      if (vs.exists()) {
        const v = vs.data();
        if (v.used) { setCodeError('Voucher already used.'); return; }
        if (v.expiresAt && v.expiresAt.toMillis() < Date.now()) { setCodeError('Voucher expired.'); return; }
        setApplied({ type: 'voucher', code, amount: Number(v.amount) });
        return;
      }
      // 2) percentage discount code?
      const snap = await getDoc(doc(db, 'discounts', code));
      if (snap.exists()) {
        const d = snap.data();
        if (d.active === false) { setCodeError('Code is inactive.'); return; }
        if (d.expiresAt && d.expiresAt.toMillis() < Date.now()) { setCodeError('Code expired.'); return; }
        setApplied({ type: 'percent', code, percent: Number(d.percent) });
        return;
      }
      setCodeError('Code not found.');
    } catch (e) { setCodeError('Could not validate code.'); }
  };

  // Ownership/loyalty are cached in the login token and go stale when a role is
  // removed in Discord. Refresh them live on load so the shop reflects reality.
  const [live, setLive] = useState({ owns: user.owns || [], loyalty: !!user.loyalty });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const idToken = await auth.currentUser.getIdToken();
        const r = await fetch('/api/my-roles', { method: 'POST', headers: { Authorization: `Bearer ${idToken}` } });
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled && Array.isArray(d.owns)) setLive({ owns: d.owns, loyalty: !!d.loyalty });
      } catch (_) { /* keep cached values */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const owns = live.owns;

  // If a role was removed, drop any standalone tracker for a package you no longer own.
  useEffect(() => {
    setBasket((b) => b.filter((it) => it.kind !== 'trackerOnly' || live.owns.includes(it.pkgId)));
  }, [live.owns]);
  const pkgById = (id) => cat.packages.find((p) => p.id === id);
  const svcById = (id) => cat.services.find((s) => s.id === id);

  const buyingIds = new Set(basket.filter((b) => b.kind === 'package').map((b) => b.pkgId));
  const hasPremiumPlus = basket.some((b) => b.kind === 'premiumplus');
  const ownsPremium = owns.includes('premium') || buyingIds.has('premium');
  const premiumInCart = basket.find((b) => b.kind === 'package' && b.pkgId === 'premium');
  const premiumRuntimeKey = premiumInCart ? premiumInCart.runtimeKey : null;

  // PT eligible: package supports tracker AND (premium owner/buyer, or owns this
  // package's role, or is buying this package now).
  const ptEligible = (id) => {
    const p = pkgById(id);
    return p && p.tracker && (ownsPremium || owns.includes(id) || buyingIds.has(id));
  };

  const add = (raw) => setBasket((b) => {
    let item = raw;
    let next = [...b];

    if (item.kind === 'package' && item.pkgId === 'premium') {
      // Premium = all analysis packages → remove the individual analysis packages
      next = next.filter((x) => !(x.kind === 'package' && x.pkgId !== 'premium'));
    }
    if (item.kind === 'package' && item.pkgId !== 'premium') {
      if (next.some((x) => x.kind === 'package' && x.pkgId === 'premium')) return next; // already covered
      if (next.some((x) => x.kind === 'package' && x.pkgId === item.pkgId)) return next; // no duplicate
    }
    if (item.kind === 'premiumplus') {
      if (next.some((x) => x.kind === 'premiumplus')) return next;
      // Premium+ = tracker for all → drop individual trackers
      next = next.map((x) => (x.kind === 'package' ? { ...x, withTracker: false } : x))
        .filter((x) => x.kind !== 'trackerOnly');
      // duration may be anything up to the Premium package's runtime (shorter is fine)
      const prem = next.find((x) => x.kind === 'package' && x.pkgId === 'premium');
      if (prem && runtimeByKey(item.runtimeKey).months > runtimeByKey(prem.runtimeKey).months) {
        item = { ...item, runtimeKey: prem.runtimeKey };
      }
    }
    if (item.kind === 'trackerOnly') {
      if (next.some((x) => x.kind === 'premiumplus')) return next; // covered by Premium+
      if (next.some((x) => x.kind === 'trackerOnly' && x.pkgId === item.pkgId)) return next;
    }
    return [...next, item];
  });

  const remove = (i) => setBasket((b) => {
    const target = b[i];
    let next = b.filter((_, idx) => idx !== i);
    // removing Premium also removes Premium+ (it depends on Premium)
    if (target && target.kind === 'package' && target.pkgId === 'premium') {
      next = next.filter((x) => x.kind !== 'premiumplus');
    }
    return next;
  });

  const lineItems = basket.flatMap((b, bi) => {
    const rt = runtimeByKey(b.runtimeKey);
    if (b.kind === 'package') {
      const p = pkgById(b.pkgId);
      const out = [{ bi, name: `${p.name} · ${rt.label}`, price: Number(p.prices[b.runtimeKey]) || 0, disc: 'analysis' }];
      if (b.withTracker && p.tracker && !hasPremiumPlus) {
        out.push({ bi, name: `Portfolio Tracker · ${p.name} · ${rt.label}`, price: cat.tracker.perPackage * rt.months, disc: 'tracker' });
      }
      return out;
    }
    if (b.kind === 'trackerOnly') {
      const p = pkgById(b.pkgId);
      return [{ bi, name: `Portfolio Tracker · ${p.name} · ${rt.label}`, price: cat.tracker.perPackage * rt.months, disc: 'tracker' }];
    }
    if (b.kind === 'premiumplus') {
      return [{ bi, name: `Premium+ · Portfolio Tracker (all) · ${rt.label}`, price: cat.tracker.premiumPlus * rt.months, disc: 'tracker' }];
    }
    if (b.kind === 'voucher') {
      return [{ bi, name: `Gift Voucher · ${fmt(b.amount)} balance`, price: Number(b.amount) || 0, disc: 'voucher' }];
    }
    const s = svcById(b.serviceId);
    return [{ bi, name: `${s.name}${s.unit ? ` ${s.unit}` : ''}`, price: Number(s.price) || 0, disc: s.id === 'deepdive' ? 'deepdive' : 'coaching' }];
  });

  const total0 = lineItems.reduce((s, x) => s + x.price, 0);
  const analysisSubtotal = lineItems.filter((x) => x.disc === 'analysis').reduce((s, x) => s + x.price, 0);
  const voucherPurchaseTotal = lineItems.filter((x) => x.disc === 'voucher').reduce((s, x) => s + x.price, 0);
  const loyaltyOff = live.loyalty ? Math.round(analysisSubtotal * 10) / 100 : 0; // 10% on analysis only
  const afterLoyalty = total0 - loyaltyOff;
  // codes & vouchers never discount a gift-voucher purchase itself
  const discountBase = Math.max(0, afterLoyalty - voucherPurchaseTotal);
  const codeOff = applied?.type === 'percent' ? Math.round(discountBase * applied.percent) / 100 : 0;
  const voucherOff = applied?.type === 'voucher' ? Math.min(applied.amount, discountBase) : 0;
  const total = +(afterLoyalty - codeOff - voucherOff).toFixed(2);
  const discKeys = [...new Set(lineItems.map((x) => x.disc))];

  // Discount lines appended to the order (so the ticket + transcript show them).
  const discountLines = [
    ...(loyaltyOff > 0 ? [{ name: 'Loyalty −10% (analysis)', price: -loyaltyOff }] : []),
    ...(codeOff > 0 ? [{ name: `Code ${applied.code} −${applied.percent}%`, price: -codeOff }] : []),
    ...(voucherOff > 0 ? [{ name: `Voucher ${applied.code}`, price: -voucherOff }] : []),
  ];

  // Packages the user can add a standalone tracker for (owns role, not buying now).
  // (not packages you're buying right now — Premium in the cart does not count here).
  // Standalone trackers you can add = packages you INDIVIDUALLY own via a Discord role
  // and aren't buying right now. Owning Premium does NOT unlock every tracker here —
  // Premium holders add all trackers via Premium+ instead.
  const ownedTrackable = hasPremiumPlus ? [] : cat.packages.filter(
    (p) => p.tracker && p.id !== 'premium' && !buyingIds.has(p.id) && owns.includes(p.id),
  );

  return (
    <div className="shell cols-main">
      <section>
        <p className="eyebrow rise">Catalog</p>
        <h1 className="rise" style={{ fontSize: 32, margin: '8px 0 14px', animationDelay: '.06s' }}>Analysis Packages</h1>

        <motion.div className="card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
          style={{ padding: '14px 18px', marginBottom: 22, borderColor: 'var(--vsx-gold-2)' }}>
          <p className="eyebrow" style={{ marginBottom: 8 }}>Included free</p>
          {cat.freebies.map((f, i) => <div key={i} style={{ fontSize: 14 }}>★ {f}</div>)}
        </motion.div>

        <div className="cols-2">
          {cat.packages.map((p, i) => (
            <PackageCard key={p.id} index={i} pkg={p} trackerPrice={cat.tracker.perPackage}
              allowTracker={p.tracker && !hasPremiumPlus}
              inCart={buyingIds.has(p.id)}
              covered={p.id !== 'premium' && buyingIds.has('premium')}
              onAdd={add} />
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
                <OwnedTrackerRow key={p.id} pkg={p} price={cat.tracker.perPackage}
                  maxMonths={premiumInCart ? runtimeByKey(premiumRuntimeKey).months : null} onAdd={add} />
              ))}
            </div>
          </>
        )}

        <PremiumPlusCard price={cat.tracker.premiumPlus} enabled={ownsPremium}
          active={hasPremiumPlus} maxRuntimeKey={premiumRuntimeKey} onAdd={add} />

        <p className="eyebrow" style={{ marginTop: 30 }}>Services</p>
        <h2 style={{ fontSize: 24, margin: '6px 0 14px' }}>Deep Dives & Coaching</h2>
        <div className="cols-2">
          {cat.services.map((s, i) => (
            <motion.div key={s.id} className="card"
              initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.5, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
              whileHover={{ y: -5, transition: { type: 'spring', stiffness: 320, damping: 22 } }}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <h3 style={{ fontSize: 18 }}>{s.name}</h3>
                <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: '4px 0 0' }}>{s.desc}</p>
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div className="mono display" style={{ fontSize: 18, color: 'var(--vsx-gold)' }}>
                  {fmt(s.price)}<span style={{ fontSize: 12, color: 'var(--vsx-muted)' }}>{s.unit || ''}</span>
                </div>
                <motion.button className="btn-ghost" whileTap={{ scale: 0.96 }} style={{ marginTop: 8 }} onClick={() => add({ kind: 'service', serviceId: s.id })}>Add</motion.button>
              </div>
            </motion.div>
          ))}
        </div>

        <p className="eyebrow" style={{ marginTop: 30 }}>Gift</p>
        <h2 style={{ fontSize: 24, margin: '6px 0 14px' }}>Gift Voucher</h2>
        <GiftVoucherCard onAdd={add} />
      </section>

      <aside>
        <div className="card cart-aside" style={{ position: 'sticky', top: 24 }}>
          <p className="eyebrow">Cart</p>
          {lineItems.length === 0 && <p style={{ color: 'var(--vsx-muted)', fontSize: 14, marginTop: 14 }}>Empty. Add packages or services.</p>}
          <AnimatePresence initial={false}>
            {lineItems.map((it, i) => (
              <motion.div key={i} layout
                initial={{ opacity: 0, x: 20, height: 0 }}
                animate={{ opacity: 1, x: 0, height: 'auto' }}
                exit={{ opacity: 0, x: -20, height: 0 }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--vsx-line)', gap: 8, overflow: 'hidden' }}>
                <div style={{ fontSize: 13 }}>{it.name}</div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div className="mono" style={{ fontSize: 13 }}>{fmt(it.price)}</div>
                  <button onClick={() => remove(it.bi)} style={{ background: 'none', color: 'var(--vsx-muted)', fontSize: 11, padding: 0 }}>remove</button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {lineItems.length > 0 && (
            <>
              {discountLines.map((d, i) => (
                <div key={`d${i}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: 13, color: 'var(--vsx-ok)' }}>
                  <span>{d.name}</span><span className="mono">{fmt(d.price)}</span>
                </div>
              ))}

              <div style={{ marginTop: 12 }}>
                <p className="eyebrow" style={{ marginBottom: 6 }}>Discount / voucher code</p>
                {applied ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                    <span className="mono" style={{ color: 'var(--vsx-gold)' }}>
                      {applied.code} {applied.type === 'voucher' ? `(${fmt(applied.amount)} voucher)` : `(−${applied.percent}%)`}
                    </span>
                    <button onClick={() => { setApplied(null); setCodeInput(''); }} style={{ background: 'none', color: 'var(--vsx-muted)', fontSize: 12, padding: 0 }}>remove</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="CODE"
                      onKeyDown={(e) => e.key === 'Enter' && applyCode()} style={{ textTransform: 'uppercase' }} />
                    <button className="btn-ghost" onClick={applyCode}>Apply</button>
                  </div>
                )}
                {codeError && <p style={{ color: 'var(--vsx-err)', fontSize: 12, marginTop: 6 }}>{codeError}</p>}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, alignItems: 'baseline' }}>
                <span className="eyebrow">Total</span>
                <AnimatePresence mode="popLayout">
                  <motion.span key={total} className="mono display"
                    initial={{ opacity: 0, y: 8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 26 }}
                    style={{ color: 'var(--vsx-gold)', fontSize: 18 }}>{fmt(total)}</motion.span>
                </AnimatePresence>
              </div>
              <motion.button className="btn" whileTap={{ scale: 0.97 }} style={{ width: '100%', marginTop: 16 }} onClick={() => setConsentOpen(true)}>Open ticket</motion.button>
            </>
          )}
        </div>
      </aside>

      <AnimatePresence>
        {consentOpen && (
          <ConsentModal discKeys={discKeys} total={total} onClose={() => setConsentOpen(false)}
          onConfirm={async () => {
            const items = [...lineItems.map(({ disc, bi, ...rest }) => rest), ...discountLines];
            const grants = basket.flatMap((b) => {
              const rt = runtimeByKey(b.runtimeKey);
              if (b.kind === 'package') {
                const p = pkgById(b.pkgId);
                const out = [{ roleId: p.roleId || '', months: rt.months, label: p.name }];
                if (b.withTracker && p.tracker) out.push({ roleId: p.ptRoleId || '', months: rt.months, label: `${p.name} PT` });
                return out;
              }
              if (b.kind === 'trackerOnly') {
                const p = pkgById(b.pkgId);
                return [{ roleId: p.ptRoleId || '', months: rt.months, label: `${p.name} PT` }];
              }
              if (b.kind === 'premiumplus') {
                return [{ roleId: cat.premiumPlusRoleId || '', months: rt.months, label: 'Premium+ PT' }];
              }
              return [];
            });
            const services = basket.filter((b) => b.kind === 'service').map((b) => {
              const s = svcById(b.serviceId); return { id: s.id, name: s.name };
            });
            const voucherPurchases = basket.filter((b) => b.kind === 'voucher').map((b) => Number(b.amount));
            const ref = await addDoc(collection(db, 'tickets'), {
              userId: user.uid, userTag: user.tag, userAvatar: user.avatar,
              items, total,
              grants, services, voucherPurchases,
              discount: applied?.type === 'percent' ? { code: applied.code, percent: applied.percent } : null,
              redeemedVoucher: applied?.type === 'voucher' ? applied.code : null,
              loyalty: loyaltyOff > 0,
              consent: { accepted: true, at: serverTimestamp(), disclaimers: discKeys },
              payment: { method: null, status: 'unpaid' },
              status: 'awaiting_payment', createdAt: serverTimestamp(),
            });
            try { await postTicketEmbed({ id: ref.id, userTag: user.tag, items, total }); } catch (_) {}
            navigate(`/ticket/${ref.id}`);
          }} />
        )}
      </AnimatePresence>
    </div>
  );
}

function PackageCard({ pkg, index = 0, trackerPrice, allowTracker, inCart, covered, onAdd }) {
  const [rtKey, setRtKey] = useState('1M');
  const [tracker, setTracker] = useState(false);
  const price = pkg.prices[rtKey];
  const soon = price == null || price === '';
  const disabled = soon || inCart || covered;
  const label = inCart ? 'In cart' : covered ? 'Included in Premium' : 'Add';

  return (
    <motion.div className="card"
      initial={{ opacity: 0, y: 26 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, delay: index * 0.06, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -6, transition: { type: 'spring', stiffness: 320, damping: 22 } }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, borderColor: pkg.highlight ? 'var(--vsx-gold-2)' : 'var(--vsx-line)', boxShadow: pkg.highlight ? 'var(--glow-gold)' : undefined, opacity: covered ? 0.6 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 19 }}>{pkg.name}</h3>
        {pkg.highlight && <span className="tag gold">Premium</span>}
      </div>
      <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: 0, minHeight: 34 }}>{pkg.desc}</p>
      <select value={rtKey} onChange={(e) => setRtKey(e.target.value)} disabled={disabled}>
        {RUNTIMES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
      </select>
      <AnimatePresence mode="wait">
        <motion.div key={soon ? 'soon' : price} className="mono display"
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25 }}
          style={{ fontSize: 22, color: soon ? 'var(--vsx-muted)' : 'var(--vsx-gold)' }}>
          {soon ? 'Coming soon' : fmt(price)}
        </motion.div>
      </AnimatePresence>
      {allowTracker && !inCart && !covered && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--vsx-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={tracker} onChange={(e) => setTracker(e.target.checked)} style={{ width: 16 }} />
          + Portfolio Tracker ({fmt(trackerPrice)}/mo)
        </label>
      )}
      <motion.button className="btn" disabled={disabled} whileTap={{ scale: 0.96 }}
        onClick={() => onAdd({ kind: 'package', pkgId: pkg.id, runtimeKey: rtKey, withTracker: tracker })}>{label}</motion.button>
    </motion.div>
  );
}

function OwnedTrackerRow({ pkg, price, maxMonths, onAdd }) {
  const options = maxMonths ? RUNTIMES.filter((r) => r.months <= maxMonths) : RUNTIMES;
  const [rtKey, setRtKey] = useState(options[0].key);
  // keep selection valid if the cap shrinks
  const valid = options.some((r) => r.key === rtKey) ? rtKey : options[0].key;
  return (
    <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
      <div style={{ fontWeight: 500 }}>{pkg.name}</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <select value={valid} onChange={(e) => setRtKey(e.target.value)} style={{ width: 'auto' }}>
          {options.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <button className="btn-ghost" onClick={() => onAdd({ kind: 'trackerOnly', pkgId: pkg.id, runtimeKey: valid })}>
          Add tracker
        </button>
      </div>
    </div>
  );
}

function PremiumPlusCard({ price, enabled, active, maxRuntimeKey, onAdd }) {
  const maxMonths = maxRuntimeKey ? runtimeByKey(maxRuntimeKey).months : null;
  const options = maxMonths ? RUNTIMES.filter((r) => r.months <= maxMonths) : RUNTIMES;
  const [rtKey, setRtKey] = useState(options[0].key);
  // clamp selection if the cap shrinks (e.g. Premium runtime changed)
  const effectiveKey = options.some((r) => r.key === rtKey) ? rtKey : options[0].key;
  return (
    <div className="card" style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, borderColor: 'var(--vsx-gold-2)', opacity: enabled ? 1 : 0.6 }}>
      <div>
        <p className="eyebrow">Add-on</p>
        <h3 style={{ fontSize: 19, marginTop: 4 }}>Premium+ · Portfolio Tracker</h3>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: '4px 0 0' }}>
          {!enabled
            ? 'Requires Premium — own the Premium role or add Premium to your cart.'
            : maxMonths
              ? `Portfolio Tracker for all your packages — ${fmt(price)}/mo. Choose any runtime up to your Premium (${runtimeByKey(maxRuntimeKey).label}).`
              : `Portfolio Tracker for all your packages — ${fmt(price)}/mo.`}
        </p>
      </div>
      <div style={{ textAlign: 'right' }}>
        <select value={effectiveKey} onChange={(e) => setRtKey(e.target.value)} style={{ width: 'auto', marginBottom: 8 }} disabled={!enabled}>
          {options.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <button className="btn" disabled={!enabled || active} onClick={() => onAdd({ kind: 'premiumplus', runtimeKey: effectiveKey })}>
          {active ? 'In cart' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function GiftVoucherCard({ onAdd }) {
  const [amount, setAmount] = useState('');
  const val = Number(amount);
  const ok = val >= 5 && val <= 5000;
  return (
    <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, borderColor: 'var(--vsx-gold-2)' }}>
      <div style={{ flex: 1 }}>
        <h3 style={{ fontSize: 18 }}>Gift Voucher</h3>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: '4px 0 0' }}>
          Choose any amount. The buyer receives a one-time code (valid 1 year) by Discord DM — perfect to gift to a friend.
        </p>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 12, top: 11, color: 'var(--vsx-muted)' }}>$</span>
          <input type="number" min="5" value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="50" style={{ width: 110, paddingLeft: 22 }} />
        </div>
        <button className="btn" disabled={!ok} onClick={() => { onAdd({ kind: 'voucher', amount: val }); setAmount(''); }}>Add</button>
      </div>
    </div>
  );
}

function ConsentModal({ discKeys, total, onClose, onConfirm }) {
  const [checked, setChecked] = useState({});
  const all = discKeys.every((_, i) => checked[i]);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: 'absolute', inset: 0, minHeight: '100vh', background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '60px 20px', zIndex: 20 }}>
      <motion.div className="card" style={{ maxWidth: 560, width: '100%' }}
        initial={{ opacity: 0, y: 30, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 26 }}>
        <p className="eyebrow">Consent</p>
        <h2 style={{ fontSize: 24, margin: '8px 0 4px' }}>Confirm disclaimers</h2>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 14, marginTop: 0 }}>Please confirm the disclaimers below to open your ticket.</p>
        <div style={{ display: 'grid', gap: 14, margin: '18px 0' }}>
          {discKeys.map((k, i) => (
            <label key={k} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--vsx-charcoal-3)', padding: 14, borderRadius: 8, cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 18, marginTop: 3 }} checked={!!checked[i]} onChange={(e) => setChecked((c) => ({ ...c, [i]: e.target.checked }))} />
              <span style={{ color: 'var(--vsx-muted)', fontSize: 13 }}>
                {DISCLAIMERS[k]}
                {DISCLAIMER_PDF[k] && (
                  <> <a href={DISCLAIMER_PDF[k]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--vsx-gold)', whiteSpace: 'nowrap' }}>Read full terms (PDF) ↗</a></>
                )}
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <motion.button className="btn" whileTap={{ scale: 0.97 }} disabled={!all} onClick={onConfirm}>Open ticket · {fmt(total)}</motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
