/**
 * Postman Collection v2.1 (imported by Postman and Insomnia) and one environment per registered
 * environment (PRO-161). Credentials become empty variables: no real value ever goes in the files.
 */
import { Api, AuthScheme, apiSchemes, Endpoint, endpointSchemes, sessionFlow } from './models';
import { hasBody } from './snippets';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

type Obj = Record<string, unknown>;

export interface PostmanVariable {
  key: string;
  value: string;
  description: string;
  secret: boolean;
}

export interface PostmanFile {
  fileName: string;
  label: string;
  json: Obj;
}

/**
 * Variable names safe in Postman and Insomnia (Insomnia templates break on "-": `{{X-API-Key}}`
 * would be read as a subtraction), e.g. "X-API-Key" → "X_API_Key".
 */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'credencial';
}

/** Variable(s) for each credential: apiKey → its name; bearer/oauth2 → token; basic → usuario + senha. */
export function credentialVariables(api: Api): Map<string, PostmanVariable[]> {
  const out = new Map<string, PostmanVariable[]>();
  const used = new Set<string>(['baseUrl']);
  const unique = (base: string, key: string) => {
    let name = base;
    if (used.has(name)) name = `${base}_${safeName(key)}`;
    used.add(name);
    return name;
  };
  for (const s of apiSchemes(api)) {
    const how = s.description ? ` ${s.description}` : '';
    if (s.type === 'apiKey') {
      out.set(s.key, [{ key: unique(safeName(s.name || 'X-API-Key'), s.key), value: '', secret: true, description: `Valor de ${s.name || 'X-API-Key'} (${s.in === 'query' ? 'query string' : s.in === 'cookie' ? 'cookie' : 'cabeçalho'}).${how}` }]);
    } else if (s.type === 'basic') {
      out.set(s.key, [
        { key: unique('usuario', s.key), value: '', secret: false, description: `Usuário do Basic Auth.${how}` },
        { key: unique('senha', s.key), value: '', secret: true, description: 'Senha do Basic Auth.' },
      ]);
    } else {
      const origin =
        s.type === 'oauth2'
          ? ` Obtenha com OAuth 2.0 client credentials em ${s.tokenUrl || 'a URL de token da API'}${s.scopes ? ` (escopos: ${s.scopes})` : ''}.`
          : sessionFlow(api, s)
            ? ` Preenchido sozinho ao chamar ${sessionFlow(api, s)!.login.method} ${sessionFlow(api, s)!.login.path}.`
            : '';
      out.set(s.key, [{ key: unique('token', s.key), value: '', secret: true, description: `Token Bearer${s.bearerFormat ? ` (${s.bearerFormat})` : ''}.${origin}${how}` }]);
    }
  }
  return out;
}

/** Folder of an endpoint: its OpenAPI tag, or the first meaningful path segment ("/v1/processos/x" → "processos"). */
export function endpointGroup(ep: Endpoint): string {
  if (ep.tag?.trim()) return ep.tag.trim();
  const seg = ep.path.split('/').find((p) => p && !/^v\d+$/i.test(p) && p !== 'api' && !p.startsWith('{'));
  return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : 'Geral';
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function describe(ep: Endpoint): string {
  const lines = [ep.description?.trim()].filter(Boolean) as string[];
  const documented = ep.parameters.filter((p) => p.description);
  if (documented.length) {
    lines.push('', '**Parâmetros**', ...documented.map((p) => `- \`${p.name}\` (${p.in}${p.required ? ', obrigatório' : ''}): ${p.description}`));
  }
  return lines.join('\n');
}

/** Request (headers, auth, URL with :path variables and query) using the collection variables. */
function request(api: Api, ep: Endpoint, vars: Map<string, PostmanVariable[]>): Obj {
  const header: Obj[] = [];
  const query: Obj[] = [];
  const cookies: string[] = [];
  let auth: Obj | undefined;
  const { required, alternatives } = endpointSchemes(api, ep);

  const addScheme = (s: AuthScheme, disabled: boolean) => {
    const v = vars.get(s.key) ?? [];
    const note = disabled ? 'Alternativa: ative esta credencial no lugar da outra.' : undefined;
    if (s.type === 'apiKey') {
      const ref = `{{${v[0].key}}}`;
      const name = s.name || 'X-API-Key';
      if (s.in === 'query') query.push({ key: name, value: ref, disabled, description: note });
      else if (s.in === 'cookie') cookies.push(`${name}=${ref}`);
      else header.push({ key: name, value: ref, type: 'text', disabled, description: note });
    } else if (s.type === 'basic') {
      if (!disabled) auth = { type: 'basic', basic: [{ key: 'username', value: `{{${v[0].key}}}`, type: 'string' }, { key: 'password', value: `{{${v[1].key}}}`, type: 'string' }] };
    } else {
      header.push({ key: 'Authorization', value: `Bearer {{${v[0].key}}}`, type: 'text', disabled, description: note });
    }
  };
  required.forEach((s) => addScheme(s, false));
  alternatives.forEach((s) => addScheme(s, true));
  if (cookies.length) header.push({ key: 'Cookie', value: cookies.join('; '), type: 'text' });
  if (hasBody(ep)) header.push({ key: 'Content-Type', value: 'application/json', type: 'text' });
  for (const p of ep.parameters.filter((x) => x.in === 'header')) {
    header.push({ key: p.name, value: p.example || '', type: 'text', disabled: !p.required && !p.example, description: p.description || undefined });
  }
  for (const p of ep.parameters.filter((x) => x.in === 'query')) {
    query.push({ key: p.name, value: p.example || '', disabled: !p.required && !p.example, description: p.description || undefined });
  }

  const path = ep.path.replace(/\{([^}]+)\}/g, ':$1');
  const segments = path.split('/').filter(Boolean);
  const variable = ep.parameters
    .filter((p) => p.in === 'path')
    .map((p) => ({ key: p.name, value: p.example || '', description: p.description || undefined }));
  const qs = query.filter((q) => !q['disabled']).map((q) => `${q['key']}=${q['value']}`);

  return {
    method: ep.method,
    header,
    ...(auth ? { auth } : required.length ? {} : { auth: { type: 'noauth' } }),
    url: {
      raw: `{{baseUrl}}${path}${qs.length ? '?' + qs.join('&') : ''}`,
      host: ['{{baseUrl}}'],
      path: segments,
      ...(query.length ? { query } : {}),
      ...(variable.length ? { variable } : {}),
    },
    ...(hasBody(ep) ? { body: { mode: 'raw', raw: pretty(ep.requestBody), options: { raw: { language: 'json' } } } } : {}),
    ...(describe(ep) ? { description: describe(ep) } : {}),
  };
}

/** Script on the session route: saves `access_token` in the token variable (environment when one is active). */
function tokenScript(tokenVar: string): Obj {
  return {
    listen: 'test',
    script: {
      type: 'text/javascript',
      exec: [
        '// Guarda o token devolvido pela API na variável usada pelas outras rotas.',
        'const token = pm.response.json().access_token;',
        'if (token) {',
        '  const scope = pm.environment && pm.environment.name ? pm.environment : pm.collectionVariables;',
        `  scope.set('${tokenVar}', token);`,
        '}',
      ],
    },
  };
}

export function postmanCollection(api: Api): Obj {
  const vars = credentialVariables(api);
  const allVars = [...vars.values()].flat();
  // Session routes that issue a token: the token variable is filled after calling them.
  const sessions = new Map<Endpoint, string>();
  for (const s of apiSchemes(api)) {
    const flow = sessionFlow(api, s);
    const v = vars.get(s.key)?.[0];
    if (flow && v) sessions.set(flow.login, v.key);
  }

  const items = api.endpoints.map((ep) => {
    const req = request(api, ep, vars);
    const examples = ep.responses
      .filter((r) => r.body?.trim())
      .map((r) => ({
        name: `${r.status} ${r.description || ''}`.trim(),
        originalRequest: { method: req['method'], header: req['header'], url: req['url'], ...(req['body'] ? { body: req['body'] } : {}) },
        code: Number(r.status),
        status: r.description || String(r.status),
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: pretty(r.body),
      }));
    const token = sessions.get(ep);
    return {
      group: endpointGroup(ep),
      item: {
        name: ep.summary?.trim() || `${ep.method} ${ep.path}`,
        request: req,
        response: examples,
        ...(token ? { event: [tokenScript(token)] } : {}),
      },
    };
  });

  // Folders by group, in the order they first appear; a single group stays flat.
  const groups = [...new Set(items.map((i) => i.group))];
  const item =
    groups.length > 1 ? groups.map((g) => ({ name: g, item: items.filter((i) => i.group === g).map((i) => i.item) })) : items.map((i) => i.item);

  const envNote = api.environments.length > 1 ? ` Ambientes: ${api.environments.map((e) => e.name).join(', ')} (importe também os arquivos de ambiente).` : '';
  return JSON.parse(
    JSON.stringify({
      info: {
        name: api.name,
        description: [api.summary, api.description, api.auth.instructions ? `**Credenciais**\n\n${api.auth.instructions}` : '', `Versão ${api.version}.${envNote}`]
          .filter((x) => x?.trim())
          .join('\n\n'),
        schema: SCHEMA,
      },
      item,
      variable: [
        { key: 'baseUrl', value: api.environments[0]?.url || api.baseUrl, type: 'string', description: 'URL base da API.' },
        ...allVars.map((v) => ({ key: v.key, value: '', type: 'string', description: v.description })),
      ],
    })
  );
}

/** Postman environment: base URL of the environment + empty credential variables. */
export function postmanEnvironment(api: Api, env: { name: string; url: string }): Obj {
  const vars = [...credentialVariables(api).values()].flat();
  return {
    name: `${api.name} · ${env.name}`,
    values: [
      { key: 'baseUrl', value: env.url, type: 'default', enabled: true },
      ...vars.map((v) => ({ key: v.key, value: '', type: v.secret ? 'secret' : 'default', enabled: true })),
    ],
    _postman_variable_scope: 'environment',
  };
}

/** Files offered on the API page: the collection plus one environment per registered environment. */
export function postmanFiles(api: Api): PostmanFile[] {
  const envs = api.environments.length ? api.environments : [{ name: 'Padrão', url: api.baseUrl }];
  const slug = (t: string) =>
    t
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return [
    { fileName: `${api.slug}.postman_collection.json`, label: 'Coleção', json: postmanCollection(api) },
    ...envs.map((e) => ({ fileName: `${api.slug}-${slug(e.name) || 'ambiente'}.postman_environment.json`, label: `Ambiente: ${e.name}`, json: postmanEnvironment(api, e) })),
  ];
}
