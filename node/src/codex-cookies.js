const MAX_COOKIE_HEADER_BYTES = 8 * 1024;

export function codexCookieHeaders(credentials) {
  return credentials.codexCookies ? { cookie: credentials.codexCookies } : {};
}

export function captureCodexCookies(response, credentials) {
  const setCookies = response.headers.getSetCookie?.() || [];
  if (!setCookies.length) return false;
  const cookies = new Map();
  for (const pair of String(credentials.codexCookies || '').split(';')) {
    const index = pair.indexOf('=');
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  for (const setCookie of setCookies) {
    const pair = setCookie.split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  const value = [...cookies].map(([name, cookie]) => `${name}=${cookie}`).join('; ');
  if (!value || Buffer.byteLength(value) > MAX_COOKIE_HEADER_BYTES || value === credentials.codexCookies) return false;
  credentials.codexCookies = value;
  return true;
}
