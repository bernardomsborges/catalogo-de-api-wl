import { Api } from './models';
import { httpAction } from './power-automate-http';
import { context, parseBody, parsePath, RecipeInput, RecipeStep, stepLabel, VAR, varsIn } from './recipes';

/**
 * A ReceAPIto as something to paste in Power Automate:
 * - Desktop: the text of the actions, pasted straight into the flow designer.
 * - Cloud: a Scope with one HTTP action per step, in the designer's clipboard format, plus the
 *   expressions that read each saved value.
 */

// ----- Desktop -----

/** Text inside $'''…''': escapes and turns {{VAR}} into %VAR%. */
function padText(text: string): string {
  return String(text)
    .split(VAR)
    .map((p, i) => (i % 2 ? `%${p}%` : p.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/%/g, '%%')))
    .join('');
}
/** Same, for a piece of the URL: the fixed text is URL-encoded, the variables go as they are. */
function padUrlText(text: string): string {
  return String(text)
    .split(VAR)
    .map((p, i) => (i % 2 ? `%${p}%` : padText(encodeURIComponent(p))))
    .join('');
}
const padLit = (text: string) => `$'''${padText(text)}'''`;
const padOneLine = (text: string) => String(text).replace(/\s*\r?\n\s*/g, ' ');
const PAD_METHODS: Record<string, string> = { GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete', HEAD: 'Head', OPTIONS: 'Options' };
const padAccess = (path: string) => parsePath(path).map((k) => (typeof k === 'number' ? `[${k}]` : `['${k.replace(/'/g, "\\'")}']`)).join('');

export function padCode(recipe: RecipeInput, apis: Api[]): string {
  const { baseVar, analysis } = context(recipe, apis);
  const L: string[] = [];
  L.push(`# ${padOneLine(recipe.title || 'ReceAPIto')}`);
  if (recipe.goal) L.push(`# ${padOneLine(recipe.goal)}`);
  L.push('# Cole no designer do Power Automate Desktop (Ctrl+V na área do fluxo) e preencha os valores abaixo.');
  for (const a of analysis.apis) L.push(`SET ${baseVar.get(a.id)} TO ${padLit(a.baseUrl)}`);
  for (const v of analysis.inputs) {
    if (recipe.inputs[v]) L.push(`# ${v}: ${padOneLine(recipe.inputs[v])}`);
    L.push(`SET ${v} TO ${padLit('PREENCHA')}`);
  }
  recipe.steps.forEach((s, i) => {
    const info = analysis.steps[i];
    const n = i + 1;
    L.push(`# ${padOneLine(stepLabel(s, i))}`);
    if (info.missing) L.push('# ATENÇÃO: esta rota não existe mais no catálogo.');
    let path = padText(s.path);
    for (const p of s.params.filter((x) => x.in === 'path')) path = path.replace(`{${p.name}}`, padUrlText(p.value));
    const query = s.params.filter((p) => p.in === 'query').map((q) => `${padUrlText(q.name)}=${padUrlText(q.value)}`);
    const base = info.api ? `%${baseVar.get(info.api.id)}%` : 'https://URL_DA_API';
    const url = `${base}${path}${query.length ? `?${query.join('&')}` : ''}`;
    const headers = s.params.filter((p) => p.in === 'header').map((h) => `${padText(h.name)}: ${padText(h.value)}`);
    const body = parseBody(s.body);
    if (body.error) L.push(`# ${body.error}`);
    const bodyText = body.value !== undefined ? JSON.stringify(body.value) : padOneLine(s.body || '');
    const parts = [
      'Web.InvokeWebService.InvokeWebService',
      `Url: $'''${url}'''`,
      `Method: Web.Method.${PAD_METHODS[s.method] ?? 'Get'}`,
      `Accept: $'''application/json'''`,
      `ContentType: $'''application/json'''`,
      ...(headers.length ? [`CustomHeaders: $'''${headers.join('\n')}'''`] : []),
      ...(bodyText ? [`RequestBody: ${padLit(bodyText)}`] : []),
      'ConnectionTimeout: 30',
      'FollowRedirection: True',
      'ClearCookies: False',
      'FailOnErrorStatus: False',
      'EncodeRequestBody: False',
      `UserAgent: $'''Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US; rv:1.8.1.21) Gecko/20100312 Firefox/3.6'''`,
      'Encoding: Web.Encoding.AutoDetect',
      'AcceptUntrustedCertificates: False',
      `ResponseHeaders=> Cabecalhos${n}`,
      `Response=> Resposta${n}`,
      `StatusCode=> Status${n}`,
    ];
    L.push(parts.join(' '));
    L.push(`IF Status${n} >= 400 THEN`);
    L.push(`    EXIT Code: 0 ErrorMessage: $'''Passo ${n} falhou (%Status${n}%): %Resposta${n}%'''`);
    L.push('END');
    const outputs = s.outputs.filter((o) => o.name && o.path);
    if (outputs.length) {
      L.push(`Variables.ConvertJsonToCustomObject Json: Resposta${n} CustomObject=> Json${n}`);
      for (const o of outputs) L.push(`SET ${o.name} TO Json${n}${padAccess(o.path)}`);
    }
  });
  return L.join('\n') + '\n';
}

// ----- Cloud -----

export interface CloudExpression {
  /** What it reads, e.g. "TOKEN" or "Status do passo 1". */
  label: string;
  /** Without the leading @, as typed in the expression editor. */
  expr: string;
}

export interface CloudAction {
  /** "Passo 1: Login" */
  label: string;
  /** Name the action gets in the flow when the actions are pasted in order: HTTP, HTTP_1, HTTP_2... */
  name: string;
  /** Clipboard text for the designer's "Colar uma ação". */
  json: string;
}

export interface CloudCode {
  /** One HTTP action per step, to paste in order. */
  actions: CloudAction[];
  expressions: CloudExpression[];
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const cloudAccess = (path: string) => parsePath(path).map((k) => (typeof k === 'number' ? `?[${k}]` : `?[${quote(k)}]`)).join('');
/** Literal text of a field: a leading @ and "@{" would be read as expressions. */
function cloudLiteral(text: string, first: boolean): string {
  const t = text.replace(/@\{/g, '@@{');
  return first && t.startsWith('@') && !t.startsWith('@@') ? `@${t}` : t;
}

/** 'pad' or 'pa-cloud' when the text asks for help building in Power Automate. */
export function powerAutomateAsked(text: string): 'pad' | 'pa-cloud' | null {
  const t = text.toLowerCase();
  if (!/power\s*automate|\bpad\b|fluxo de nuvem|cloud flow|desktop flow|fluxo d[aeo] [aá]rea de trabalho/.test(t)) return null;
  return /cloud|nuvem/.test(t) ? 'pa-cloud' : 'pad';
}

export function cloudCode(recipe: RecipeInput, apis: Api[]): CloudCode {
  const { analysis } = context(recipe, apis);
  /** Expression (no @) that gives each variable saved by an earlier step. */
  const source = new Map<string, string>();
  const actions: CloudAction[] = [];
  const expressions: CloudExpression[] = [];

  /** {{VARS}} → the earlier step's expression, or PREENCHA_NOME for what the person fills in. */
  const text = (value: string, wrap = (e: string) => e) =>
    String(value)
      .split(VAR)
      .map((p, i) => (i % 2 ? (source.has(p) ? `@{${wrap(source.get(p)!)}}` : `PREENCHA_${p}`) : cloudLiteral(p, i === 0)))
      .join('');
  const encoded = (value: string) => text(value, (e) => `encodeUriComponent(${e})`);
  /** JSON body: a string that is only a variable keeps the variable's type. */
  const bodyValue = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const parts = v.split(VAR);
      return parts.length === 3 && !parts[0] && !parts[2] && source.has(parts[1]) ? `@${source.get(parts[1])}` : text(v);
    }
    if (Array.isArray(v)) return v.map(bodyValue);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bodyValue(x)]));
    return v;
  };

  recipe.steps.forEach((s: RecipeStep, i) => {
    const info = analysis.steps[i];
    // The pasted action is always called "HTTP"; the designer numbers the repeated ones.
    const name = i ? `HTTP_${i}` : 'HTTP';
    let path = cloudLiteral(s.path, false);
    for (const p of s.params.filter((x) => x.in === 'path')) path = path.replace(`{${p.name}}`, varsIn(p.value).length ? encoded(p.value) : encodeURIComponent(p.value));
    const body = parseBody(s.body);
    const headers: [string, string][] = [
      ...(body.value !== undefined ? ([['Content-Type', 'application/json']] as [string, string][]) : []),
      ...s.params.filter((p) => p.in === 'header').map((h): [string, string] => [h.name, text(h.value)]),
    ];
    actions.push({
      label: `Passo ${i + 1}${s.title ? `: ${s.title}` : ''}`,
      name,
      json: httpAction({
        uri: `${info.api?.baseUrl ?? 'https://URL_DA_API'}${path}`,
        method: s.method,
        headers,
        queries: s.params.filter((p) => p.in === 'query').map((q): [string, string] => [q.name, text(q.value)]),
        body: body.value !== undefined ? JSON.stringify(bodyValue(body.value), null, 2) : s.body?.trim() ? text(s.body) : '',
      }),
    });
    for (const o of s.outputs) {
      if (!o.name || !o.path) continue;
      const e = `body(${quote(name)})${cloudAccess(o.path)}`;
      source.set(o.name, e);
      expressions.push({ label: o.name, expr: e });
    }
    expressions.push({ label: `Status do passo ${i + 1}`, expr: `outputs(${quote(name)})?['statusCode']` });
  });

  return { actions, expressions };
}
