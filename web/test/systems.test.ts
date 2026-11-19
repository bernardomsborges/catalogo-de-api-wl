// Systems affected by breaking changes (PRO-166).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affectedSystems, Consumer } from '../src/app/core/systems';

const system = (name: string, routes: string[] = []): Consumer => ({ id: name, name, owner: '', contactEmail: '', description: '', routes });
const change = (route: string, text = 'mudou') => ({ breaking: true, route, text });

test('who uses the whole API is hit by any breaking change; who declared routes, only by those and by API-wide ones', () => {
  const consumers = [system('Painel'), system('Protocolo', ['POST /processos']), system('Relatórios', ['GET /relatorios'])];
  const names = (changes: ReturnType<typeof change>[]) => affectedSystems(changes, consumers).map((a) => `${a.system.name}:${a.changes.length}`);

  assert.deepEqual(names([change('POST /processos')]), ['Painel:1', 'Protocolo:1']);
  assert.deepEqual(names([change('')]), ['Painel:1', 'Protocolo:1', 'Relatórios:1'], 'an API-wide change (e.g. credentials) hits everyone');
  assert.deepEqual(names([change('DELETE /anexos')]), ['Painel:1']);
  assert.deepEqual(names([]), []);
});
