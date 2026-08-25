// A stand-in Discord API, just complete enough to record the dashboard against.
//
// The dashboard's server picker, role pickers and bot-presence checks all call
// Discord for real. Recording the tour therefore needs either a live bot and a
// live guild — which makes the shoot depend on someone's Discord account
// staying exactly as it was — or this. Point DISCORD_API_BASE at it.
//
//   node scripts/hero-mock-discord.mjs &      # listens on :4312
//
// It serves ONLY what the dashboard reads. Anything else 404s loudly rather
// than returning a plausible empty object, so a scene that quietly depends on
// an unmocked endpoint fails during the shoot instead of shipping wrong.
import http from 'node:http';

const PORT = Number(process.env.MOCK_DISCORD_PORT || 4312);
const GUILD = process.env.SEED_GUILD_ID || '420000000000000001';
const OWNER = process.env.SEED_OWNER_ID || '410000000000000001';
const NAME = process.env.SEED_GUILD_NAME || 'Dues Membership';

// The roles a seller would actually have, so the role pickers look real.
const ROLES = [
  { id: '900000000000000001', name: 'VIP', color: 0xf5f5f4, position: 5, managed: false },
  { id: '900000000000000002', name: 'Signals', color: 0x57f287, position: 4, managed: false },
  { id: '900000000000000003', name: 'Inner Circle', color: 0xfee75c, position: 3, managed: false },
  { id: '900000000000000004', name: 'Member', color: 0, position: 2, managed: false },
  { id: '900000000000000009', name: 'Dues', color: 0, position: 8, managed: true },
];

const guild = { id: GUILD, name: NAME, icon: null, owner: true, permissions: String((1n << 3n).toString()) };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const p = url.pathname.replace(/^\/api\/v\d+/, '');

    if (p === '/users/@me/guilds') return json(200, [guild]);
    if (p === '/users/@me') return json(200, { id: OWNER, username: 'duesq', discriminator: '0', avatar: null });
    if (p === `/guilds/${GUILD}`) return json(200, { id: GUILD, name: NAME, icon: null, approximate_member_count: 1240 });
    if (p === `/guilds/${GUILD}/roles`) return json(200, ROLES);
    if (p.startsWith(`/guilds/${GUILD}/members/`)) return json(200, { user: { id: OWNER, username: 'duesq' }, roles: ['900000000000000004'] });
    if (p.startsWith('/channels/')) return json(200, { id: '430000000000000001', name: 'sale-alerts', type: 0 });
    if (p === `/guilds/${GUILD}/channels`) {
      return json(200, [
        { id: '430000000000000001', name: 'sale-alerts', type: 0 },
        { id: '430000000000000002', name: 'general', type: 0 },
      ]);
    }

    console.warn(`[mock-discord] UNMOCKED ${req.method} ${p} — add it rather than shipping a scene that depends on it`);
    json(404, { message: 'not mocked', code: 0 });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[mock-discord] :${PORT} · guild ${GUILD} (${NAME}) · owner ${OWNER}`));
