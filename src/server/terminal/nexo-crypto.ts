import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SharedKey } from '../../shared/contract.ts';

// Adyen Terminal API message protection ("shared key"), as implemented by Adyen's Node, Java and .NET
// libraries: PBKDF2-HMAC-SHA1 → AES-256-CBC with IV ⊕ nonce, HMAC-SHA256 over
// the plaintext. The MessageHeader travels in clear next to the blob.

const derived = new Map<string, { hmacKey: Buffer; cipherKey: Buffer; iv: Buffer }>();

function derive(passphrase: string) {
  let keys = derived.get(passphrase);
  if (!keys) {
    const dk = pbkdf2Sync(passphrase, 'AdyenNexoV1Salt', 4000, 80, 'sha1');
    keys = { hmacKey: dk.subarray(0, 32), cipherKey: dk.subarray(32, 64), iv: dk.subarray(64, 80) };
    derived.set(passphrase, keys);
  }
  return keys;
}

const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((v, i) => v ^ b[i]));

export interface Envelope {
  MessageHeader: unknown;
  NexoBlob: string;
  SecurityTrailer: { AdyenCryptoVersion: number; KeyIdentifier: string; KeyVersion: number; Nonce: string; Hmac: string };
}

/** `{ [root]: message }` → `{ [root]: Envelope }` */
export function encrypt(root: string, message: { MessageHeader: unknown }, key: SharedKey): Record<string, Envelope> {
  const plain = Buffer.from(JSON.stringify({ [root]: message }), 'utf8');
  const { hmacKey, cipherKey, iv } = derive(key.passphrase);
  const nonce = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', cipherKey, xor(iv, nonce));
  return {
    [root]: {
      MessageHeader: message.MessageHeader,
      NexoBlob: Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64'),
      SecurityTrailer: {
        AdyenCryptoVersion: 1,
        KeyIdentifier: key.keyIdentifier,
        KeyVersion: key.keyVersion,
        Nonce: nonce.toString('base64'),
        Hmac: createHmac('sha256', hmacKey).update(plain).digest('base64'),
      },
    },
  };
}

/** The decrypted message text, or null if the key, the cipher text or the HMAC do not match. */
export function decrypt(envelope: Envelope, key: SharedKey): string | null {
  const trailer = envelope.SecurityTrailer;
  if (!trailer || trailer.AdyenCryptoVersion !== 1 || trailer.KeyIdentifier !== key.keyIdentifier || trailer.KeyVersion !== key.keyVersion) return null;
  try {
    const { hmacKey, cipherKey, iv } = derive(key.passphrase);
    const decipher = createDecipheriv('aes-256-cbc', cipherKey, xor(iv, Buffer.from(trailer.Nonce, 'base64')));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.NexoBlob, 'base64')), decipher.final()]);
    const expected = createHmac('sha256', hmacKey).update(plain).digest();
    const received = Buffer.from(trailer.Hmac, 'base64');
    return received.length === expected.length && timingSafeEqual(received, expected) ? plain.toString('utf8') : null;
  } catch {
    return null;
  }
}
