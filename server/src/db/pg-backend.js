/**
 * Storage in PostgreSQL (DATABASE_URL). Each API is one JSONB row; every publication is a row in
 * api_versions; drafts live next to the published data. On the first start with an empty database,
 * the current JSON file (or the seed) is imported, so nothing is lost when switching.
 *
 * Concurrent editors are handled with the revision number: an update only applies when the row
 * still has the revision the editor started from.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { readJsonFile } = require('./doc-store');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'apis.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DATABASE_POOL_SIZE) || 5 });

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** First start on an empty database: brings in the JSON file (or the seed). */
async function importFromFile(client) {
  const file = fs.existsSync(DATA_FILE) ? DATA_FILE : SEED_FILE;
  if (!fs.existsSync(file)) return 0;
  const list = readJsonFile(file);
  for (const a of list) {
    const api = { ...a, revision: a.revision || 1 };
    await client.query('INSERT INTO apis (id, slug, data, revision, updated_at) VALUES ($1, $2, $3, $4, $5)', [api.id, api.slug, api, api.revision, api.updatedAt || new Date()]);
    await client.query('INSERT INTO api_versions (api_id, revision, data, saved_at, note) VALUES ($1, $2, $3, $4, $5)', [
      api.id,
      api.revision,
      api,
      api.updatedAt || new Date(),
      `Importada de ${path.basename(file)}`,
    ]);
  }
  console.log(`[banco] ${list.length} API(s) importada(s) de ${file}.`);
  return list.length;
}

/** Loads everything. The tables come from migrations/, applied before (see migrate.js). */
async function init() {
  await tx(async (c) => {
    // Only one server instance imports, even if several start together.
    await c.query('LOCK TABLE apis IN EXCLUSIVE MODE');
    const { rows } = await c.query('SELECT count(*)::int AS n FROM apis');
    if (!rows[0].n) await importFromFile(c);
  });
  const apis = (await pool.query('SELECT data FROM apis ORDER BY data->>\'name\'')).rows.map((r) => r.data);
  const drafts = {};
  for (const r of (await pool.query('SELECT api_id, data, base_revision, updated_at, updated_by FROM api_drafts')).rows) {
    drafts[r.api_id] = { data: r.data, baseRevision: r.base_revision, updatedAt: r.updated_at.toISOString(), updatedBy: r.updated_by };
  }
  return { apis, drafts };
}

async function savePublished(api, expectedRevision, meta) {
  return tx(async (c) => {
    if (expectedRevision === 0) {
      const r = await c.query('INSERT INTO apis (id, slug, data, revision, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [api.id, api.slug, api, api.revision, api.updatedAt]);
      if (!r.rowCount) return false;
    } else {
      const r = await c.query('UPDATE apis SET slug = $2, data = $3, revision = $4, updated_at = $5 WHERE id = $1 AND revision = $6', [
        api.id,
        api.slug,
        api,
        api.revision,
        api.updatedAt,
        expectedRevision,
      ]);
      if (!r.rowCount) return false;
    }
    await c.query('INSERT INTO api_versions (api_id, revision, data, saved_at, saved_by, note) VALUES ($1, $2, $3, $4, $5, $6)', [
      api.id,
      api.revision,
      api,
      api.updatedAt,
      meta.by || '',
      meta.note || '',
    ]);
    return true;
  });
}

async function deleteApi(id) {
  await pool.query('DELETE FROM apis WHERE id = $1', [id]);
}

async function saveDraft(id, draft) {
  await pool.query(
    `INSERT INTO api_drafts (api_id, data, base_revision, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (api_id) DO UPDATE SET data = EXCLUDED.data, base_revision = EXCLUDED.base_revision, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [id, draft.data, draft.baseRevision, draft.updatedAt, draft.updatedBy || '']
  );
}

async function deleteDraft(id) {
  await pool.query('DELETE FROM api_drafts WHERE api_id = $1', [id]);
}

async function listVersions(id) {
  const { rows } = await pool.query(
    `SELECT revision, saved_at, saved_by, note, data->>'version' AS version, data->>'name' AS name, jsonb_array_length(data->'endpoints') AS endpoints
     FROM api_versions WHERE api_id = $1 ORDER BY revision DESC`,
    [id]
  );
  return rows.map((r) => ({ revision: r.revision, savedAt: r.saved_at.toISOString(), savedBy: r.saved_by, note: r.note, version: r.version, name: r.name, endpoints: r.endpoints }));
}

async function getVersion(id, revision) {
  const { rows } = await pool.query('SELECT data FROM api_versions WHERE api_id = $1 AND revision = $2', [id, revision]);
  return rows[0]?.data ?? null;
}

async function currentRevision(id) {
  const { rows } = await pool.query('SELECT revision FROM apis WHERE id = $1', [id]);
  return rows[0]?.revision ?? 0;
}

/** Health check: the database answers a trivial query. */
async function ping() {
  await pool.query('SELECT 1');
}

module.exports = { name: 'PostgreSQL', init, ping, savePublished, deleteApi, saveDraft, deleteDraft, listVersions, getVersion, currentRevision, pool };
