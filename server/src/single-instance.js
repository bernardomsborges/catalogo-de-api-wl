/**
 * The catalog runs as ONE instance (PRO-197). It keeps the data in memory (loaded at startup and
 * written whole on each change), the call limits in memory, and runs the health checks and the
 * OpenAPI sync on timers. A second copy would overwrite the first one's changes, split the limits
 * and send every e-mail twice.
 *
 * With PostgreSQL, this is enforced: before loading anything, the server takes an advisory lock on a
 * dedicated connection and holds it while running. A second copy waits until the first one stops
 * (which also makes a rolling deploy safe: the new copy starts serving once the old one is gone).
 * If the connection holding the lock drops, the server stops, so two copies never run together.
 * Without a database there is nothing shared to lock: run one copy per data folder.
 */
const LOCK_KEY = 4_215_830_197; // any fixed number, the same for every copy of the catalog
const RETRY_MS = Number(process.env.INSTANCE_LOCK_RETRY_MS) || 5000;

let client = null;

/** Resolves once this is the only running copy. `log` receives the waiting messages. */
async function acquire({ log = console.log } = {}) {
  if (!process.env.DATABASE_URL) return 'sem banco: rode uma cópia só por pasta de dados';
  const { Client } = require('pg');
  let warned = false;
  for (;;) {
    const c = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'catalogo-de-apis (trava de instância)' });
    await c.connect();
    const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (rows[0].ok) {
      client = c;
      c.on('error', (err) => {
        console.error(`[instância] a conexão que segura a trava caiu (${err.message}). Parando para não rodar junto com outra cópia.`);
        process.exit(1);
      });
      return warned ? 'a outra cópia parou; esta assumiu' : 'esta é a única cópia rodando';
    }
    await c.end();
    if (!warned) log('[instância] outra cópia do catálogo está rodando com este banco. Esperando ela parar (o catálogo roda com uma réplica só)…');
    warned = true;
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

/** Releases the lock (on shutdown). */
async function release() {
  if (!client) return;
  const c = client;
  client = null;
  c.removeAllListeners('error');
  await c.end().catch(() => {});
}

module.exports = { acquire, release, LOCK_KEY };
