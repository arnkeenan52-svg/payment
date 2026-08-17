import { config } from '../config.js';
import { sessionUserId } from './session.js';

// The signed-in Discord user matching OWNER_DISCORD_ID — the human allowed
// to see diagnostics detail and edit the plan role mapping.
export function ownerAuthorized(req) {
  const uid = sessionUserId(req);
  return Boolean(uid && config.ownerDiscordId && uid === config.ownerDiscordId);
}
