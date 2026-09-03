// The community-server join link, as a stable platform URL. The homepage
// can't read env, so it links here; the hop goes to the Dues community
// server's permanent invite. The invite itself lives in config
// (COMMUNITY_INVITE) — the same value the receipt email links — so there is
// exactly one place to change when it is re-issued.
import { config } from '../src/config.js';
import { guard, redirect } from '../src/lib/http.js';

export default guard(async (req, res) => {
  redirect(res, config.communityInvite);
});
