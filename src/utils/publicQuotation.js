const crypto = require('crypto');

function secret() {
  const value = String(process.env.PUBLIC_QUOTE_TOKEN_SECRET || process.env.JWT_SECRET || '').trim();
  if (!value) throw Object.assign(new Error('Public quotation token secret is not configured'), { status: 503 });
  return value;
}

function signature(id) {
  return crypto.createHmac('sha256', secret()).update(String(id)).digest('base64url');
}

function makePublicQuoteToken(id) {
  return `${id}.${signature(id)}`;
}

function parsePublicQuoteToken(token) {
  if (typeof token !== 'string' || token.length > 180) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const id = token.slice(0, dot);
  const supplied = token.slice(dot + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const expected = signature(id);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

function publicQuoteOrigin() {
  return String(process.env.PUBLIC_QUOTE_ORIGIN || 'https://fieldtrail-backend-3.vercel.app').trim().replace(/\/+$/, '');
}

function publicQuoteUrl(token) {
  return `${publicQuoteOrigin()}/q/index.html?t=${encodeURIComponent(token)}`;
}

module.exports = { makePublicQuoteToken, parsePublicQuoteToken, publicQuoteOrigin, publicQuoteUrl };
