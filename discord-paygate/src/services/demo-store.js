// The hosted demo store: a fixed, database-free storefront at /demo. The
// landing page links here so visitors can walk a themed checkout without the
// page pointing at any real seller. Nothing about it is purchasable — the
// client renders the full flow but never reaches Stripe, and the checkout
// APIs refuse the slug outright.
export const DEMO_SLUG = 'demo';

export const DEMO_NAME = 'Ripley Membership';

// The Emerald preset, same tokens the dashboard offers.
export const DEMO_THEME = {
  bg: '#071209', panel: '#0d2012', text: '#e9f6ec',
  accent: '#22c55e', pay: '#22c55e', radius: 16, font: 'default',
};

export const demoPlans = () => [
  {
    id: 'vip-access', name: 'VIP Access', description: 'Every alpha channel, for life.',
    priceUsd: 49.99, interval: null, lifetime: true, imageUrl: null,
    roleNames: ['VIP'], descriptionHighlight: null,
  },
  {
    id: 'signals-monthly', name: 'Signals Monthly', description: 'Daily signals while your membership runs.',
    priceUsd: 14.99, interval: 'month', lifetime: false, imageUrl: null,
    roleNames: ['Signals'], descriptionHighlight: null,
  },
  {
    id: 'inner-circle', name: 'Inner Circle', description: 'The private desk, lifetime.',
    priceUsd: 79.99, interval: null, lifetime: true, imageUrl: null,
    roleNames: ['VIP'], descriptionHighlight: null,
  },
];

// The one code the demo checkout accepts, so the discount flow demos too.
export const DEMO_DISCOUNT = { code: 'LAUNCH20', kind: 'percent', amount: 20 };

export function demoPlansPayload({ platformName, brandFallback }) {
  return {
    brand: DEMO_NAME,
    platform: { name: platformName ?? brandFallback },
    store: { slug: DEMO_SLUG, status: 'live', description: 'A demo of a Ripley store — nothing here is for sale.', bannerUrl: null, theme: DEMO_THEME },
    server: { name: DEMO_NAME, guildId: '', iconUrl: null },
    capabilities: { stripe: true, crypto: false, demo: true },
    plans: demoPlans(),
  };
}
