// Encryption-at-rest for per-store Stripe secret keys: AES-256-GCM with a
// key derived from SESSION_SECRET (HKDF), random IV per value. If
// SESSION_SECRET rotates, stored keys become unreadable and owners re-enter
// them — acceptable, and far better than plaintext keys in the database.
import crypto from 'node:crypto';
import { config } from '../config.js';

const key = () => crypto.hkdfSync('sha256', config.sessionSecret, 'ripley-store-keys', 'aes-256-gcm', 32);

export function sealSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key()), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function openSecret(sealed) {
  try {
    const [v, ivB64, encB64, tagB64] = String(sealed ?? '').split('.');
    if (v !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key()), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
