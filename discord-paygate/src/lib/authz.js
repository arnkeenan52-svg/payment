import { config } from '../config.js';
import { sessionUserId } from './session.js';

// The signed-in Discord user matching OWNER_DISCORD_ID — the human allowed
// to see full doctor detail and edit the plan role mapping.
export async function ownerAuthorized(req) {
  const uid = await sessionUserId(req);
  return Boolean(uid && config.ownerDiscordId && uid === config.ownerDiscordId);
}
