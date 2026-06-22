// VisionX product catalogue + disclaimers + public payment details.
// Public values only. Webhook URLs / secrets live in the Cloud Functions config.

// Payment endpoints are public by nature, so they live here.
export const PAYMENT = {
  paypalHandle: '@serenityibb',
  // TRC20 (USDT) Empfangsadresse — On-Chain-Prüfung per Knopf im Admin-Panel.
  tronAddress: 'TDXQmtWWcu9HGVzP6PjKEZrki9mRAcJc8t',
};

// Runtimes a customer can attach to a product (days + price multiplier-free flat add).
export const RUNTIMES = [
  { label: '1 Monat', days: 30, price: 0 },
  { label: '3 Monate', days: 90, price: 0 },
  { label: '6 Monate', days: 180, price: 0 },
];

// Replace with your real catalogue. `disclaimer` is shown at ticket open and
// stored (with a hash) as the consent record.
export const PRODUCTS = [
  {
    id: 'deep-dive',
    name: 'Deep Dive Report',
    blurb: 'Einzelner Deep-Dive Report im VisionX Format.',
    price: 49,
    runtimes: false, // one-off, no runtime
    disclaimer:
      'Dieser Report dient ausschließlich Informationszwecken und stellt keine ' +
      'Anlageberatung oder Aufforderung zum Kauf/Verkauf von Finanzinstrumenten dar. ' +
      'VisionX beschreibt Marktstruktur und Szenarien, niemals Direktiven. ' +
      'Jede Handelsentscheidung treffen Sie eigenverantwortlich.',
  },
  {
    id: 'analysis-access',
    name: 'Analyse-Zugang',
    blurb: 'Laufender Zugang zu TA/FA-Analysen über die gewählte Runtime.',
    price: 89,
    runtimes: true,
    disclaimer:
      'Der Analyse-Zugang vermittelt Marktstruktur-Analysen und Szenarien. ' +
      'Es handelt sich nicht um individuelle Anlageberatung im Sinne der MiFID II. ' +
      'Vergangene Performance ist kein Indikator für zukünftige Ergebnisse.',
  },
  {
    id: 'coaching-akali',
    name: 'Coaching · Akali',
    blurb: '1:1 Coaching-Stunde (IGL-Methodik, EW/SMC Framework).',
    price: 350,
    runtimes: false,
    disclaimer:
      'Coaching vermittelt methodisches Wissen und Werkzeuge. Es ersetzt keine ' +
      'individuelle Finanzberatung. Umgesetzte Trades erfolgen auf eigenes Risiko.',
  },
];

export const productById = (id) => PRODUCTS.find((p) => p.id === id);
