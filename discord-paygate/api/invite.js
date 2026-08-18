// The bot-invite link, as a stable platform URL. The homepage (static HTML)
// can't read DISCORD_CLIENT_ID, so it links here and this hop carries the
// visitor to Discord's authorize screen with the exact same scope and
// permissions the onboarding wizard requests (Manage Roles).
import { guard, redirect, sendText } from '../src/lib/http.js';
import { config } from '../src/config.js';

export default guard(async (req, res) => {
  if (!config.discord.clientId) {
    return sendText(res, 500, 'DISCORD_CLIENT_ID is not configured');
  }
  redirect(
    res,
    `https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}&scope=bot&permissions=268435456`,
  );
});
