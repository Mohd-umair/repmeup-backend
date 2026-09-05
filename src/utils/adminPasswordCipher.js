const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function encryptionKey() {
  const raw = process.env.ADMIN_PASSWORD_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!raw || String(raw).length < 16) {
    throw new Error('ADMIN_PASSWORD_ENCRYPTION_KEY or JWT_SECRET must be configured');
  }
  return crypto.createHash('sha256').update(String(raw)).digest();
}

/**
 * Encrypt a plaintext password for super-admin recovery (at rest only).
 * @param {string} plain
 * @returns {string}
 */
function encryptAdminPassword(plain) {
  if (!plain) return '';
  const key = encryptionKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * @param {string} payload
 * @returns {string|null}
 */
function decryptAdminPassword(payload) {
  if (!payload || typeof payload !== 'string' || !payload.includes(':')) {
    return null;
  }
  try {
    const [ivB64, tagB64, cipherB64] = payload.split(':');
    const key = encryptionKey();
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(cipherB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

module.exports = {
  encryptAdminPassword,
  decryptAdminPassword
};
