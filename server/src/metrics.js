/**
 * Usage metrics of the portal (PRO-165): which APIs, routes and guides people open, what they search
 * for (and don't find), and how the test console is used.
 *
 * Anonymous by design: only daily counters are kept — no IP, account, credential, request body or
 * URL. Search terms go through the same redaction as the assistant (tokens, keys, e-mails removed).
 * Visits of admins and editors are not counted, so the team's own work doesn't drown the numbers.
 *
 * { days: { 'YYYY-MM-DD': {
 *     views:    { [apiId]: n },
 *     guides:   { [apiId]: { [guideId]: n } },
 *     routes:   { [apiId]: { [endpointId]: n } },
 *     console:  { [apiId]: { [endpointId | '?']: { calls, errors } } },
 *     searches: { [term]: { count, empty } },
 * } } }
 */
const path = require('path');
const { docStore } = require('./db/doc-store');
const { redact } = require('./ai/assistant');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'apis.json');
const METRICS_FILE = process.env.METRICS_FILE || path.join(path.dirname(DATA_FILE), 'metrics.json');
const KEEP_DAYS = 120;
const SAVE_DELAY_MS = Number(process.env.METRICS_SAVE_DELAY_MS) || 10_000;
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;

let data = { days: {} };
const doc = docStore('metrics', METRICS_FILE);
let timer = null;

async function init() {
  data = await doc.load({ days: {} });
  data.days ||= {};
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

function today() {
  const key = dayKey();
  return (data.days[key] ||= { views: {}, guides: {}, routes: {}, console: {}, searches: {} });
}

/** Writes at most every few seconds: a page view must not cost a database write. */
function changed() {
  if (timer) return;
  timer = setTimeout(flush, SAVE_DELAY_MS);
  timer.unref();
}

function flush() {
  clearTimeout(timer);
  timer = null;
  const oldest = dayKey(new Date(Date.now() - KEEP_DAYS * 86_400_000));
  for (const k of Object.keys(data.days)) if (k < oldest) delete data.days[k];
  return doc.save(data);
}

const bump = (obj, key, n = 1) => (obj[key] = (obj[key] || 0) + n);

/** A page of an API was opened: the API itself, one of its guides or one of its routes. */
/**
 * @param {any} api
 * @param {{ guide?: string, endpoint?: string }} [detail]
 */
function view(api, { guide, endpoint } = {}) {
  const d = today();
  if (guide && ID.test(guide)) bump((d.guides[api.id] ||= {}), guide);
  else if (endpoint && api.endpoints?.some((e) => e.id === endpoint)) bump((d.routes[api.id] ||= {}), endpoint);
  else bump(d.views, api.id);
  changed();
}

/** Search terms are kept in a normalized, redacted form; one letter or a pasted secret is not a search. */
function searchTerm(q) {
  const t = redact(String(q || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (t.length < 2 || /\[(?:removido|token removido|valor removido|e-mail removido)\]/.test(t)) return '';
  return t;
}

function search(q, results) {
  const term = searchTerm(q);
  if (!term) return false;
  const s = (today().searches[term] ||= { count: 0, empty: 0 });
  s.count++;
  if (!(Number(results) > 0)) s.empty++;
  changed();
  return true;
}

/** A real call of the test console. `ok`: the API answered with a status below 400. */
function consoleCall(api, endpointId, ok) {
  const key = endpointId && api.endpoints?.some((e) => e.id === endpointId) ? endpointId : '?';
  const c = ((today().console[api.id] ||= {})[key] ||= { calls: 0, errors: 0 });
  c.calls++;
  if (!ok) c.errors++;
  changed();
}

/**
 * Totals of the last `days` days (today included), optionally for one API. `apis`: the catalog, for
 * names and routes; `gaps`: the assistant's unanswered questions ({ at, api: slug }).
 */
/** @param {{ days?: number | string | any, apiId?: string | null, apis?: any[], gaps?: any[] }} [options] */
function report({ days = 30, apiId = null, apis = [], gaps = [] } = {}) {
  const n = Math.min(Math.max(Math.round(Number(days)) || 30, 1), KEEP_DAYS);
  const from = dayKey(new Date(Date.now() - (n - 1) * 86_400_000));
  const to = dayKey();
  const byId = new Map(apis.map((a) => [a.id, a]));
  const only = (id) => !apiId || id === apiId;
  const apiInfo = (id) => {
    const a = byId.get(id);
    return { apiId: id, apiName: a?.name ?? 'API removida', apiSlug: a?.slug ?? null };
  };
  const route = (apiId_, epId) => {
    const ep = byId.get(apiId_)?.endpoints?.find((e) => e.id === epId);
    return { endpointId: epId, method: ep?.method ?? null, path: ep?.path ?? (epId === '?' ? null : 'rota removida') };
  };

  const views = {};
  const guides = {};
  const routes = {};
  const consoleUse = {};
  const searches = {};
  const daily = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = dayKey(new Date(Date.now() - i * 86_400_000));
    const d = data.days[key];
    const day = { date: key, views: 0, searches: 0, consoleCalls: 0 };
    if (d) {
      for (const [id, c] of Object.entries(d.views)) if (only(id)) (bump(views, id, c), (day.views += c));
      for (const [id, g] of Object.entries(d.guides)) if (only(id)) for (const [gid, c] of Object.entries(g)) (bump(guides, `${id} ${gid}`, c), (day.views += c));
      for (const [id, r] of Object.entries(d.routes)) if (only(id)) for (const [eid, c] of Object.entries(r)) (bump(routes, `${id} ${eid}`, c), (day.views += c));
      for (const [id, r] of Object.entries(d.console)) {
        if (!only(id)) continue;
        for (const [eid, c] of Object.entries(r)) {
          const t = (consoleUse[`${id} ${eid}`] ||= { calls: 0, errors: 0 });
          t.calls += c.calls;
          t.errors += c.errors;
          day.consoleCalls += c.calls;
        }
      }
      if (!apiId) {
        for (const [term, s] of Object.entries(d.searches)) {
          const t = (searches[term] ||= { count: 0, empty: 0 });
          t.count += s.count;
          t.empty += s.empty;
          day.searches += s.count;
        }
      }
    }
    daily.push(day);
  }

  const split = (k) => k.split(' ');
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const desc = (key) => (a, b) => b[key] - a[key];
  const slug = apiId ? byId.get(apiId)?.slug : null;
  const searchList = Object.entries(searches).map(([term, s]) => ({ term, ...s }));
  const consoleList = Object.entries(consoleUse).map(([k, c]) => ({ ...apiInfo(split(k)[0]), ...route(...split(k)), ...c }));

  return {
    from,
    to,
    days: n,
    apiId,
    totals: {
      apiViews: sum(views),
      guideViews: sum(guides),
      routeViews: sum(routes),
      searches: searchList.reduce((a, s) => a + s.count, 0),
      emptySearches: searchList.reduce((a, s) => a + s.empty, 0),
      consoleCalls: consoleList.reduce((a, c) => a + c.calls, 0),
      consoleErrors: consoleList.reduce((a, c) => a + c.errors, 0),
      unanswered: gaps.filter((g) => g.at.slice(0, 10) >= from && (!apiId || g.api === slug)).length,
    },
    apis: Object.entries(views).map(([id, c]) => ({ ...apiInfo(id), views: c })).sort(desc('views')).slice(0, 20),
    guides: Object.entries(guides).map(([k, c]) => ({ ...apiInfo(split(k)[0]), guideId: split(k)[1], views: c })).sort(desc('views')).slice(0, 20),
    routes: Object.entries(routes).map(([k, c]) => ({ ...apiInfo(split(k)[0]), ...route(...split(k)), views: c })).sort(desc('views')).slice(0, 20),
    console: consoleList.sort(desc('calls')).slice(0, 30),
    searches: searchList.sort(desc('count')).slice(0, 20),
    emptySearches: searchList.filter((s) => s.empty > 0).map((s) => ({ term: s.term, count: s.empty })).sort(desc('count')).slice(0, 30),
    daily,
  };
}

module.exports = { init, view, search, searchTerm, consoleCall, report, flush };
