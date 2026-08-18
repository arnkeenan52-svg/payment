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
    'Ripley <onboarding@resend.dev>'
  );
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function receiptHtml({ storeName, planName, amountUsd, lifetime, discordUsername, reference, dateIso }) {
  const amount = `$${Number(amountUsd).toFixed(2)} USD`;
  const row = (k, v) => `
    <tr>
      <td style="padding:9px 0;color:#8a8f98;font-size:13px;border-bottom:1px solid #eef0f3;">${esc(k)}</td>
      <td style="padding:9px 0;color:#0b0b0c;font-size:13px;font-weight:600;text-align:right;border-bottom:1px solid #eef0f3;">${esc(v)}</td>
    </tr>`;
  return `
  <div style="background:#f4f5f7;padding:36px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:460px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;border:1px solid #e6e8ec;">
      <table role="presentation" style="border-collapse:collapse;margin:0 0 14px;"><tr>
        <td style="width:34px;height:34px;background:#e9f9ef;border:1px solid #bfeccd;border-radius:6px;text-align:center;vertical-align:middle;color:#16a34a;font-size:17px;font-weight:700;line-height:34px;">&#10003;</td>
        <td style="padding-left:12px;">
          <span style="display:block;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#16a34a;font-weight:800;">Membership Activated</span>
        </td>
      </tr></table>
      <h1 style="margin:0 0 10px;font-size:21px;line-height:1.3;color:#0b0b0c;">Your ${esc(storeName)} membership is active</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#3f4450;line-height:1.65;">
        <strong>${esc(planName)}</strong> is live on
        <strong>@${esc(discordUsername ?? 'your Discord account')}</strong> — your roles have been
        delivered and every members-only channel is now open to you.
      </p>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #eef0f3;">
        ${row('Server', storeName)}
        ${row('Membership', planName)}
        ${row('Access', lifetime ? 'Lifetime — never expires' : 'Renews monthly')}
        ${row('Amount paid', amount)}
        ${row('Date', dateIso)}
        ${row('Reference', reference)}
      </table>
      <div style="margin-top:20px;">
        <a href="${esc(config.publicBaseUrl)}/account"
           style="display:inline-block;background:#0b0b0c;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 20px;border-radius:6px;">
          Manage Membership
        </a>
      </div>
      <p style="margin:20px 0 0;font-size:11.5px;color:#8a8f98;line-height:1.6;">
        Payment processed by Stripe. Sent by Ripley on behalf of ${esc(storeName)}.
        If anything looks wrong, reply to this email.
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
        subject: `Your ${storeName} membership is active`,
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
