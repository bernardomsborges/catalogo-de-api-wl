/**
 * "Acompanhar esta API": e-mail subscriptions per API, confirmed by a link (double opt-in) so nobody
 * can subscribe someone else. Each subscription has a secret token used by the confirm and
 * unsubscribe links.
 */
const path = require('path');
const crypto = require('crypto');
const { docStore } = require('./db/doc-store');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'apis.json');
const SUBS_FILE = process.env.SUBSCRIPTIONS_FILE || path.join(path.dirname(DATA_FILE), 'subscriptions.json');
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const RESEND_AFTER_MS = 10 * 60_000;

/** [{ id, apiId, email, token, status: 'pending' | 'active' | 'cancelled', createdAt, confirmedAt, lastSentAt }] */
let subs = [];
const doc = docStore('subscriptions', SUBS_FILE);

async function init() {
  subs = await doc.load([]);
}

function persist() {
  doc.save(subs);
}

const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => e.length <= 254 && EMAIL.test(e);
const newToken = () => crypto.randomBytes(24).toString('base64url');

/**
 * Starts a subscription. Returns the subscription that needs a confirmation e-mail, or null when
 * nothing should be sent (already active, or a confirmation went out a few minutes ago).
 */
function subscribe(apiId, rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!validEmail(email)) return { error: 'Informe um e-mail válido.' };
  const now = new Date().toISOString();
  let s = subs.find((x) => x.apiId === apiId && x.email === email);
  if (s?.status === 'active') return { sub: null };
  if (s && s.status === 'pending' && Date.now() - Date.parse(s.lastSentAt || 0) < RESEND_AFTER_MS) return { sub: null };
  if (!s) {
    s = { id: crypto.randomUUID(), apiId, email, token: newToken(), status: 'pending', createdAt: now };
    subs.push(s);
  }
  s.status = 'pending';
  s.lastSentAt = now;
  persist();
  return { sub: s };
}

const byToken = (token) => (typeof token === 'string' && token.length >= 20 ? subs.find((x) => x.token === token) : undefined);

function confirm(token) {
  const s = byToken(token);
  if (!s) return null;
  if (s.status !== 'active') {
    s.status = 'active';
    s.confirmedAt = new Date().toISOString();
    persist();
  }
  return s;
}

function unsubscribe(token) {
  const s = byToken(token);
  if (!s) return null;
  if (s.status !== 'cancelled') {
    s.status = 'cancelled';
    persist();
  }
  return s;
}

/** Undo from the unsubscribe page: the token already proves the address. */
function resubscribe(token) {
  const s = byToken(token);
  if (!s || s.status === 'pending') return null;
  s.status = 'active';
  persist();
  return s;
}

const activeFor = (apiId) => subs.filter((s) => s.apiId === apiId && s.status === 'active');

function counts() {
  const out = {};
  for (const s of subs) if (s.status === 'active') out[s.apiId] = (out[s.apiId] || 0) + 1;
  return out;
}

function removeApi(apiId) {
  const before = subs.length;
  subs = subs.filter((s) => s.apiId !== apiId);
  if (subs.length !== before) persist();
}

module.exports = { init, subscribe, confirm, unsubscribe, resubscribe, activeFor, counts, removeApi };
