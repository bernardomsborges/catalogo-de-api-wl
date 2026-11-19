// Versions of the database structure (PRO-202).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { list } = require('../src/db/migrate');
const { startServer } = require('./helpers');

function folder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogo-migr-'));
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'SELECT 1;');
  return dir;
}

describe('migration files', () => {
  test('in numeric order, ignoring other files', () => {
    const dir = folder(['010-dez.sql', '002-dois.sql', '001-um.sql', 'LEIA-ME.md']);
    assert.deepEqual(list(dir).map((m) => m.version), [1, 2, 10]);
  });

  test('a repeated number or a wrong name stops everything', () => {
    assert.throws(() => list(folder(['001-um.sql', '001-outro.sql'])), /duas migrações com o número 1/);
    assert.throws(() => list(folder(['1-curto.sql'])), /nome inválido/);
    assert.throws(() => list(folder(['001_Com Espaco.sql'])), /nome inválido/);
  });

  test('the files of the catalog itself are valid', () => {
    assert.ok(list().length >= 1);
  });
});

// Needs a database: set TEST_DATABASE_URL (the CI does). Each test uses its own empty schema.
const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'defina TEST_DATABASE_URL para rodar';

async function withSchema(fn) {
  const { Client } = require('pg');
  const name = `migr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${name}`);
  const u = new URL(url);
  u.searchParams.set('options', `-c search_path=${name}`);
  try {
    await fn(u.toString(), (sql) => admin.query(sql.replaceAll('$schema', name)));
  } finally {
    await admin.query(`DROP SCHEMA ${name} CASCADE`);
    await admin.end();
  }
}

const env = (dbUrl) => ({ DATABASE_URL: dbUrl, ADMIN_PASSWORD: 'senha-do-admin-123', INSTANCE_LOCK_RETRY_MS: '200' });

test('an empty database gets every migration once', { skip }, async () => {
  await withSchema(async (dbUrl, q) => {
    let server = await startServer({ env: env(dbUrl) });
    assert.match(server.log(), /migração aplicada: 001-tabelas-iniciais\.sql/);
    await server.stop();
    const versions = (await q('SELECT version FROM $schema.schema_migrations ORDER BY version')).rows.map((r) => r.version);
    assert.deepEqual(versions, list().map((m) => m.version));

    server = await startServer({ env: env(dbUrl) });
    assert.match(server.log(), /nada a migrar/);
    assert.doesNotMatch(server.log(), /migração aplicada/);
    await server.stop();
  });
});

test('a database created before the versions keeps its data', { skip }, async () => {
  await withSchema(async (dbUrl, q) => {
    // What older versions created on their own, with one API already saved.
    await q(`CREATE TABLE $schema.apis (id text PRIMARY KEY, slug text NOT NULL UNIQUE, data jsonb NOT NULL, revision integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE $schema.documents (name text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await q(`INSERT INTO $schema.apis (id, slug, data, revision) VALUES ('x', 'antiga', '{"id":"x","slug":"antiga","name":"API antiga","endpoints":[]}', 3)`);

    const server = await startServer({ env: env(dbUrl) });
    try {
      const r = await server.call('GET', '/api/apis');
      assert.deepEqual(r.json.map((a) => a.slug), ['antiga']);
    } finally {
      await server.stop();
    }
    assert.equal((await q('SELECT count(*)::int AS n FROM $schema.schema_migrations')).rows[0].n, list().length);
  });
});
