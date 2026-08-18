// Receipt emails via Resend's REST API (no SDK). Strictly best-effort:
// a receipt that cannot be sent must never fail the payment flow that
// triggered it. The API key comes from RESEND_API_KEY or, so the owner can
// set it from the dashboard without a redeploy, the sealed app_secrets row.
import { config } from '../config.js';
import { getAppSecret } from '../db.js';
import { openSecret } from './secretbox.js';

const apiBase = () => process.env.RESEND_API_BASE || 'https://api.resend.com';

export async function resendApiKey() {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  const sealed = await getAppSecret('resend_api_key').catch(() => null);
  return sealed ? openSecret(sealed) : null;
}

export async function receiptFrom() {
  return (
    process.env.RECEIPT_FROM ||
    (await getAppSecret('receipt_from').catch(() => null)) ||
    'Ripley Receipts <onboarding@resend.dev>'
  );
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function receiptHtml({ storeName, planName, amountUsd, lifetime, discordUsername, reference, dateIso }) {
  const amount = `$${Number(amountUsd).toFixed(2)} USD`;
  const row = (k, v) => `
    <tr>
      <td style="padding:8px 0;color:#8a8f98;font-size:13px;">${esc(k)}</td>
      <td style="padding:8px 0;color:#0b0b0c;font-size:13px;font-weight:600;text-align:right;">${esc(v)}</td>
    </tr>`;
  return `
  <div style="background:#f4f5f7;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:460px;margin:0 auto;background:#ffffff;border-radius:14px;padding:28px;border:1px solid #e6e8ec;">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#8a8f98;font-weight:700;">Receipt</p>
      <h1 style="margin:0 0 18px;font-size:20px;color:#0b0b0c;">${esc(storeName)}</h1>
      <p style="margin:0 0 18px;font-size:14px;color:#3f4450;line-height:1.6;">
        Thanks for your purchase — your access has been delivered to
        <strong>@${esc(discordUsername ?? 'your Discord account')}</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6e8ec;">
        ${row('Product', planName)}
        ${row('Access', lifetime ? 'Lifetime — never expires' : 'Subscription')}
        ${row('Amount', amount)}
        ${row('Date', dateIso)}
        ${row('Reference', reference)}
      </table>
      <div style="border-top:1px solid #e6e8ec;margin-top:6px;padding-top:16px;">
        <a href="${esc(config.publicBaseUrl)}/account"
           style="display:inline-block;background:#0b0b0c;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 18px;border-radius:999px;">
          Manage your access
        </a>
      </div>
      <p style="margin:18px 0 0;font-size:11.5px;color:#8a8f98;">
        Payment processed by Stripe. Sent by Ripley on behalf of ${esc(storeName)}.
      </p>
    </div>
  </div>`;
}

// Fire-and-forget: resolves true when Resend accepted the email.
export async function sendReceiptEmail({ to, storeName, planName, amountUsd, lifetime, discordUsername, reference }) {
  try {
    const key = await resendApiKey();
    if (!key || !to) return false;
    const res = await fetch(`${apiBase()}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: await receiptFrom(),
        to: [to],
        subject: `Your ${storeName} receipt — ${planName}`,
        html: receiptHtml({
          storeName,
          planName,
          amountUsd,
          lifetime,
          discordUsername,
          reference,
          dateIso: new Date().toISOString().slice(0, 10),
        }),
      }),
    });
    if (!res.ok) {
      console.warn(`[email] resend answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[email] receipt to ${to} failed: ${err.message}`);
    return false;
  }
}
