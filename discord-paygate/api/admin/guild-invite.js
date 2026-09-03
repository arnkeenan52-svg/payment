// THE ADMIN PANEL'S "Discord server" LINK, made to actually open something.
//
// It used to be a plain https://discord.com/channels/<guildId> href. That URL
// only resolves for somebody already in the guild — for the platform operator,
// who is not a member of a seller's private server, it lands on a dead screen.
// A link that is dead for the one person the admin panel is built for is not
// a link.
//
// So this mints a real invite through the bot, which is already in the guild
// and already asks for Create Instant Invite in its invite URL (bit 0 of
// 268455073). One use, one hour, no temporary membership — enough to look at
// a store's server when supporting its seller, not a standing key.
//
// Gate: OWNER_DISCORD_ID only, the same gate as /api/admin/platform. This
// hands out entry to somebody else's private server, so it is the platform
// operator's alone, it is never a store owner's, and it is a POST — a GET
// would let any page on the internet mint one by embedding an image.

import { sendJson, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { sessionUserId } from '../../src/lib/session.js';
import { storeBySlug } from '../../src/services/stores.js';
import { getGuildChannels, createChannelInvite } from '../../src/lib/discord.js';

export default guard(async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  if (!await sessionUserId(req)) return sendJson(res, 401, { error: 'sign in first' });
  if (!await ownerAuthorized(req)) return sendJson(res, 403, { error: 'platform owner only' });

  let body = {};
  try {
    body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return sendJson(res, 400, { error: 'bad request body' });
  }
  const slug = String(body.store ?? '').trim();
  if (!slug) return sendJson(res, 400, { error: 'which store?' });

  const store = await storeBySlug(slug).catch(() => null);
  if (!store || !store.guildId) return sendJson(res, 404, { error: 'no such store, or it has no server' });

  // The bot can only invite through a CHANNEL, so it needs one it can see.
  // Channels come back in the guild's own order, so the first is the one a
  // member would land on anyway.
  const channels = await getGuildChannels(store.guildId);
  if (!channels?.length) {
    return sendJson(res, 502, {
      error: 'Discord would not list that server’s channels — the bot may have been removed from it.',
    });
  }

  // Try them in order: a bot can be in a guild and still lack Create Instant
  // Invite on any one channel, and the first refusal is not the guild's answer.
  const failures = [];
  for (const channel of channels.slice(0, 5)) {
    try {
      const invite = await createChannelInvite(channel.id, { maxAgeSeconds: 3600, maxUses: 1 });
      if (invite?.code) {
        return sendJson(res, 200, { url: `https://discord.gg/${invite.code}`, channel: channel.name });
      }
    } catch (err) {
      failures.push(`#${channel.name}: ${err.message}`);
    }
  }
  console.warn(`[admin] no invitable channel in guild ${store.guildId}: ${failures.join(' | ')}`);
  return sendJson(res, 502, {
    error: 'The bot could not create an invite in any channel there — it needs Create Instant Invite in at least one.',
  });
});
