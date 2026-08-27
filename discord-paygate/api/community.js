// The community-server join link, as a stable platform URL. The homepage
// can't read env, so it links here; the hop goes to the Dues community
// server's permanent invite when one is configured, and otherwise falls back
// to the bot-invite screen so the button never dead-ends.
import { guard, redirect } from '../src/lib/http.js';

export default guard(async (req, res) => {
  const invite = process.env.DISCORD_COMMUNITY_INVITE;
  redirect(res, invite || 'https://discord.gg/G6yjsX5qbB');
});
