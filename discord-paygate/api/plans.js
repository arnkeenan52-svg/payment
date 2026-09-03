import { config, capabilities } from '../src/config.js';
import { sendJson, guard } from '../src/lib/http.js';
import { getGuild, guildIconUrl, getGuildRoles } from '../src/lib/discord.js';
import { effectiveRoleMap } from '../src/services/plan-config.js';
import { storeBySlug, sellablePlansOf, bannerFor } from '../src/services/stores.js';
import { DEMO_SLUG, demoPlansPayload } from '../src/services/demo-store.js';
import { countLiveMembers, countStoreFollowers, reviewSummary } from '../src/db.js';
import { storeTheme } from '../src/services/billing.js';
import { validateTheme, themeCss, bgLayer, themeWithLook } from '../src/lib/theme.js';

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

// A Discord role is a NAME and a COLOUR. The storefront used to draw one as
// two letters in a grey disc — the initial-avatar we use for people — which
// says nothing about the role and is the wrong metaphor for a thing that is
// not a person. The guild's own role list carries both, so it is fetched here
// once per guild and cached for the same five minutes as the guild's name and
// icon: one extra REST call per warm instance per store, on a response that
// already makes one.
//
// It fails SILENTLY and on purpose. A role list we could not fetch must cost
// the page a colour, never the line — the stored names still render, uncoloured.
const roleCache = new Map(); // guildId -> { at, byId, byName }

// Discord ships a role's colour as an integer, and 0 means "no colour set" —
// those roles inherit their member's next colour down, so there is no hex we
// could honestly print for one. null, and the client draws the neutral chip.
const roleColor = (n) => (Number.isInteger(n) && n > 0 ? `#${n.toString(16).padStart(6, '0')}` : null);

async function guildRoles(guildId) {
  const cached = roleCache.get(guildId);
  if (cached && Date.now() - cached.at < GUILD_TTL_MS) return cached;
  let list = null;
  try {
    list = await getGuildRoles(guildId);
  } catch {
    // The bot kicked, the guild gone, Discord down — all the same to this
    // page. Cached as an empty answer so a broken guild is not re-fetched on
    // every storefront hit.
    list = null;
  }
  const entry = { at: Date.now(), byId: new Map(), byName: new Map() };
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r.name !== 'string') continue;
    // @everyone shares the guild's id and is held by every member already.
    // Printing it would tell a buyer they are paying for what they have.
    if (String(r.id) === String(guildId)) continue;
    const role = { name: r.name, color: roleColor(r.color) };
    entry.byId.set(String(r.id), role);
    const key = r.name.toLowerCase();
    if (!entry.byName.has(key)) entry.byName.set(key, role);
  }
  roleCache.set(guildId, entry);
  return entry;
}

// What a buyer actually receives, resolved the same way the GRANT resolves it
// (src/services/plan-config.js): configured ids first, and the stored names
// ONLY when none of those ids exist in the guild. Mixing the two would print a
// renamed role twice — once under the name the guild has now and once under
// the name plans.json remembers.
function planRoles(guild, ids, names) {
  const out = [];
  const seen = new Set();
  for (const id of ids ?? []) {
    const role = guild.byId.get(String(id));
    if (!role || seen.has(role.name.toLowerCase())) continue;
    seen.add(role.name.toLowerCase());
    out.push(role);
  }
  if (out.length) return out;
  for (const raw of names ?? []) {
    // The '@' is a sigil the seller may or may not have typed; the role's name
    // does not include it and the page adds its own.
    const name = String(raw ?? '').replace(/^@/, '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(guild.byName.get(name.toLowerCase()) ?? { name, color: null });
  }
  return out;
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
  const guildRoleIndex = await guildRoles(store.guildId);
  const banner = await bannerFor(store);
  // The built-in store is virtual (id null): no row, so no follow ledger.
  const followable = store.id !== null && store.id !== undefined;
  // Reviews are all-or-nothing. With the switch off the storefront is told the
  // section does not exist, rather than being handed a subset to draw — there
  // is no shape of this payload that carries SOME of a store's reviews.
  const reviewsPublic =
    followable && store.reviewsOn ? { ...(await reviewSummary(store.id)), on: true } : { count: 0, average: null, on: false };
  // The seller's half of the crypto rail. Same predicate the checkout guards
  // with, so the page and the payment agree on whether the rail exists.
  const cryptoPayout = Boolean(String(store.cryptoWallet ?? '').trim() && String(store.cryptoChain ?? '').trim());
  // One product, one wallpaper. The layer is BUILT HERE, by the same
  // bgLayer() that writes the server-rendered page, so the card and the
  // checkout the storefront swaps in cannot drift from what a product's own
  // link renders — there is no second copy of this logic in the browser.
  // A product with no background of its own gets null and wears the store's,
  // which is already on the page. `still` because /sky.js only drives the
  // canvases present when it loaded.
  const theme = await storeTheme(store);
  const bgViewOf = (plan) => {
    if (!plan.bg) return null;
    try {
      const layer = bgLayer(validateTheme(themeWithLook(theme, plan.bg)), { still: true });
      return layer ? { id: layer.id, material: layer.material, inner: layer.inner, lightTone: layer.lightTone } : null;
    } catch {
      return null; // an unusable stored background inherits the store's
    }
  };
  sendJson(res, 200, {
    brand: store.isDefault ? config.brand : store.name,
    platform: { name: config.platform },
    store: {
      slug: store.slug, status: store.status, description: store.description ?? null,
      // Ready to use as-is: an uploaded banner is served from /api/img under
      // the store's CURRENT link, a pasted one passes through.
      bannerUrl: banner.url, bannerKind: banner.kind, theme,
      about: store.about ?? null, links: store.links ?? null,
      // Live members, only when the owner switched the badge on — the count
      // is the same real number the dashboard bills on, seller excluded from
      // their own store on both sides.
      memberCount: store.showMembers
        ? await countLiveMembers([store.id ?? null], { except: [store.ownerDiscordId] })
        : null,
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
    // What this particular store can actually take money with. A tenant
    // store's crypto rail needs BOTH the platform's NOWPayments credentials
    // and that seller's own payout wallet — the platform half alone would
    // offer a button whose only outcome is the custody refusal at checkout.
    // The seller's half is an address AND the chain to pay it on: checkout
    // refuses on a half-filled row (paying out with no chain would send the
    // buyer's coin to an address on another network), so the same pair has
    // to decide whether the page offers the rail at all — otherwise the
    // buyer picks a coin and only then gets turned away.
    capabilities: store.isDefault
      ? { ...capabilities(), nowpayments: capabilities().nowpayments && cryptoPayout }
      : {
          stripe: Boolean(store.stripeKey),
          crypto: false,
          nowpayments: capabilities().nowpayments && cryptoPayout,
        },
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
      // The same roles again, as the guild defines them: live name, live
      // colour. `roleNames` stays beside it because it is what the checkout
      // and the receipt have always read, and a client running against a
      // cached older payload still has something to draw.
      roles: planRoles(
        guildRoleIndex,
        (roleMap ? roleMap.get(p.id)?.roleIds : null) ?? p.roleIds ?? [],
        (roleMap ? roleMap.get(p.id)?.roleNames : null) ?? p.roleNames ?? [],
      ),
      descriptionHighlight: p.descriptionHighlight ?? null,
      linkSlug: p.linkSlug ?? null,
      variantOf: p.variantOf ?? null,
      // The product's OWN wallpaper, already rendered to the same layer the
      // page would carry, or null when it wears the store's. The storefront
      // must not invent one — see src/lib/theme.js themeWithLook.
      bgView: bgViewOf(p),
      // Buyer-facing hints: "offer ends …" and "for @X members only". The
      // checkout endpoint enforces both — these just explain the page.
      expiresAt: p.expiresAt ?? null,
      requiredRoleName: p.requiredRoleName ?? null,
      // How long the access lasts. The crypto rail has no renewal to point
      // at, so the pay screen has to name the term itself — without this
      // field it can only say "a fixed term" and a buyer paying for a year
      // is told nothing about when their role goes away.
      durationDays: p.lifetime ? null : (p.durationDays ?? null),
    })),
  });
});
