import { sendJson, readJsonBody, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { cronAuthorized } from '../cron/reconcile.js';
import { sessionUserId } from '../../src/lib/session.js';
import { getAppSecret, setAppSecret } from '../../src/db.js';
import { sealSecret } from '../../src/lib/secretbox.js';
import { resendApiKey, receiptFrom } from '../../src/lib/email.js';

// Platform settings (owner only): the Resend key powering receipt emails and
// the From address. Stored sealed in the database so no redeploy is needed;
// values are never echoed back — only their presence.
export default guard(async function handler(req, res) {
  if (!(ownerAuthorized(req) || cronAuthorized(req))) {
    sendJson(res, sessionUserId(req) ? 403 : 401, { error: 'owner only' });
    return;
  }
  if (req.method === 'GET') {
    sendJson(res, 200, {
      receiptEmails: Boolean(await resendApiKey()),
      receiptFrom: await receiptFrom(),
    });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const body = await readJsonBody(req).catch(() => ({}));
  if (typeof body.resendApiKey === 'string' && body.resendApiKey.trim()) {
    const key = body.resendApiKey.trim();
    if (!/^re_[A-Za-z0-9_]{10,}$/.test(key)) {
      sendJson(res, 400, { error: 'That does not look like a Resend API key (re_…).' });
      return;
    }
    await setAppSecret('resend_api_key', sealSecret(key));
  }
  if (typeof body.receiptFrom === 'string' && body.receiptFrom.trim()) {
    await setAppSecret('receipt_from', body.receiptFrom.trim().slice(0, 120));
  }
  sendJson(res, 200, { ok: true, receiptEmails: Boolean(await resendApiKey()), receiptFrom: await receiptFrom() });
});
