// Protocol reference: whatsmeow's pair-passkey.go (tulir/whatsmeow, MPL-2.0), independently reimplemented.
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'crypto';

function varint(nInput: number): Buffer {
  let n = nInput;
  const bytes: number[] = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}
function lenField(field: number, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 2]), varint(data.length), data]);
}
function varintField(field: number, value: number): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 0]), varint(value)]);
}

export function encodeCompanionEphemeralIdentity(publicKey: Buffer, deviceType: number, ref: string): Buffer {
  return Buffer.concat([lenField(1, publicKey), varintField(2, deviceType), lenField(3, Buffer.from(ref, 'utf8'))]);
}
export function encodeProloguePayload(companionEphemeralIdentity: Buffer, commitmentHash: Buffer): Buffer {
  const commitment = lenField(1, commitmentHash);
  return Buffer.concat([lenField(1, companionEphemeralIdentity), lenField(2, commitment)]);
}
export function encodePairingRequest(companionPublicKey: Buffer, companionIdentityKey: Buffer, advSecret: Buffer): Buffer {
  return Buffer.concat([lenField(1, companionPublicKey), lenField(2, companionIdentityKey), lenField(3, advSecret)]);
}
export function encodeEncryptedPairingRequest(encryptedPayload: Buffer, iv: Buffer): Buffer {
  return Buffer.concat([lenField(1, encryptedPayload), lenField(2, iv)]);
}

export function decodePrimaryEphemeralIdentity(buf: Buffer): { publicKey: Buffer; nonce: Buffer } {
  let publicKey = Buffer.alloc(0);
  let nonce = Buffer.alloc(0);
  let i = 0;
  while (i < buf.length) {
    const key = buf[i++];
    const field = key >> 3;
    const wire = key & 0x7;
    if (wire !== 2) throw new Error(`field ${field} has unexpected wire type ${wire}`);
    let len = 0;
    let shift = 0;
    for (;;) {
      const b = buf[i++];
      len |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const data = buf.subarray(i, i + len);
    i += len;
    if (field === 1) publicKey = Buffer.from(data);
    else if (field === 2) nonce = Buffer.from(data);
  }
  if (publicKey.length !== 32) throw new Error(`primary publicKey len ${publicKey.length} != 32`);
  if (nonce.length !== 32) throw new Error(`primary nonce len ${nonce.length} != 32`);
  return { publicKey, nonce };
}

export const sha256 = (buf: Buffer): Buffer => createHash('sha256').update(buf).digest();
export const hmacSha256 = (key: Buffer, buf: Buffer): Buffer => createHmac('sha256', key).update(buf).digest();
export const hkdf256 = (ikm: Buffer, salt: Buffer, info: string, len = 32): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), len));

export function aesGcmEncrypt(key: Buffer, iv: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

export const deriveHandoffKey = (advSecretKey: Buffer): Buffer =>
  hkdf256(advSecretKey, Buffer.alloc(32, 0), 'shortcake-passkey-handoff-v1', 32);

export const buildCommitment = (identBytes: Buffer, companionNonce: Buffer): Buffer =>
  sha256(Buffer.concat([identBytes, companionNonce]));

export const deriveEncryptionKey = (sharedSecret: Buffer, deviceType: number, pairingRef: string): Buffer =>
  hkdf256(
    sharedSecret,
    Buffer.from(`Companion Pairing ${deviceType} with ref ${pairingRef}`, 'utf8'),
    'Pairing Information Encryption Key',
    32,
  );

const LINKING_BASE32 = '123456789ABCDEFGHJKLMNPQRSTVWXYZ';

export function derivePairingCode(companionNonce: Buffer, primaryPublicKey: Buffer, primaryNonce: Buffer): string {
  const digest = sha256(Buffer.concat([companionNonce, primaryPublicKey]));
  const codeBytes = Buffer.alloc(5);
  for (let i = 0; i < 5; i++) codeBytes[i] = primaryNonce[i] ^ digest[i];
  let bits = 0n;
  for (const b of codeBytes) bits = (bits << 8n) | BigInt(b);
  let encoded = '';
  for (let g = 7; g >= 0; g--) encoded += LINKING_BASE32[Number((bits >> BigInt(g * 5)) & 0x1fn)];
  return `${encoded.slice(0, 4)}-${encoded.slice(4)}`;
}

export { randomBytes };
