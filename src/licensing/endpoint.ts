// Mirrors evolution-go/pkg/core/endpoint.go
// In release builds, set LICENSE_ENDPOINT_ENCODED + LICENSE_ENDPOINT_XOR_KEY (hex).
// In dev, the URL is reconstructed from a parts array — same technique as the Go version.

const encodedEP = process.env.LICENSE_ENDPOINT_ENCODED ?? '';
const xorKey = process.env.LICENSE_ENDPOINT_XOR_KEY ?? '';

export function resolveEndpoint(): string {
  if (encodedEP && xorKey) {
    return decodeXOR(encodedEP, xorKey);
  }
  // Dev fallback — assembled at runtime, not a single string literal.
  const parts = [
    'h',
    'tt',
    'ps',
    '://',
    'li',
    'ce',
    'nse',
    '.',
    'ev',
    'ol',
    'ut',
    'io',
    'nf',
    'ou',
    'nd',
    'at',
    'io',
    'n.',
    'co',
    'm.',
    'br',
  ];
  return parts.join('');
}

function decodeXOR(enc: string, key: string): string {
  const encBytes = hexDec(enc);
  const keyBytes = hexDec(key);
  if (keyBytes.length === 0) return '';
  const out = Buffer.alloc(encBytes.length);
  for (let i = 0; i < encBytes.length; i++) {
    out[i] = encBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return out.toString('utf8');
}

function hexDec(s: string): Buffer {
  if (s.length % 2 !== 0) return Buffer.alloc(0);
  return Buffer.from(s, 'hex');
}
