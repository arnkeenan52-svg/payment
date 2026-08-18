import { config, planById } from '../../src/config.js';
import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { sessionUserId } from '../../src/lib/session.js';
import { cronAuthorized } from '../cron/reconcile.js';
import { getGuildRoles, getGuildMember, getBotUser } from '../../src/lib/discord.js';
import { setPlanOverride } from '../../src/db.js';

// Owner-only: point a plan at a real guild role, picked in the dashboard.
// Validated server-side against the LIVE guild: the role must exist, must not
// be @everyone or integration-managed, and must sit strictly below the bot's
// top role — otherwise every grant would 403 after payment.

export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  if (!(cronAuthorized(req) || ownerAuthorized(req))) {
    sendText(res, sessionUserId(req) ? 403 : 401, 'owner only');
    return;
  }

  const body = await readJsonBody(req).catch(() => null);
  const plan = body?.planId ? planById(body.planId) : null;
  const roleId = /^\d{17,20}$/.test(body?.roleId ?? '') ? body.roleId : null;
  if (!plan || !roleId) {
    sendJson(res, 400, { error: 'planId and a valid roleId are required' });
    return;
  }

  const [roles, botMember] = await Promise.all([getGuildRoles(), getBotUser().then((bot) => getGuildMember(bot.id))]);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const role = byId.get(roleId);
  if (!role) {
    sendJson(res, 400, { error: 'that role does not exist in the guild' });
    return;
  }
  if (role.id === config.discord.guildId || role.managed) {
    sendJson(res, 400, { error: 'that role cannot be granted by a bot' });
    return;
  }
  let botTop = 0;
  for (const rid of botMember?.roles ?? []) {
    const r = byId.get(rid);
    if (r && r.position > botTop) botTop = r.position;
  }
  if (role.position >= botTop) {
    sendJson(res, 400, {
      error: `"${role.name}" (position ${role.position}) is at or above the bot's top role (position ${botTop}) — drag the bot's role above it in Server Settings → Roles, or pick a lower role`,
    });
    return;
  }

  await setPlanOverride(plan.id, [role.id], [`@${role.name}`]);
  sendJson(res, 200, { ok: true, planId: plan.id, roleId: role.id, roleName: role.name });
});
