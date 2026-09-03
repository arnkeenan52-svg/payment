import { config } from '../../src/config.js';
import { sendJson, guard } from '../../src/lib/http.js';
import { sessionUserId } from '../../src/lib/session.js';
import { getUser } from '../../src/db.js';
import { getUserGuilds, getGuild } from '../../src/lib/discord.js';
import { managedStoreByGuild } from '../../src/services/stores.js';

const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

// The dashboard's server picker: every guild the signed-in user can set up
// (owner, Administrator or Manage Server), with whether the Dues bot is
// already inside and whether a store already exists for it.
export default guard(async function handler(req, res) {
  const uid = await sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'sign in first' });
    return;
  }
  const user = await getUser(uid);
  if (!user?.access_token) {
    sendJson(res, 428, { error: 'reauth', detail: 'Sign in again so Dues can list your servers.' });
    return;
  }
  let guilds;
  try {
    guilds = await getUserGuilds(user.access_token);
  } catch {
    // Tokens from before the `guilds` scope (or expired ones) can't list
    // servers — a fresh sign-in fixes both.
    sendJson(res, 428, { error: 'reauth', detail: 'Sign in again so Dues can list your servers.' });
    return;
  }

  const manageable = guilds.filter((g) => {
    if (g.owner) return true;
    try {
      const perms = BigInt(g.permissions ?? 0);
      return (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_GUILD) !== 0n;
    } catch {
      return false;
    }
  });

  const out = [];
  for (const g of manageable.slice(0, 30)) {
    const store = await managedStoreByGuild(g.id); // only managed stores count — the built-in server stays onboardable
    // Bot presence: the bot can fetch the guild object only for guilds it is
    // a member of, so a successful fetch IS the presence check.
    const botIn = Boolean(await getGuild(g.id));
    out.push({
      id: g.id,
      name: g.name,
      iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.${g.icon.startsWith('a_') ? 'gif' : 'png'}?size=64` : null,
      owner: Boolean(g.owner),
      botIn,
      store: store ? { slug: store.slug, name: store.name, status: store.status } : null,
    });
  }

  sendJson(res, 200, {
    guilds: out,
    botInvite: `https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}&scope=bot&permissions=268455073`,
  });
});
