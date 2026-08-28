import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { sessionUserId } from '../../src/lib/session.js';
import * as db from '../../src/db.js';
import { adminStoreBySlug, isReservedSlug } from '../../src/services/stores.js';
import { sealSecret } from '../../src/lib/secretbox.js';
import { stripeFetch, isStripeKey } from '../../src/lib/stripe.js';
import { validateTheme } from '../../src/lib/theme.js';
import { isStoreCategory } from '../../src/services/stores.js';
import { getGuildChannels, postChannelMessage } from '../../src/lib/discord.js';
import { parseUploadDataUrl, uploadKind, UPLOAD_BODY_LIMIT } from '../../src/lib/upload.js';

// Store identity settings: name, description, banner, custom link (slug).
// Tenant stores only — the built-in store is env-configured.
export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const uid = sessionUserId(req);
  if (!uid && !ownerAuthorized(req)) {
    sendJson(res, 401, { error: 'sign in first' });
    return;
  }
  const body = await readJsonBody(req, { maxBytes: UPLOAD_BODY_LIMIT }).catch(() => ({}));
  const store = await adminStoreBySlug(String(body.store ?? ''));
  if (!store || store.id === null || store.id === undefined) {
    sendJson(res, 404, { error: 'unknown store' });
    return;
  }
  if (!(ownerAuthorized(req) || (store.ownerDiscordId && store.ownerDiscordId === uid))) {
    sendJson(res, 403, { error: 'not your store' });
    return;
  }

  // Deleting a store frees its guild and link for a fresh onboarding run.
  // Refused once real payments exist — that history (and members' access)
  // must survive; the Stripe dashboard stays the source of truth for money.
  if (body.action === 'delete') {
    if ((await db.countStoreSubscriptions(store.id)) > 0) {
      sendJson(res, 409, { error: 'This store has payment history and cannot be deleted.' });
      return;
    }
    await db.deleteStore(store.id);
    sendJson(res, 200, { ok: true, deleted: true });
    return;
  }

  const fields = {};
  // Rotate the Stripe key: validated against Stripe before anything is saved.
  if (body.stripeKey !== undefined && String(body.stripeKey).trim() !== '') {
    const key = String(body.stripeKey).trim();
    if (!isStripeKey(key)) {
      return sendJson(res, 400, { error: 'That does not look like a Stripe API key. Restricted keys (rk_live_…) and secret keys (sk_live_…) both work.' });
    }
    try {
      await stripeFetch('/v1/account', { key });
    } catch {
      return sendJson(res, 400, { error: 'Stripe rejected that key. Create one under Stripe → Developers → API keys — a restricted key needs write on Checkout Sessions, Products, Prices, Coupons, Webhook Endpoints and Subscriptions.' });
    }
    fields.stripeSecretEnc = sealSecret(key);
  }
  // Discover listing is strictly opt-in — a paid community's store is not a
  // public storefront unless its owner says so.
  if (body.discoverable !== undefined) fields.discoverable = body.discoverable ? 1 : 0;
  if (body.category !== undefined) {
    if (body.category !== null && body.category !== '' && !isStoreCategory(body.category)) {
      return sendJson(res, 400, { error: 'Pick a category from the list.' });
    }
    fields.category = body.category || null;
  }
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 60);
    if (!name) return sendJson(res, 400, { error: 'Give your store a name.' });
    fields.name = name;
  }
  if (body.description !== undefined) fields.description = String(body.description).trim().slice(0, 500) || null;
  // Store-page extras: a longer about block, social links from a fixed key
  // set (https only), and the opt-in live member-count badge.
  if (body.about !== undefined) fields.about = String(body.about).trim().slice(0, 2000) || null;
  if (body.links !== undefined) {
    const ALLOWED = ['discord', 'x', 'youtube', 'instagram', 'tiktok', 'website'];
    const clean = {};
    for (const key of ALLOWED) {
      const raw = String(body.links?.[key] ?? '').trim();
      if (!raw) continue;
      if (!/^https:\/\/\S+$/.test(raw) || raw.length > 300) {
        return sendJson(res, 400, { error: `The ${key} link must be a full https:// URL.` });
      }
      clean[key] = raw;
    }
    fields.links = Object.keys(clean).length ? JSON.stringify(clean) : null;
  }
  if (body.showMembers !== undefined) fields.showMembers = body.showMembers ? 1 : 0;
  // Dashboard preferences: accent color, stat-card visibility and the
  // default analytics period. Validated to a fixed shape — never raw JSON.
  if (body.dashboardPrefs !== undefined) {
    if (body.dashboardPrefs === null) {
      fields.dashboardPrefs = null;
    } else {
      const p = body.dashboardPrefs;
      const clean = {};
      if (p?.accent) {
        if (!/^#[0-9a-fA-F]{6}$/.test(String(p.accent))) {
          return sendJson(res, 400, { error: 'The accent must be a #rrggbb color.' });
        }
        clean.accent = String(p.accent).toLowerCase();
      }
      if (p?.cards && typeof p.cards === 'object') {
        const hidden = {};
        for (const k of ['revenue', 'sales', 'members', 'mrr']) if (p.cards[k] === false) hidden[k] = false;
        if (Object.keys(hidden).length) clean.cards = hidden;
      }
      if (p?.defaultRange && ['today', '7', '30', '90', '12m', 'all'].includes(String(p.defaultRange))) {
        clean.defaultRange = String(p.defaultRange);
      }
      fields.dashboardPrefs = Object.keys(clean).length ? JSON.stringify(clean) : null;
    }
  }
  // Storefront theme: tokens only, validated server-side — never raw CSS.
  // null (or an emptied object) clears it back to the platform look.
  if (body.theme !== undefined) {
    let clean;
    try {
      clean = validateTheme(body.theme);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    fields.theme = clean ? JSON.stringify(clean) : null;
  }
  // Reviews: one switch, and it is the whole of a seller's power over them.
  // There is no per-review control here and there must never be one — see the
  // header of api/reviews.js for why.
  if (body.reviewsOn !== undefined) fields.reviewsOn = body.reviewsOn ? 1 : 0;

  // Who is behind the store. A claim by the seller about the seller, in the
  // same class as `about` — stored and rendered, never verified, and never
  // presented with any marker that would imply the platform checked it.
  if (body.creatorName !== undefined) {
    const v = String(body.creatorName).trim();
    if (v.length > 40) return sendJson(res, 400, { error: 'A creator name tops out at 40 characters.' });
    fields.creatorName = v || null;
  }
  if (body.teamHeading !== undefined) {
    const v = String(body.teamHeading).trim();
    if (v.length > 30) return sendJson(res, 400, { error: 'A team heading tops out at 30 characters.' });
    fields.teamHeading = v || null;
  }
  if (body.team !== undefined) {
    if (body.team !== null && !Array.isArray(body.team)) return sendJson(res, 400, { error: 'The team must be a list.' });
    const raw = body.team ?? [];
    if (raw.length > 12) return sendJson(res, 400, { error: 'A team tops out at 12 people.' });
    const team = [];
    for (const m of raw) {
      if (!m || typeof m !== 'object') return sendJson(res, 400, { error: 'Each team member must be a name and an optional handle and title.' });
      const name = String(m.name ?? '').trim();
      if (!name) return sendJson(res, 400, { error: 'Every team member needs a name.' });
      if (name.length > 40) return sendJson(res, 400, { error: 'A team member name tops out at 40 characters.' });
      // The @ is stripped once, here at the edge, so the storefront never has
      // to guess whether it is rendering "@@alex".
      const handle = String(m.handle ?? '').trim().replace(/^@+/, '');
      if (handle && !/^[A-Za-z0-9._-]{1,32}$/.test(handle)) {
        return sendJson(res, 400, { error: 'A handle can use letters, numbers, dots, dashes and underscores.' });
      }
      const title = String(m.title ?? '').trim();
      if (title.length > 40) return sendJson(res, 400, { error: 'A team member title tops out at 40 characters.' });
      team.push({ name, handle: handle || null, title: title || null });
    }
    fields.team = team.length ? JSON.stringify(team) : null;
  }

  if (body.bannerUrl !== undefined) {
    const u = String(body.bannerUrl).trim();
    if (u && !/^https:\/\/\S+$/.test(u)) return sendJson(res, 400, { error: 'The banner URL must start with https:// (1600×533 works best).' });
    fields.bannerUrl = u ? u.slice(0, 500) : null;
  }
  // The uploaded banner, three-state like every other picker in the dashboard:
  // absent leaves it alone, empty clears it, a data URL replaces it. Validated
  // here but written after the row update, so a rejected slug or channel never
  // leaves a banner applied to a save that failed.
  let bannerUpload; // undefined = untouched
  if (body.bannerData !== undefined) {
    if (body.bannerData === null || body.bannerData === '') {
      bannerUpload = null;
    } else {
      const parsed = parseUploadDataUrl(body.bannerData);
      if (!parsed) {
        return sendJson(res, 400, { error: 'That banner could not be read — use a JPG, PNG, WebP or GIF under 1.5MB, or a short MP4/WebM clip.' });
      }
      bannerUpload = { mime: parsed.mime, data: body.bannerData };
    }
  }
  // Sale notifications: the channel the bot posts each order to. Validated
  // against the store's own guild, and a test message proves the bot can
  // actually post there before anything is saved.
  if (body.notifyChannelId !== undefined) {
    if (body.notifyChannelId === null || body.notifyChannelId === '') {
      fields.notifyChannelId = null;
    } else {
      const channelId = String(body.notifyChannelId);
      if (!/^\d{17,20}$/.test(channelId)) {
        return sendJson(res, 400, { error: 'Pick a channel from the list.' });
      }
      const channels = await getGuildChannels(store.guildId);
      const channel = channels?.find((c) => c.id === channelId);
      if (!channel) {
        return sendJson(res, 409, { error: 'That channel is not in your server — is the Dues bot still there?' });
      }
      const posted = await postChannelMessage(channelId, {
        embeds: [{
          title: 'Sale notifications are on',
          description: `New orders in **${store.name}** will land here.`,
          color: 0xffffff,
        }],
      });
      if (!posted) {
        return sendJson(res, 409, {
          error: `The bot cannot post in #${channel.name}. Give the Dues role View Channel and Send Messages there, then retry.`,
        });
      }
      fields.notifyChannelId = channelId;
    }
  }
  if (body.slug !== undefined) {
    const slug = String(body.slug).trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(slug)) {
      return sendJson(res, 400, { error: 'Links are 2–40 lowercase letters, numbers and dashes.' });
    }
    if (slug !== store.slug) {
      if (isReservedSlug(slug, store.guildId) || (await db.getStoreBySlug(slug))) {
        return sendJson(res, 409, { error: 'That link is taken — pick another.' });
      }
      fields.slug = slug;
    }
  }
  const row = await db.updateStore(store.id, fields);
  if (bannerUpload === null) await db.deleteStoreMedia(store.id, 'banner');
  else if (bannerUpload) await db.setStoreMedia(store.id, 'banner', bannerUpload.mime, bannerUpload.data);
  // The upload itself never rides a response — only what it IS, so the form
  // can show "banner uploaded" and pick <img> vs <video> for its preview.
  const bannerMedia = await db.getStoreMediaMeta(store.id, 'banner');
  // Return EVERY editable field, not just the few that changed: the dashboard
  // repopulates the settings form from this response, and any field omitted
  // here renders blank and gets wiped on the next save (the "saved, then went
  // back to empty" class of bug). Keep this in step with the form's inputs.
  sendJson(res, 200, {
    ok: true,
    store: {
      slug: row.slug,
      name: row.name,
      description: row.description ?? null,
      bannerUrl: row.banner_url ?? null,
      hasBannerUpload: Boolean(bannerMedia),
      bannerKind: bannerMedia ? uploadKind(bannerMedia.mime) : null,
      notifyChannelId: row.notify_channel_id ?? null,
      status: row.status,
      about: row.about ?? null,
      links: row.links ? JSON.parse(row.links) : null,
      showMembers: Boolean(Number(row.show_members ?? 0)),
      dashboardPrefs: row.dashboard_prefs ? JSON.parse(row.dashboard_prefs) : null,
      theme: row.theme ? JSON.parse(row.theme) : null,
      discoverable: Boolean(Number(row.discoverable ?? 0)),
      category: row.category ?? null,
      reviewsOn: Boolean(Number(row.reviews_on ?? 0)),
      creatorName: row.creator_name ?? null,
      team: row.team ? JSON.parse(row.team) : null,
      teamHeading: row.team_heading ?? null,
    },
  });
});
