import { config, capabilities } from '../src/config.js';
import { sendJson, guard } from '../src/lib/http.js';
import { getGuild, guildIconUrl } from '../src/lib/discord.js';
import { effectiveRoleMap } from '../src/services/plan-config.js';
import { storeBySlug, sellablePlansOf, bannerFor } from '../src/services/stores.js';
import { DEMO_SLUG, demoPlansPayload } from '../src/services/demo-store.js';
import { countLiveMembers, countStoreFollowers, reviewSummary } from '../src/db.js';
import { themeIfPaid } from '../src/services/billing.js';

// The server's own identity fronts every checkout: name and icon come from
// the live guild lookup via the bot (animated icons surface as .gif).
// Cached per guild per warm instance. When nothing real is known the name is
// null — the client hides it rather than showing filler.
const guildCache = new Map(); // guildId -> { at, name, iconUrl }
const GUILD_TTL_MS = 5 * 60 * 1000;

async function serverInfo(guildId, nameOverride = null) {
  const cached = guildCache.get(guildId);
  if (cached && Date.now() - cached.at < GUILD_TTL_MS) return cached;
  const guild = await getGuild(guildId);
  const info = {
    at: Date.now(),
    name: nameOverride || guild?.name || null,
    iconUrl: guildIconUrl(guild),
  };
  guildCache.set(guildId, info);
  return info;
}

export default guard(async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const slugParam = url.searchParams.get('store') ?? '';
  if (slugParam === DEMO_SLUG) {
    const payload = demoPlansPayload({ platformName: config.platform, brandFallback: config.brand });
    // The demo has no database row behind it, so there is nothing to key a
    // follow on and no count to report. null, not 0 — "nobody follows this"
    // would be a claim about a store that does not exist.
    Object.assign(payload.store, { bannerKind: null, followers: null, followable: false });
    sendJson(res, 200, payload);
    return;
  }
  const store = await storeBySlug(slugParam);
  if (!store) {
    sendJson(res, 404, { error: 'unknown store' });
    return;
  }
  const { name, iconUrl } = await serverInfo(store.guildId, store.isDefault ? config.discord.guildName : store.name);
  const roleMap = store.isDefault ? await effectiveRoleMap() : null;
  const plans = await sellablePlansOf(store);
  const banner = await bannerFor(store);
  // The built-in store is virtual (id null): no row, so no follow ledger.
  const followable = store.id !== null && store.id !== undefined;
  // Reviews are all-or-nothing. With the switch off the storefront is told the
  // section does not exist, rather than being handed a subset to draw — there
  // is no shape of this payload that carries SOME of a store's reviews.
  const reviewsPublic =
    followable && store.reviewsOn ? { ...(await reviewSummary(store.id)), on: true } : { count: 0, average: null, on: false };
  sendJson(res, 200, {
    brand: store.isDefault ? config.brand : store.name,
    platform: { name: config.platform },
    store: {
      slug: store.slug, status: store.status, description: store.description ?? null,
      // Ready to use as-is: an uploaded banner is served from /api/img under
      // the store's CURRENT link, a pasted one passes through.
      bannerUrl: banner.url, bannerKind: banner.kind, theme: await themeIfPaid(store),
      about: store.about ?? null, links: store.links ?? null,
      // Live members, only when the owner switched the badge on — the count
      // is the same real number the dashboard bills on.
      memberCount: store.showMembers ? await countLiveMembers([store.id ?? null]) : null,
      // COUNT(*) of the follow ledger and nothing else — never seeded, never
      // rounded. A store nobody can follow reports null rather than 0.
      followers: followable ? await countStoreFollowers(store.id) : null,
      followable,
      // Seller-authored identity — the store's own claim about itself, in the
      // same class as `about` and `links`. The platform stores and renders
      // these; it does not verify them and must never imply that it has.
      creatorName: store.creatorName ?? null,
      team: Array.isArray(store.team) && store.team.length ? store.team : null,
      teamHeading: store.teamHeading ?? null,
      // The rating, and the only shape of it there is: COUNT(*) and the mean
      // over published rows. `reviewsOn` false reports zero/null rather than
      // the real figures, because the seller's switch hides the score and the
      // reviews together — it never hides SOME of them.
      reviews: reviewsPublic,
    },
    // Guild id is public (it's in every invite link); the receipt page needs
    // it for the "Open on Discord" deep link.
    server: { name, guildId: store.guildId, iconUrl },
    currency: store.currency ?? 'usd',
    capabilities: store.isDefault ? capabilities() : { stripe: Boolean(store.stripeKey), crypto: false },
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      priceUsd: p.priceUsd,
      // What that number is denominated in. Without this the page has no way
      // to know whether 1500 means $1,500.00 or ¥1,500 and would guess wrong.
      currency: p.currency ?? 'usd',
      interval: p.interval,
      lifetime: Boolean(p.lifetime),
      imageUrl: p.imageUrl ?? null,
      mediaKind: p.mediaKind ?? null,
      roleNames: (roleMap ? roleMap.get(p.id)?.roleNames : null) ?? p.roleNames ?? [],
      descriptionHighlight: p.descriptionHighlight ?? null,
      linkSlug: p.linkSlug ?? null,
      variantOf: p.variantOf ?? null,
      // Buyer-facing hints: "offer ends …" and "for @X members only". The
      // checkout endpoint enforces both — these just explain the page.
      expiresAt: p.expiresAt ?? null,
      requiredRoleName: p.requiredRoleName ?? null,
    })),
  });
});
