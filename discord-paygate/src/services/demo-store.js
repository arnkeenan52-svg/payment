// The hosted demo store: a fixed, database-free storefront at /demo. The
// landing page links here so visitors can walk a themed checkout without the
// page pointing at any real seller. Nothing about it is purchasable — the
// client renders the full flow but never reaches Stripe, and the checkout
// APIs refuse the slug outright.
export const DEMO_SLUG = 'demo';

export const DEMO_NAME = 'Dues Membership';

// The signature black — the platform's own tokens, character for character the
// THEME_DEFAULTS the dashboard offers as "Midnight". Deliberately NOT a custom
// background: the demo is what a Dues store looks like out of the box, and
// dressing it in a preset backdrop advertised a look that a new store does not
// actually arrive wearing.
export const DEMO_THEME = {
  bg: '#0a0a0a', panel: '#101010', text: '#f5f5f4',
  accent: '#ededed', pay: '#5865f2', radius: 16, font: 'default',
  bgPreset: '', material: 'glass',
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
      description: 'A demo of a Dues store — nothing here is for sale.',
      bannerUrl: null, theme: DEMO_THEME,
      about: 'This is what buyers see when a seller shares their Dues store link: every product, the store\u2019s own colors and type, and a checkout that pays straight into the seller\u2019s Stripe account.\nBuild yours in minutes \u2014 invite Dues, paste a Stripe key, pick the roles to sell.',
      links: { website: 'https://dues.gg' },
      memberCount: 134,
    },
    // The avatar box is 96 CSS px: the 48px favicon painted there is a 2x
    // upscale on a laptop and 4x on retina, on the one page sellers judge by.
    server: { name: DEMO_NAME, guildId: '', iconUrl: '/favicon-96x96.png' },
    capabilities: { stripe: true, crypto: false, demo: true },
    plans: demoPlans(),
  };
}
