/**
 * Storage in JSON files (default, no database needed): published APIs in DATA_FILE, versions and
 * drafts in files next to it. Good for development and small installs with one editor.
 */
const fs = require('fs');
const path = require('path');
const { readJsonFile } = require('./doc-store');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'apis.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const VERSIONS_FILE = path.join(path.dirname(DATA_FILE), 'api-versions.json');
const DRAFTS_FILE = path.join(path.dirname(DATA_FILE), 'api-drafts.json');

let apis = [];
/** { [apiId]: [{ revision, savedAt, savedBy, note, data }] } */
let versions = {};
/** { [apiId]: { data, baseRevision, updatedAt, updatedBy } } */
let drafts = {};

/** Missing file: fallback. A file that can't be read stops the server instead of being overwritten. */
function readJson(file, fallback) {
  return readJsonFile(file) ?? fallback;
}

function writeJson(file, value) {
  // Temp file first so a crash never leaves a half-written file.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

async function init() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, fs.existsSync(SEED_FILE) ? fs.readFileSync(SEED_FILE, 'utf8') : '[]');
  }
  apis = readJson(DATA_FILE, []);
  versions = readJson(VERSIONS_FILE, {});
  drafts = readJson(DRAFTS_FILE, {});
  // Data from before the history existed: start each API at revision 1.
  let changed = false;
  for (const a of apis) {
    if (!a.revision) {
      a.revision = 1;
      changed = true;
    }
    if (!versions[a.id]?.length) {
      versions[a.id] = [{ revision: a.revision, savedAt: a.updatedAt || new Date().toISOString(), savedBy: '', note: 'Versão inicial', data: a }];
      changed = true;
    }
  }
  if (changed) {
    writeJson(DATA_FILE, apis);
    writeJson(VERSIONS_FILE, versions);
  }
  return { apis: structuredClone(apis), drafts: structuredClone(drafts) };
}

/** Saves a published API whose revision is expectedRevision + 1 (0 = new). False on conflict. */
async function savePublished(api, expectedRevision, meta) {
  const i = apis.findIndex((a) => a.id === api.id);
  const current = i >= 0 ? apis[i].revision : 0;
  if (current !== expectedRevision) return false;
  if (i >= 0) apis[i] = api;
  else apis.push(api);
  (versions[api.id] ||= []).push({ revision: api.revision, savedAt: api.updatedAt, savedBy: meta.by || '', note: meta.note || '', data: api });
  writeJson(DATA_FILE, apis);
  writeJson(VERSIONS_FILE, versions);
  return true;
}

async function deleteApi(id) {
  apis = apis.filter((a) => a.id !== id);
  delete versions[id];
  delete drafts[id];
  writeJson(DATA_FILE, apis);
  writeJson(VERSIONS_FILE, versions);
  writeJson(DRAFTS_FILE, drafts);
}

async function saveDraft(id, draft) {
  drafts[id] = draft;
  writeJson(DRAFTS_FILE, drafts);
}

async function deleteDraft(id) {
  if (!drafts[id]) return;
  delete drafts[id];
  writeJson(DRAFTS_FILE, drafts);
}

async function listVersions(id) {
  return (versions[id] || []).map(({ data, ...meta }) => ({ ...meta, version: data.version, name: data.name, endpoints: data.endpoints.length })).reverse();
}

async function getVersion(id, revision) {
  return structuredClone((versions[id] || []).find((v) => v.revision === revision)?.data ?? null);
}

/** Current published revision in storage (the cache may be behind in other backends). */
async function currentRevision(id) {
  return apis.find((a) => a.id === id)?.revision ?? 0;
}

module.exports = { name: 'arquivo', init, savePublished, deleteApi, saveDraft, deleteDraft, listVersions, getVersion, currentRevision };
