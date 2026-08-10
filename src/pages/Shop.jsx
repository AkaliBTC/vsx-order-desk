import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { collection, addDoc, doc, getDoc, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useAuth } from '../auth';
import { useCatalogue } from '../catalogue';
import { postTicketEmbed } from '../lib';
import { RUNTIMES, DISCLAIMERS, DISCLAIMER_PDF, runtimeByKey, fmt, coachBulkPercent, COACH_BULK_MIN } from '../data';

// Optical price treatment. Takes the string fmt() already produced and
// sets the currency symbol and the cents at 60%, so $22.00 reads as a
// large confident 22 with quiet ornament around it. Display only — it
// does not parse, round or alter any value.
function Au({ value }) {
  const m = /^([^\d]*)(\d[\d,]*)(\.\d+)?(.*)$/.exec(String(value));
  if (!m) return <>{value}</>;
  const [, sym, whole, cents, rest] = m;
  return (
    <>
      {sym && <span className="au-sym">{sym}</span>}
      {whole}
      {cents && <span className="au-cent">{cents}</span>}
      {rest}
    </>
  );
}

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
  const [info, setInfo] = useState('');   // info popup (e.g. extend-analysis-to-add-tracker)
  const [deepDiveOpen, setDeepDiveOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(null);   // coach service id or null

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

  // Raw months remaining on an existing Discord role (from the user's own entitlements),
  // with a 1-day tolerance so a tracker can still be added right after buying the analysis
  // (time drift between the two purchases shouldn't block it). null = unknown.
  const ONE_DAY = 24 * 3600 * 1000;
  const monthsLeft = (roleId) => {
    const exp = roleId ? entExpiry[roleId] : null;
    if (!exp || exp <= Date.now()) return null;
    return (exp - Date.now() + ONE_DAY) / (30 * ONE_DAY);
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
      const r = await fetch('/api/me?action=trial', {
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
  // Coaching bulk discount — every coaching in the cart counts toward one total,
  // regardless of which coach it is. Kicks in from 3 sessions, saturates near 10%.
  const coachLines = lineItems.filter((x) => x.disc === 'coaching');
  const coachCount = coachLines.length;
  const coachSubtotal = coachLines.reduce((s, x) => s + x.price, 0);
  const coachPct = coachBulkPercent(coachCount);
  const coachBulkOff = Math.round(coachSubtotal * coachPct) / 100;
  const afterLoyalty = total0 - loyaltyOff - coachBulkOff;
  // codes & vouchers never discount a gift-voucher purchase itself
  // A percent code may be scoped to certain product categories (empty scope = all).
  const codeScope = applied?.type === 'percent' ? (applied.scope || []) : [];
  const isPercentLike = applied?.type === 'percent' || applied?.type === 'referral';
  const inScope = (x) => x.disc !== 'voucher' && (codeScope.length === 0 || codeScope.includes(x.disc));
  const codeBase = isPercentLike
    ? lineItems.filter(inScope).reduce((s, x) => {
        if (x.disc === 'analysis' && user.loyalty) return s + x.price * 0.9;
        if (x.disc === 'coaching' && coachPct > 0) return s + x.price * (1 - coachPct / 100);
        return s + x.price;
      }, 0)
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
    ...(coachBulkOff > 0 ? [{ name: `Coaching bulk ×${coachCount} −${coachPct.toFixed(2)}%`, price: -coachBulkOff }] : []),
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

  // Lowest effective monthly rate across the catalogue. Read-only: it drives
  // the headline copy so the page can never quote a price the shop doesn't
  // actually offer.
  const fromMonthly = (() => {
    const rates = cat.packages
      .filter((p) => p.id !== 'premium' && p.prices['1M'] != null && p.prices['1M'] !== '')
      .map((p) => Number(p.prices['1M']));
    return rates.length ? Math.min(...rates) : null;
  })();

  return (
    <>
      <Hero fromMonthly={fromMonthly} />
      <Proof />
      <IncludedStrip freebies={cat.freebies} />

      <div className="shell cols-main" id="packs" style={{ paddingBottom: 120 }}>
      <section>
        <div className="rule-head"><p className="eyebrow">Subscriptions</p></div>
        <h1 style={{ fontSize: 'clamp(32px,4vw,52px)', margin: '20px 0 10px' }}>Choose your coverage</h1>
        <p style={{ color: 'var(--tx-2)', fontSize: 14, maxWidth: '52ch', margin: '0 0 18px' }}>
          Pick the markets you actually trade. Longer terms cost less per month, and every pack ships
          the macro and practice channels.
        </p>
        {fromMonthly != null && (
          <p style={{ fontSize: 14, margin: '0 0 32px', color: 'var(--tx-2)' }}>
            Comparable research desks charge <span style={{ color: 'var(--tx-1)' }}>$50 to $100 a month</span>.
            {' '}Ours start at <span className="mono" style={{ color: 'var(--au-primary)' }}>{fmt(fromMonthly)}</span>,
            {' '}because we live from our trading, not from your subscription.
          </p>
        )}

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
            <div className="rule-head" style={{ marginTop: 56 }}><p className="eyebrow">Portfolio Tracker</p></div>
            <h2 style={{ fontSize: 30, margin: '16px 0 8px' }}>Add Portfolio Tracker</h2>
            <p style={{ color: 'var(--tx-2)', fontSize: 13, margin: '0 0 18px', maxWidth: '62ch' }}>
              Add a tracker for any package individually — {fmt(cat.tracker.perPackage)}/mo each.
              Or pick Premium+ below for every tracker at once (selecting it clears the individual ones).
            </p>
            <div style={{ display: 'grid', gap: 10 }}>
              {ownedTrackable.map((p) => (
                <OwnedTrackerRow key={p.id} pkg={p} price={cat.tracker.perPackage}
                  maxMonths={trackerCap(p)} onAdd={add} onInfo={setInfo} />
              ))}
            </div>
          </>
        )}

        <PremiumPlusCard price={cat.tracker.premiumPlus} enabled={ownsPremium}
          active={hasPremiumPlus} maxMonths={premiumPlusCap} onAdd={add} onInfo={setInfo} />

        {(!trialUsed || trialMsg) && (
          <FreeTrialCard packages={cat.packages.filter((p) => p.id !== 'premium')}
            used={trialUsed} busy={trialBusy} msg={trialMsg} onStart={startTrial} />
        )}

        <div className="rule-head" style={{ marginTop: 56 }}><p className="eyebrow">Services</p></div>
        <h2 style={{ fontSize: 30, margin: '16px 0 10px' }}>Deep Dives & Coaching</h2>
        <p style={{ color: 'var(--tx-2)', fontSize: 13, margin: '0 0 20px', maxWidth: '62ch' }}>
          {coachCount >= COACH_BULK_MIN ? (
            <>Coaching bulk discount active: <span style={{ color: 'var(--vsx-gold)' }}>−{coachPct.toFixed(2)}%</span> on
              {' '}{coachCount} sessions. Add one more for −{coachBulkPercent(coachCount + 1).toFixed(2)}%.</>
          ) : (
            <>Book <span style={{ color: 'var(--vsx-gold)' }}>{COACH_BULK_MIN}+ coaching sessions</span> for an automatic bulk
              discount — all coaches count together, up to −10%.</>
          )}
        </p>
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
                {s.id === 'deepdive' && (
                  <button onClick={() => setDeepDiveOpen(true)}
                    style={{ background: 'none', border: 'none', padding: '6px 0 0', color: 'var(--vsx-gold)', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
                    What's included ↗
                  </button>
                )}
                {s.id.startsWith('coach-') && (
                  <button onClick={() => setCoachOpen(s.id)}
                    style={{ background: 'none', border: 'none', padding: '6px 0 0', color: 'var(--vsx-gold)', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
                    What's included ↗
                  </button>
                )}
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div className="mono display" style={{ fontSize: 30, lineHeight: 1, letterSpacing: '-.02em', color: 'var(--tx-1)' }}>
                  <Au value={fmt(s.price)} /><span style={{ fontSize: 13, color: 'var(--tx-3)' }}>{s.unit || ''}</span>
                </div>
                <motion.button className="btn-ghost" whileTap={{ scale: 0.96 }} style={{ marginTop: 8 }} onClick={() => add({ kind: 'service', serviceId: s.id })}>Add</motion.button>
              </div>
            </motion.div>
          ))}
        </div>

        <div className="rule-head" style={{ marginTop: 56 }}><p className="eyebrow">Gift</p></div>
        <h2 style={{ fontSize: 30, margin: '16px 0 16px' }}>Gift Voucher</h2>
        <GiftVoucherCard onAdd={add} />
      </section>

      <aside>
        <div className="card cart-aside" style={{ position: 'sticky', top: 96 }}>
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
                    style={{ color: 'var(--au-primary)', fontSize: 28, lineHeight: 1, letterSpacing: '-.02em' }}><Au value={fmt(total)} /></motion.span>
                </AnimatePresence>
              </div>
              <motion.button className="btn" whileTap={{ scale: 0.97 }} style={{ width: '100%', marginTop: 16 }} onClick={() => setConsentOpen(true)}>Open ticket</motion.button>
            </>
          )}
        </div>
      </aside>
      </div>

      <HowItWorks />
      <FreeTier />
      <Faq />
      <ClosingCta />
      <SiteFooter />

      {lineItems.length > 0 && (
        <div className="checkout-bar">
          <div>
            <span className="eyebrow eyebrow-plain">Order total</span>
            <div className="mono display" style={{ fontSize: 24, lineHeight: 1.1, color: 'var(--au-primary)' }}>
              <Au value={fmt(total)} />
            </div>
          </div>
          <button className="btn" onClick={() => setConsentOpen(true)}>Open ticket</button>
        </div>
      )}

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

      <AnimatePresence>
        {info && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setInfo('')}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 60 }}>
            <motion.div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440, width: '100%' }}
              initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 26 }}>
              <p className="eyebrow">Heads up</p>
              <h3 style={{ fontSize: 20, margin: '6px 0 8px' }}>Extend your analysis first</h3>
              <p style={{ color: 'var(--vsx-muted)', fontSize: 14, margin: 0 }}>{info}</p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
                <button className="btn" onClick={() => setInfo('')}>Got it</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deepDiveOpen && <DeepDiveInfo onClose={() => setDeepDiveOpen(false)} />}
      </AnimatePresence>

      <AnimatePresence>
        {coachOpen && <CoachingInfo coach={coachOpen} onClose={() => setCoachOpen(null)} />}
      </AnimatePresence>
    </>
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
    <motion.div className={`card${pkg.highlight ? ' is-premium' : ''}`}
      initial={{ opacity: 0, y: 20, filter: 'blur(10px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.6, delay: index * 0.05, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -2, transition: { type: 'spring', stiffness: 320, damping: 26 } }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: covered ? 0.55 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 22, lineHeight: 1.15 }}>{pkg.name}</h3>
        {pkg.highlight && <span className="tag gold">Everything we publish</span>}
      </div>
      <p style={{ color: 'var(--tx-2)', fontSize: 13, lineHeight: 1.55, margin: 0, minHeight: 62 }}>{pkg.desc}</p>
      <span style={{ display: 'block', height: 1, background: 'var(--au-hairline)', margin: '6px 0' }} />
      <select value={rtKey} onChange={(e) => setRtKey(e.target.value)} disabled={disabled}>
        {RUNTIMES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
      </select>
      <AnimatePresence mode="wait">
        <motion.div key={soon ? 'soon' : price} className="mono display"
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25 }}
          style={{ fontSize: 34, lineHeight: 1, letterSpacing: '-.02em', color: soon ? 'var(--tx-3)' : 'var(--tx-1)' }}>
          {soon ? <span style={{ fontSize: 20, color: 'var(--tx-3)' }}>Coming soon</span> : <Au value={fmt(price)} />}
        </motion.div>
      </AnimatePresence>
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {allowTracker && !inCart && !covered && (
          <label style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, color: tracker ? 'var(--tx-1)' : 'var(--tx-2)', cursor: 'pointer', padding: '12px 14px', borderRadius: 'var(--r-ctl)', background: 'var(--vsx-inset)', border: `1px solid ${tracker ? 'var(--au-line)' : 'var(--au-hairline)'}`, transition: 'border-color .35s, color .3s' }}>
            <input type="checkbox" checked={tracker} onChange={(e) => setTracker(e.target.checked)} />
            Portfolio Tracker · {fmt(trackerPrice)}/mo
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, letterSpacing: '.12em', color: tracker ? 'var(--au-primary)' : 'var(--tx-3)' }}>{tracker ? 'ON' : 'OFF'}</span>
          </label>
        )}
        <motion.button className="btn" disabled={disabled} whileTap={{ scale: 0.96 }}
          onClick={() => onAdd({ kind: 'package', pkgId: pkg.id, runtimeKey: rtKey, withTracker: tracker })}>{label}</motion.button>
      </div>
    </motion.div>
  );
}

function OwnedTrackerRow({ pkg, price, maxMonths, onAdd, onInfo }) {
  const options = maxMonths != null ? RUNTIMES.filter((r) => r.months <= maxMonths) : RUNTIMES;
  const blocked = options.length === 0; // role expires in under 1 month → must extend first
  const [rtKey, setRtKey] = useState((options[0] || RUNTIMES[0]).key);
  // keep selection valid if the cap shrinks
  const valid = options.some((r) => r.key === rtKey) ? rtKey : (options[0] || RUNTIMES[0]).key;
  const infoMsg = `Your ${pkg.name} analysis runs out too soon to add a Portfolio Tracker for it. Please extend your ${pkg.name} analysis subscription first — then you can add the tracker for the matching duration.`;
  return (
    <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
      <div style={{ fontWeight: 500 }}>
        {pkg.name}
        {blocked && <div style={{ fontSize: 11, color: 'var(--vsx-muted)', fontWeight: 400, marginTop: 2 }}>Less than 1 month left — extend to add a tracker.</div>}
      </div>
      {blocked ? (
        <button className="btn-ghost" style={{ fontSize: 12, color: 'var(--vsx-gold)', flexShrink: 0 }} onClick={() => onInfo && onInfo(infoMsg)}>Extend to unlock ⓘ</button>
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

function PremiumPlusCard({ price, enabled, active, maxMonths, onAdd, onInfo }) {
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
        <button className="btn" disabled={!enabled || active || blocked} onClick={() => blocked ? (onInfo && onInfo('Your Premium analysis runs out too soon to add Premium+. Please extend your Premium subscription first, then add Premium+ for the matching duration.')) : onAdd({ kind: 'premiumplus', runtimeKey: effectiveKey })}>
          {active ? 'In cart' : blocked ? 'Extend first' : 'Add'}
        </button>
        {blocked && <button className="btn-ghost" style={{ fontSize: 11, color: 'var(--vsx-gold)', marginTop: 6, display: 'block', marginLeft: 'auto' }} onClick={() => onInfo && onInfo('Your Premium analysis runs out too soon to add Premium+. Please extend your Premium subscription first, then add Premium+ for the matching duration.')}>Why? ⓘ</button>}
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
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, overflowY: 'auto', zIndex: 50 }}>
      <motion.div className="card" style={{ maxWidth: 560, width: '100%', maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', margin: 'auto' }}
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

const DD_TA = [
  ['Multi-Timeframe Elliott Wave', 'HTF structure · MTF/LTF refinement · Alt scenario'],
  ['Full Indicator Stack', 'MACD · RSI · SQZ MOM · ADX · Ichimoku'],
  ['Trend & Width Signals', 'Supertrend · McClellan · AK Cycle Confirmation'],
  ['Time & Cycle Analysis', 'Sine curve LTF · Time cycles HTF · Seasonality'],
  ['Harmonics & Chart Patterns', 'Log chart analysis · Key level commentary'],
];
const DD_FA = [
  ['Base Fundamentals', 'Snapshot with metric commentary'],
  ['Institutions & Smart Money', 'Ownership · Allocations · Analyst consensus'],
  ['On-Chain & Derivatives', 'OI · Funding · Premium · Liquidations'],
  ['Whale & Wallet Flows', 'Notable positions · Institutional exposure'],
  ['Sector Cycle & Catalysts', 'RRG rotation · Relevant news & events'],
];

function CoverageColumn({ eyebrow, title, items }) {
  return (
    <div className="card" style={{ background: 'var(--vsx-charcoal-3)', display: 'grid', gap: 0, alignContent: 'start', height: '100%' }}>
      <p className="eyebrow" style={{ margin: '0 0 6px' }}>{eyebrow}</p>
      <h3 className="display" style={{ fontSize: 24, margin: '0 0 10px', letterSpacing: 0.5 }}>{title}</h3>
      {items.map(([name, sub], i) => (
        <div key={name} style={{ display: 'flex', gap: 10, padding: '11px 0', borderTop: i === 0 ? 'none' : '1px solid var(--vsx-line)' }}>
          <span style={{ color: 'var(--vsx-gold)', fontSize: 12, lineHeight: '20px' }}>◆</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{name}</div>
            <div className="mono" style={{ color: 'var(--vsx-muted)', fontSize: 12, marginTop: 2 }}>{sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function DeepDiveInfo({ onClose }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.72)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, overflowY: 'auto', zIndex: 60 }}>
      <motion.div className="card" onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520, width: '100%', maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', margin: 'auto', borderColor: 'var(--vsx-gold-2)' }}
        initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 280, damping: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <p className="eyebrow" style={{ margin: 0 }}>VisionX Market Analytics</p>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--vsx-muted)', fontSize: 20, lineHeight: 1, cursor: 'pointer', padding: 0 }}>×</button>
        </div>
        <h2 className="display" style={{ fontSize: 42, lineHeight: 1, margin: '6px 0 6px',
          background: 'var(--au-fill)',
          WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          DEEP DIVES
        </h2>
        <p style={{ fontSize: 14, margin: '0 0 20px' }}>
          One asset. Every angle. <span style={{ color: 'var(--vsx-gold-2)' }}>Institutional-grade market reports.</span>
        </p>

        <div className="stack">
          <CoverageColumn eyebrow="Technical Analysis" title="TA Coverage" items={DD_TA} />
          <CoverageColumn eyebrow="Fundamental Analysis" title="FA Coverage" items={DD_FA} />
        </div>

        <p className="mono" style={{ textAlign: 'center', color: 'var(--vsx-muted)', fontSize: 11, letterSpacing: 1, margin: '20px 0 6px' }}>
          AVAILABLE VIA DISCORD · IN-DEPTH MARKET REPORTS · TA + FA
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

const COACHES = {
  'coach-filip': {
    tier: 'Essential', name: 'Filip', price: '$150', unit: 'hour',
    items: [
      ['Elliott Wave Basics', 'Impulse · Zigzag · Flat · Triangle · Diagonal'],
      ['Fibonacci in EW', 'Retracements & extensions for all different waves'],
      ['TA Foundations', 'Trend & trend switch · Trendlines · S/R · Dow Theory · How price action develops'],
      ['Portfolio Allocation', 'Relative strength approach'],
    ],
  },
  'coach-michael': {
    tier: 'Advanced', name: 'Michael', price: '$250', unit: 'hour',
    items: [
      ['Deep Dive Elliott Wave', 'Classic · Complex · AK Tweaks'],
      ['Smart Money Concepts', 'BoS · CHoCH · EQL/EQH · FVG · OB · BFVG'],
      ['Chart Patterns', 'HnS · Wedges & more'],
      ['Market Width', ''],
    ],
    bonus: {
      title: '+ Bonus · Fundamentals',
      lines: [
        ['Stocks', 'Finviz: short float, insider, institutional'],
        ['Crypto', 'Velo · Coinalyze · Coinglass · Aggr'],
      ],
    },
  },
  'coach-akali': {
    tier: 'Expert', name: 'Akali', price: '$350', unit: 'hour',
    items: [
      ['Indicators', 'Advanced indicator work across timeframes'],
      ['Time Analysis', 'Time-based cycle methodology'],
      ['Harmonics', 'Harmonic pattern trading'],
    ],
  },
};

function CoachingInfo({ coach, onClose }) {
  const c = COACHES[coach];
  if (!c) return null;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.72)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, overflowY: 'auto', zIndex: 60 }}>
      <motion.div className="card" onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520, width: '100%', maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', margin: 'auto', borderColor: 'var(--vsx-gold-2)' }}
        initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 280, damping: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <p className="eyebrow" style={{ margin: 0 }}>VisionX Market Analytics</p>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--vsx-muted)', fontSize: 20, lineHeight: 1, cursor: 'pointer', padding: 0 }}>×</button>
        </div>
        <h2 className="display" style={{ fontSize: 42, lineHeight: 1, margin: '6px 0 6px',
          background: 'var(--au-fill)',
          WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          COACHING
        </h2>
        <p style={{ fontSize: 14, margin: '0 0 20px' }}>
          1-on-1 sessions. <span style={{ color: 'var(--vsx-gold-2)' }}>Learn the craft from our analysts.</span>
        </p>

        <div className="card" style={{ background: 'var(--vsx-charcoal-3)' }}>
          <p className="eyebrow" style={{ margin: '0 0 4px' }}>{c.tier}</p>
          <h3 className="display" style={{ fontSize: 34, margin: '0 0 6px', letterSpacing: 0.5 }}>{c.name}</h3>
          <div className="mono" style={{ fontSize: 22, color: 'var(--vsx-gold)', marginBottom: 4 }}>
            {c.price}<span style={{ fontSize: 13, color: 'var(--vsx-muted)' }}> / {c.unit}</span>
          </div>
          <div style={{ borderTop: '1px solid var(--vsx-gold-2)', opacity: 0.5, margin: '10px 0 2px' }} />
          {c.items.map(([name, sub], i) => (
            <div key={name} style={{ display: 'flex', gap: 10, padding: '11px 0', borderTop: i === 0 ? 'none' : '1px solid var(--vsx-line)' }}>
              <span style={{ color: 'var(--vsx-gold)', fontSize: 12, lineHeight: '20px' }}>◆</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{name}</div>
                {sub && <div className="mono" style={{ color: 'var(--vsx-muted)', fontSize: 12, marginTop: 2 }}>{sub}</div>}
              </div>
            </div>
          ))}
          {c.bonus && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--vsx-line)' }}>
              <p className="eyebrow" style={{ margin: '0 0 8px' }}>{c.bonus.title}</p>
              {c.bonus.lines.map(([k, v]) => (
                <div key={k} className="mono" style={{ fontSize: 12, color: 'var(--vsx-muted)', marginBottom: 4 }}>
                  <span style={{ color: 'var(--vsx-offwhite)' }}>{k}</span> — {v}
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="mono" style={{ textAlign: 'center', color: 'var(--vsx-muted)', fontSize: 11, letterSpacing: 1, margin: '20px 0 6px' }}>
          AVAILABLE VIA DISCORD · TA & FA COACHING · 1-ON-1
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ======================================================================
   Sales page — presentational only. None of the components below read or
   write basket state, pricing or entitlements.
   ====================================================================== */

function RuleHead({ children }) {
  return <div className="rule-head"><p className="eyebrow">{children}</p></div>;
}

// The right-hand hero panel. An abstract sequence, not a live chart and not
// a dashboard mock-up: hollow gold up-candles, dark down-candles, drawn once.
// [bodyTop, bodyHeight, isUp, upperWick, lowerWick] — wicks are drawn as two
// separate segments above and below the body, never through it.
const CANDLES = [
  [64, 30, 0, 10, 14], [58, 24, 1, 16, 8],  [61, 34, 0, 6, 12],  [52, 20, 1, 12, 10],
  [56, 26, 1, 8, 16],  [44, 18, 0, 14, 6],  [48, 30, 0, 10, 10], [40, 22, 1, 18, 8],
  [46, 26, 0, 6, 14],  [34, 16, 1, 12, 12], [38, 24, 1, 8, 6],   [28, 14, 0, 16, 10],
  [33, 22, 0, 10, 8],  [24, 12, 1, 14, 14], [29, 20, 0, 8, 10],  [20, 30, 0, 12, 6],
  [26, 40, 0, 6, 16],  [18, 26, 0, 18, 10],
];

function HeroSequence() {
  return (
    <div className="card" style={{ position: 'relative', minHeight: 460, padding: 28, overflow: 'hidden' }}>
      <p className="eyebrow eyebrow-plain" style={{ margin: 0 }}>Sequence</p>
      <motion.svg viewBox="0 0 420 300" width="100%" height="330" aria-hidden
        style={{ display: 'block', marginTop: 24 }}
        initial={{ clipPath: 'inset(0 100% 0 0)' }}
        animate={{ clipPath: 'inset(0 0% 0 0)' }}
        transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1] }}>
        {CANDLES.map(([y, h, up, uw, lw], i) => {
          const x = 12 + i * 22;
          const top = y * 3;
          const bottom = top + h * 3;
          const stroke = up ? 'var(--au-primary)' : '#3A322B';
          return (
            <g key={i}>
              <line x1={x + 6} y1={top - uw} x2={x + 6} y2={top} stroke={stroke} strokeWidth="1.2" />
              <line x1={x + 6} y1={bottom} x2={x + 6} y2={bottom + lw} stroke={stroke} strokeWidth="1.2" />
              <rect x={x} y={top} width="12" height={h * 3} rx="1"
                fill={up ? 'var(--vsx-panel)' : 'var(--vsx-panel-hi)'}
                stroke={stroke} strokeWidth="1.2" />
            </g>
          );
        })}
      </motion.svg>
      <span className="mono" style={{ position: 'absolute', bottom: 22, left: 28, right: 28, fontSize: 11, letterSpacing: '.06em', color: 'var(--tx-3)' }}>
        PUBLISHED BEFORE THE MOVE
      </span>
    </div>
  );
}

function Hero({ fromMonthly }) {
  const scrollTo = (id) => () => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <section className="hero-section" style={{ position: 'relative', maxWidth: 1280, margin: '0 auto', padding: '0 40px 120px' }}>
      <div aria-hidden className="hero-light"
        style={{ position: 'absolute', left: '2%', top: '6%', width: 620, height: 420, pointerEvents: 'none' }} />
      <div className="hero-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,7fr) minmax(0,5fr)', gap: 28, alignItems: 'center' }}>
        <div style={{ position: 'relative', padding: '72px 0' }}>
          <RuleHead>Independent market analysis house</RuleHead>
          <h1 style={{ fontSize: 'clamp(40px,7vw,88px)', lineHeight: 0.92, letterSpacing: '-.025em', margin: '32px 0 0' }}>
            <motion.span style={{ display: 'block' }}
              initial={{ opacity: 0, y: 20, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.7, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}>We called</motion.span>
            <motion.span style={{ display: 'block' }}
              initial={{ opacity: 0, y: 20, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.7, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}>the Nikkei crash.</motion.span>
            <motion.span style={{ display: 'block', color: 'var(--tx-2)' }}
              initial={{ opacity: 0, y: 20, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.7, delay: 0.23, ease: [0.16, 1, 0.3, 1] }}>People still got liquidated.</motion.span>
          </h1>
          <motion.p style={{ maxWidth: '62ch', margin: '30px 0 0', fontSize: 15, lineHeight: 1.65, color: 'var(--tx-2)' }}
            initial={{ opacity: 0, y: 20, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.7, delay: 0.32, ease: [0.16, 1, 0.3, 1] }}>
            August 2024. We saw the move and published it. Watching people get wiped out anyway is why
            VisionX exists. We trade our own capital, no client money and no external investors, and we
            publish the analysis, the research and the reasoning behind it.
          </motion.p>
          <motion.div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 34 }}
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}>
            <button className="btn" onClick={scrollTo('packs')}>See the packs</button>
            <button className="btn-ghost" onClick={scrollTo('free')}>Watch us for free</button>
          </motion.div>
          <div className="hero-facts">
            <span>{fromMonthly != null ? `From ${fmt(fromMonthly)} / month` : 'Transparent pricing'}</span>
            <span>Own capital only</span>
            <span>Published track record</span>
          </div>
        </div>
        <div className="hide-sm" style={{ position: 'relative' }}>
          <HeroSequence />
        </div>
      </div>
    </section>
  );
}

function IncludedStrip({ freebies }) {
  return (
    <section className="section" style={{ paddingBottom: 120 }}>
      <div className="card card-inset" style={{ padding: '34px 40px', display: 'grid', gridTemplateColumns: 'minmax(180px,240px) 1fr', gap: 40, alignItems: 'center' }}>
        <RuleHead>Included in every pack</RuleHead>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 24 }}>
          {freebies.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <span style={{ marginTop: 8, width: 7, height: 7, background: 'var(--au-primary)', transform: 'rotate(45deg)', flex: 'none' }} />
              <span style={{ fontSize: 14, lineHeight: 1.55 }}>{f}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FreeTier() {
  const rows = [
    'One full analysis every week.',
    'The public portfolio view.',
    'The community.',
  ];
  return (
    <section className="section" id="free">
      <div className="card card-inset" style={{ padding: '44px 40px' }}>
        <RuleHead>No subscription required</RuleHead>
        <h2 style={{ fontSize: 30, margin: '18px 0 24px' }}>Watch us first</h2>
        <div style={{ maxWidth: '62ch' }}>
          {rows.map((r, i) => (
            <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderTop: i === 0 ? 'none' : '1px solid var(--au-hairline)' }}>
              <span style={{ width: 7, height: 7, background: 'var(--au-primary)', transform: 'rotate(45deg)', flex: 'none' }} />
              <span style={{ fontSize: 15 }}>{r}</span>
            </div>
          ))}
        </div>
        <p style={{ color: 'var(--tx-2)', fontSize: 15, maxWidth: '62ch', margin: '20px 0 26px' }}>
          We'd rather convince you with the product than with a sales pitch.
        </p>
        <a className="btn-ghost" href="https://discord.gg/b8btM4zdRr" target="_blank" rel="noreferrer"
          style={{ display: 'inline-block', textDecoration: 'none' }}>Join the Discord</a>
      </div>
    </section>
  );
}

const FAQ_ITEMS = [
  ['What is VisionX?',
    'An independent market analysis house. We trade our own capital, no client money and no external investors, and we share our analysis, research and education with the community. We started after the Nikkei crash in August 2024: we predicted the move, but watched too many people get liquidated anyway. VisionX exists so that does not happen to you.'],
  ['If you want to help people, why are subscriptions paid?',
    'Because we do not live from your subscription, we live from our trading. The packs cover the operational cost of running this at a professional level: infrastructure, research time, reporting. That is also why our prices sit far below what comparable services charge. We are not optimising for subscription revenue.'],
  ['How do I know your analysis is actually good?',
    'You do not have to take our word for it. Our track record channel documents closed trades in full, with entries and exits, and the Quarterly Performance Memorandum reports the rest. We always publish hit rate together with sample size and average risk/reward, because a hit rate on its own means nothing.'],
  ['Are your analyses trading signals?',
    'No. We document our own trading and explain our reasoning so you learn how we think. Nothing we publish is investment advice or a recommendation to copy. See our disclaimer.'],
  ['How often do you post updates?',
    'It depends on the asset volatility. Crypto every weekday, Stocks twice a week, Commodities and Indices when market conditions actually change. We do not post noise to look busy.'],
  ['What is included in the packs?',
    'Every subscriber gets the macro economy channel and the practice channel. Crypto, Stocks and Premium also include the educational channel. The full overview lives in our products channel.'],
  ['How do I subscribe?',
    'Add what you want to your order and check out with PayPal or USDT (TRC20). You can also open a ticket in Discord and our team will set you up. No refunds on delivered analysis periods.'],
  ['What do I get for free?',
    'One full analysis every week, the public portfolio view, and the community. We would rather convince you with the product than with a sales pitch.'],
];

function Faq() {
  const [open, setOpen] = useState(null);
  return (
    <section className="section" id="faq">
      <div className="faq">
        <RuleHead>Questions</RuleHead>
        <h2 style={{ fontSize: 30, margin: '18px 0 28px' }}>FAQ</h2>
        {FAQ_ITEMS.map(([q, a], i) => (
          <div key={q} className={`faq-item${open === i ? ' open' : ''}`}>
            <button className="faq-q" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
              <span>{q}</span>
              <span className="faq-mark" aria-hidden>+</span>
            </button>
            <AnimatePresence initial={false}>
              {open === i && (
                <motion.div key="a" style={{ overflow: 'hidden' }}
                  initial={{ height: 0, opacity: 0, filter: 'blur(8px)' }}
                  animate={{ height: 'auto', opacity: 1, filter: 'blur(0px)' }}
                  exit={{ height: 0, opacity: 0, filter: 'blur(8px)' }}
                  transition={{ type: 'spring', stiffness: 260, damping: 32 }}>
                  <p className="faq-a">{a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-grid">
        <div className="footer-col">
          <span className="display wordmark" style={{ fontSize: 22 }}>VISIONX</span>
          <p style={{ color: 'var(--tx-2)', fontSize: 14, maxWidth: '34ch', margin: '12px 0 0' }}>
            Independent market analysis house. We trade our own capital and publish the reasoning.
          </p>
        </div>
        <div className="footer-col">
          <h4>Products</h4>
          <a href="#packs">Analysis packs</a>
          <a href="#packs">Portfolio Tracker</a>
          <a href="#packs">Deep Dives &amp; Coaching</a>
        </div>
        <div className="footer-col">
          <h4>Community</h4>
          <a href="https://discord.gg/b8btM4zdRr" target="_blank" rel="noreferrer">Discord</a>
          <a href="#free">Free analysis</a>
          <a href="#free">Track record</a>
        </div>
        <div className="footer-col">
          <h4>Legal</h4>
          <a href={DISCLAIMER_PDF.analysis} target="_blank" rel="noreferrer">Risk disclosure</a>
          <a href={DISCLAIMER_PDF.deepdive} target="_blank" rel="noreferrer">Deep Dive terms</a>
          <a href={DISCLAIMER_PDF.tracker} target="_blank" rel="noreferrer">Tracker terms</a>
          <a href={DISCLAIMER_PDF.coaching} target="_blank" rel="noreferrer">Coaching terms</a>
        </div>
      </div>
      <div className="footer-bar">
        <div>
          VisionX Market Analytics provides educational and analytical content only. Nothing published
          constitutes investment advice, a personal recommendation, or an offer to buy or sell any
          financial instrument. Trading involves substantial risk of loss.
        </div>
      </div>
    </footer>
  );
}

// Proof, not persuasion. Every claim here is something a visitor can go and
// check for themselves in the Discord — no invented statistics, no logo wall,
// no testimonial carousel.
const PROOF = [
  ['Own capital only', 'No client money and no external investors. We are exposed to every call we publish, which is the only incentive alignment that actually holds.'],
  ['Published before the move', 'Analysis goes out before the market resolves it, not after. The timestamp is the argument.'],
  ['Hit rate with sample size', 'Closed trades are documented in full, entries and exits. We always report hit rate together with sample size and average risk/reward, because a hit rate on its own means nothing.'],
];

function Proof() {
  return (
    <section className="section" style={{ paddingBottom: 120 }}>
      <RuleHead>Why anyone should listen</RuleHead>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 28, marginTop: 28 }}>
        {PROOF.map(([title, body], i) => (
          <motion.div key={title} className="card"
            initial={{ opacity: 0, y: 20, filter: 'blur(10px)' }} whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.6, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}>
            <span className="mono" style={{ fontSize: 11, letterSpacing: '.16em', color: 'var(--au-core)' }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3 style={{ fontSize: 22, margin: '14px 0 10px' }}>{title}</h3>
            <p style={{ color: 'var(--tx-2)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>{body}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

const STEPS = [
  ['Pick your markets', 'Choose the packs that match what you actually trade. Longer terms cost less per month.'],
  ['Open a ticket', 'Check out with PayPal or USDT. Your Discord roles are granted as soon as payment lands.'],
  ['Read the reasoning', 'Analysis, the macro report and the practice channel, from the first day of your term.'],
];

function HowItWorks() {
  return (
    <section className="section">
      <RuleHead>How it works</RuleHead>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 28, marginTop: 28 }}>
        {STEPS.map(([title, body], i) => (
          <div key={title} style={{ borderTop: '1px solid var(--au-hairline)', paddingTop: 20 }}>
            <span className="mono" style={{ fontSize: 11, letterSpacing: '.16em', color: 'var(--au-core)' }}>
              STEP {String(i + 1).padStart(2, '0')}
            </span>
            <h3 style={{ fontSize: 20, margin: '12px 0 8px' }}>{title}</h3>
            <p style={{ color: 'var(--tx-2)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ClosingCta() {
  const toPacks = () => {
    const el = document.getElementById('packs');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <section className="section" style={{ paddingBottom: 96 }}>
      <div className="card closing-cta">
        <div className="hero-light" aria-hidden
          style={{ position: 'absolute', left: '-6%', top: '-40%', width: 520, height: 360, pointerEvents: 'none' }} />
        <div style={{ position: 'relative' }}>
          <RuleHead>Start where you are</RuleHead>
          <h2 style={{ fontSize: 'clamp(28px,3.4vw,44px)', margin: '20px 0 14px', maxWidth: '18ch' }}>
            Trade with the reasoning, not the noise
          </h2>
          <p style={{ color: 'var(--tx-2)', fontSize: 15, maxWidth: '54ch', margin: '0 0 28px' }}>
            Take a single pack for a month and judge it on the analysis. If it does not change how you
            read your charts, you have lost the price of a dinner.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <button className="btn" onClick={toPacks}>See the packs</button>
            <a className="btn-ghost" href="https://discord.gg/b8btM4zdRr" target="_blank" rel="noreferrer"
              style={{ textDecoration: 'none', display: 'inline-block' }}>Join the Discord</a>
          </div>
        </div>
      </div>
    </section>
  );
}
