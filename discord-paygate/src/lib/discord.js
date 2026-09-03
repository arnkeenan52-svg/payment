import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One place for every Discord REST call: Bot auth, JSON bodies, and 429
// handling. Discord tells us exactly how long to back off (retry_after in
// seconds, both in the JSON body and the Retry-After header) — honour it.
async function discordFetch(path, { method = 'GET', body, auth = `Bot ${config.discord.botToken}`, form = false } = {}) {
  const headers = { authorization: auth };
  let payload;
  if (body !== undefined) {
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    } else {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    // Bounded per attempt: webhook handlers grant BEFORE responding, so a
    // hung Discord must fail fast enough to leave room for the provider's
    // retry instead of eating the whole serverless function budget.
    const res = await fetch(`${config.discord.apiBase}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const retryAfter = Number(data.retry_after ?? res.headers.get('retry-after') ?? 1);
      await sleep(Math.min(Math.max(retryAfter * 1000, 50), 5000));
      continue;
    }
    return res;
  }
  throw new Error(`discord: still rate limited after retries: ${method} ${path}`);
}

async function expect(res, allowed, what) {
  if (allowed.includes(res.status)) return res;
  const detail = await res.text().catch(() => '');
  throw new Error(`discord: ${what} failed with ${res.status}: ${detail.slice(0, 300)}`);
}

// ── guild ─────────────────────────────────────────────────────────────────────

// The guild object (name, icon hash) — used to show the server's own icon on
// the storefront. Returns null on any failure; callers must have a fallback.
export async function getGuild(guildId = config.discord.guildId) {
  try {
    const res = await discordFetch(`/guilds/${guildId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// CDN url for a guild icon; animated icons (a_ prefix) are served as GIFs, so
// an animated server icon animates on the storefront too.
export function guildIconUrl(guild, size = 128) {
  if (!guild?.icon || !guild?.id) return null;
  const ext = guild.icon.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${ext}?size=${size}`;
}

// The bot's own user (id, username) via its token.
export async function getBotUser() {
  const res = await discordFetch('/users/@me');
  await expect(res, [200], 'fetch bot user');
  return res.json();
}

// Full role list of the guild (id, name, color, position, managed) — used by
// the doctor and the owner dashboard role picker.
export async function getGuildRoles(guildId = config.discord.guildId) {
  const res = await discordFetch(`/guilds/${guildId}/roles`);
  await expect(res, [200], 'list guild roles');
  return res.json();
}

// ── guild members and roles ───────────────────────────────────────────────────

// Thrown when the BOT is not in the guild (kicked, or the server deleted):
// an outage for every member of that store, not a fact about one buyer.
// Callers key on `code` so a sweep can stop hammering the guild.
export function botNotInGuildError(guildId) {
  const err = new Error(`discord: the bot is not in guild ${guildId} (kicked, or the server was deleted) — re-invite it; no role there can be granted or removed until then`);
  err.code = 'bot_not_in_guild';
  err.guildId = String(guildId);
  return err;
}

// WHO THE BOT IS, asked rather than assumed.
//
// The comp audit has to tell "a human handed this role over" from "Dues
// granted it", and the only thing separating them on an audit entry is the
// actor id. For a real application the bot user's id and the application id
// are the same number, so config.discord.clientId is usually right — but
// "usually right" is how a comp audit starts counting every paying member
// twice. Discord will say, so ask it, once per process.
let botUserIdCache;
export async function botUserId() {
  if (botUserIdCache !== undefined) return botUserIdCache;
  try {
    const res = await discordFetch('/users/@me');
    if (res.ok) {
      const me = await res.json();
      if (me?.id) {
        botUserIdCache = String(me.id);
        return botUserIdCache;
      }
    }
  } catch {
    /* fall through to the application id */
  }
  // Not cached as a miss: a transient failure should not pin the fallback for
  // the life of the process when the next call could get the real answer.
  return config.discord.clientId ? String(config.discord.clientId) : null;
}

// ── audit log ─────────────────────────────────────────────────────────────────

// MEMBER_ROLE_UPDATE. Discord's action_type for "somebody's roles changed";
// the entry carries target_id (who), user_id (who did it) and a changes array
// whose $add / $remove values are arrays of {id, name} roles.
export const AUDIT_MEMBER_ROLE_UPDATE = 25;

// Role changes in a guild since `after`, newest-first, capped at one page.
//
// This is how Dues sees a role handed out BY HAND. The alternative — listing
// the guild's members and diffing — needs the privileged GUILD_MEMBERS intent,
// which Discord approves per application and gates behind bot verification
// past 100 servers. The audit log needs only View Audit Log, an ordinary
// permission in the invite, and it says more: not just that somebody holds a
// role, but who gave it to them and when. Entries live 45 days, which is why
// the cursor is stored and read forward rather than rebuilt.
//
// Returns { entries, blocked }. `blocked` is Discord refusing the log —
// the bot was invited without the permission — and is a state to show the
// seller, not an error to retry into.
export async function guildRoleAuditLog(guildId, { after = null, limit = 100 } = {}) {
  const params = new URLSearchParams({
    action_type: String(AUDIT_MEMBER_ROLE_UPDATE),
    limit: String(Math.min(Math.max(limit, 1), 100)),
  });
  if (after) params.set('after', String(after));
  const res = await discordFetch(`/guilds/${guildId}/audit-logs?${params.toString()}`);
  if (res.status === 403) return { entries: [], blocked: true };
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`discord: audit log for ${guildId} failed with ${res.status}: ${detail.slice(0, 200)}`);
  }
  const body = await res.json().catch(() => ({}));
  const entries = Array.isArray(body.audit_log_entries) ? body.audit_log_entries : [];
  return { entries, blocked: false };
}

// A 404 here means one of two very different things. Unknown Member (10007)
// is the buyer not being in the server — null, and the caller may pull them
// in. Unknown Guild (10004), like 403 Missing Access (50001), is the BOT not
// being in the server; folding that into null made a kicked bot read as a
// per-buyer join failure in every log line and every webhook of the store.
export async function getGuildMember(discordId, guildId = config.discord.guildId) {
  const res = await discordFetch(`/guilds/${guildId}/members/${discordId}`);
  if (res.status === 404 || res.status === 403) {
    const data = await res.json().catch(() => ({}));
    if (data.code === 10004 || data.code === 50001 || data.message === 'Unknown Guild') throw botNotInGuildError(guildId);
    if (res.status === 404) return null;
    throw new Error(`discord: get member ${discordId} failed with 403: ${JSON.stringify(data).slice(0, 300)}`);
  }
  await expect(res, [200], `get member ${discordId}`);
  return res.json();
}

export async function addRole(discordId, roleId, guildId = config.discord.guildId) {
  const res = await discordFetch(
    `/guilds/${guildId}/members/${discordId}/roles/${roleId}`,
    { method: 'PUT' },
  );
  await expect(res, [204], `add role ${roleId} to ${discordId}`);
}

export async function removeRole(discordId, roleId, guildId = config.discord.guildId) {
  const res = await discordFetch(
    `/guilds/${guildId}/members/${discordId}/roles/${roleId}`,
    { method: 'DELETE' },
  );
  await expect(res, [204], `remove role ${roleId} from ${discordId}`);
}

// Puts a user who isn't in the guild yet inside it, with their entitled roles
// already applied — needs the guilds.join scope on their OAuth access token.
// 201 = joined, 204 = was already a member (roles are NOT applied then).
export async function joinGuildWithRoles(discordId, accessToken, roleIds, guildId = config.discord.guildId) {
  const res = await discordFetch(`/guilds/${guildId}/members/${discordId}`, {
    method: 'PUT',
    body: { access_token: accessToken, roles: roleIds },
  });
  await expect(res, [201, 204], `join ${discordId} to guild`);
  return res.status === 201;
}

// The guilds the USER belongs to, via their OAuth access token (scope:
// guilds). Used by the dashboard's server picker; owner/permissions fields
// let us show only servers they can actually set up.
export async function getUserGuilds(accessToken) {
  const res = await discordFetch('/users/@me/guilds', { auth: `Bearer ${accessToken}` });
  await expect(res, [200], 'list user guilds');
  return res.json();
}

// ── channels ──────────────────────────────────────────────────────────────────

// Text channels of a guild, for the dashboard's sale-notification picker.
// Returns null when the bot cannot list them (kicked, no access).
export async function getGuildChannels(guildId) {
  const res = await discordFetch(`/guilds/${guildId}/channels`);
  if (res.status !== 200) return null;
  const channels = await res.json();
  return channels
    .filter((c) => c.type === 0 || c.type === 5) // text + announcement
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => ({ id: c.id, name: c.name }));
}

// A fresh invite to a channel, for the platform admin panel's "Discord server"
// link (api/admin/guild-invite.js). Short-lived and single-use by default: it
// exists so an operator can look at a seller's server while helping them, not
// so a link in a dashboard becomes a standing key to somebody's community.
// Throws on refusal — the caller tries the next channel, because a bot can be
// in a guild and still lack Create Instant Invite on any one of them.
export async function createChannelInvite(channelId, { maxAgeSeconds = 3600, maxUses = 1 } = {}) {
  const res = await discordFetch(`/channels/${channelId}/invites`, {
    method: 'POST',
    body: { max_age: maxAgeSeconds, max_uses: maxUses, temporary: false, unique: true },
  });
  await expect(res, [200, 201], `create invite in channel ${channelId}`);
  return res.json();
}

// Best effort, like DMs: a sale ping that cannot be posted must never fail
// the payment that triggered it.
export async function postChannelMessage(channelId, payload) {
  try {
    const res = await discordFetch(`/channels/${channelId}/messages`, { method: 'POST', body: payload });
    await expect(res, [200], `post to channel ${channelId}`);
    return true;
  } catch (err) {
    console.warn(`[discord] channel message to ${channelId} failed: ${err.message}`);
    return false;
  }
}

// ── DMs ───────────────────────────────────────────────────────────────────────

// Best effort: members can disable DMs, and a failed DM must never fail the
// payment flow that triggered it.
export async function dmUser(discordId, content) {
  try {
    const chRes = await discordFetch('/users/@me/channels', {
      method: 'POST',
      body: { recipient_id: discordId },
    });
    await expect(chRes, [200], `open DM with ${discordId}`);
    const channel = await chRes.json();
    const msgRes = await discordFetch(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: { content },
    });
    await expect(msgRes, [200], `DM ${discordId}`);
    return true;
  } catch (err) {
    console.warn(`[discord] DM to ${discordId} failed: ${err.message}`);
    return false;
  }
}

// ── OAuth2 ────────────────────────────────────────────────────────────────────

// guilds: the dashboard server picker lists the user's servers.
// guilds.join: paid buyers can be pulled into a server automatically.
export const OAUTH_SCOPES = 'identify guilds guilds.join';

export function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    response_type: 'code',
    redirect_uri: `${config.publicBaseUrl}/auth/callback`,
    scope: OAUTH_SCOPES,
    state,
    prompt: 'none',
  });
  return `${config.discord.apiBase}/oauth2/authorize?${params}`;
}

export async function exchangeOAuthCode(code) {
  const res = await fetch(`${config.discord.apiBase}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.publicBaseUrl}/auth/callback`,
    }).toString(),
    // Bounded like every other Discord call. A token endpoint that accepts
    // the connection and never answers is the outage mode a rejection-only
    // catch cannot see: the callback would hang until the platform killed
    // the function, and that gateway timeout carries no Set-Cookie, so the
    // state cookie survives and every refresh hangs again. With the bound,
    // the callback's catch turns a hang into the 502 that spends the cookie.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`discord: oauth token exchange failed with ${res.status}`);
  return res.json();
}

export async function fetchOAuthUser(accessToken) {
  const res = await discordFetch('/users/@me', { auth: `Bearer ${accessToken}` });
  await expect(res, [200], 'fetch oauth user');
  return res.json();
}
