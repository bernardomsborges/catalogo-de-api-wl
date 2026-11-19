/**
 * Versions of the PostgreSQL structure (PRO-202). Each change is a numbered file in migrations/
 * (`002-o-que-muda.sql`), applied in order, once, inside a transaction together with its row in
 * `schema_migrations`. A file that fails leaves the database as it was and stops the server.
 *
 * Applied files must never be edited: write a new file instead. Runs before any module loads data.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'migrations');
const NAME = /^(\d{3,})-[a-z0-9-]+\.sql$/;
// Besides the single-instance lock: also safe for tools that migrate without starting the server.
const LOCK_KEY = 4_215_830_202;

/** The migration files, in order: [{ version, name, file }]. Wrong names and repeated numbers throw. */
function list(dir = DIR) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.sql')) continue;
    const m = NAME.exec(name);
    if (!m) throw new Error(`migração com nome inválido: ${name} (use 001-descricao-curta.sql)`);
    out.push({ version: Number(m[1]), name, file: path.join(dir, name) });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i - 1].version) throw new Error(`duas migrações com o número ${out[i].version}: ${out[i - 1].name} e ${out[i].name}`);
  }
  return out;
}

/** Applies the pending migrations. Returns a line for the log. */
async function run({ dir = DIR, log = console.log } = {}) {
  if (!process.env.DATABASE_URL) return 'sem banco: nada a migrar';
  const files = list(dir);
  const { pool } = require('./pg-backend');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const applied = new Map((await client.query('SELECT version, name FROM schema_migrations')).rows.map((r) => [r.version, r.name]));
    const known = new Set(files.map((f) => f.version));
    const unknown = [...applied].filter(([v]) => !known.has(v));
    if (unknown.length) {
      log(`[banco] aviso: o banco tem migrações que este código não conhece (${unknown.map(([, n]) => n).join(', ')}). Ele foi atualizado por uma versão mais nova do catálogo.`);
    }

    const pending = files.filter((f) => !applied.has(f.version));
    for (const f of pending) {
      const sql = fs.readFileSync(f.file, 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [f.version, f.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`a migração ${f.name} falhou e não foi aplicada: ${err.message}`);
      }
      log(`[banco] migração aplicada: ${f.name}`);
    }
    const version = Math.max(0, ...files.map((f) => f.version), ...applied.keys());
    return pending.length ? `estrutura na versão ${version} (${pending.length} migração(ões) aplicada(s))` : `estrutura na versão ${version}, nada a migrar`;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { run, list };
