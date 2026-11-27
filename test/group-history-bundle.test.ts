import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';

import { decryptGroupHistoryBundle, GROUP_HISTORY_MAX_ENTRIES } from '@utils/groupHistoryBundle';
import { proto } from 'baileys';

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeField1Message(msgBytes: Uint8Array): Buffer {
  const tag = encodeVarint((1 << 3) | 2);
  const len = encodeVarint(msgBytes.length);
  return Buffer.concat([tag, len, Buffer.from(msgBytes)]);
}

function encryptBundle(plaintext: Buffer, mediaKey: Uint8Array): { file: Buffer; fileEncSha256: Buffer } {
  const compressed = deflateSync(plaintext);
  const expanded = Buffer.from(hkdfSync('sha256', mediaKey, Buffer.alloc(0), Buffer.from('Group History'), 112));
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);

  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const mac10 = createHmac('sha256', macKey).update(iv).update(ciphertext).digest().subarray(0, 10);

  const file = Buffer.concat([ciphertext, mac10]);
  const fileEncSha256 = createHash('sha256').update(file).digest();
  return { file, fileEncSha256 };
}

function buildSampleMessages(): proto.IWebMessageInfo[] {
  return [
    {
      key: {
        id: 'MSG_1',
        participant: '1234567890@lid',
        fromMe: false,
      },
      messageTimestamp: 1700000001,
      message: { conversation: 'Hello from group history 1' },
    },
    {
      key: {
        id: 'MSG_2',
        participant: '9876543210@lid',
        fromMe: false,
      },
      messageTimestamp: 1700000002,
      message: { extendedTextMessage: { text: 'Hello from group history 2' } },
    },
    {
      key: {
        id: 'MSG_3',
        participant: '5555555555@lid',
        fromMe: true,
      },
      messageTimestamp: 1700000003,
      message: { conversation: 'Third message' },
    },
  ];
}

function buildValidPlaintextWithUnknownFields(messages: proto.IWebMessageInfo[]): Buffer {
  const chunks: Buffer[] = [];
  // Field 2, wire type 0 (varint)
  chunks.push(encodeVarint((2 << 3) | 0), encodeVarint(42));
  // Field 3, wire type 1 (64-bit)
  chunks.push(encodeVarint((3 << 3) | 1), Buffer.alloc(8, 0xaa));

  for (const msg of messages) {
    const encoded = proto.WebMessageInfo.encode(msg).finish();
    chunks.push(encodeField1Message(encoded));
  }

  // Field 4, wire type 2 (length-delimited)
  const extra = Buffer.from('extra-meta');
  chunks.push(encodeVarint((4 << 3) | 2), encodeVarint(extra.length), extra);
  // Field 5, wire type 5 (32-bit)
  chunks.push(encodeVarint((5 << 3) | 5), Buffer.alloc(4, 0x55));

  return Buffer.concat(chunks);
}

describe('decryptGroupHistoryBundle', () => {
  it('1. round-trip decodes entries and skips unknown wire types 0/1/2/5', () => {
    const mediaKey = randomBytes(32);
    const sampleMessages = buildSampleMessages();
    const plaintext = buildValidPlaintextWithUnknownFields(sampleMessages);
    const { file, fileEncSha256 } = encryptBundle(plaintext, mediaKey);

    const decoded = decryptGroupHistoryBundle(file, mediaKey, fileEncSha256);

    assert.equal(decoded.length, 3);
    assert.equal(decoded[0].key?.id, 'MSG_1');
    assert.equal(decoded[0].key?.participant, '1234567890@lid');
    assert.equal(Number(decoded[0].messageTimestamp), 1700000001);
    assert.equal(decoded[0].message?.conversation, 'Hello from group history 1');

    assert.equal(decoded[1].key?.id, 'MSG_2');
    assert.equal(decoded[1].message?.extendedTextMessage?.text, 'Hello from group history 2');

    assert.equal(decoded[2].key?.id, 'MSG_3');
    assert.equal(decoded[2].key?.fromMe, true);
  });

  it('2. throws on MAC mismatch', () => {
    const mediaKey = randomBytes(32);
    const plaintext = buildValidPlaintextWithUnknownFields(buildSampleMessages());
    const { file } = encryptBundle(plaintext, mediaKey);

    const tampered = Buffer.from(file);
    tampered[tampered.length - 1] ^= 0x01;

    assert.throws(() => decryptGroupHistoryBundle(tampered, mediaKey), /MAC mismatch/i);
  });

  it('3. throws on fileEncSha256 mismatch and succeeds when omitted', () => {
    const mediaKey = randomBytes(32);
    const plaintext = buildValidPlaintextWithUnknownFields(buildSampleMessages());
    const { file, fileEncSha256 } = encryptBundle(plaintext, mediaKey);

    const badSha = Buffer.from(fileEncSha256);
    badSha[0] ^= 0xff;

    assert.throws(() => decryptGroupHistoryBundle(file, mediaKey, badSha), /fileEncSha256 mismatch/i);

    const decodedWithoutSha = decryptGroupHistoryBundle(file, mediaKey, null);
    assert.equal(decodedWithoutSha.length, 3);
  });

  it('4. throws on invalid mediaKey length', () => {
    const mediaKey = randomBytes(16);
    assert.throws(() => decryptGroupHistoryBundle(Buffer.alloc(32), mediaKey), /mediaKey length/i);
  });

  it('5. throws on malformed protobuf (truncation, bad field-1 wire type, unsupported wire types)', () => {
    const mediaKey = randomBytes(32);

    // 5a: truncated field 1 payload
    const truncated = Buffer.concat([encodeVarint((1 << 3) | 2), encodeVarint(100), Buffer.from([1, 2, 3])]);
    const encTruncated = encryptBundle(truncated, mediaKey);
    assert.throws(
      () => decryptGroupHistoryBundle(encTruncated.file, mediaKey, encTruncated.fileEncSha256),
      /truncated/i,
    );

    // 5b: wrong wire type (0) for field 1
    const badWire1 = Buffer.concat([encodeVarint((1 << 3) | 0), encodeVarint(1)]);
    const encBadWire1 = encryptBundle(badWire1, mediaKey);
    assert.throws(
      () => decryptGroupHistoryBundle(encBadWire1.file, mediaKey, encBadWire1.fileEncSha256),
      /unexpected wire type/i,
    );

    // 5c: unsupported wire type 3 (start group) and wire type 6
    for (const wt of [3, 6, 7]) {
      const unsupported = encodeVarint((2 << 3) | wt);
      const encUnsupported = encryptBundle(unsupported, mediaKey);
      assert.throws(
        () => decryptGroupHistoryBundle(encUnsupported.file, mediaKey, encUnsupported.fileEncSha256),
        /unsupported wire type/i,
      );
    }
  });

  it('6. throws when entry count exceeds GROUP_HISTORY_MAX_ENTRIES', () => {
    const mediaKey = randomBytes(32);
    const plaintext = Buffer.alloc((GROUP_HISTORY_MAX_ENTRIES + 1) * 2, Buffer.from([0x0a, 0x00]));
    const { file, fileEncSha256 } = encryptBundle(plaintext, mediaKey);

    assert.throws(
      () => decryptGroupHistoryBundle(file, mediaKey, fileEncSha256),
      /Malformed GroupHistory protobuf: too many entries/,
    );
  });
});
