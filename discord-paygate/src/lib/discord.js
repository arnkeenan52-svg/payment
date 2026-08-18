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
// the doctor and the owner diagnostics role picker.
export async function getGuildRoles(guildId = config.discord.guildId) {
  const res = await discordFetch(`/guilds/${guildId}/roles`);
  await expect(res, [200], 'list guild roles');
  return res.json();
}

// ── guild members and roles ───────────────────────────────────────────────────

export async function getGuildMember(discordId, guildId = config.discord.guildId) {
  const res = await discordFetch(`/guilds/${guildId}/members/${discordId}`);
  if (res.status === 404) return null;
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
  });
  if (!res.ok) throw new Error(`discord: oauth token exchange failed with ${res.status}`);
  return res.json();
}

export async function fetchOAuthUser(accessToken) {
  const res = await discordFetch('/users/@me', { auth: `Bearer ${accessToken}` });
  await expect(res, [200], 'fetch oauth user');
  return res.json();
}
