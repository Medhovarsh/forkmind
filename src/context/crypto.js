const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');

/**
 * Key management + AES-256-GCM for context capsules.
 *
 * The master key lives OUTSIDE .forkmind/ (in ~/.forkmind-keys/ by default,
 * overridable via FORKMIND_KEY_DIR). `.forkmind/` is the directory users are
 * told to .gitignore but sometimes commit anyway — keeping keys elsewhere means
 * a leaked .forkmind/ exposes only ciphertext and manifests.
 *
 * Each capsule gets its own random DEK (data-encryption key). The DEK is
 * wrapped with the project master key and stored in the capsule manifest.
 * Deleting a capsule destroys the wrapped DEK first (crypto-shredding), so
 * even ciphertext surviving in backups or FS snapshots stays unreadable.
 */

const ALG = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function keyDir() {
  return process.env.FORKMIND_KEY_DIR || path.join(os.homedir(), '.forkmind-keys');
}

/** Stable per-project key filename derived from the project path, not its contents. */
function projectKeyPath() {
  const projectHash = crypto
    .createHash('sha256')
    .update(process.cwd())
    .digest('hex')
    .slice(0, 12);
  return path.join(keyDir(), `${projectHash}.key`);
}

/**
 * Load the project master key, creating it (0600) on first use.
 * @returns {Buffer} 32-byte master key.
 */
function loadMasterKey() {
  const p = projectKeyPath();
  if (fs.existsSync(p)) {
    const key = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex');
    if (key.length !== KEY_BYTES) {
      throw new Error(`master key at ${p} is corrupt (expected ${KEY_BYTES} bytes)`);
    }
    return key;
  }
  fs.ensureDirSync(keyDir());
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(p, key.toString('hex'), { mode: 0o600 });
  return key;
}

/** nonce ‖ ciphertext ‖ tag, as one buffer. */
function encrypt(key, plaintext) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

/**
 * Inverse of encrypt(). Throws on tamper (GCM auth failure).
 * @returns {string} plaintext (utf8).
 */
function decrypt(key, blob) {
  if (blob.length < NONCE_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALG, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Fresh random DEK for one capsule. */
function newDek() {
  return crypto.randomBytes(KEY_BYTES);
}

/** Wrap a DEK with the master key → hex string safe to store in a manifest. */
function wrapDek(masterKey, dek) {
  return encrypt(masterKey, dek.toString('hex')).toString('hex');
}

/** @returns {Buffer} the unwrapped DEK. Throws if the wrap was tampered. */
function unwrapDek(masterKey, wrapped) {
  return Buffer.from(decrypt(masterKey, Buffer.from(wrapped, 'hex')), 'hex');
}

// scrypt params for passphrase-derived export keys. N=2^15 costs ~100-200ms
// on typical hardware — deliberately slow to resist offline brute force of a
// weak export passphrase, since an exported bundle may leave the machine
// (email, USB, a different project's key store) where the local master key
// no longer protects it.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;

/**
 * Derive a 32-byte key from a passphrase + salt (scrypt). Used only for
 * capsule export/import — day-to-day capsule crypto never touches a
 * passphrase, only the local master key.
 * @returns {{key: Buffer, salt: Buffer}}
 */
function deriveExportKey(passphrase, salt = crypto.randomBytes(SALT_BYTES)) {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('export passphrase must be a string of at least 8 characters');
  }
  const key = crypto.scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // Node's scrypt defaults to a 32MB working-set cap; N*r*p at these
    // params needs ~32MB itself, so raise the ceiling rather than weaken KDF.
    maxmem: 64 * 1024 * 1024,
  });
  return { key, salt };
}

module.exports = {
  loadMasterKey,
  projectKeyPath,
  encrypt,
  decrypt,
  newDek,
  wrapDek,
  unwrapDek,
  deriveExportKey,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
};
