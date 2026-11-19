import { Api, apiSchemes, AuthScheme, authSummary, defaultSchemes, endpointSchemes, extraSchemes, LOCATION_LABELS, SCHEME_LABELS, schemeWire } from './models';
import { exampleUrl, generateSnippets } from './snippets';

export interface GeneratedGuide {
  id: string;
  title: string;
  description: string;
  content: string;
  generated: boolean;
}

const HTTP_MEANINGS: Record<number, string> = {
  400: 'A requisição está malformada. Revise o corpo e os parâmetros.',
  401: 'Credencial ausente, inválida ou expirada. Gere um novo token/chave.',
  403: 'A credencial é válida, mas não tem permissão para este recurso ou escopo.',
  404: 'O recurso não existe ou o caminho está incorreto.',
  409: 'Conflito com o estado atual do recurso (ex.: registro duplicado).',
  422: 'Os dados foram entendidos, mas não passaram nas regras de validação.',
  429: 'Limite de requisições excedido. Aguarde e tente novamente com backoff.',
  500: 'Erro interno do provedor. Tente novamente; se persistir, acione o time responsável.',
  502: 'Falha de comunicação com um serviço interno. Tente novamente.',
  503: 'Serviço temporariamente indisponível. Tente novamente com backoff.',
};

function fence(lang: string, code: string): string {
  return '```' + lang + '\n' + code + '\n```';
}

function quickstart(api: Api): string {
  const ep = api.endpoints.find((e) => e.method === 'GET') ?? api.endpoints[0];
  const env = api.environments.find((e) => /sandbox|homolog|hml|teste/i.test(e.name));
  const parts: string[] = [];

  parts.push(`Este guia leva você da credencial à primeira chamada da **${api.name}** em poucos minutos.`);

  parts.push('## 1. Obtenha acesso');
  const schemes = apiSchemes(api);
  if (!schemes.length) {
    parts.push('Esta API é pública: nenhuma credencial é necessária.');
  } else {
    parts.push(`A autenticação usa **${authSummary(api)}**. Veja o guia **Autenticação** para os detalhes.`);
    if (defaultSchemes(api).length) parts.push(credentialsTable(api));
    if (api.auth.instructions) parts.push(api.auth.instructions);
    if (api.contactEmail) parts.push(`Dúvidas sobre acesso: [${api.contactEmail}](mailto:${api.contactEmail}).`);
  }

  parts.push('## 2. Escolha o ambiente');
  if (api.environments.length) {
    parts.push('| Ambiente | URL base |\n|---|---|\n' + api.environments.map((e) => `| ${e.name} | \`${e.url}\` |`).join('\n'));
    if (env) parts.push(`Recomendamos começar por **${env.name}**, que não afeta dados reais.`);
  } else {
    parts.push(`URL base: \`${api.baseUrl}\``);
  }

  const oauth = endpointSchemes(api, ep).required.find((s) => s.type === 'oauth2');
  if (oauth) {
    parts.push('## 3. Gere um token de acesso');
    parts.push(fence('bash', oauthTokenCurl(oauth)));
    parts.push('Guarde o `access_token` da resposta e reutilize-o até expirar (`expires_in`).');
  }

  const step = oauth ? 4 : 3;
  if (ep) {
    parts.push(`## ${step}. Faça sua primeira chamada`);
    parts.push(`Vamos usar **${ep.summary || ep.path}** (\`${ep.method} ${ep.path}\`):`);
    parts.push(fence('bash', generateSnippets(api, ep, env?.url ?? api.baseUrl)[0].code));
    const ok = ep.responses.find((r) => r.status >= 200 && r.status < 300);
    if (ok?.body) {
      parts.push(`Se tudo deu certo, você receberá **${ok.status}** com um corpo parecido com:`);
      parts.push(fence('json', ok.body));
    }
    parts.push(`## ${step + 1}. Próximos passos`);
    parts.push(
      [
        '- Veja todos os endpoints na aba **Referência**, com exemplos em 7 linguagens.',
        '- Teste chamadas direto do navegador no **Console de testes** de cada endpoint.',
        '- Leia o guia de **Tratamento de erros** antes de ir para produção.',
      ].join('\n')
    );
  } else {
    parts.push(`## ${step}. Endpoints`);
    parts.push('Esta API ainda não tem endpoints documentados. Fale com o time responsável.');
  }
  return parts.join('\n\n');
}

function oauthTokenCurl(s: AuthScheme): string {
  return [
    `curl -X POST "${s.tokenUrl || 'https://URL_DO_TOKEN'}"`,
    '  -H "Content-Type: application/x-www-form-urlencoded"',
    '  -d "grant_type=client_credentials"',
    '  -d "client_id=SEU_CLIENT_ID"',
    '  -d "client_secret=SEU_CLIENT_SECRET"' + (s.scopes ? ' \\\n  -d "scope=' + s.scopes + '"' : ''),
  ].join(' \\\n');
}

/** Markdown table with every credential: name, type, where it goes and an example value. */
function credentialsTable(api: Api, schemes = defaultSchemes(api)): string {
  const rows = schemes.map((s) => {
    const w = schemeWire(s);
    return `| \`${w.name}\` | ${SCHEME_LABELS[s.type]} | ${LOCATION_LABELS[w.in]} | \`${w.value}\` |`;
  });
  return '| Credencial | Tipo | Onde enviar | Exemplo |\n|---|---|---|---|\n' + rows.join('\n');
}

/** The request lines that carry the credentials, e.g. "X-Client-Id: SEU_CLIENT_ID". */
function wireExample(schemes: AuthScheme[]): string {
  const lines: string[] = [];
  const query: string[] = [];
  const cookies: string[] = [];
  for (const s of schemes) {
    const w = schemeWire(s);
    if (w.in === 'header') lines.push(`${w.name}: ${w.value}`);
    if (w.in === 'query') query.push(`${w.name}=${w.value}`);
    if (w.in === 'cookie') cookies.push(`${w.name}=${w.value}`);
  }
  if (cookies.length) lines.push(`Cookie: ${cookies.join('; ')}`);
  if (query.length) lines.unshift(`GET /recurso?${query.join('&')}`);
  return lines.join('\n');
}

function schemeSection(s: AuthScheme): string {
  const w = schemeWire(s);
  const parts = [`### \`${w.name}\` · ${SCHEME_LABELS[s.type]}`];
  if (s.description) parts.push(s.description);
  switch (s.type) {
    case 'apiKey':
      parts.push(
        w.in === 'header'
          ? `Envie no cabeçalho \`${w.name}\` de cada requisição.`
          : w.in === 'query'
            ? `Envie no parâmetro de query \`${w.name}\` de cada requisição.`
            : `Envie no cookie \`${w.name}\` de cada requisição.`
      );
      break;
    case 'bearer':
      parts.push(`Envie o token no cabeçalho \`Authorization\` com o prefixo \`Bearer\`${s.bearerFormat ? ` (formato **${s.bearerFormat}**)` : ''}.`);
      break;
    case 'basic':
      parts.push('Codifique `usuario:senha` em Base64 e envie no cabeçalho `Authorization` com o prefixo `Basic`:');
      parts.push(fence('bash', 'echo -n "usuario:senha" | base64'));
      break;
    case 'oauth2':
      parts.push('1. Troque seu `client_id` e `client_secret` por um token de acesso.\n2. Envie o token em cada chamada no cabeçalho `Authorization: Bearer …`.\n3. Renove o token quando ele expirar (não peça um token novo a cada chamada).');
      if (s.tokenUrl) parts.push(`Endpoint de token: \`${s.tokenUrl}\``);
      if (s.scopes) parts.push(`Escopos disponíveis: ${s.scopes.split(/\s+/).map((x) => '`' + x + '`').join(', ')}`);
      parts.push(fence('bash', oauthTokenCurl(s)));
      parts.push('Resposta esperada:');
      parts.push(fence('json', '{\n  "access_token": "eyJhbGciOi...",\n  "token_type": "Bearer",\n  "expires_in": 3600\n}'));
      break;
  }
  return parts.join('\n\n');
}

function authentication(api: Api): string {
  const schemes = defaultSchemes(api);
  const extras = extraSchemes(api);
  if (!schemes.length && !extras.length) {
    return 'Esta API é **pública**: nenhum cabeçalho de autenticação é necessário. Ainda assim, respeite os limites de uso.';
  }
  const any = api.auth.mode === 'any' && schemes.length > 1;
  const parts: string[] = [];
  if (!schemes.length) parts.push('A maioria dos endpoints desta API é **pública**.');
  else if (schemes.length === 1) parts.push(`Esta API usa **${authSummary(api)}**.`);
  else if (any) parts.push(`Esta API aceita **qualquer uma** das ${schemes.length} credenciais abaixo. Envie apenas uma delas.`);
  else parts.push(`Esta API exige **${schemes.length} credenciais em todas as requisições**, enviadas juntas.`);
  if (schemes.length) parts.push(credentialsTable(api));
  if (extras.length) {
    parts.push('Alguns endpoints usam outra credencial (veja **Endpoints com regra própria** abaixo):');
    parts.push(credentialsTable(api, extras));
  }

  if (api.auth.instructions) parts.push('## Como obter as credenciais\n\n' + api.auth.instructions);

  if (schemes.length) {
    parts.push(any ? '## Exemplo (usando a primeira opção)' : '## Exemplo de requisição autenticada');
    parts.push(fence('http', wireExample(any ? [schemes[0]] : schemes)));
  }

  parts.push(schemes.length + extras.length > 1 ? '## Detalhes de cada credencial' : '## Detalhes');
  [...schemes, ...extras].forEach((s) => parts.push(schemeSection(s)));

  // Endpoints whose rule differs from the API default.
  const special = api.endpoints.filter((e) => e.security);
  if (special.length) {
    parts.push('## Endpoints com regra própria');
    parts.push(
      special
        .map((e) => {
          const req = endpointSchemes(api, e).required;
          const what = !req.length ? 'público (sem credencial)' : req.map((s) => '`' + schemeWire(s).name + '`').join(' + ');
          return `- \`${e.method} ${e.path}\`: ${what}`;
        })
        .join('\n')
    );
  }

  parts.push('## Boas práticas de segurança');
  parts.push(
    [
      '- Nunca coloque credenciais no código-fonte ou no front-end; use variáveis de ambiente ou um cofre de segredos.',
      '- Use credenciais diferentes para cada ambiente.',
      '- Revogue imediatamente qualquer credencial exposta.',
    ].join('\n')
  );
  return parts.join('\n\n');
}

function errorHandling(api: Api): string {
  const seen = new Map<number, string>();
  for (const ep of api.endpoints) {
    for (const r of ep.responses) {
      if (r.status >= 400 && !seen.has(r.status)) seen.set(r.status, r.description);
    }
  }
  [401, 429, 500].forEach((s) => {
    if (!seen.has(s) && (s !== 401 || apiSchemes(api).length)) seen.set(s, '');
  });
  const rows = [...seen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([s, d]) => `| \`${s}\` | ${d || HTTP_MEANINGS[s] || '—'} | ${s === 429 || s >= 500 ? 'Sim, com backoff' : 'Não'} |`);

  const parts = [
    'A API usa os códigos de status HTTP para indicar sucesso ou falha. Respostas `2xx` indicam sucesso, `4xx` indicam um problema na requisição e `5xx` um problema no servidor.',
    '## Códigos de erro desta API',
    '| Status | Significado | Repetir? |\n|---|---|---|\n' + rows.join('\n'),
    '## Estratégia de nova tentativa recomendada',
    'Para `429` e `5xx`, tente novamente com **backoff exponencial** (1s, 2s, 4s, 8s…) e um pouco de aleatoriedade. Não repita erros `4xx` sem corrigir a requisição.',
    fence(
      'javascript',
      `async function chamarComRetry(fn, tentativas = 4) {
  for (let i = 0; i < tentativas; i++) {
    const res = await fn();
    if (res.status !== 429 && res.status < 500) return res;
    const espera = 2 ** i * 1000 + Math.random() * 250;
    await new Promise((r) => setTimeout(r, espera));
  }
  throw new Error('Número máximo de tentativas atingido');
}`
    ),
  ];
  if (api.endpoints.some((e) => e.parameters.some((p) => /idempot/i.test(p.name)))) {
    parts.push('## Idempotência');
    parts.push('Envie o cabeçalho `Idempotency-Key` em operações de escrita. Assim, repetir uma requisição após uma falha de rede não cria registros duplicados.');
  }
  return parts.join('\n\n');
}

function productionChecklist(api: Api): string {
  const items = [
    apiSchemes(api).length > 0 && 'Credenciais de produção guardadas em um cofre de segredos (não no código).',
    apiSchemes(api).some((s) => s.type === 'oauth2') && 'Token OAuth reutilizado até expirar, com renovação automática.',
    'Tratamento de erros `4xx` e `5xx` implementado, com nova tentativa só para `429` e `5xx`.',
    'Tempo limite (timeout) configurado em todas as chamadas.',
    api.rateLimit && `Volume de chamadas dentro do limite: **${api.rateLimit}**.`,
    'Logs com o status e o tempo de resposta de cada chamada (sem registrar credenciais ou dados pessoais).',
    api.environments.length > 1 && 'Integração validada no ambiente de testes antes de apontar para produção.',
    `Inscrição nas novidades da API para acompanhar mudanças de versão (versão atual: **${api.version}**).`,
    api.contactEmail && `Contato do time responsável salvo para incidentes: ${api.contactEmail}.`,
  ].filter(Boolean);

  const parts = ['Use esta lista antes de colocar sua integração em produção.', items.map((i) => `- [ ] ${i}`).join('\n')];
  if (api.sla) parts.push(`**SLA:** ${api.sla}`);
  if (api.status === 'depreciada') {
    parts.unshift('> **Atenção:** esta API está depreciada. Não inicie novas integrações com ela.');
  }
  return parts.join('\n\n');
}

export function buildGuides(api: Api): GeneratedGuide[] {
  const generated: GeneratedGuide[] = [
    { id: 'inicio-rapido', title: 'Início rápido', description: 'Da credencial à primeira chamada em minutos.', content: quickstart(api), generated: true },
    { id: 'autenticacao', title: 'Autenticação', description: 'Como obter e enviar suas credenciais.', content: authentication(api), generated: true },
    { id: 'erros', title: 'Tratamento de erros', description: 'Códigos de status e estratégia de nova tentativa.', content: errorHandling(api), generated: true },
    { id: 'producao', title: 'Checklist de produção', description: 'O que revisar antes de ir para produção.', content: productionChecklist(api), generated: true },
  ];
  const custom = api.guides.map((g, i) => ({
    id: `guia-${i + 1}`,
    title: g.title,
    description: 'Guia escrito pelo time responsável.',
    content: g.content,
    generated: false,
  }));
  return [...generated, ...custom];
}

export { exampleUrl };
