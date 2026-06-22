// VisionX catalogue + pricing + disclaimers. Edit this file to change anything.
// Currency is USD ($). All analysis packages are subscriptions (1M / 3M / 12M).

export const CURRENCY = '$';
export const fmt = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

export const PAYMENT = {
  paypalHandle: '@serenityibb',
  tronAddress: 'TDXQmtWWcu9HGVzP6PjKEZrki9mRAcJc8t',
};

export const RUNTIMES = [
  { key: '1M', label: '1 Month', months: 1 },
  { key: '3M', label: '3 Months', months: 3 },
  { key: '12M', label: '12 Months', months: 12 },
];

// Portfolio Tracker pricing (per month).
export const TRACKER = { perPackage: 10, premiumPlus: 35 };

// ---- Analysis packages -------------------------------------------------
// prices: one price per runtime. Set null = shown as "Coming soon".
// tracker: whether the Portfolio Tracker add-on is available for this package.
export const PACKAGES = [
  { id: 'btc-eth', name: 'BTC + ETH', desc: 'Bitcoin & Ethereum analysis, incl. Total3.',
    prices: { '1M': null, '3M': null, '12M': null }, tracker: false },        // TODO set prices
  { id: 'crypto', name: 'Crypto', desc: 'BTC + ETH package plus altcoins.',
    prices: { '1M': null, '3M': null, '12M': null }, tracker: true },         // TODO set prices
  { id: 'stocks', name: 'Stocks', desc: 'Equity market analysis.',
    prices: { '1M': 51, '3M': 135, '12M': 486 }, tracker: true },
  { id: 'indices', name: 'Indices', desc: 'Index analysis.',
    prices: { '1M': 8, '3M': 22, '12M': 78 }, tracker: true },
  { id: 'commodities', name: 'Commodities', desc: 'Commodity analysis.',
    prices: { '1M': 8, '3M': 22, '12M': 78 }, tracker: true },
  { id: 'etfs', name: 'ETFs', desc: 'ETF analysis.',
    prices: { '1M': 16, '3M': 43, '12M': 155 }, tracker: true },
  { id: 'forex', name: 'Forex', desc: 'FX market analysis.',
    prices: { '1M': 8, '3M': 22, '12M': 78 }, tracker: true },
  { id: 'premium', name: 'Premium', desc: 'Every analysis package in one.',
    prices: { '1M': 88, '3M': 249, '12M': 864 }, tracker: true, highlight: true },
];

// ---- One-off services --------------------------------------------------
export const SERVICES = [
  { id: 'deepdive', name: 'Deep Dive', desc: 'In-depth single-asset report (TA + FA).', price: 100 },
  { id: 'coach-filip', name: 'Coaching · Filip', desc: 'Foundation', price: 150, unit: '/hr' },
  { id: 'coach-michael', name: 'Coaching · Michael', desc: 'Advanced', price: 250, unit: '/hr' },
  { id: 'coach-akali', name: 'Coaching · Akali', desc: 'Expert', price: 350, unit: '/hr' },
];

// ---- Included free -----------------------------------------------------
export const FREEBIES = [
  'Macro Economy report — included with every package',
  'Educational content — Crypto, Stocks & Premium',
];

// ---- Consent disclaimers (shown when opening a ticket) -----------------
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
    'This report is for informational purposes only and does not constitute investment advice. ' +
    'You make all trading decisions at your own risk.',
  coaching:
    'Coaching conveys methodology and tools. It does not replace individual financial advice. ' +
    'Trades you execute are at your own risk.',
};

export const pkgById = (id) => PACKAGES.find((p) => p.id === id);
export const serviceById = (id) => SERVICES.find((s) => s.id === id);
export const runtimeByKey = (k) => RUNTIMES.find((r) => r.key === k);
