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

// The sender decides whether buyers actually get mail: Resend's
// onboarding@resend.dev TEST sender delivers only to the Resend account
// owner's own inbox — every real buyer is silently refused. An explicit
// override wins; otherwise the account's verified domains are looked up and
// the first one becomes the sender, so verifying a domain in Resend is the
// only step an operator ever has to take. Cached per warm instance.
let senderCache = { value: null, at: 0 };

export async function receiptFrom() {
  const explicit = process.env.RECEIPT_FROM || (await getAppSecret('receipt_from').catch(() => null));
  // The resend.dev test sender is never a real choice — the old settings UI
  // could persist it as an "override", which then shadowed the verified-
  // domain lookup forever. Only honor overrides on a real domain.
  if (explicit && !explicit.includes('resend.dev')) return explicit;
  const now = Date.now();
  if (senderCache.value && now - senderCache.at < 10 * 60_000) return senderCache.value;
  let from = 'Ripley <onboarding@resend.dev>';
  try {
    const key = await resendApiKey();
    if (key) {
      const res = await fetch(`${apiBase()}/domains`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const verified = ((await res.json()).data ?? []).find((d) => d.status === 'verified');
        if (verified) from = `Ripley <receipts@${verified.name}>`;
      }
    }
  } catch {
    /* keep the test-sender fallback; the next send retries the lookup */
  }
  if (from.includes('resend.dev')) {
    // Loud, because this failure mode is otherwise invisible: sends "work"
    // but only ever reach the Resend account owner.
    console.warn('[email] no verified Resend domain — receipts use the test sender, which does NOT deliver to real buyers');
    senderCache = { value: null, at: 0 }; // do not cache the bad state
    return from;
  }
  senderCache = { value: from, at: now };
  return from;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The site's own palette, in email-safe solid hex: near-black ground,
// hairline borders, the green accent for the good news.
export function receiptHtml({ storeName, planName, amountUsd, lifetime, discordUsername, reference, dateIso }) {
  const amount = `$${Number(amountUsd).toFixed(2)} USD`;
  const row = (k, v) => `
    <tr>
      <td style="padding:9px 0;color:#9a9f98;font-size:13px;border-bottom:1px solid #232323;">${esc(k)}</td>
      <td style="padding:9px 0;color:#f2f2f0;font-size:13px;font-weight:600;text-align:right;border-bottom:1px solid #232323;">${esc(v)}</td>
    </tr>`;
  return `
  <div style="background:#0a0a0a;padding:36px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:460px;margin:0 auto;background:#141414;border-radius:8px;padding:32px;border:1px solid #262626;">
      <table role="presentation" style="border-collapse:collapse;margin:0 0 14px;"><tr>
        <td style="width:34px;height:34px;background:#1c1c1c;border:1px solid #2e2e2e;border-radius:6px;text-align:center;vertical-align:middle;color:#ffffff;font-size:17px;font-weight:700;line-height:34px;">&#10003;</td>
        <td style="padding-left:12px;">
          <span style="display:block;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#f2f2f0;font-weight:800;">Membership Activated</span>
        </td>
      </tr></table>
      <h1 style="margin:0 0 10px;font-size:21px;line-height:1.3;color:#f2f2f0;">Your ${esc(storeName)} membership is active</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#b9beb6;line-height:1.65;">
        <strong style="color:#f2f2f0;">${esc(planName)}</strong> is active on
        <strong style="color:#f2f2f0;">@${esc(discordUsername ?? 'your Discord account')}</strong>.
        Your role is on, and every members-only channel is open to you.
      </p>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #232323;">
        ${row('Server', storeName)}
        ${row('Membership', planName)}
        ${row('Access', lifetime ? 'Lifetime, never expires' : 'Renews monthly')}
        ${row('Amount paid', amount)}
        ${row('Date', dateIso)}
        ${row('Reference', reference)}
      </table>
      <div style="margin-top:20px;">
        <a href="${esc(config.publicBaseUrl)}/account"
           style="display:inline-block;background:#ffffff;color:#0a0a0a;text-decoration:none;font-size:13px;font-weight:700;padding:11px 20px;border-radius:6px;">
          Manage Membership
        </a>
      </div>
      <p style="margin:20px 0 0;font-size:11.5px;color:#9a9f98;line-height:1.6;">
        Stripe processed your payment. Ripley sent this receipt for ${esc(storeName)}.
        Reply to this email if anything looks wrong.
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
