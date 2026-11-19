// Postman / Insomnia collection and environments: folders, credentials as variables, session token.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialVariables, endpointGroup, postmanCollection, postmanEnvironment, postmanFiles } from '../src/app/core/postman';
import { catalogApi } from './fixtures';

type Obj = Record<string, any>;

const api = catalogApi();
const collection = postmanCollection(api) as Obj;
const requests: Obj[] = collection['item'].flatMap((i: Obj) => (i['item'] ? i['item'] : [i]));
const byName = (name: string) => requests.find((r) => r['name'] === name)!;

describe('postmanCollection', () => {
  test('uses the v2.1 schema', () => {
    assert.equal(collection['info'].schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    assert.equal(collection['info'].name, 'API de Processos');
  });

  test('one folder per tag; routes without a tag go to a folder named after the path', () => {
    assert.deepEqual(
      collection['item'].map((f: Obj) => [f['name'], f['item'].map((r: Obj) => r['name'])]),
      [
        ['Sessões', ['Entrar', 'Sair']],
        ['Status', ['Status']], // "/v1/status": the version segment is skipped
        ['Processos', ['Consultar processo']],
      ]
    );
  });

  test('credentials are empty variables: no real value goes in the file', () => {
    assert.deepEqual(
      collection['variable'].map((v: Obj) => [v['key'], v['value']]),
      [
        ['baseUrl', 'https://api.exemplo.gov.br'],
        ['X_Client_Id', ''],
        ['token', ''],
      ]
    );
  });

  test('each route sends the credentials it needs', () => {
    const headers = (name: string) => byName(name)['request'].header.filter((h: Obj) => !h['disabled']).map((h: Obj) => `${h['key']}: ${h['value']}`);
    assert.deepEqual(headers('Consultar processo'), ['X-Client-Id: {{X_Client_Id}}', 'Authorization: Bearer {{token}}']);
    assert.deepEqual(headers('Entrar'), ['X-Client-Id: {{X_Client_Id}}', 'Content-Type: application/json']);
    assert.deepEqual(headers('Status'), []);
    assert.deepEqual(byName('Status')['request'].auth, { type: 'noauth' });
  });

  test('path parameters become :variables with the example', () => {
    const url = byName('Consultar processo')['request'].url;
    assert.equal(url.raw, '{{baseUrl}}/v1/processos/:id');
    assert.deepEqual(url.variable, [{ key: 'id', value: '42' }]);
    assert.deepEqual(url.query, [{ key: 'campos', value: '', disabled: true }]);
  });

  test('the login route saves the token for the other routes', () => {
    const script = byName('Entrar')['event'][0].script.exec.join('\n');
    assert.match(script, /pm\.response\.json\(\)\.access_token/);
    assert.match(script, /scope\.set\('token', token\)/);
    assert.equal(byName('Consultar processo')['event'], undefined);
  });

  test('response examples go along', () => {
    const [example] = byName('Consultar processo')['response'];
    assert.equal(example.code, 200);
    assert.deepEqual(JSON.parse(example.body), { id: 42, numero: '0001.2026', assunto: 'string' });
  });
});

describe('variables, environments and files', () => {
  test('endpointGroup: the tag, else the first meaningful path segment', () => {
    const ep = (path: string, tag?: string) => ({ ...api.endpoints[0], path, tag });
    assert.equal(endpointGroup(ep('/v1/x', 'Sessões')), 'Sessões');
    assert.equal(endpointGroup(ep('/api/v2/processos/{id}')), 'Processos');
    assert.equal(endpointGroup(ep('/{id}')), 'Geral');
  });

  test('names that Insomnia accepts, unique even when two credentials collide', () => {
    const two = catalogApi();
    two.auth.schemes = [
      { ...two.auth.schemes![0], key: 'A', name: 'X-Client-Id' },
      { ...two.auth.schemes![0], key: 'B', name: 'X Client Id' },
      { ...two.auth.schemes![1], key: 'Basic', type: 'basic' },
    ];
    const names = [...credentialVariables(two).values()].flat().map((v) => v.key);
    assert.deepEqual(names, ['X_Client_Id', 'X_Client_Id_B', 'usuario', 'senha']);
  });

  test('one environment per registered environment, with secret credentials', () => {
    const env = postmanEnvironment(api, api.environments[1]) as Obj;
    assert.equal(env['name'], 'API de Processos · Homologação');
    assert.deepEqual(env['values'].map((v: Obj) => [v['key'], v['value'], v['type']]), [
      ['baseUrl', 'https://hml.exemplo.gov.br', 'default'],
      ['X_Client_Id', '', 'secret'],
      ['token', '', 'secret'],
    ]);
  });

  test('file names come from the slug and the environment name', () => {
    assert.deepEqual(postmanFiles(api).map((f) => f.fileName), [
      'processos.postman_collection.json',
      'processos-producao.postman_environment.json',
      'processos-homologacao.postman_environment.json',
    ]);
  });
});
