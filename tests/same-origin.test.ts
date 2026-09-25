import { describe, expect, it } from 'vitest';
import { isFromOwnPages } from '@/server/same-origin';

const HOST = '34-173-199-167.sslip.io';

function post(headers: Record<string, string>): Request {
  return new Request(`https://${HOST}/api/admin/surgeons`, { method: 'POST', headers: { host: HOST, ...headers } });
}

describe('isFromOwnPages', () => {
  it('accepts a form posted from this exact address', () => {
    // What a real browser sends under Referrer-Policy: no-referrer.
    expect(isFromOwnPages(post({ 'sec-fetch-site': 'same-origin', origin: 'null' }))).toBe(true);
  });

  it('refuses another sslip.io address, which SameSite cookies treat as the same site', () => {
    expect(isFromOwnPages(post({ 'sec-fetch-site': 'same-site', origin: 'null' }))).toBe(false);
  });

  it('refuses another site entirely', () => {
    expect(isFromOwnPages(post({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))).toBe(false);
  });

  it('trusts Sec-Fetch-Site over a claimed Origin', () => {
    expect(isFromOwnPages(post({ 'sec-fetch-site': 'cross-site', origin: `https://${HOST}` }))).toBe(false);
  });

  it('falls back to Origin for a client without fetch metadata', () => {
    expect(isFromOwnPages(post({ origin: `https://${HOST}` }))).toBe(true);
    expect(isFromOwnPages(post({ origin: 'https://evil.example' }))).toBe(false);
  });

  it('allows a request with neither signal, which no browser page can send', () => {
    expect(isFromOwnPages(post({}))).toBe(true);
    expect(isFromOwnPages(post({ origin: 'null' }))).toBe(true);
  });
});
