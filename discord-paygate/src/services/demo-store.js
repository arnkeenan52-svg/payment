// The hosted demo store: a fixed, database-free storefront at /demo. The
// landing page links here so visitors can walk a themed checkout without the
// page pointing at any real seller. Nothing about it is purchasable — the
// client renders the full flow but never reaches Stripe, and the checkout
// APIs refuse the slug outright.
export const DEMO_SLUG = 'demo';

export const DEMO_NAME = 'Ripley Membership';

// The Midnight preset, same tokens the dashboard offers — the platform's
// own black look.
export const DEMO_THEME = {
  bg: '#0a0a0a', panel: '#101010', text: '#f5f5f4',
  accent: '#ededed', pay: '#5865f2', radius: 16, font: 'default',
};

export const demoPlans = () => [
  {
    id: 'vip-access', name: 'VIP Access', description: 'Every alpha channel, for life.',
    priceUsd: 49.99, interval: null, lifetime: true, imageUrl: null,
    roleNames: ['VIP'], descriptionHighlight: null, linkSlug: null,
  },
  {
    id: 'signals-monthly', name: 'Signals Monthly', description: 'Daily signals while your membership runs.',
    priceUsd: 14.99, interval: 'month', lifetime: false, imageUrl: null,
    roleNames: ['Signals'], descriptionHighlight: null, linkSlug: null,
  },
  {
    id: 'inner-circle', name: 'Inner Circle', description: 'The private desk, lifetime.',
    priceUsd: 79.99, interval: null, lifetime: true, imageUrl: null,
    roleNames: ['VIP'], descriptionHighlight: null, linkSlug: null,
  },
];

// The one code the demo checkout accepts, so the discount flow demos too.
export const DEMO_DISCOUNT = { code: 'LAUNCH20', kind: 'percent', amount: 20 };

export function demoPlansPayload({ platformName, brandFallback }) {
  return {
    brand: DEMO_NAME,
    platform: { name: platformName ?? brandFallback },
    store: {
      slug: DEMO_SLUG, status: 'live',
      description: 'A demo of a Ripley store — nothing here is for sale.',
      bannerUrl: null, theme: DEMO_THEME,
      about: 'This is what buyers see when a seller shares their Ripley store link: every product, the store\u2019s own colors and type, and a checkout that pays straight into the seller\u2019s Stripe account.\nBuild yours in minutes \u2014 invite Ripley, paste a Stripe key, pick the roles to sell.',
      links: { website: 'https://www.ripleybot.com' },
      memberCount: 134,
    },
    server: { name: DEMO_NAME, guildId: '', iconUrl: '/favicon.png' },
    capabilities: { stripe: true, crypto: false, demo: true },
    plans: demoPlans(),
  };
}
