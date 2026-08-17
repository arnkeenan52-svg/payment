import { redirect } from '../../src/lib/http.js';
import { clearSessionCookie } from '../../src/lib/session.js';

export default function handler(req, res) {
  redirect(res, '/', { 'set-cookie': clearSessionCookie() });
}
