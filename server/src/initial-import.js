/**
 * Initial catalog: on the first start, the APIs listed in CATALOG_IMPORT are imported from their
 * OpenAPI/Swagger documents, in place of the sample APIs.
 *
 * CATALOG_IMPORT takes one of:
 * - links and/or files, separated by commas or line breaks:
 *     CATALOG_IMPORT=https://api.exemplo.gov.br/openapi.json, ./specs/protocolo.yaml
 *   A link may point to the documentation page (Swagger UI, Redoc): the document is found the same
 *   way as in "Importar OpenAPI → Link" in the admin.
 * - a manifest, a .json file with the list and what to set on each API:
 *     CATALOG_IMPORT=./catalogo-inicial.json
 *     [{ "source": "https://…/openapi.json", "category": "Documentos", "owner": "Time X",
 *        "contactEmail": "x@exemplo.gov.br", "tags": ["sei"], "visibility": "private",
 *        "groups": ["servidores"], "status": "estavel", "sync": true }, "./specs/outra.yaml"]
 *   Relative paths are resolved from the manifest's folder (or, without a manifest, from the project's
 *   root: the same in development and in the Docker image, /app).
 *
 * When it runs: once, when the catalog is still empty. The result is recorded (document "setup"), so
 * it doesn't run again even if every API is deleted later. If every source fails (e.g. no network),
 * nothing is recorded and it tries again on the next start.
 * APIs imported from a link get the OpenAPI sync turned on ("sync": false turns it off).
 *
 * To check the sources without saving anything:  npm --prefix server run import:check [-- <fontes>]
 */
const fs = require('fs');
const path = require('path');
const { docStore } = require('./db/doc-store');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'apis.json');
const SETUP_FILE = process.env.SETUP_FILE || path.join(path.dirname(DATA_FILE), 'setup.json');
const IMPORTER = path.join(__dirname, '..', 'generated', 'openapi-import.cjs');
const MAX_BYTES = 10 * 1024 * 1024;
/** The project's root (/app in the Docker image): base of relative paths in CATALOG_IMPORT. */
const ROOT = path.join(__dirname, '..', '..');
const FIELDS = ['name', 'slug', 'summary', 'category', 'owner', 'contactEmail', 'status', 'version'];

/** The OpenAPI → catalog conversion of the portal (web/src/app/core/openapi.ts), bundled by the build. */
function importer() {
  if (!fs.existsSync(IMPORTER)) {
    throw new Error(`Conversor de OpenAPI não encontrado (${path.relative(process.cwd(), IMPORTER)}). Rode "npm run build" na raiz do projeto.`);
  }
  return require(IMPORTER);
}

const isUrl = (s) => /^https?:\/\//i.test(s);

/**
 * The list of sources: [{ source, ...settings }]. `value`: CATALOG_IMPORT. `cwd`: base for relative
 * paths (default: the project's root).
 */
function parseSources(value, cwd = ROOT) {
  const text = String(value || '').trim();
  if (!text) return [];
  const asFile = !isUrl(text) && /\.json$/i.test(text) ? path.resolve(cwd, text) : null;
  if (asFile && fs.existsSync(asFile)) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(asFile, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      throw new Error(`O manifesto ${text} não é um JSON válido (${err.message}).`);
    }
    // An OpenAPI document in JSON is a source, not a manifest.
    if (manifest && !Array.isArray(manifest) && (manifest.openapi || manifest.swagger)) return [{ source: asFile }];
    const list = Array.isArray(manifest) ? manifest : manifest?.apis;
    if (!Array.isArray(list)) throw new Error(`O manifesto ${text} deve ser uma lista ou { "apis": [...] }.`);
    const base = path.dirname(asFile);
    return list.map((item, i) => {
      const entry = typeof item === 'string' ? { source: item } : { ...item };
      if (!entry.source || typeof entry.source !== 'string') throw new Error(`Manifesto ${text}, item ${i + 1}: falta "source" (link ou arquivo).`);
      if (!isUrl(entry.source)) entry.source = path.resolve(base, entry.source);
      return entry;
    });
  }
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({ source: isUrl(s) ? s : path.resolve(cwd, s) }));
}

/** The document's text. A link may be the documentation page; the spec is discovered from it. */
async function readSource(source) {
  if (isUrl(source)) {
    const { text, source: found, error } = await require('./spec-sync').fetchOnce({ url: source });
    if (error) throw new Error(error);
    if (text.length > MAX_BYTES) throw new Error('O documento passa de 10 MB.');
    return { text, url: found || source };
  }
  if (!fs.existsSync(source)) throw new Error('Arquivo não encontrado.');
  if (fs.statSync(source).size > MAX_BYTES) throw new Error('O arquivo passa de 10 MB.');
  return { text: fs.readFileSync(source, 'utf8').replace(/^﻿/, ''), url: null };
}

/**
 * The API to create: the converted document plus what the manifest sets. `url`: where the document
 * came from (a base URL for documents without "servers").
 */
function toInput(text, entry, url = null) {
  const draft = importer().importOpenApi(text);
  const input = { ...draft };
  for (const k of FIELDS) if (typeof entry[k] === 'string' && entry[k].trim()) input[k] = entry[k].trim();
  if (Array.isArray(entry.tags)) input.tags = [...new Set([...(draft.tags || []), ...entry.tags.map(String)])];
  if (entry.visibility === 'private') {
    input.visibility = 'private';
    input.groups = Array.isArray(entry.groups) ? entry.groups.map(String) : [];
  }
  // Many public documents have no description: the catalog requires a summary.
  if (!String(input.summary || '').trim()) input.summary = `Documentação da API ${input.name || 'importada'}.`;
  // A document without "servers" has no base URL, and the catalog requires one: the manifest's
  // baseUrl, else the address the document came from.
  if (typeof entry.baseUrl === 'string' && entry.baseUrl.trim()) input.baseUrl = entry.baseUrl.trim();
  if (!input.baseUrl && url) input.baseUrl = new URL(url).origin;
  // "servers": [{ "url": "/api/v3" }] is relative to where the document is.
  if (url) {
    const absolute = (u) => (u && !/^https?:\/\//i.test(u) ? new URL(u, url).href.replace(/\/+$/, '') : u);
    input.baseUrl = absolute(input.baseUrl);
    input.environments = (input.environments || []).map((e) => ({ ...e, url: absolute(e.url) }));
  }
  if (!input.baseUrl) throw new Error('O documento não tem "servers": informe "baseUrl" para esta API no manifesto.');
  return input;
}

const label = (source) => (isUrl(source) ? source : path.basename(source));

/**
 * Imports every source. Never throws for one source: each result says what happened.
 * `dryRun`: converts and validates, but saves nothing.
 */
/**
 * @param {any[]} entries
 * @param {{ store: any, specSync?: any, by?: string, dryRun?: boolean, log?: (...args: any[]) => void }} options
 */
async function importAll(entries, { store, specSync, by = 'importação inicial', dryRun = false, log = console.log }) {
  const results = [];
  for (const entry of entries) {
    const name = label(entry.source);
    try {
      const { text, url } = await readSource(entry.source);
      const input = toInput(text, entry, url);
      if (dryRun) {
        const errors = store.validate(input);
        results.push({ source: name, ok: !errors.length, name: input.name, endpoints: (input.endpoints || []).length, error: errors.join(' ') || undefined });
        continue;
      }
      const r = await store.create(input, { by, note: `Importada de ${name}` });
      if (!r.api) throw new Error(r.errors?.join(' ') || r.conflict || 'Não foi possível salvar.');
      if (url && entry.sync !== false) specSync.adopt(r.api.id, url, text);
      results.push({ source: name, ok: true, name: r.api.name, slug: r.api.slug, endpoints: r.api.endpoints.length });
      log(`[importação inicial] ${r.api.name}: ${r.api.endpoints.length} rota(s), de ${name}.`);
    } catch (err) {
      results.push({ source: name, ok: false, error: err.message });
      log(`[importação inicial] ${name}: ${err.message}`);
    }
  }
  return results;
}

const setupDoc = docStore('setup', SETUP_FILE);

/**
 * On startup: imports CATALOG_IMPORT if this is the first start (nothing recorded and no API yet).
 * Returns a line for the log, or null when there is nothing to do.
 */
/** @param {{ store: any, specSync: any, log?: (...args: any[]) => void, value?: string }} options */
async function runIfNeeded({ store, specSync, log = console.log, value = process.env.CATALOG_IMPORT }) {
  if (!String(value || '').trim()) return null;
  const setup = await setupDoc.load({});
  if (setup.initialImport) return null;
  if (store.list().length) {
    setupDoc.save({ ...setup, initialImport: { at: new Date().toISOString(), skipped: 'o catálogo já tinha APIs' } });
    return 'o catálogo já tem APIs: a importação inicial (CATALOG_IMPORT) não foi feita';
  }
  let entries;
  try {
    entries = parseSources(value);
  } catch (err) {
    return `CATALOG_IMPORT inválido: ${err.message}`;
  }
  log(`[importação inicial] ${entries.length} fonte(s) em CATALOG_IMPORT.`);
  const results = await importAll(entries, { store, specSync, log });
  const ok = results.filter((r) => r.ok).length;
  if (!ok && results.length) return `nenhuma das ${results.length} fonte(s) pôde ser importada; tento de novo na próxima vez que o servidor subir`;
  await setupDoc.save({ ...setup, initialImport: { at: new Date().toISOString(), results } });
  return `${ok} de ${results.length} API(s) importada(s)`;
}

module.exports = { parseSources, toInput, importAll, runIfNeeded };

// `node src/initial-import.js [fontes]`: checks the sources (CATALOG_IMPORT, or the ones given) without saving.
if (require.main === module) {
  const value = process.argv.slice(2).join(',') || process.env.CATALOG_IMPORT;
  if (!value) {
    console.error('Informe as fontes (links, arquivos ou um manifesto .json) ou defina CATALOG_IMPORT.');
    process.exit(2);
  }
  const store = require('./store');
  importAll(parseSources(value), { store, dryRun: true, log: () => {} })
    .then((results) => {
      for (const r of results) {
        console.log(r.ok ? `OK     ${r.name} (${r.endpoints} rota(s)) — ${r.source}` : `ERRO   ${r.source}: ${r.error}`);
      }
      const bad = results.filter((r) => !r.ok).length;
      console.log(`\n${results.length - bad} de ${results.length} fonte(s) podem ser importadas.`);
      process.exit(bad ? 1 : 0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(2);
    });
}
