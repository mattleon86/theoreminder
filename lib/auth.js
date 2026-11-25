'use strict';

const crypto = require('node:crypto');

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const failures = globalThis[Symbol.for('theoreminder.sync-auth-failures')] || new Map();
globalThis[Symbol.for('theoreminder.sync-auth-failures')] = failures;

function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store');
}

function header(req, name) {
  const value = req.headers && req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function secretMatches(provided, expected) {
  const left = crypto.createHash('sha256').update(typeof provided === 'string' ? provided : '').digest();
  const right = crypto.createHash('sha256').update(typeof expected === 'string' ? expected : '').digest();
  return crypto.timingSafeEqual(left, right);
}

function clientIp(req) {
  const forwarded = header(req, 'x-forwarded-for');
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function requireSyncKey(req, res) {
  noStore(res);
  const ip = clientIp(req);
  const now = Date.now();
  const previous = failures.get(ip);
  if (previous && previous.resetAt > now && previous.count >= RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', String(Math.ceil((previous.resetAt - now) / 1000)));
    res.status(429).json({ error: 'Troppi tentativi non autorizzati. Riprova tra poco.' });
    return false;
  }

  const expected = process.env.SYNC_SECRET;
  const provided = header(req, 'x-sync-key');
  if (expected && typeof provided === 'string' && secretMatches(provided, expected)) {
    failures.delete(ip);
    return true;
  }

  const current = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  current.count += 1;
  failures.set(ip, current);
  if (failures.size > 1000) {
    for (const [key, value] of failures) {
      if (value.resetAt <= now) failures.delete(key);
    }
  }
  res.status(401).json({ error: 'Non autorizzato' });
  return false;
}

function requireCronSecret(req, res) {
  noStore(res);
  const expected = process.env.CRON_SECRET;
  const provided = header(req, 'authorization');
  if (expected && typeof provided === 'string' && secretMatches(provided, `Bearer ${expected}`)) return true;
  res.status(401).json({ error: 'Non autorizzato' });
  return false;
}

module.exports = { noStore, requireSyncKey, requireCronSecret };
