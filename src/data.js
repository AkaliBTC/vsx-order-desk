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

export const DISCLAIMERS = {
  analysis:
    'These analyses are for informational purposes only and do not constitute investment ' +
    'advice or a solicitation to buy or sell financial instruments. VisionX describes market ' +
    'structure and scenarios, never directives. Past performance is not indicative of future ' +
    'results. You make all trading decisions at your own risk.',
  tracker:
    'The Portfolio Tracker is a tool for personal record-keeping and does not constitute ' +
    'investment advice.',
  deepdive:
    'This report is for informational purposes only and does not constitute investment advice.',
  coaching:
    'Coaching conveys methodology and tools. It does not replace individual financial advice. ' +
    'Trades you execute are at your own risk.',
  voucher:
    'Gift vouchers are non-refundable, cannot be exchanged for cash, and are single-use. ' +
    'Keep your code private — do not share or forward it.',
};

// ----- DEFAULT catalogue (seed) ----------------------------------------
// roleId = the Discord role that proves a customer already OWNS this package.
// Leave '' until you set the real role IDs in the Admin editor.
export const DEFAULT_CATALOGUE = {
  packages: [
    { id: 'btc-eth', name: 'BTC + ETH', desc: 'Bitcoin & Ethereum analysis, incl. Total3.',
      prices: { '1M': null, '3M': null, '12M': null }, tracker: false, roleId: '', ptRoleId: '' },
    { id: 'crypto', name: 'Crypto', desc: 'BTC + ETH package plus altcoins.',
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
    { id: 'coach-filip', name: 'Coaching · Filip', desc: 'Foundation', price: 150, unit: '/hr' },
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
