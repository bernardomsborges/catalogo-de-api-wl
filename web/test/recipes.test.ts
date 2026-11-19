// ReceAPItos: analysis of the steps and the generated code (cURL, Python, Go, Power Automate).
// When bash, Python or Go are installed, the generated scripts are also checked by them.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudCode, padCode, powerAutomateAsked } from '../src/app/core/power-automate';
import { analyze, curlCode, goCode, parseBody, parsePath, pythonCode, RecipeInput, responseFields, stepFromEndpoint, varsIn } from '../src/app/core/recipes';
import { catalogApi } from './fixtures';

const api = catalogApi();

/** Log in, then read a process with the token: the usual two-step ReceAPIto. */
function recipe(): RecipeInput {
  const login = stepFromEndpoint(api, api.endpoints[0]);
  login.body = '{"usuario": "{{USUARIO}}", "senha": "{{SENHA}}"}';
  login.outputs = [{ name: 'TOKEN', path: 'access_token' }];
  const read = stepFromEndpoint(api, api.endpoints[3]);
  read.params = read.params.map((p) => (p.name === 'id' ? { ...p, value: '{{PROCESSO}}' } : p));
  read.params.push({ in: 'query', name: 'campos', value: 'numero,assunto' });
  read.outputs = [{ name: 'NUMERO', path: 'numero' }];
  return { slug: 'consultar', title: 'Consultar um processo', goal: 'Entrar e ler um processo.', intro: '', tags: [], inputs: { USUARIO: 'Seu usuário' }, steps: [login, read] };
}

describe('steps and analysis', () => {
  test('stepFromEndpoint fills the credentials and the required parameters', () => {
    const step = stepFromEndpoint(api, api.endpoints[3]);
    assert.deepEqual(step.params, [
      { in: 'header', name: 'X-Client-Id', value: '{{CLIENT_ID}}' },
      { in: 'header', name: 'Authorization', value: 'Bearer {{TOKEN}}' },
      { in: 'path', name: 'id', value: '42' },
    ]);
    assert.equal(stepFromEndpoint(api, api.endpoints[2]).params.length, 0); // public route
  });

  test('analyze: what the person provides and which step saves each variable', () => {
    const a = analyze(recipe(), [api]);
    assert.deepEqual(a.inputs, ['CLIENT_ID', 'USUARIO', 'SENHA', 'PROCESSO']);
    assert.deepEqual(a.steps[1].uses.find((u) => u.name === 'TOKEN'), { name: 'TOKEN', from: 1 });
    assert.equal(a.missingCount, 0);
  });

  test('analyze: a route that left the catalog is flagged', () => {
    const r = recipe();
    r.steps[1].path = '/v1/processos/{id}/antigo';
    assert.equal(analyze(r, [api]).steps[1].missing, true);
  });

  test('helpers: variables, JSON paths, body and response fields', () => {
    assert.deepEqual(varsIn('Bearer {{ TOKEN }} e {{X}}'), ['TOKEN', 'X']);
    assert.deepEqual(parsePath('unidades[0].itens[2].id'), ['unidades', 0, 'itens', 2, 'id']);
    assert.match(parseBody('{"a": {{X}}}').error!, /entre aspas/);
    assert.deepEqual(parseBody('{"a": "{{X}}"}').value, { a: '{{X}}' });
    assert.deepEqual(responseFields(api.endpoints[3]), ['id', 'numero', 'assunto']);
  });
});

/** How to ask each tool whether it is installed (gofmt has no --version: `go version` does it). */
const PROBE: Record<string, [string, string[]]> = { bash: ['bash', ['--version']], python: ['python', ['--version']], gofmt: ['go', ['version']] };

/** Runs `cmd` on the code saved to a file; skips when the tool isn't installed. */
function checkWith(t: { skip: (msg: string) => void }, cmd: string, args: (file: string) => string[], code: string, ext: string) {
  const [probeCmd, probeArgs] = PROBE[cmd];
  const probe = spawnSync(probeCmd, probeArgs, { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip(`${cmd} não está instalado`);
  const dir = mkdtempSync(join(tmpdir(), 'receapito-'));
  try {
    const file = join(dir, `receapito.${ext}`);
    writeFileSync(file, code);
    const run = spawnSync(cmd, args(file), { encoding: 'utf8' });
    assert.equal(run.status, 0, `${cmd} recusou o código:\n${run.stderr}\n${code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generated code', () => {
  const r = recipe();

  test('cURL: reads the inputs, chains the token and is valid bash', (t) => {
    const code = curlCode(r, [api]);
    assert.match(code, /: "\$\{USUARIO:\?Defina USUARIO\}"/);
    assert.match(code, /TOKEN=/);
    assert.match(code, /Bearer \$\{?TOKEN/);
    checkWith(t, 'bash', (f) => ['-n', f], code, 'sh');
  });

  test('Python: reads the inputs, chains the token and compiles', (t) => {
    const code = pythonCode(r, [api]);
    assert.match(code, /USUARIO = os\.environ\["USUARIO"\]/);
    assert.match(code, /TOKEN = resp\["access_token"\]/);
    assert.match(code, /NUMERO = resp\["numero"\]/);
    checkWith(t, 'python', (f) => ['-c', 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', f], code, 'py');
  });

  test('Go: a complete program that gofmt accepts', (t) => {
    const code = goCode(r, [api]);
    assert.match(code, /^package main/m);
    assert.match(code, /func main\(\)/);
    assert.match(code, /USUARIO = env\("USUARIO"\)/);
    assert.match(code, /TOKEN = get\(resp, "access_token"\)/);
    checkWith(t, 'gofmt', (f) => ['-e', f], code, 'go');
  });
});

describe('Power Automate', () => {
  const r = recipe();

  test('Cloud: one HTTP action per step, named as the designer names them', () => {
    const { actions } = cloudCode(r, [api]);
    assert.deepEqual(actions.map((a) => [a.label, a.name]), [
      ['Passo 1: Entrar', 'HTTP'],
      ['Passo 2: Consultar processo', 'HTTP_1'],
    ]);
    for (const a of actions) assert.doesNotThrow(() => JSON.parse(a.json));
  });

  test('Cloud: later steps read the earlier response; the rest is PREENCHA', () => {
    const second = cloudCode(r, [api]).actions[1].json;
    assert.ok(second.includes("Bearer @{body('HTTP')?['access_token']}"), 'token do passo 1');
    assert.ok(second.includes('https://api.exemplo.gov.br/v1/processos/PREENCHA_PROCESSO'), 'URL com o id a preencher');
    assert.ok(second.includes('PREENCHA_CLIENT_ID'));
  });

  test('Cloud: expressions to read each response', () => {
    assert.deepEqual(cloudCode(r, [api]).expressions.map((e) => [e.label, e.expr]), [
      ['TOKEN', "body('HTTP')?['access_token']"],
      ['Status do passo 1', "outputs('HTTP')?['statusCode']"],
      ['NUMERO', "body('HTTP_1')?['numero']"],
      ['Status do passo 2', "outputs('HTTP_1')?['statusCode']"],
    ]);
  });

  test('Cloud: a literal "@" is escaped so it is not read as an expression', () => {
    const at = recipe();
    at.steps[1].params.push({ in: 'header', name: 'X-Origem', value: '@sistema' });
    assert.ok(cloudCode(at, [api]).actions[1].json.includes('@@sistema'));
  });

  test('Desktop: variables to fill, one call per step and a stop on error', () => {
    const code = padCode(r, [api]);
    for (const v of ['CLIENT_ID', 'USUARIO', 'SENHA', 'PROCESSO']) assert.match(code, new RegExp(`SET ${v} TO \\$'''PREENCHA'''`));
    assert.equal(code.match(/Web\.InvokeWebService\.InvokeWebService/g)?.length, 2);
    assert.match(code, /IF Status1 >= 400 THEN/);
    assert.match(code, /SET TOKEN TO Json1\['access_token'\]/);
    assert.match(code, /Url: \$'''%BASE_URL%\/v1\/processos\/%PROCESSO%/);
  });

  test('powerAutomateAsked tells Desktop from Cloud', () => {
    assert.equal(powerAutomateAsked('como faço isso no Power Automate?'), 'pad');
    assert.equal(powerAutomateAsked('quero um fluxo de nuvem'), 'pa-cloud');
    assert.equal(powerAutomateAsked('power automate cloud'), 'pa-cloud');
    assert.equal(powerAutomateAsked('me mostra em Python'), null);
  });
});
