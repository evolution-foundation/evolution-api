import { createDecipheriv, createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { inflateSync } from 'node:zlib';

import { proto } from 'baileys';

export const GROUP_HISTORY_DOWNLOAD_TIMEOUT_MS = 30_000;
export const GROUP_HISTORY_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const GROUP_HISTORY_MAX_INFLATE_BYTES = 20 * 1024 * 1024;
export const GROUP_HISTORY_MAX_ENTRIES = 50_000;

const GROUP_HISTORY_HKDF_INFO = Buffer.from('Group History');
const HKDF_OUTPUT_LENGTH = 112;
const MAC_LENGTH = 10;
const AES_BLOCK_SIZE = 16;
const TOP_LEVEL_MESSAGE_FIELDS = new Set([1, 3, 4, 5]);
const ASSOCIATED_MESSAGE_LISTS_FIELD = 2;
const NESTED_MESSAGE_FIELDS = new Set([1]);

function readVarint(buf: Buffer, offset: number): { value: number; nextOffset: number } {
  let result = 0;
  let multiplier = 1;

  for (let i = 0; i < 10; i++) {
    if (offset + i >= buf.length) {
      throw new Error('Malformed GroupHistory protobuf: truncated varint');
    }

    const byte = buf[offset + i];
    if (i === 9 && byte > 1) {
      throw new Error('Malformed GroupHistory protobuf: varint overflow');
    }

    result += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(result)) {
      throw new Error('Malformed GroupHistory protobuf: varint exceeds safe integer');
    }

    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: offset + i + 1 };
    }

    multiplier *= 128;
  }

  throw new Error('Malformed GroupHistory protobuf: varint too long');
}

function skipVarint(buf: Buffer, offset: number): number {
  for (let i = 0; i < 10; i++) {
    if (offset + i >= buf.length) {
      throw new Error('Malformed GroupHistory protobuf: truncated varint');
    }
    if ((buf[offset + i] & 0x80) === 0) {
      return offset + i + 1;
    }
  }

  throw new Error('Malformed GroupHistory protobuf: varint too long');
}

function parseFields(
  buf: Buffer,
  entries: proto.IWebMessageInfo[],
  messageFields: ReadonlySet<number>,
  nestedField?: number,
): void {
  let offset = 0;

  while (offset < buf.length) {
    const tagRes = readVarint(buf, offset);
    const tag = tagRes.value;
    offset = tagRes.nextOffset;

    if (tag === 0 || tag > 0xffffffff) {
      throw new Error(`Malformed GroupHistory protobuf: invalid tag ${tag}`);
    }

    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    if (fieldNumber === 0) {
      throw new Error('Malformed GroupHistory protobuf: field number 0');
    }

    if (messageFields.has(fieldNumber)) {
      if (wireType !== 2) {
        const scope = nestedField === undefined ? ' (nested)' : '';
        throw new Error(
          `Malformed GroupHistory protobuf: unexpected wire type ${wireType} for field ${fieldNumber}${scope}`,
        );
      }

      if (entries.length >= GROUP_HISTORY_MAX_ENTRIES) {
        throw new Error('Malformed GroupHistory protobuf: too many entries');
      }

      const lenRes = readVarint(buf, offset);
      const len = lenRes.value;
      offset = lenRes.nextOffset;

      if (len > buf.length - offset) {
        throw new Error(`Malformed GroupHistory protobuf: truncated field ${fieldNumber} payload`);
      }

      const slice = buf.subarray(offset, offset + len);
      offset += len;
      entries.push(proto.WebMessageInfo.decode(slice));
      continue;
    }

    if (nestedField !== undefined && fieldNumber === nestedField) {
      if (wireType !== 2) {
        throw new Error(`Malformed GroupHistory protobuf: unexpected wire type ${wireType} for field ${fieldNumber}`);
      }

      const lenRes = readVarint(buf, offset);
      const len = lenRes.value;
      offset = lenRes.nextOffset;

      if (len > buf.length - offset) {
        throw new Error(`Malformed GroupHistory protobuf: truncated field ${fieldNumber} payload`);
      }

      const slice = buf.subarray(offset, offset + len);
      offset += len;
      parseFields(slice, entries, NESTED_MESSAGE_FIELDS);
      continue;
    }

    switch (wireType) {
      case 0:
        offset = skipVarint(buf, offset);
        break;
      case 1:
        if (offset + 8 > buf.length) {
          throw new Error('Malformed GroupHistory protobuf: truncated 64-bit field');
        }
        offset += 8;
        break;
      case 2: {
        const lenRes = readVarint(buf, offset);
        const len = lenRes.value;
        offset = lenRes.nextOffset;
        if (len > buf.length - offset) {
          throw new Error('Malformed GroupHistory protobuf: truncated length-delimited field');
        }
        offset += len;
        break;
      }
      case 5:
        if (offset + 4 > buf.length) {
          throw new Error('Malformed GroupHistory protobuf: truncated 32-bit field');
        }
        offset += 4;
        break;
      default:
        throw new Error(`Malformed GroupHistory protobuf: unsupported wire type ${wireType}`);
    }
  }
}

function parseGroupHistory(buf: Buffer): proto.IWebMessageInfo[] {
  const entries: proto.IWebMessageInfo[] = [];
  parseFields(buf, entries, TOP_LEVEL_MESSAGE_FIELDS, ASSOCIATED_MESSAGE_LISTS_FIELD);
  return entries;
}

export function decryptGroupHistoryBundle(
  file: Buffer,
  mediaKey: Uint8Array,
  fileEncSha256?: Uint8Array | null,
): proto.IWebMessageInfo[] {
  if (!mediaKey || mediaKey.length !== 32) {
    throw new Error(`Invalid GroupHistory mediaKey length: expected 32, got ${mediaKey?.length ?? 0}`);
  }

  if (
    !Buffer.isBuffer(file) ||
    file.length < AES_BLOCK_SIZE + MAC_LENGTH ||
    (file.length - MAC_LENGTH) % AES_BLOCK_SIZE !== 0
  ) {
    throw new Error(`Invalid GroupHistory encrypted file length: ${file?.length ?? 0}`);
  }

  if (fileEncSha256 != null) {
    if (fileEncSha256.length !== 32) {
      throw new Error(`Invalid GroupHistory fileEncSha256 length: expected 32, got ${fileEncSha256.length}`);
    }
    const actualSha256 = createHash('sha256').update(file).digest();
    if (!timingSafeEqual(actualSha256, fileEncSha256)) {
      throw new Error('GroupHistory bundle fileEncSha256 mismatch');
    }
  }

  const expandedKey = Buffer.from(
    hkdfSync('sha256', mediaKey, Buffer.alloc(0), GROUP_HISTORY_HKDF_INFO, HKDF_OUTPUT_LENGTH),
  );
  const iv = expandedKey.subarray(0, 16);
  const cipherKey = expandedKey.subarray(16, 48);
  const macKey = expandedKey.subarray(48, 80);

  const ciphertext = file.subarray(0, file.length - MAC_LENGTH);
  const mac10 = file.subarray(file.length - MAC_LENGTH);
  const expectedMac10 = createHmac('sha256', macKey).update(iv).update(ciphertext).digest().subarray(0, MAC_LENGTH);

  if (!timingSafeEqual(expectedMac10, mac10)) {
    throw new Error('GroupHistory bundle MAC mismatch');
  }

  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const plaintext = inflateSync(compressed, { maxOutputLength: GROUP_HISTORY_MAX_INFLATE_BYTES });

  return parseGroupHistory(plaintext);
}
