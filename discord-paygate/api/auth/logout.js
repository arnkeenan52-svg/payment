import { redirect, guard } from '../../src/lib/http.js';
import { clearSessionCookie } from '../../src/lib/session.js';

export default guard(function handler(req, res) {
  redirect(res, '/', { 'set-cookie': clearSessionCookie() });
});
