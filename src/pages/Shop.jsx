import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { collection, addDoc, doc, getDoc, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
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
  const [applied, setApplied] = useState(null);   // {type:'percent'|'voucher'|'referral',...}
  const [codeError, setCodeError] = useState('');
  const [balance, setBalance] = useState(0);       // referral $ credit on the user's sheet
  const [useBalance, setUseBalance] = useState(false);
  const [entExpiry, setEntExpiry] = useState({});  // pkgId -> latest role expiry (ms) for runtime caps
  const [trialUsed, setTrialUsed] = useState(false);
  const [trialMsg, setTrialMsg] = useState('');
  const [trialBusy, setTrialBusy] = useState(false);

  // Load the user's referral balance, trial-lock and per-package role expiries.
  useEffect(() => {
    if (!user?.uid) return;
    (async () => {
      try { const b = await getDoc(doc(db, 'balances', user.uid)); setBalance(b.exists() ? (Number(b.data().amount) || 0) : 0); } catch (_) {}
      try { const t = await getDoc(doc(db, 'trial_used', user.uid)); setTrialUsed(t.exists()); } catch (_) {}
      try {
        const snap = await getDocs(query(collection(db, 'entitlements'), where('userId', '==', user.uid)));
        const byRole = {};
        snap.docs.forEach((d) => { const e = d.data(); if (e.roleId && e.expiresAt) byRole[e.roleId] = Math.max(byRole[e.roleId] || 0, e.expiresAt.toMillis()); });
        setEntExpiry(byRole);
      } catch (_) {}
    })();
  }, [user?.uid]);

  const applyCode = async () => {
    const code = codeInput.trim().toUpperCase();
    setCodeError('');
    if (!code) return;
    try {
      // 1) gift voucher ($ balance or % off)
      const vs = await getDoc(doc(db, 'vouchers', code));
      if (vs.exists()) {
        const v = vs.data();
        if (v.used) { setCodeError('Voucher already used.'); return; }
        if (v.expiresAt && v.expiresAt.toMillis() < Date.now()) { setCodeError('Voucher expired.'); return; }
        if (v.percent) setApplied({ type: 'voucher', code, percent: Number(v.percent) });
        else setApplied({ type: 'voucher', code, amount: Number(v.amount) });
        return;
      }
      // 2) referral code — rewards the owner; each customer may use ONE in their lifetime
      const rf = await getDoc(doc(db, 'referrals', code));
      if (rf.exists()) {
        const owner = rf.data().ownerId;
        if (owner === user.uid) { setCodeError("You can't use your own referral code."); return; }
        const used = await getDoc(doc(db, 'referral_used', user.uid));
        if (used.exists()) { setCodeError("You've already used a referral code — one per customer."); return; }
        setApplied({ type: 'referral', code, ownerId: owner, percent: 5 });
        return;
      }
      // 3) percentage discount code?
      const snap = await getDoc(doc(db, 'discounts', code));
      if (snap.exists()) {
        const d = snap.data();
        if (d.active === false) { setCodeError('Code is inactive.'); return; }
        if (d.expiresAt && d.expiresAt.toMillis() < Date.now()) { setCodeError('Code expired.'); return; }
        setApplied({ type: 'percent', code, percent: Number(d.percent), scope: Array.isArray(d.scope) ? d.scope : [] });
        return;
      }
      setCodeError('Code not found.');
    } catch (e) { setCodeError('Could not validate code.'); }
  };

  const owns = user.owns || [];

  // owns is refreshed live in AuthProvider on load. Drop any standalone tracker whose
  // access you no longer have — but keep them while Premium covers you (owned or in cart).
  useEffect(() => {
    setBasket((b) => {
      const premiumCovers = (user.owns || []).includes('premium')
        || b.some((x) => x.kind === 'package' && x.pkgId === 'premium');
      return b.filter((it) => it.kind !== 'trackerOnly' || premiumCovers || (user.owns || []).includes(it.pkgId));
    });
  }, [user.owns]);
  const pkgById = (id) => cat.packages.find((p) => p.id === id);
  const svcById = (id) => cat.services.find((s) => s.id === id);

  const buyingIds = new Set(basket.filter((b) => b.kind === 'package').map((b) => b.pkgId));
  const hasPremiumPlus = basket.some((b) => b.kind === 'premiumplus');
  const ownsPremium = owns.includes('premium') || buyingIds.has('premium');
  const premiumInCart = basket.find((b) => b.kind === 'package' && b.pkgId === 'premium');
  const premiumRuntimeKey = premiumInCart ? premiumInCart.runtimeKey : null;
  const premiumPkg = pkgById('premium');

  // Raw months remaining on an existing Discord role (from the user's own entitlements).
  // Fractional — e.g. 0.4 means ~12 days left. null = unknown (no entitlement on record).
  const monthsLeft = (roleId) => {
    const exp = roleId ? entExpiry[roleId] : null;
    if (!exp || exp <= Date.now()) return null;
    return (exp - Date.now()) / (30 * 24 * 3600 * 1000);
  };
  // Cap a tracker's runtime to: the Premium runtime being bought now, AND/OR the time
  // still left on the package's own role. null = no cap (full RUNTIMES available).
  // A cap below 1 month means the role expires too soon — the PT can't be bought until
  // the subscription is extended.
  const trackerCap = (p) => {
    const caps = [];
    if (premiumInCart) caps.push(runtimeByKey(premiumRuntimeKey).months);
    const left = monthsLeft(p.roleId);
    if (left != null) caps.push(left);
    return caps.length ? Math.min(...caps) : null;
  };
  const premiumPlusCap = (() => {
    const caps = [];
    if (premiumInCart) caps.push(runtimeByKey(premiumRuntimeKey).months);
    const left = monthsLeft(premiumPkg?.roleId);
    if (left != null) caps.push(left);
    return caps.length ? Math.min(...caps) : null;
  })();

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

  const startTrial = async (packageId) => {
    setTrialMsg(''); setTrialBusy(true);
    try {
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/free-trial', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ packageId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      setTrialUsed(true);
      setTrialMsg(`✓ Your ${d.package} trial is live for ${d.days} days — check your DMs! 🤍`);
    } catch (e) { setTrialMsg('Could not start trial: ' + e.message); }
    setTrialBusy(false);
  };

  const remove = (i) => setBasket((b) => {
    const target = b[i];
    let next = b.filter((_, idx) => idx !== i);
    // Removing the Premium *purchase* — if you don't also own Premium via a role, you lose
    // access to everything Premium unlocked: Premium+ and any tracker for a package you
    // don't individually own all fly out of the cart too.
    if (target && target.kind === 'package' && target.pkgId === 'premium' && !owns.includes('premium')) {
      next = next.filter((x) => x.kind !== 'premiumplus');
      next = next.filter((x) => x.kind !== 'trackerOnly' || owns.includes(x.pkgId));
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
  const loyaltyOff = user.loyalty ? Math.round(analysisSubtotal * 10) / 100 : 0; // 10% on analysis only
  const afterLoyalty = total0 - loyaltyOff;
  // codes & vouchers never discount a gift-voucher purchase itself
  // A percent code may be scoped to certain product categories (empty scope = all).
  const codeScope = applied?.type === 'percent' ? (applied.scope || []) : [];
  const isPercentLike = applied?.type === 'percent' || applied?.type === 'referral';
  const inScope = (x) => x.disc !== 'voucher' && (codeScope.length === 0 || codeScope.includes(x.disc));
  const codeBase = isPercentLike
    ? lineItems.filter(inScope).reduce((s, x) => s + ((x.disc === 'analysis' && user.loyalty) ? x.price * 0.9 : x.price), 0)
    : 0;
  const codeOff = isPercentLike ? Math.round(codeBase * applied.percent) / 100 : 0;
  const voucherBase = Math.max(0, afterLoyalty - voucherPurchaseTotal);
  const voucherOff = applied?.type === 'voucher'
    ? (applied.percent ? Math.round(voucherBase * applied.percent) / 100 : Math.min(applied.amount, voucherBase))
    : 0;
  const beforeBalance = +(afterLoyalty - codeOff - voucherOff).toFixed(2);
  const balanceApplied = useBalance ? Math.min(balance, beforeBalance) : 0;
  const total = +(beforeBalance - balanceApplied).toFixed(2);
  const discKeys = [...new Set(lineItems.map((x) => x.disc))];

  // Discount lines appended to the order (so the ticket + transcript show them).
  const discountLines = [
    ...(loyaltyOff > 0 ? [{ name: 'Loyalty −10% (analysis)', price: -loyaltyOff }] : []),
    ...(codeOff > 0 ? [{ name: applied.type === 'referral' ? `Referral ${applied.code} −${applied.percent}%` : `Code ${applied.code} −${applied.percent}%`, price: -codeOff }] : []),
    ...(voucherOff > 0 ? [{ name: `Voucher ${applied.code}`, price: -voucherOff }] : []),
    ...(balanceApplied > 0 ? [{ name: 'Balance credit', price: -balanceApplied }] : []),
  ];

  // Packages the user can add a standalone tracker for.
  // = any trackable package you have access to (individually owned OR covered by Premium)
  //   and aren't buying as a package right now. Hidden entirely once Premium+ is in the
  //   cart, since Premium+ already covers every tracker.
  const ownedTrackable = hasPremiumPlus ? [] : cat.packages.filter(
    (p) => p.tracker && p.id !== 'premium' && !buyingIds.has(p.id) && (ownsPremium || owns.includes(p.id)),
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
              allowTracker={p.tracker && p.id !== 'premium' && !hasPremiumPlus}
              inCart={buyingIds.has(p.id)}
              covered={p.id !== 'premium' && buyingIds.has('premium')}
              onAdd={add} />
          ))}
        </div>

        {ownedTrackable.length > 0 && (
          <>
            <p className="eyebrow" style={{ marginTop: 30 }}>Portfolio Tracker</p>
            <h2 style={{ fontSize: 22, margin: '6px 0 6px' }}>Add Portfolio Tracker</h2>
            <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: '0 0 14px' }}>
              Add a tracker for any package individually — {fmt(cat.tracker.perPackage)}/mo each.
              Or pick Premium+ below for every tracker at once (selecting it clears the individual ones).
            </p>
            <div style={{ display: 'grid', gap: 10 }}>
              {ownedTrackable.map((p) => (
                <OwnedTrackerRow key={p.id} pkg={p} price={cat.tracker.perPackage}
                  maxMonths={trackerCap(p)} onAdd={add} />
              ))}
            </div>
          </>
        )}

        <PremiumPlusCard price={cat.tracker.premiumPlus} enabled={ownsPremium}
          active={hasPremiumPlus} maxMonths={premiumPlusCap} onAdd={add} />

        <FreeTrialCard packages={cat.packages.filter((p) => p.id !== 'premium')}
          used={trialUsed} busy={trialBusy} msg={trialMsg} onStart={startTrial} />

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
                      {applied.code} {applied.type === 'referral'
                        ? '(referral · your friend gets rewarded 🤍)'
                        : applied.type === 'voucher'
                          ? `(${applied.percent ? `−${applied.percent}%` : fmt(applied.amount)} voucher)`
                          : `(−${applied.percent}%${(applied.scope && applied.scope.length) ? ' · ' + applied.scope.map((s) => ({ analysis: 'Analysis', tracker: 'Tracker', deepdive: 'Deep Dive', coaching: 'Coaching' }[s] || s)).join(', ') : ''})`}
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

              {balance > 0 && (
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 12, cursor: 'pointer' }}>
                  <span style={{ fontSize: 13 }}>
                    Use my balance <span className="mono" style={{ color: 'var(--vsx-gold)' }}>({fmt(balance)})</span>
                  </span>
                  <input type="checkbox" checked={useBalance} onChange={(e) => setUseBalance(e.target.checked)} style={{ width: 18 }} />
                </label>
              )}

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
              discount: applied?.type === 'percent' ? { code: applied.code, percent: applied.percent, scope: applied.scope || [] } : null,
              redeemedVoucher: applied?.type === 'voucher' ? applied.code : null,
              referralCode: applied?.type === 'referral' ? applied.code : null,
              balanceUsed: balanceApplied || 0,
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
  const options = maxMonths != null ? RUNTIMES.filter((r) => r.months <= maxMonths) : RUNTIMES;
  const blocked = options.length === 0; // role expires in under 1 month → must extend first
  const [rtKey, setRtKey] = useState((options[0] || RUNTIMES[0]).key);
  // keep selection valid if the cap shrinks
  const valid = options.some((r) => r.key === rtKey) ? rtKey : (options[0] || RUNTIMES[0]).key;
  return (
    <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
      <div style={{ fontWeight: 500 }}>
        {pkg.name}
        {blocked && <div style={{ fontSize: 11, color: 'var(--vsx-muted)', fontWeight: 400, marginTop: 2 }}>Less than 1 month left — extend this subscription to add a tracker.</div>}
      </div>
      {blocked ? (
        <span style={{ fontSize: 12, color: 'var(--vsx-gold)', flexShrink: 0 }}>Extend to unlock</span>
      ) : (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={valid} onChange={(e) => setRtKey(e.target.value)} style={{ width: 'auto' }}>
            {options.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <button className="btn-ghost" onClick={() => onAdd({ kind: 'trackerOnly', pkgId: pkg.id, runtimeKey: valid })}>
            Add tracker
          </button>
        </div>
      )}
    </div>
  );
}

function PremiumPlusCard({ price, enabled, active, maxMonths, onAdd }) {
  const options = maxMonths != null ? RUNTIMES.filter((r) => r.months <= maxMonths) : RUNTIMES;
  const blocked = enabled && options.length === 0; // Premium expires in under 1 month
  const safe = options.length ? options : [RUNTIMES[0]];
  const [rtKey, setRtKey] = useState(safe[0].key);
  // clamp selection if the cap shrinks (e.g. Premium runtime changed)
  const effectiveKey = safe.some((r) => r.key === rtKey) ? rtKey : safe[0].key;
  const capLabel = options.length ? options.slice(-1)[0].label : '';
  return (
    <div className="card" style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, borderColor: 'var(--vsx-gold-2)', opacity: enabled ? 1 : 0.6 }}>
      <div>
        <p className="eyebrow">Add-on</p>
        <h3 style={{ fontSize: 19, marginTop: 4 }}>Premium+ · Portfolio Tracker</h3>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: '4px 0 0' }}>
          {!enabled
            ? 'Requires Premium — own the Premium role or add Premium to your cart.'
            : blocked
              ? 'Less than 1 month of Premium left — extend your Premium subscription to add Premium+.'
              : maxMonths != null
                ? `Portfolio Tracker for all your packages — ${fmt(price)}/mo. Runtime is capped to your Premium access (${capLabel}).`
                : `Portfolio Tracker for all your packages — ${fmt(price)}/mo.`}
        </p>
      </div>
      <div style={{ textAlign: 'right' }}>
        {!blocked && (
          <select value={effectiveKey} onChange={(e) => setRtKey(e.target.value)} style={{ width: 'auto', marginBottom: 8 }} disabled={!enabled}>
            {safe.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        )}
        <button className="btn" disabled={!enabled || active || blocked} onClick={() => onAdd({ kind: 'premiumplus', runtimeKey: effectiveKey })}>
          {active ? 'In cart' : blocked ? 'Extend first' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function FreeTrialCard({ packages, used, busy, msg, onStart }) {
  const [pid, setPid] = useState(packages[0]?.id || '');
  if (!packages.length) return null;
  return (
    <div className="card" style={{ marginTop: 18, borderColor: 'var(--vsx-gold-2)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 220, flex: 1 }}>
          <p className="eyebrow">Free trial</p>
          <h3 style={{ fontSize: 19, marginTop: 4 }}>Try one package — 5 days free</h3>
          <p style={{ color: 'var(--vsx-muted)', fontSize: 13, margin: '4px 0 0' }}>
            {used
              ? 'You\u2019ve already used your free trial. 🤍'
              : 'Pick any analysis package (except Premium) and test it free for 5 days. One trial per customer, ever.'}
          </p>
        </div>
        {!used && (
          <div style={{ textAlign: 'right' }}>
            <select value={pid} onChange={(e) => setPid(e.target.value)} style={{ width: 'auto', marginBottom: 8 }} disabled={busy}>
              {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="btn" disabled={busy || !pid} onClick={() => onStart(pid)}>{busy ? 'Starting…' : 'Start free trial'}</button>
          </div>
        )}
      </div>
      {msg && <p style={{ fontSize: 13, marginTop: 10, color: msg.startsWith('✓') ? 'var(--vsx-ok)' : 'var(--vsx-err)' }}>{msg}</p>}
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
