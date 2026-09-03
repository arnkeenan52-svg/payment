// The one whitelist for everything an owner uploads through the dashboard —
// product photos and store banners alike. Uploads arrive as data URLs on a
// JSON body: stills are downscaled client-side (~100KB typical; 2M chars ≈
// 1.5MB decoded is the hard ceiling), while GIFs and short MP4/WebM clips ride
// through un-recompressed — a canvas pass would freeze them — with a 4M-char
// cap (~3MB decoded) so the body stays deliverable.
//
// This set is deliberately narrow because /api/img echoes the parsed MIME back
// as the response content-type under nosniff: widening it here widens what the
// platform will serve from its own origin.

// Room for the largest data URL the whitelist accepts plus the JSON around it.
// Vercel pre-parses request bodies, but the dev shim reads the stream itself,
// so upload routes must raise their own ceiling or lose the very uploads the
// whitelist allows.
export const UPLOAD_BODY_LIMIT = 6 * 1024 * 1024;

const STILL = /^data:(image\/(?:png|jpeg|webp));base64,[A-Za-z0-9+/=]+$/;
const ANIMATED = /^data:(image\/gif|video\/(?:mp4|webm));base64,[A-Za-z0-9+/=]+$/;

// Returns { mime } for an acceptable upload, null for anything else — the
// caller decides which of the two that is (a 400 with a human sentence, or a
// silent fall-back to a pasted link).
export function parseUploadDataUrl(v, { maxStill = 2_000_000, maxAnimated = 4_000_000 } = {}) {
  if (typeof v !== 'string') return null;
  let m;
  if (v.length <= maxStill && (m = STILL.exec(v))) return { mime: m[1] };
  if (v.length <= maxAnimated && (m = ANIMATED.exec(v))) return { mime: m[1] };
  return null;
}

// What the upload IS, for surfaces that must choose <img> vs <video> without
// ever loading the bytes.
export const uploadKind = (mime) => (String(mime ?? '').startsWith('video/') ? 'video' : 'image');
