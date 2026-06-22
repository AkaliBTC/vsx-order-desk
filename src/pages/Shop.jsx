import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth, login } from '../auth';
import { PRODUCTS, RUNTIMES, productById } from '../data';
import { postTicketEmbed } from '../lib';

const eur = (n) => `${n.toFixed(2)} €`;

export default function Shop() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [basket, setBasket] = useState([]); // {productId, runtimeIdx}
  const [consentOpen, setConsentOpen] = useState(false);

  const add = (productId, runtimeIdx = 0) =>
    setBasket((b) => [...b, { productId, runtimeIdx }]);
  const remove = (i) => setBasket((b) => b.filter((_, idx) => idx !== i));

  const lineItems = basket.map((it) => {
    const p = productById(it.productId);
    const rt = p.runtimes ? RUNTIMES[it.runtimeIdx] : null;
    return {
      productId: p.id,
      name: p.name,
      runtimeLabel: rt ? rt.label : null,
      days: rt ? rt.days : null,
      price: p.price + (rt ? rt.price : 0),
      disclaimer: p.disclaimer,
    };
  });
  const total = lineItems.reduce((s, x) => s + x.price, 0);

  return (
    <div className="shell" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 28 }}>
      <section>
        <p className="eyebrow">Katalog</p>
        <h1 style={{ fontSize: 32, margin: '8px 0 24px' }}>Produkte</h1>
        <div style={{ display: 'grid', gap: 16 }}>
          {PRODUCTS.map((p) => (
            <ProductCard key={p.id} product={p} onAdd={add} />
          ))}
        </div>
      </section>

      <aside>
        <div className="card" style={{ position: 'sticky', top: 24 }}>
          <p className="eyebrow">Warenkorb</p>
          {lineItems.length === 0 && (
            <p style={{ color: 'var(--vsx-muted)', fontSize: 14, marginTop: 14 }}>
              Noch leer. Füge Produkte hinzu.
            </p>
          )}
          {lineItems.map((it, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '12px 0', borderBottom: '1px solid var(--vsx-line)' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{it.name}</div>
                {it.runtimeLabel && <div className="mono" style={{ fontSize: 12, color: 'var(--vsx-muted)' }}>{it.runtimeLabel}</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="mono">{eur(it.price)}</div>
                <button onClick={() => remove(i)} style={{ background: 'none', color: 'var(--vsx-muted)', fontSize: 12, padding: 0 }}>entfernen</button>
              </div>
            </div>
          ))}
          {lineItems.length > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
                <span className="eyebrow">Summe</span>
                <span className="mono display" style={{ color: 'var(--vsx-gold)', fontSize: 18 }}>{eur(total)}</span>
              </div>
              {user ? (
                <button className="btn" style={{ width: '100%', marginTop: 18 }} onClick={() => setConsentOpen(true)}>
                  Ticket öffnen
                </button>
              ) : (
                <button className="btn" style={{ width: '100%', marginTop: 18 }} onClick={login}>
                  Anmelden zum Bestellen
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      {consentOpen && (
        <ConsentModal
          lineItems={lineItems}
          total={total}
          onClose={() => setConsentOpen(false)}
          onConfirm={async () => {
            const ref = await addDoc(collection(db, 'tickets'), {
              userId: user.uid,
              userTag: user.tag,
              userAvatar: user.avatar,
              items: lineItems.map(({ disclaimer, ...rest }) => rest),
              total,
              consent: {
                accepted: true,
                at: serverTimestamp(),
                products: lineItems.map((x) => x.productId),
              },
              payment: { method: null, status: 'unpaid' },
              status: 'awaiting_payment',
              createdAt: serverTimestamp(),
            });
            try {
              await postTicketEmbed({ id: ref.id, userTag: user.tag, items: lineItems, total });
            } catch (e) { console.error('webhook', e); }
            navigate(`/ticket/${ref.id}`);
          }}
        />
      )}
    </div>
  );
}

function ProductCard({ product, onAdd }) {
  const [rt, setRt] = useState(0);
  return (
    <div className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'center' }}>
      <div>
        <h3 style={{ fontSize: 19 }}>{product.name}</h3>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 14, margin: '6px 0 0', maxWidth: 420 }}>{product.blurb}</p>
        {product.runtimes && (
          <select value={rt} onChange={(e) => setRt(+e.target.value)} style={{ width: 'auto', marginTop: 12 }}>
            {RUNTIMES.map((r, i) => <option key={i} value={i}>{r.label}</option>)}
          </select>
        )}
      </div>
      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div className="mono display" style={{ fontSize: 20, color: 'var(--vsx-gold)' }}>{eur(product.price)}</div>
        <button className="btn-ghost" style={{ marginTop: 10 }} onClick={() => onAdd(product.id, rt)}>Hinzufügen</button>
      </div>
    </div>
  );
}

function ConsentModal({ lineItems, total, onClose, onConfirm }) {
  const [checked, setChecked] = useState({});
  const allAccepted = lineItems.every((_, i) => checked[i]);
  return (
    <div style={{ position: 'absolute', inset: 0, minHeight: '100vh', background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '60px 20px', zIndex: 20 }}>
      <div className="card" style={{ maxWidth: 560, width: '100%' }}>
        <p className="eyebrow">Einverständnis</p>
        <h2 style={{ fontSize: 24, margin: '8px 0 4px' }}>Disclaimer bestätigen</h2>
        <p style={{ color: 'var(--vsx-muted)', fontSize: 14, marginTop: 0 }}>
          Bitte bestätige die produktspezifischen Hinweise, um das Ticket zu öffnen.
        </p>
        <div style={{ display: 'grid', gap: 14, margin: '18px 0' }}>
          {lineItems.map((it, i) => (
            <label key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--vsx-charcoal-3)', padding: 14, borderRadius: 8, cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 18, marginTop: 3 }} checked={!!checked[i]} onChange={(e) => setChecked((c) => ({ ...c, [i]: e.target.checked }))} />
              <span>
                <strong>{it.name}</strong>
                <span style={{ display: 'block', color: 'var(--vsx-muted)', fontSize: 13, marginTop: 4 }}>{it.disclaimer}</span>
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="btn-ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn" disabled={!allAccepted} onClick={onConfirm}>
            Ticket öffnen · {total.toFixed(2)} €
          </button>
        </div>
      </div>
    </div>
  );
}
