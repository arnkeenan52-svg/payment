import { config } from '../../src/config.js';
import { sendJson, sendText, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { sessionUserId } from '../../src/lib/session.js';
import { cronAuthorized } from '../cron/reconcile.js';
import { getGuildRoles, getGuildMember, getBotUser } from '../../src/lib/discord.js';
import { effectiveRoleMap } from '../../src/services/plan-config.js';

// Owner-only: the guild's live role list for the dashboard role picker.
// Roles the bot cannot grant are flagged unusable with the reason — that
// makes the hierarchy problem visible instead of mysterious.

const colorHex = (n) => (n ? `#${Number(n).toString(16).padStart(6, '0')}` : null);

export default guard(async function handler(req, res) {
  if (req.method !== 'GET') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  if (!(cronAuthorized(req) || ownerAuthorized(req))) {
    sendText(res, sessionUserId(req) ? 403 : 401, 'owner only');
    return;
  }

  const [roles, botMember] = await Promise.all([
    getGuildRoles(),
    getBotUser().then((bot) => getGuildMember(bot.id)),
  ]);

  const byId = new Map(roles.map((r) => [r.id, r]));
  let botTop = { id: config.discord.guildId, name: '@everyone', position: 0 };
  for (const rid of botMember?.roles ?? []) {
    const role = byId.get(rid);
    if (role && role.position > botTop.position) botTop = { id: role.id, name: role.name, position: role.position };
  }

  const usability = (role) => {
    if (role.id === config.discord.guildId) return { usable: false, reason: '@everyone cannot be granted' };
    if (role.managed) return { usable: false, reason: 'managed by an integration — bots cannot grant it' };
    if (role.position >= botTop.position) return { usable: false, reason: `at or above the bot's top role "${botTop.name}" (position ${botTop.position}) — drag the bot's role higher or pick a lower role` };
    return { usable: true };
  };

  const roleMap = await effectiveRoleMap();
  sendJson(res, 200, {
    botTop,
    botFound: Boolean(botMember),
    roles: roles
      .slice()
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: colorHex(r.color),
        position: r.position,
        managed: Boolean(r.managed),
        ...usability(r),
      })),
    plans: config.plans.map((p) => ({
      id: p.id,
      name: p.name,
      roleIds: roleMap.get(p.id)?.roleIds ?? p.roleIds,
      roleNames: roleMap.get(p.id)?.roleNames ?? p.roleNames ?? [],
      source: roleMap.get(p.id)?.source ?? 'default',
    })),
  });
});
