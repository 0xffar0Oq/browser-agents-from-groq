// Decoder utilities (ported from rep+ misc.js): base64, URL, JWT, hex.

export type DecodeFormat = 'base64' | 'url' | 'jwt' | 'hex' | 'auto';

function base64UrlDecodeToString(str: string): string {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const decoded = atob(s);
  return decodeURIComponent(
    decoded
      .split('')
      .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
      .join(''),
  );
}

export function decodeJWT(jwt: string): string {
  const token = jwt.trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format. Expected format: header.payload.signature');
  }

  let header: unknown;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecodeToString(parts[0]));
  } catch (e) {
    throw new Error(`Failed to decode JWT header: ${(e as Error).message}`);
  }
  try {
    payload = JSON.parse(base64UrlDecodeToString(parts[1]));
  } catch (e) {
    throw new Error(`Failed to decode JWT payload: ${(e as Error).message}`);
  }

  let output = 'JWT Decoded:\n\n';
  output += '=== HEADER ===\n';
  output += JSON.stringify(header, null, 2);
  output += '\n\n=== PAYLOAD ===\n';
  output += JSON.stringify(payload, null, 2);
  output += '\n\n=== SIGNATURE ===\n';
  output += `${parts[2]}\n(Signature verification not performed)`;

  if (typeof payload.exp === 'number') {
    const expDate = new Date(payload.exp * 1000);
    const now = new Date();
    const isExpired = expDate < now;
    output += '\n\n=== TOKEN INFO ===\n';
    output += `Expiration: ${expDate.toISOString()}\n`;
    output += `Status: ${isExpired ? 'EXPIRED' : 'VALID'}\n`;
    if (isExpired) {
      output += `Expired ${Math.floor((now.getTime() - expDate.getTime()) / 1000 / 60)} minutes ago`;
    } else {
      output += `Expires in ${Math.floor((expDate.getTime() - now.getTime()) / 1000 / 60)} minutes`;
    }
  }

  return output;
}

function looksLikeJwt(input: string): boolean {
  const trimmed = input.trim();
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(trimmed) && trimmed.length > 30;
}

function looksLikeBase64(input: string): boolean {
  const trimmed = input.trim();
  return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0 && trimmed.length >= 8;
}

export function decode(input: string, format: DecodeFormat = 'auto'): string {
  const trimmed = input.trim();
  let resolved = format;
  if (format === 'auto') {
    if (looksLikeJwt(trimmed)) resolved = 'jwt';
    else if (looksLikeBase64(trimmed)) resolved = 'base64';
    else if (/^https?:\/\/|%[0-9a-f]{2}/i.test(trimmed)) resolved = 'url';
    else resolved = 'hex';
  }

  switch (resolved) {
    case 'jwt':
      return decodeJWT(trimmed);
    case 'base64': {
      try {
        const binary = atob(trimmed);
        // Prefer a UTF-8 interpretation when possible.
        try {
          const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          return binary;
        }
      } catch (e) {
        throw new Error(`Base64 decode failed: ${(e as Error).message}`);
      }
    }
    case 'url': {
      if (/^https?:\/\//i.test(trimmed)) {
        const url = new URL(trimmed);
        const params = [...url.searchParams.entries()].map(([k, v]) => `${k}=${v}`);
        return [
          `URL: ${url.origin}${url.pathname}`,
          `Decoded path: ${decodeURIComponent(url.pathname)}`,
          params.length
            ? `Query params:\n${params.map((p) => `  ${decodeURIComponent(p)}`).join('\n')}`
            : 'Query params: (none)',
        ].join('\n');
      }
      return decodeURIComponent(trimmed.replace(/\+/g, ' '));
    }
    case 'hex': {
      let hex = trimmed.replace(/\s+/g, '').replace(/^0x/i, '');
      if (hex.length % 2 !== 0) hex = `0${hex}`;
      if (!/^[0-9a-f]+$/i.test(hex)) {
        // encode to hex instead
        const bytes = new TextEncoder().encode(trimmed);
        return Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      }
      const bytes = hex.match(/.{2}/g)?.map((h) => Number.parseInt(h, 16)) ?? [];
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
      } catch {
        return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
      }
    }
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}
