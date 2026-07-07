// Static config + DEFAULT catalogue. The live catalogue is stored in Firestore
// (config/catalogue) and editable in the Admin panel. These defaults are used
// until an admin saves the catalogue the first time.

export const CURRENCY = '$';
export const fmt = (n) => {
  if (n == null || n === '') return '—';
  const v = Number(n);
  return (v < 0 ? '−$' : '$') + Math.abs(v).toFixed(2);
};

export const PAYMENT = {
  paypalHandle: '@serenityibb',
  tronAddress: 'TDXQmtWWcu9HGVzP6PjKEZrki9mRAcJc8t',
};

export const RUNTIMES = [
  { key: '1M', label: '1 Month', months: 1 },
  { key: '3M', label: '3 Months', months: 3 },
  { key: '12M', label: '12 Months', months: 12 },
];
export const runtimeByKey = (k) => RUNTIMES.find((r) => r.key === k) || RUNTIMES[0];

// Prestige tiers — bought ONLY with referral balance, and only one level at a time
// (must own the previous tier first). Each tier boosts your referral commission.
// IMPORTANT: keep this in sync with the copy in api/prestige.js + api/grant-role.js.
export const PRESTIGE = [
  { tier: 1, name: 'Prestige I', price: 500, roleId: '1519733465199808745', boost: 0.10 },
  { tier: 2, name: 'Prestige II', price: 1000, roleId: '1519733547462824057', boost: 0.25 },
  { tier: 3, name: 'Prestige III', price: 5000, roleId: '1519733602831568907', boost: 0.50 },
];

export const DISCLAIMERS = {
  analysis:
    'These analyses are for informational purposes only and do not constitute investment ' +
    'advice or a solicitation to buy or sell financial instruments. VisionX describes market ' +
    'structure and scenarios, never directives. Past performance is not indicative of future ' +
    'results. You make all trading decisions at your own risk.',
  tracker:
    'I acknowledge the VisionX Position Tracker Disclaimer & Terms: it is a transparency / ' +
    'track-record tool showing VisionX\u2019s own positions — not investment advice and not ' +
    'signals to copy. Figures are indicative, past performance is not indicative of future ' +
    'results, and any use is at my own risk.',
  deepdive:
    'I acknowledge the VisionX Deep Dive Disclaimer & Terms: the analysis is informational / ' +
    'educational only and not investment advice (MiFID II / WpHG). It is opinion, not a ' +
    'recommendation, with no guarantee of results. All sales are final and non-refundable, ' +
    'redistribution is prohibited, and my decisions are at my own risk.',
  coaching:
    'Coaching conveys methodology and tools. It does not replace individual financial advice. ' +
    'Trades you execute are at your own risk.',
  voucher:
    'Gift vouchers are non-refundable, cannot be exchanged for cash, and are single-use. ' +
    'Keep your code private — do not share or forward it.',
};

// Full legal documents (PDF) linked next to each consent checkbox.
export const DISCLAIMER_PDF = {
  analysis: '/VisionX_MarketAnalysis_Disclaimer.pdf',
  tracker: '/VisionX_PositionTracker_Disclaimer.pdf',
  deepdive: '/VisionX_DeepDive_Disclaimer.pdf',
  coaching: '/VisionX_TACoaching_Disclaimer.pdf',
};

// ----- DEFAULT catalogue (seed) ----------------------------------------
// roleId = the Discord role that proves a customer already OWNS this package.
// Leave '' until you set the real role IDs in the Admin editor.
export const DEFAULT_CATALOGUE = {
  packages: [
    { id: 'crypto', name: 'Crypto', desc: 'Full crypto analysis — BTC, ETH, Total3 & altcoins.',
      prices: { '1M': null, '3M': null, '12M': null }, tracker: true, roleId: '', ptRoleId: '' },
    { id: 'stocks', name: 'Stocks', desc: 'Equity market analysis.',
      prices: { '1M': 51, '3M': 135, '12M': 486 }, tracker: true, roleId: '', ptRoleId: '' },
    { id: 'indices', name: 'Indices', desc: 'Index analysis.',
      prices: { '1M': 8, '3M': 22, '12M': 78 }, tracker: true, roleId: '', ptRoleId: '' },
    { id: 'commodities', name: 'Commodities', desc: 'Commodity analysis.',
      prices: { '1M': 8, '3M': 22, '12M': 78 }, tracker: true, roleId: '', ptRoleId: '' },
    { id: 'etfs', name: 'ETFs', desc: 'ETF analysis.',
      prices: { '1M': 16, '3M': 43, '12M': 155 }, tracker: true, roleId: '', ptRoleId: '' },
    { id: 'forex', name: 'Forex', desc: 'FX market analysis.',
      prices: { '1M': 8, '3M': 22, '12M': 78 }, tracker: true, roleId: '', ptRoleId: '' },
    { id: 'premium', name: 'Premium', desc: 'Every analysis package in one.',
      prices: { '1M': 88, '3M': 249, '12M': 864 }, tracker: true, highlight: true, roleId: '', ptRoleId: '' },
  ],
  services: [
    { id: 'deepdive', name: 'Deep Dive', desc: 'In-depth single-asset report (TA + FA).', price: 100, unit: '' },
    { id: 'coach-filip', name: 'Coaching · Filip', desc: 'Essential', price: 150, unit: '/hr' },
    { id: 'coach-michael', name: 'Coaching · Michael', desc: 'Advanced', price: 250, unit: '/hr' },
    { id: 'coach-akali', name: 'Coaching · Akali', desc: 'Expert', price: 350, unit: '/hr' },
  ],
  freebies: [
    'Macro Economy report — included with every package',
    'Educational content — Crypto, Stocks & Premium',
  ],
  tracker: { perPackage: 10, premiumPlus: 35 },
  loyaltyRoleId: '',
  premiumPlusRoleId: '',
};
