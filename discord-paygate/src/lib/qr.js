import qrcode from 'qrcode-generator';

// The payment QR.
// ============================================================================
//
// Two decisions here are about not losing someone's money.
//
// 1. The QR encodes the BARE ADDRESS, never a payment URI with the amount in
//    it. Amount-bearing URIs differ per chain (bitcoin: takes decimal BTC,
//    ethereum: takes wei, solana: takes a decimal in a different param) and a
//    wallet that misparses one sends the wrong amount — which on this account
//    lands as `partially_paid` and grants nothing. Every wallet handles a bare
//    address correctly, and the amount sits beside the code with its own copy
//    button where the buyer can read it.
//
// 2. A chain that requires a memo/destination tag gets NO QR at all — see
//    qrForPayment below. Scanning gives the address and silently drops the
//    memo, and on those chains a payment without it cannot be credited to the
//    order. Making the buyer copy both fields by hand is the point.
//
// Error correction level M (~15%): enough that a phone camera reads it off a
// slightly glossy screen, without inflating the module count so far that the
// code stops resolving at the size we render it.

const QUIET = 4; // modules; the spec's minimum quiet zone, and scanners need it

export function qrSvg(text, { size = 200, id = 'qr' } = {}) {
  const qr = qrcode(0, 'M'); // 0 = pick the smallest version that fits
  qr.addData(String(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const span = n + QUIET * 2;

  // One path of horizontal runs rather than a rect per module: a 33x33 code is
  // over a thousand elements otherwise, and this rides inside a JSON response.
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) { c += 1; continue; }
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run += 1;
      d += `M${c + QUIET} ${r + QUIET}h${run}v1h-${run}z`;
      c += run;
    }
  }
  const title = 'Payment address QR code';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${size}" height="${size}"` +
    ` shape-rendering="crispEdges" role="img" aria-labelledby="${id}-t">` +
    `<title id="${id}-t">${title}</title>` +
    // The light modules must be painted, not left transparent: a scanner needs
    // the contrast, and on a dark page a transparent QR is unreadable.
    `<rect width="${span}" height="${span}" fill="#fff"/>` +
    `<path d="${d}" fill="#000"/></svg>`
  );
}

// Whether this payment should show a QR at all, and the code if so.
export function qrForPayment({ address, extraId, size }) {
  if (!address) return null;
  if (extraId) return null; // memo chains: see note 2 above
  return qrSvg(address, { size });
}
