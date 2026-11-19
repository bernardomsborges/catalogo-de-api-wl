import { Api, Endpoint, endpointSchemes, HttpMethod } from './models';

/**
 * Recipes: a real task done with several routes in order ("abrir um processo e anexar um PDF").
 * Steps pass data along with variables: a step saves values from its JSON response
 * (`access_token` → TOKEN) and later steps use them as {{TOKEN}}. Variables nobody saves are
 * inputs the person provides (API key, user, password…).
 */

export interface RecipeParam {
  in: 'path' | 'query' | 'header';
  name: string;
  /** Text with {{VARIABLES}}. */
  value: string;
}

export interface RecipeOutput {
  /** Variable name, e.g. TOKEN. */
  name: string;
  /** Where in the JSON response, e.g. "access_token", "unidades[0].id". */
  path: string;
}

export interface RecipeStep {
  id?: string;
  title: string;
  description: string;
  /** API of the route (id; slug kept as fallback for imported recipes). */
  apiId: string;
  apiSlug?: string;
  method: HttpMethod;
  path: string;
  params: RecipeParam[];
  /** JSON body; strings may hold {{VARIABLES}}. */
  body: string;
  outputs: RecipeOutput[];
}

export interface Recipe {
  id: string;
  slug: string;
  title: string;
  /** One-line goal shown in the list. */
  goal: string;
  /** Markdown introduction. */
  intro: string;
  tags: string[];
  /** Description of each input variable, e.g. { USUARIO: 'Seu usuário do SEI' }. */
  inputs: Record<string, string>;
  steps: RecipeStep[];
  createdAt: string;
  updatedAt: string;
}

export type RecipeInput = Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;

export function emptyRecipe(): RecipeInput {
  return { slug: '', title: '', goal: '', intro: '', tags: [], inputs: {}, steps: [] };
}

export const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function varsIn(text: string): string[] {
  return [...String(text ?? '').matchAll(VAR)].map((m) => m[1]);
}

// ----- analysis -----

export interface StepInfo {
  api?: Api;
  endpoint?: Endpoint;
  /** The route no longer exists in the catalog. */
  missing: boolean;
  /** Variables used here and the step (1-based) that saves them; 0 = provided by the person. */
  uses: { name: string; from: number }[];
}

export interface RecipeAnalysis {
  steps: StepInfo[];
  /** Variables the person provides (env vars), in order of first use. */
  inputs: string[];
  /** APIs used, in order. */
  apis: Api[];
  missingCount: number;
}

export function findApi(apis: Api[], step: Pick<RecipeStep, 'apiId' | 'apiSlug'>): Api | undefined {
  return apis.find((a) => a.id === step.apiId) ?? (step.apiSlug ? apis.find((a) => a.slug === step.apiSlug) : undefined);
}

export function analyze(recipe: Pick<RecipeInput, 'steps'>, apis: Api[]): RecipeAnalysis {
  const savedBy = new Map<string, number>();
  const inputs: string[] = [];
  const used: Api[] = [];
  const steps = recipe.steps.map((s, i) => {
    const api = findApi(apis, s);
    const endpoint = api?.endpoints.find((e) => e.method === s.method && e.path === s.path);
    if (api && !used.includes(api)) used.push(api);
    const names = [...new Set([...s.params.flatMap((p) => varsIn(p.value)), ...varsIn(s.body)])];
    const uses = names.map((name) => {
      const from = savedBy.get(name) ?? 0;
      if (!from && !inputs.includes(name)) inputs.push(name);
      return { name, from };
    });
    for (const o of s.outputs) if (o.name && !savedBy.has(o.name)) savedBy.set(o.name, i + 1);
    return { api, endpoint, missing: !endpoint, uses };
  });
  return { steps, inputs, apis: used, missingCount: steps.filter((s) => s.missing).length };
}

// ----- new step from a catalog route -----

/** Variable name for a credential, e.g. X-API-Key → API_KEY, bearer → TOKEN. */
function credentialVar(name: string, type: string): string {
  if (type === 'bearer' || type === 'oauth2') return 'TOKEN';
  if (type === 'basic') return 'BASIC_AUTH';
  const v = name.replace(/^x-/i, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase();
  return v || 'API_KEY';
}

/** Pre-fills a step with the route's credentials, parameters and body example. */
export function stepFromEndpoint(api: Api, ep: Endpoint): RecipeStep {
  const params: RecipeParam[] = [];
  for (const sc of endpointSchemes(api, ep).required) {
    if (sc.type === 'apiKey' && sc.in !== 'cookie') params.push({ in: sc.in, name: sc.name, value: `{{${credentialVar(sc.name, sc.type)}}}` });
    else if (sc.type === 'basic') params.push({ in: 'header', name: 'Authorization', value: 'Basic {{BASIC_AUTH}}' });
    else if (sc.type !== 'apiKey') params.push({ in: 'header', name: 'Authorization', value: 'Bearer {{TOKEN}}' });
  }
  for (const p of ep.parameters) {
    if (p.in === 'path' || p.required) params.push({ in: p.in, name: p.name, value: p.example || '' });
  }
  return {
    title: ep.summary || `${ep.method} ${ep.path}`,
    description: '',
    apiId: api.id,
    apiSlug: api.slug,
    method: ep.method,
    path: ep.path,
    params,
    body: ['GET', 'DELETE'].includes(ep.method) ? '' : ep.requestBody || '',
    outputs: [],
  };
}

/** Fields of the success response example, as output suggestions ("access_token", "processo.id_procedimento"). */
export function responseFields(ep: Endpoint | undefined, limit = 30): string[] {
  const ok = ep?.responses.find((r) => r.status >= 200 && r.status < 300 && r.body?.trim());
  if (!ok) return [];
  let data: unknown;
  try {
    data = JSON.parse(ok.body);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    if (out.length >= limit || depth > 4) return;
    if (Array.isArray(v)) return v.length ? walk(v[0], `${path}[0]`, depth + 1) : undefined;
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    if (path) out.push(path);
  };
  walk(data, '', 0);
  return out;
}

// ----- code generation -----

/** "unidades[0].id" → ['unidades', 0, 'id']. */
export function parsePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of String(path).split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) {
      out.push(part);
      continue;
    }
    if (m[1]) out.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

interface Ctx {
  apis: Api[];
  /** Base URL variable per API id. */
  baseVar: Map<string, string>;
}

export function context(recipe: Pick<RecipeInput, 'steps'>, apis: Api[]): Ctx & { analysis: RecipeAnalysis } {
  const analysis = analyze(recipe, apis);
  const baseVar = new Map<string, string>();
  const multi = analysis.apis.length > 1;
  for (const a of analysis.apis) {
    const suffix = a.slug.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toUpperCase();
    baseVar.set(a.id, multi ? `BASE_URL_${suffix}` : 'BASE_URL');
  }
  return { apis, baseVar, analysis };
}

export const stepLabel = (s: RecipeStep, i: number) => `Passo ${i + 1}: ${s.title || `${s.method} ${s.path}`} (${s.method} ${s.path})`;

/** Parses the body; {{VARS}} must sit inside JSON strings. */
export function parseBody(body: string): { value?: unknown; error?: string } {
  if (!body?.trim()) return {};
  try {
    return { value: JSON.parse(body) };
  } catch {
    return { error: 'O corpo não é um JSON válido (as {{VARIÁVEIS}} devem ficar entre aspas).' };
  }
}

// Python

const pyStr = (s: string) => JSON.stringify(s);

/** Text with {{VARS}} → Python expression. */
function pyText(text: string, raw = false): string {
  const parts = String(text).split(VAR);
  if (parts.length === 3 && parts[0] === '' && parts[2] === '') return raw ? parts[1] : `str(${parts[1]})`;
  if (parts.length === 1) return pyStr(text);
  let f = '';
  parts.forEach((p, i) => {
    if (i % 2) f += `{${p}}`;
    else f += JSON.stringify(p).slice(1, -1).replace(/\{/g, '{{').replace(/\}/g, '}}');
  });
  return `f"${f}"`;
}

function pyValue(v: unknown, indent: string): string {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return pyText(v, true);
  const inner = indent + '    ';
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + pyValue(x, inner)).join(',\n')},\n${indent}]` : '[]';
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length ? `{\n${entries.map(([k, x]) => `${inner}${pyStr(k)}: ${pyValue(x, inner)}`).join(',\n')},\n${indent}}` : '{}';
}

const pyAccess = (path: string) => parsePath(path).map((k) => (typeof k === 'number' ? `[${k}]` : `[${pyStr(k)}]`)).join('');

export function pythonCode(recipe: RecipeInput, apis: Api[]): string {
  const { baseVar, analysis } = context(recipe, apis);
  const L: string[] = [];
  L.push('"""');
  L.push(recipe.title || 'ReceAPIto');
  if (recipe.goal) L.push('', recipe.goal);
  L.push('', 'Como rodar:', '    pip install requests');
  for (const v of analysis.inputs) L.push(`    export ${v}=...${recipe.inputs[v] ? `  # ${recipe.inputs[v]}` : ''}`);
  L.push('    python receapito.py', '"""');
  L.push('import os', 'from urllib.parse import quote', '', 'import requests', '');
  for (const a of analysis.apis) L.push(`${baseVar.get(a.id)} = os.environ.get(${pyStr(baseVar.get(a.id)!)}, ${pyStr(a.baseUrl)})`);
  for (const v of analysis.inputs) L.push(`${v} = os.environ[${pyStr(v)}]`);
  L.push('');
  L.push('', 'def call(base, method, path, **kwargs):');
  L.push('    r = requests.request(method, base + path, timeout=30, **kwargs)');
  L.push('    if not r.ok:');
  L.push('        raise SystemExit(f"{method} {path} falhou: {r.status_code} {r.text}")');
  L.push('    return r.json() if r.content else None');
  L.push('');
  recipe.steps.forEach((s, i) => {
    const info = analysis.steps[i];
    L.push('');
    L.push(`# ${stepLabel(s, i)}`);
    if (info.missing) L.push('# ATENÇÃO: esta rota não existe mais no catálogo.');
    // Path with its parameters, URL-encoded.
    let pathExpr = s.path;
    const pathParams = s.params.filter((p) => p.in === 'path');
    const usesVars = pathParams.some((p) => varsIn(p.value).length);
    if (usesVars) {
      let f = JSON.stringify(s.path).slice(1, -1).replace(/\{/g, '{{').replace(/\}/g, '}}');
      for (const p of pathParams) {
        const value = varsIn(p.value).length ? `{quote(${pyText(p.value)}, safe='')}` : encodeURIComponent(p.value).replace(/\{/g, '{{').replace(/\}/g, '}}');
        f = f.replace(`{{${p.name}}}`, value);
      }
      pathExpr = `f"${f}"`;
    } else {
      for (const p of pathParams) pathExpr = pathExpr.replace(`{${p.name}}`, encodeURIComponent(p.value));
      pathExpr = pyStr(pathExpr);
    }
    const args: string[] = [baseVar.get(info.api?.id ?? '') ?? 'BASE_URL', pyStr(s.method), pathExpr];
    const headers = s.params.filter((p) => p.in === 'header');
    if (headers.length) args.push(`headers={${headers.map((h) => `${pyStr(h.name)}: ${pyText(h.value)}`).join(', ')}}`);
    const query = s.params.filter((p) => p.in === 'query');
    if (query.length) args.push(`params={${query.map((q) => `${pyStr(q.name)}: ${pyText(q.value)}`).join(', ')}}`);
    const body = parseBody(s.body);
    if (body.error) L.push(`# ${body.error}`);
    if (body.value !== undefined) args.push(`json=${pyValue(body.value, '')}`);
    const target = s.outputs.length ? 'resp = ' : '';
    L.push(`${target}call(${args.join(', ')})`);
    for (const o of s.outputs) if (o.name && o.path) L.push(`${o.name} = resp${pyAccess(o.path)}`);
    L.push(`print(${pyStr(`OK: ${stepLabel(s, i)}`)})`);
  });
  return L.join('\n') + '\n';
}

// cURL (bash)

/** Text inside double quotes in bash: escapes and turns {{VAR}} into ${VAR}. */
function shText(text: string): string {
  return String(text)
    .split(VAR)
    .map((p, i) => (i % 2 ? `\${${p}}` : p.replace(/(["\\$`])/g, '\\$1')))
    .join('');
}

/**
 * JSON body as a jq expression, so values with quotes or other special characters stay valid:
 * "{{SENHA}}" → $SENHA, "Olá {{NOME}}" → "Olá \($NOME)".
 */
function jqExpr(v: unknown, indent = ''): string {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') {
    const parts = v.split(VAR);
    if (parts.length === 3 && !parts[0] && !parts[2]) return `$${parts[1]}`;
    return '"' + parts.map((p, i) => (i % 2 ? `\\($${p})` : JSON.stringify(p).slice(1, -1))).join('') + '"';
  }
  const inner = indent + '  ';
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + jqExpr(x, inner)).join(',\n')}\n${indent}]` : '[]';
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length ? `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${jqExpr(x, inner)}`).join(',\n')}\n${indent}}` : '{}';
}

const jqPath = (path: string) =>
  parsePath(path)
    .map((k) => (typeof k === 'number' ? `[${k}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`))
    .join('')
    .replace(/^\[/, '.[');

export function curlCode(recipe: RecipeInput, apis: Api[]): string {
  const { baseVar, analysis } = context(recipe, apis);
  const L: string[] = [];
  L.push('#!/usr/bin/env bash');
  L.push(`# ${recipe.title || 'ReceAPIto'}`);
  if (recipe.goal) L.push(`# ${recipe.goal}`);
  L.push('#', '# Requer curl e jq. Como rodar:');
  L.push(`#   ${[...analysis.inputs.map((v) => `${v}=...`), 'bash receapito.sh'].join(' ')}`);
  for (const v of analysis.inputs) if (recipe.inputs[v]) L.push(`#   ${v}: ${recipe.inputs[v]}`);
  L.push('set -euo pipefail', '');
  for (const a of analysis.apis) L.push(`${baseVar.get(a.id)}="\${${baseVar.get(a.id)}:-${a.baseUrl}}"`);
  for (const v of analysis.inputs) L.push(`: "\${${v}:?Defina ${v}}"`);
  L.push('');
  L.push('# Faz a chamada e para com a mensagem da API se der erro.');
  L.push('call() {');
  L.push('  local out status');
  L.push('  out=$(curl -sS -w \'\\n%{http_code}\' "$@")');
  L.push('  status=${out##*$\'\\n\'}');
  L.push('  out=${out%$\'\\n\'*}');
  L.push('  if [ "$status" -ge 400 ]; then echo "Falhou ($status): $out" >&2; exit 1; fi');
  L.push("  printf '%s' \"$out\"");
  L.push('}');
  L.push("enc() { jq -rn --arg v \"$1\" '$v|@uri'; }");
  recipe.steps.forEach((s, i) => {
    const info = analysis.steps[i];
    L.push('');
    L.push(`# ${stepLabel(s, i)}`);
    if (info.missing) L.push('# ATENÇÃO: esta rota não existe mais no catálogo.');
    let path = shText(s.path);
    for (const p of s.params.filter((x) => x.in === 'path')) {
      const value = varsIn(p.value).length ? `$(enc "${shText(p.value)}")` : encodeURIComponent(p.value);
      path = path.replace(`{${p.name}}`, value);
    }
    const query = s.params
      .filter((p) => p.in === 'query')
      .map((q) => `${encodeURIComponent(q.name)}=${varsIn(q.value).length ? `$(enc "${shText(q.value)}")` : encodeURIComponent(q.value)}`);
    const url = `\${${baseVar.get(info.api?.id ?? '') ?? 'BASE_URL'}}${path}${query.length ? `?${query.join('&')}` : ''}`;
    const args = [`-X ${s.method}`, `"${url}"`];
    for (const h of s.params.filter((p) => p.in === 'header')) args.push(`-H "${shText(h.name)}: ${shText(h.value)}"`);
    const body = parseBody(s.body);
    if (body.error) L.push(`# ${body.error}`);
    if (body.value !== undefined) {
      const vars = [...new Set(varsIn(s.body))];
      const program = jqExpr(body.value).replace(/'/g, `'\\''`);
      L.push(`BODY=$(jq -n${vars.map((v) => ` --arg ${v} "\${${v}}"`).join('')} '${program}')`);
      args.push('-H "Content-Type: application/json"', '--data-binary "$BODY"');
    }
    const cmd = `call ${args.join(' \\\n  ')}`;
    L.push(s.outputs.length ? `RESP=$(${cmd})` : `${cmd} > /dev/null`);
    for (const o of s.outputs) if (o.name && o.path) L.push(`${o.name}=$(printf '%s' "$RESP" | jq -r '${jqPath(o.path)}')`);
    L.push(`echo "✓ ${shText(stepLabel(s, i))}"`);
  });
  return L.join('\n') + '\n';
}

// Go

/** Names the generated program already uses: a variable with one of them gets a trailing underscore. */
const GO_TAKEN = new Set([
  ...'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'.split(' '),
  ...'bytes json fmt io http url os time main call get env envOr fail resp any string int nil true false len'.split(' '),
]);
const goName = (v: string) => (GO_TAKEN.has(v) ? `${v}_` : v);
const goStr = (s: string) => JSON.stringify(s);

/** Text with {{VARS}} → Go string expression. */
function goText(text: string): string {
  const parts = String(text)
    .split(VAR)
    .map((p, i) => (i % 2 ? goName(p) : p ? goStr(p) : ''))
    .filter(Boolean);
  return parts.length ? parts.join(' + ') : '""';
}

function goValue(v: unknown, indent: string): string {
  if (v === null) return 'nil';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return goText(v);
  const inner = indent + '\t';
  if (Array.isArray(v)) return v.length ? `[]any{\n${v.map((x) => `${inner}${goValue(x, inner)},`).join('\n')}\n${indent}}` : '[]any{}';
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length ? `map[string]any{\n${entries.map(([k, x]) => `${inner}${goStr(k)}: ${goValue(x, inner)},`).join('\n')}\n${indent}}` : 'map[string]any{}';
}

const GO_HELPERS = `
func env(name string) string {
	v := os.Getenv(name)
	if v == "" {
		fail("Defina a variável de ambiente " + name)
	}
	return v
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}

// Faz a chamada e para com a mensagem da API se der erro.
func call(base, method, path string, headers map[string]string, query url.Values, body any) any {
	target := base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			fail(err.Error())
		}
		payload = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, target, payload)
	if err != nil {
		fail(err.Error())
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		fail(err.Error())
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		fail(err.Error())
	}
	if res.StatusCode >= 400 {
		fail(fmt.Sprintf("%s %s falhou: %d %s", method, path, res.StatusCode, data))
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	var out any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		fail(fmt.Sprintf("%s %s não devolveu JSON: %s", method, path, data))
	}
	return out
}

// Lê um campo da resposta: get(resp, "unidades", 0, "id").
func get(v any, keys ...any) string {
	for _, k := range keys {
		switch key := k.(type) {
		case string:
			m, _ := v.(map[string]any)
			v = m[key]
		case int:
			a, _ := v.([]any)
			if key >= len(a) {
				v = nil
			} else {
				v = a[key]
			}
		}
	}
	if v == nil {
		fail(fmt.Sprint("A resposta não trouxe o campo esperado: ", keys))
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}
`;

export function goCode(recipe: RecipeInput, apis: Api[]): string {
  const { baseVar, analysis } = context(recipe, apis);
  const L: string[] = [];
  L.push(`// ${recipe.title || 'ReceAPIto'}`);
  if (recipe.goal) L.push(`// ${recipe.goal}`);
  L.push('//', '// Só usa a biblioteca padrão. Como rodar:');
  for (const v of analysis.inputs) L.push(`//   export ${v}=...${recipe.inputs[v] ? `  # ${recipe.inputs[v]}` : ''}`);
  L.push('//   go run receapito.go');
  L.push('package main', '');
  L.push('import (', ...['bytes', 'encoding/json', 'fmt', 'io', 'net/http', 'net/url', 'os', 'time'].map((p) => `\t"${p}"`), ')', '');

  const bases = analysis.apis.map((a) => baseVar.get(a.id)!);
  const saved = recipe.steps.flatMap((s) => s.outputs.filter((o) => o.name && o.path).map((o) => o.name));
  const names = [...new Set([...bases, ...analysis.inputs, ...saved])].map(goName);
  if (names.length) L.push(`var ${names.join(', ')} string`);
  if (saved.length) L.push('var resp any');
  if (names.length) L.push('');
  L.push('func main() {');
  for (const a of analysis.apis) L.push(`\t${goName(baseVar.get(a.id)!)} = envOr(${goStr(baseVar.get(a.id)!)}, ${goStr(a.baseUrl)})`);
  for (const v of analysis.inputs) L.push(`\t${goName(v)} = env(${goStr(v)})`);

  recipe.steps.forEach((s, i) => {
    const info = analysis.steps[i];
    L.push('', `\t// ${stepLabel(s, i)}`);
    if (info.missing) L.push('\t// ATENÇÃO: esta rota não existe mais no catálogo.');
    // Path with its parameters, URL-encoded.
    const values = new Map(s.params.filter((p) => p.in === 'path').map((p) => [p.name, p.value]));
    const pathExpr =
      s.path
        .split(/(\{[^{}]+\})/)
        .map((part) => {
          const name = /^\{(.+)\}$/.exec(part)?.[1];
          if (name === undefined || !values.has(name)) return part ? goStr(part) : '';
          const value = values.get(name)!;
          return varsIn(value).length ? `url.PathEscape(${goText(value)})` : goStr(encodeURIComponent(value));
        })
        .filter(Boolean)
        .join(' + ')
        .replaceAll('" + "', '') || '""';
    const headers = s.params.filter((p) => p.in === 'header');
    const query = s.params.filter((p) => p.in === 'query');
    const body = parseBody(s.body);
    if (body.error) L.push(`\t// ${body.error}`);
    const args = [
      info.api ? goName(baseVar.get(info.api.id)!) : goStr('https://URL_DA_API'),
      goStr(s.method),
      pathExpr,
      headers.length ? `map[string]string{${headers.map((h) => `${goStr(h.name)}: ${goText(h.value)}`).join(', ')}}` : 'nil',
      query.length ? `url.Values{${query.map((q) => `${goStr(q.name)}: {${goText(q.value)}}`).join(', ')}}` : 'nil',
      body.value !== undefined ? goValue(body.value, '\t') : 'nil',
    ];
    const outputs = s.outputs.filter((o) => o.name && o.path);
    L.push(`\t${outputs.length ? 'resp = ' : ''}call(${args.join(', ')})`);
    for (const o of outputs) L.push(`\t${goName(o.name)} = get(resp, ${parsePath(o.path).map((k) => (typeof k === 'number' ? String(k) : goStr(k))).join(', ')})`);
    L.push(`\tfmt.Println(${goStr(`OK: ${stepLabel(s, i)}`)})`);
  });
  L.push('}');
  return L.join('\n') + '\n' + GO_HELPERS;
}
