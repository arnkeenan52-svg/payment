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
    const res = await fetch(`${config.discord.apiBase}${path}`, { method, headers, body: payload });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const retryAfter = Number(data.retry_after ?? res.headers.get('retry-after') ?? 1);
      await sleep(Math.max(retryAfter * 1000, 50));
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

// ── guild members and roles ───────────────────────────────────────────────────

export async function getGuildMember(discordId) {
  const res = await discordFetch(`/guilds/${config.discord.guildId}/members/${discordId}`);
  if (res.status === 404) return null;
  await expect(res, [200], `get member ${discordId}`);
  return res.json();
}

export async function addRole(discordId, roleId) {
  const res = await discordFetch(
    `/guilds/${config.discord.guildId}/members/${discordId}/roles/${roleId}`,
    { method: 'PUT' },
  );
  await expect(res, [204], `add role ${roleId} to ${discordId}`);
}

export async function removeRole(discordId, roleId) {
  const res = await discordFetch(
    `/guilds/${config.discord.guildId}/members/${discordId}/roles/${roleId}`,
    { method: 'DELETE' },
  );
  await expect(res, [204], `remove role ${roleId} from ${discordId}`);
}

// Puts a user who isn't in the guild yet inside it, with their entitled roles
// already applied — needs the guilds.join scope on their OAuth access token.
// 201 = joined, 204 = was already a member (roles are NOT applied then).
export async function joinGuildWithRoles(discordId, accessToken, roleIds) {
  const res = await discordFetch(`/guilds/${config.discord.guildId}/members/${discordId}`, {
    method: 'PUT',
    body: { access_token: accessToken, roles: roleIds },
  });
  await expect(res, [201, 204], `join ${discordId} to guild`);
  return res.status === 201;
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

export const OAUTH_SCOPES = 'identify guilds.join';

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
