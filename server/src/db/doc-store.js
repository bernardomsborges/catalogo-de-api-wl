/**
 * Data kept as one JSON document each: accounts (people, groups, access requests), recipes,
 * subscriptions, OpenAPI sync, monitoring, AI questions without answer and the AI search cache.
 *
 * - With DATABASE_URL: one row per document in the `documents` table (created by migrations/), next to the APIs. On the
 *   first start with the database, the existing JSON file is imported, so switching loses nothing.
 * - Without it: the JSON file, written atomically (temp file, then rename).
 *
 * A file that exists but can't be read stops the server: starting empty would write over the data.
 */
const fs = require('fs');
const path = require('path');

const usePg = !!process.env.DATABASE_URL;

const pool = () => require('./pg-backend').pool;

/** Reads a JSON file: undefined when missing, an error when it exists but can't be read. */
function readJsonFile(file) {
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} existe mas não pôde ser lido (${err.message}). Corrija ou restaure o arquivo; o servidor não sobe para não apagar os dados.`);
  }
}

/**
 * @param {string} file
 * @param {any} value
 * @param {{ pretty?: boolean, mode?: number }} [options]
 */
function writeJsonFile(file, value, { pretty = true, mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : undefined), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/**
 * One document. `load(empty)` returns the stored data (or `empty`); `save(data)` writes it.
 * In PostgreSQL, writes go one at a time, each with the data as it was when save() was called.
 */
function docStore(name, file, options = {}) {
  /** @type {Promise<unknown>} */
  let writing = Promise.resolve();
  return {
    where: usePg ? 'PostgreSQL' : file,

    async load(empty) {
      if (!usePg) return readJsonFile(file) ?? empty;
      const get = async () => (await pool().query('SELECT data FROM documents WHERE name = $1', [name])).rows[0]?.data;
      const stored = await get();
      if (stored !== undefined) return stored;
      const fromFile = readJsonFile(file);
      const data = fromFile ?? empty;
      // Several instances may start together: the first insert wins and the others read it.
      const ins = await pool().query('INSERT INTO documents (name, data) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING', [name, JSON.stringify(data)]);
      if (!ins.rowCount) return get();
      if (fromFile !== undefined) console.log(`[dados] ${path.basename(file)} importado para o PostgreSQL (${name}).`);
      return data;
    },

    save(data) {
      if (!usePg) return writeJsonFile(file, data, options);
      // Always sent as text: node-pg would turn a JS array into a PostgreSQL array.
      const snapshot = JSON.stringify(data);
      writing = writing
        .then(() => pool().query('UPDATE documents SET data = $2::jsonb, updated_at = now() WHERE name = $1', [name, snapshot]))
        .catch((err) => console.error(`[dados] Não foi possível gravar ${name} no PostgreSQL:`, err.message));
    },
  };
}

module.exports = { docStore, readJsonFile, writeJsonFile };
