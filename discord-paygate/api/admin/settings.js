import { sendJson, readJsonBody, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { cronAuthorized } from '../cron/reconcile.js';
import { sessionUserId } from '../../src/lib/session.js';
import { getAppSecret, setAppSecret } from '../../src/db.js';
import { sealSecret } from '../../src/lib/secretbox.js';
import { resendApiKey, receiptFrom } from '../../src/lib/email.js';

// A bare address, or a display name in front of one in angle brackets. The
// name may not carry quotes or brackets of its own — nothing here needs the
// full RFC 5322 grammar, and a From header is not the place to explore it.
const ADDRESS = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+';
const FROM_RE = new RegExp(`^(?:${ADDRESS}|[^<>"\\r\\n]{1,80}<${ADDRESS}>)$`);

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
    const from = body.receiptFrom.trim();
    // This string goes straight into the From header of every receipt. Resend
    // rejects a sender that is not an address, and the only symptom is that
    // receipts quietly stop — so the shape is checked here, where the owner
    // can still see the answer.
    if (from.length > 120 || !FROM_RE.test(from)) {
      sendJson(res, 400, { error: 'The sender must be an email address, or Name <address> — e.g. Dues <receipts@yourdomain.com>.' });
      return;
    }
    await setAppSecret('receipt_from', from);
  }
  sendJson(res, 200, { ok: true, receiptEmails: Boolean(await resendApiKey()), receiptFrom: await receiptFrom() });
});
