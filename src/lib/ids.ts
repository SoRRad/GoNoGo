import crypto from 'crypto';

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';

/**
 * 32 url-safe characters of CSPRNG. This is the only credential a surgeon has,
 * so it is drawn from crypto.randomBytes with rejection sampling (no modulo
 * bias) and avoids glyphs that get misread when a link is retyped by hand.
 */
export function generateAccessToken(length = 32): string {
  const out: string[] = [];
  const max = 256 - (256 % TOKEN_ALPHABET.length);
  while (out.length < length) {
    const bytes = crypto.randomBytes(length);
    for (const byte of bytes) {
      if (byte >= max) continue;
      out.push(TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export function nowIso(): string {
  return new Date().toISOString();
}
