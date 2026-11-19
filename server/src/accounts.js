/**
 * People, groups and access requests. Stored in PostgreSQL when DATABASE_URL is set, otherwise in
 * ACCOUNTS_FILE (default: accounts.json next to DATA_FILE). See db/doc-store.js.
 *
 * - Roles: 'admin' (everything, including people and access), 'editor' (documents APIs and
 *   ReceAPItos) and 'consumer' (reads the portal).
 * - A private API is visible only to admins, editors and members of one of its groups.
 * - Passwords: scrypt with a random salt. Sessions: signed tokens (HMAC), so a restart doesn't log
 *   anybody out; changing the password or disabling the account invalidates the old tokens.
 */
const path = require('path');
const crypto = require('crypto');
const { docStore } = require('./db/doc-store');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'apis.json');
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || path.join(path.dirname(DATA_FILE), 'accounts.json');
const SESSION_MS = (Number(process.env.SESSION_DAYS) || 7) * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const MIN_PASSWORD = 8;

const ROLES = ['admin', 'editor', 'consumer'];

/** { secret, users: [], groups: [], requests: [] }. Filled by init() before the server starts. */
let db = shape({});
const doc = docStore('accounts', ACCOUNTS_FILE, { mode: 0o600 });

function shape(data) {
  return { secret: data.secret || '', users: data.users || [], groups: data.groups || [], requests: data.requests || [] };
}

/** Loads people, groups and access requests (PostgreSQL with DATABASE_URL, the file otherwise). */
async function init() {
  db = shape(await doc.load({}));
  return `${db.users.length} conta(s) e ${db.groups.length} grupo(s) em ${doc.where}`;
}

function persist() {
  doc.save(db);
}

const now = () => new Date().toISOString();
const normEmail = (e) => String(e || '').trim().toLowerCase();
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!db.secret) {
    db.secret = crypto.randomBytes(32).toString('hex');
    persist();
  }
  return db.secret;
}

// ----- passwords -----

// scrypt runs on libuv's thread pool: a login being hashed doesn't hold up the other requests.
const scrypt = (password, salt, length) =>
  new Promise((resolve, reject) => crypto.scrypt(password, salt, length, (err, key) => (err ? reject(err) : resolve(key))));

const formatHash = (salt, hash) => `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return formatHash(salt, await scrypt(String(password), salt, 64));
}

async function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

// Same cost for unknown e-mails, so the answer time doesn't tell which accounts exist.
// Computed once at startup, so the synchronous call doesn't matter here.
const DUMMY_SALT = crypto.randomBytes(16);
const DUMMY_HASH = formatHash(DUMMY_SALT, crypto.scryptSync(crypto.randomBytes(8).toString('hex'), DUMMY_SALT, 64));

function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
  if (p.length > 200) return 'A senha é longa demais.';
  return '';
}

// ----- sessions -----

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function issueToken(user) {
  const payload = `${user.id}.${user.tokenVersion || 0}.${Date.now() + SESSION_MS}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

/** The user of a session token, or null (bad signature, expired, disabled, password changed). */
function verify(token) {
  const [b64, sig] = String(token || '').split('.');
  if (!b64 || !sig) return null;
  const payload = Buffer.from(b64, 'base64url').toString();
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [id, version, exp] = payload.split('.');
  if (Number(exp) < Date.now()) return null;
  const user = db.users.find((u) => u.id === id);
  if (!user || user.disabled || String(user.tokenVersion || 0) !== version) return null;
  return user;
}

// ----- views -----

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    groups: (u.groups || []).map((g) => db.groups.find((x) => x.id === g)).filter(Boolean).map((g) => ({ id: g.id, name: g.name })),
    /** False for accounts that only ever entered through SSO (no password to change). */
    hasPassword: !!u.passwordHash,
  };
}

function adminUser(u) {
  return { ...publicUser(u), sso: !!u.sso, disabled: !!u.disabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null };
}

const isStaff = (u) => !!u && (u.role === 'admin' || u.role === 'editor');

/** Who can see an API: public for everybody; private for staff and members of one of its groups. */
function canSee(user, api) {
  if (!api) return false;
  if (api.visibility !== 'private') return true;
  if (!user || user.disabled) return false;
  if (isStaff(user)) return true;
  const allowed = new Set(api.groups || []);
  return (user.groups || []).some((g) => allowed.has(g));
}

/** Same check by e-mail (for e-mail notices about a private API). */
function canEmailSee(email, api) {
  if (api?.visibility !== 'private') return true;
  return canSee(db.users.find((u) => u.email === normEmail(email)), api);
}

// ----- accounts -----

function findByEmail(email) {
  return db.users.find((u) => u.email === normEmail(email));
}

/** `withoutPassword`: account that will enter only through SSO (created by an admin when passwords are off). */
async function register({ email, name, password }, { withoutPassword = false } = {}) {
  const e = normEmail(email);
  if (!EMAIL.test(e) || e.length > 254) return { error: 'Informe um e-mail válido.' };
  const n = clean(name, 120);
  if (!n) return { error: 'Informe o seu nome.' };
  const noPassword = withoutPassword && !password;
  const p = noPassword ? '' : passwordProblem(password);
  if (p) return { error: p };
  const taken = { error: 'Já existe uma conta com este e-mail. Entre com ela ou peça ao administrador para redefinir a senha.' };
  if (findByEmail(e)) return taken;
  const passwordHash = noPassword ? '' : await hashPassword(password);
  if (findByEmail(e)) return taken; // created by another request while hashing
  const user = { id: crypto.randomUUID(), email: e, name: n, passwordHash, role: 'consumer', groups: [], tokenVersion: 0, createdAt: now() };
  db.users.push(user);
  persist();
  return { user, token: issueToken(user) };
}

async function login(email, password) {
  const user = findByEmail(email);
  const ok = await checkPassword(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok || user.disabled) return null;
  user.lastLoginAt = now();
  persist();
  return { user, token: issueToken(user) };
}

async function changePassword(user, current, next) {
  if (!(await checkPassword(current, user.passwordHash))) return { error: 'A senha atual está incorreta.' };
  const p = passwordProblem(next);
  if (p) return { error: p };
  user.passwordHash = await hashPassword(next);
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  delete user.reset;
  persist();
  return { token: issueToken(user) };
}

// ----- SSO (OpenID Connect, see sso.js) -----

/**
 * Logs in someone the identity provider vouched for. The account is found by the SSO identity
 * (issuer + sub), else by e-mail (first SSO login of an existing account, e.g. the first admin), else
 * created as a consumer. Role, groups and password are kept: SSO only proves who the person is.
 */
function ssoLogin({ issuer, sub, email, name }) {
  const e = normEmail(email);
  if (!EMAIL.test(e) || e.length > 254) return { error: 'O provedor de login não informou um e-mail válido.' };
  let user = db.users.find((u) => u.sso && u.sso.issuer === issuer && u.sso.sub === sub) || findByEmail(e);
  if (user?.sso && (user.sso.issuer !== issuer || user.sso.sub !== sub)) {
    return { error: 'Este e-mail já está ligado a outra conta do provedor de login. Fale com um administrador.' };
  }
  if (user?.disabled) return { error: 'Sua conta está desativada. Fale com um administrador.' };
  if (!user) {
    user = { id: crypto.randomUUID(), email: e, name: clean(name, 120) || e.split('@')[0], passwordHash: '', role: 'consumer', groups: [], tokenVersion: 0, createdAt: now() };
    db.users.push(user);
  }
  user.sso = { issuer, sub };
  if (e !== user.email && !findByEmail(e)) user.email = e; // e-mail changed at the provider
  if (!user.name || user.name === 'Administrador') user.name = clean(name, 120) || user.name;
  user.lastLoginAt = now();
  persist();
  return { user, token: issueToken(user) };
}

// ----- forgotten password -----
// The e-mail carries a random token; only its hash is stored, for RESET_MINUTES, and it works once.

const RESET_MS = (Number(process.env.RESET_MINUTES) || 60) * 60_000;
const RESEND_RESET_MS = 60_000;
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** Starts a reset for an active account: { user, token }, or null (unknown, disabled, or asked a minute ago). */
function startReset(email) {
  const user = findByEmail(email);
  if (!user || user.disabled) return null;
  if (user.reset && Date.now() - user.reset.createdAt < RESEND_RESET_MS) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  user.reset = { hash: sha256(token), createdAt: Date.now(), expiresAt: Date.now() + RESET_MS };
  persist();
  return { user, token, minutes: Math.round(RESET_MS / 60_000) };
}

/** Sets a new password from a reset link. Logs in (new session) and ends the other sessions. */
async function finishReset(token, password) {
  const hash = sha256(token || '');
  const find = () => db.users.find((u) => u.reset && u.reset.hash === hash && !u.disabled && u.reset.expiresAt >= Date.now());
  const invalid = { error: 'Este link é inválido ou expirou. Peça um novo em "Esqueci minha senha".' };
  if (!find()) return invalid;
  const p = passwordProblem(password);
  if (p) return { error: p };
  const passwordHash = await hashPassword(password);
  const user = find(); // the link works once, even with two requests at the same time
  if (!user) return invalid;
  user.passwordHash = passwordHash;
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  delete user.reset;
  user.lastLoginAt = now();
  persist();
  return { user, token: issueToken(user) };
}

/** E-mails of the active administrators (they receive the access requests). */
function adminEmails() {
  return db.users.filter((u) => u.role === 'admin' && !u.disabled && EMAIL.test(u.email)).map((u) => u.email);
}

/** First run: creates the administrator from ADMIN_EMAIL / ADMIN_PASSWORD (or the old ADMIN_USER). */
async function ensureAdmin() {
  if (db.users.some((u) => u.role === 'admin' && !u.disabled)) return null;
  const email = normEmail(process.env.ADMIN_EMAIL || process.env.ADMIN_USER || 'admin');
  const password = process.env.ADMIN_PASSWORD || 'troque-esta-senha';
  const passwordHash = await hashPassword(password);
  const existing = findByEmail(email);
  if (existing) {
    existing.role = 'admin';
    existing.disabled = false;
  } else {
    db.users.push({ id: crypto.randomUUID(), email, name: 'Administrador', passwordHash, role: 'admin', groups: [], tokenVersion: 0, createdAt: now() });
  }
  persist();
  return email;
}

// ----- admin: people -----

const activeAdmins = () => db.users.filter((u) => u.role === 'admin' && !u.disabled);

function listUsers() {
  return db.users.map(adminUser).sort((a, b) => a.name.localeCompare(b.name));
}

/** `withoutPassword`: allowed when people enter only through SSO. */
async function createUser({ email, name, password, role, groups }, { withoutPassword = false } = {}) {
  const r = await register({ email, name, password }, { withoutPassword });
  if (r.error) return r;
  const out = await updateUser(r.user.id, { role, groups }, null);
  return out.error ? out : { user: out.user };
}

async function updateUser(id, input, actor) {
  // The new password is checked and hashed first: an error must not leave half the changes applied.
  let passwordHash;
  if (input.password) {
    const p = passwordProblem(input.password);
    if (p) return { error: p };
    passwordHash = await hashPassword(input.password);
  }
  const user = db.users.find((u) => u.id === id);
  if (!user) return { notFound: true };
  const nextRole = input.role !== undefined ? input.role : user.role;
  const nextDisabled = input.disabled !== undefined ? !!input.disabled : !!user.disabled;
  if (!ROLES.includes(nextRole)) return { error: 'Papel inválido.' };
  const losesAdmin = user.role === 'admin' && !user.disabled && (nextRole !== 'admin' || nextDisabled);
  if (losesAdmin && activeAdmins().length === 1) return { error: 'Este é o único administrador ativo. Promova outra pessoa antes.' };
  if (actor && actor.id === user.id && (nextDisabled || nextRole !== user.role)) return { error: 'Você não pode mudar o próprio papel nem desativar a própria conta.' };
  if (input.email !== undefined && normEmail(input.email) !== user.email) {
    const e = normEmail(input.email);
    if (!EMAIL.test(e) || e.length > 254) return { error: 'Informe um e-mail válido.' };
    if (findByEmail(e)) return { error: 'Já existe uma conta com este e-mail.' };
    user.email = e;
    delete user.reset;
  }
  if (input.name !== undefined) user.name = clean(input.name, 120) || user.name;
  if (input.groups !== undefined) {
    const valid = new Set(db.groups.map((g) => g.id));
    user.groups = [...new Set((Array.isArray(input.groups) ? input.groups : []).map(String).filter((g) => valid.has(g)))];
  }
  if (nextDisabled !== !!user.disabled) user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.role = nextRole;
  user.disabled = nextDisabled;
  if (passwordHash) {
    user.passwordHash = passwordHash;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    delete user.reset;
  }
  persist();
  return { user: adminUser(user) };
}

/**
 * Ends every session of the person: tokens carry the account's tokenVersion, so bumping it makes
 * all of them invalid at once (this browser's included).
 */
function endSessions(id) {
  const user = db.users.find((u) => u.id === id);
  if (!user) return { notFound: true };
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  persist();
  return {};
}

function removeUser(id, actor) {
  const user = db.users.find((u) => u.id === id);
  if (!user) return { notFound: true };
  if (actor?.id === id) return { error: 'Você não pode excluir a própria conta.' };
  if (user.role === 'admin' && !user.disabled && activeAdmins().length === 1) return { error: 'Este é o único administrador ativo.' };
  db.users = db.users.filter((u) => u.id !== id);
  db.requests = db.requests.filter((r) => r.userId !== id);
  persist();
  return {};
}

// ----- groups -----

function groupView(g, withMembers) {
  const members = db.users.filter((u) => (u.groups || []).includes(g.id));
  return { id: g.id, name: g.name, description: g.description, requestable: g.requestable !== false, memberCount: members.length, ...(withMembers ? { members: members.map(publicUser) } : {}) };
}

function listGroups({ requestableOnly = false, withMembers = false } = {}) {
  return db.groups
    .filter((g) => !requestableOnly || g.requestable !== false)
    .map((g) => groupView(g, withMembers))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function saveGroup(id, input) {
  const name = clean(input.name, 80);
  if (!name) return { error: 'Dê um nome ao grupo.' };
  if (db.groups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) return { error: 'Já existe um grupo com este nome.' };
  let g = id ? db.groups.find((x) => x.id === id) : null;
  if (id && !g) return { notFound: true };
  if (!g) {
    g = { id: crypto.randomUUID(), createdAt: now() };
    db.groups.push(g);
  }
  g.name = name;
  g.description = clean(input.description, 400);
  g.requestable = input.requestable !== false;
  persist();
  return { group: groupView(g, true) };
}

function removeGroup(id) {
  if (!db.groups.some((g) => g.id === id)) return { notFound: true };
  db.groups = db.groups.filter((g) => g.id !== id);
  for (const u of db.users) u.groups = (u.groups || []).filter((g) => g !== id);
  db.requests = db.requests.filter((r) => r.groupId !== id);
  persist();
  return {};
}

const groupExists = (id) => db.groups.some((g) => g.id === id);

// ----- access requests -----
// A request is for an API (button on its page) or for a group (account page). Approving adds the
// person to a group: the one asked for, or the one the admin picks among the API's groups.

function requestView(r) {
  const u = db.users.find((x) => x.id === r.userId);
  const g = db.groups.find((x) => x.id === r.groupId);
  return { ...r, user: u ? { id: u.id, name: u.name, email: u.email } : null, group: g ? { id: g.id, name: g.name } : null };
}

function requestAccess(user, { groupId, api, message }) {
  if (api) {
    if (canSee(user, api)) return { error: 'Você já tem acesso a esta API.' };
    const open = db.requests.find((r) => r.userId === user.id && r.apiId === api.id && r.status === 'pending');
    if (open) return { request: requestView(open) };
    const r = { id: crypto.randomUUID(), userId: user.id, apiId: api.id, apiName: api.name, groupId: null, message: clean(message, 500), status: 'pending', createdAt: now() };
    db.requests.push(r);
    persist();
    return { request: requestView(r), created: true };
  }
  const g = db.groups.find((x) => x.id === groupId);
  if (!g || g.requestable === false) return { error: 'Este grupo não aceita pedidos de acesso.' };
  if ((user.groups || []).includes(groupId)) return { error: 'Você já faz parte deste grupo.' };
  const open = db.requests.find((r) => r.userId === user.id && r.groupId === groupId && !r.apiId && r.status === 'pending');
  if (open) return { request: requestView(open) };
  const r = { id: crypto.randomUUID(), userId: user.id, apiId: null, groupId, message: clean(message, 500), status: 'pending', createdAt: now() };
  db.requests.push(r);
  persist();
  return { request: requestView(r), created: true };
}

function myRequests(user) {
  return db.requests.filter((r) => r.userId === user.id).map(requestView).reverse();
}

function listRequests(status) {
  return db.requests.filter((r) => !status || r.status === status).map(requestView).reverse();
}

/** Approves (adding the person to `groupId`, or the group asked for) or rejects a request. */
/**
 * @param {string} id
 * @param {boolean} approve
 * @param {any} actor
 * @param {{ groupId?: string, note?: string }} [options]
 */
function decide(id, approve, actor, { groupId, note } = {}) {
  const r = db.requests.find((x) => x.id === id);
  if (!r) return { notFound: true };
  if (r.status !== 'pending') return { error: 'Este pedido já foi respondido.' };
  if (approve) {
    const target = groupId || r.groupId;
    if (!target || !groupExists(target)) return { error: 'Escolha o grupo que vai dar o acesso.' };
    r.groupId = target;
    const u = db.users.find((x) => x.id === r.userId);
    if (u && !(u.groups || []).includes(target)) u.groups = [...(u.groups || []), target];
  }
  r.status = approve ? 'approved' : 'rejected';
  r.decidedAt = now();
  r.decidedBy = actor?.email || '';
  r.note = clean(note, 500);
  persist();
  return { request: requestView(r) };
}

/**
 * What someone without access sees of a private API: the summary only. Same shape as an API (empty
 * lists), so the portal pages don't need special cases, plus `locked: true`.
 */
function lockedView(api) {
  return {
    id: api.id,
    slug: api.slug,
    name: api.name,
    summary: api.summary,
    description: '',
    category: api.category,
    tags: api.tags || [],
    status: api.status,
    // When it is switched off and what replaces it are public too (PRO-205).
    ...(api.sunsetDate ? { sunsetDate: api.sunsetDate } : {}),
    ...(api.replacedBy ? { replacedBy: api.replacedBy } : {}),
    version: api.version,
    owner: api.owner,
    contactEmail: api.contactEmail,
    baseUrl: '',
    environments: [],
    auth: { type: 'none', headerName: '', tokenUrl: '', scopes: '', instructions: '', schemes: [], mode: 'all' },
    rateLimit: '',
    sla: '',
    endpoints: [],
    guides: [],
    changelog: [],
    visibility: 'private',
    groups: [],
    locked: true,
    createdAt: api.createdAt,
    updatedAt: api.updatedAt,
  };
}

/** The API as `user` may see it: everything, or the summary when it's private and they have no access. */
function viewApi(user, api) {
  return canSee(user, api) ? api : lockedView(api);
}

module.exports = {
  ROLES,
  init,
  register,
  login,
  ssoLogin,
  verify,
  changePassword,
  endSessions,
  startReset,
  finishReset,
  adminEmails,
  ensureAdmin,
  publicUser,
  isStaff,
  canSee,
  canEmailSee,
  viewApi,
  lockedView,
  listUsers,
  createUser,
  updateUser,
  removeUser,
  listGroups,
  saveGroup,
  removeGroup,
  groupExists,
  requestAccess,
  myRequests,
  listRequests,
  decide,
};
