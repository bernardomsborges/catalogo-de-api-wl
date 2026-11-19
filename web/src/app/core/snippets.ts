import { Api, Endpoint, endpointSchemes, schemeWire } from './models';

export interface Snippet {
  lang: string;
  label: string;
  code: string;
}

export const LANGUAGES = [
  { lang: 'curl', label: 'cURL' },
  { lang: 'javascript', label: 'JavaScript' },
  { lang: 'python', label: 'Python' },
  { lang: 'java', label: 'Java' },
  { lang: 'csharp', label: 'C#' },
  { lang: 'go', label: 'Go' },
  { lang: 'php', label: 'PHP' },
];

/** Builds the full URL with example values filled into path and query params. */
export function exampleUrl(api: Api, ep: Endpoint, baseUrl = api.baseUrl): string {
  let path = ep.path;
  const query: string[] = [];
  for (const p of ep.parameters) {
    const value = p.example || `{${p.name}}`;
    if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(value));
    if (p.in === 'query' && (p.required || p.example)) query.push(`${p.name}=${encodeURIComponent(value)}`);
  }
  // Credentials that travel in the query string (apiKey in: query).
  for (const s of endpointSchemes(api, ep).required) {
    const w = schemeWire(s);
    if (w.in === 'query') query.push(`${w.name}=${w.value}`);
  }
  return baseUrl + path + (query.length ? `?${query.join('&')}` : '');
}

/** Headers a request needs: auth + JSON content type + documented header params. */
export function exampleHeaders(api: Api, ep: Endpoint): [string, string][] {
  const headers: [string, string][] = [];
  const cookies: string[] = [];
  for (const s of endpointSchemes(api, ep).required) {
    const w = schemeWire(s);
    if (w.in === 'header') headers.push([w.name, w.value]);
    if (w.in === 'cookie') cookies.push(`${w.name}=${w.value}`);
  }
  if (cookies.length) headers.push(['Cookie', cookies.join('; ')]);
  if (hasBody(ep)) headers.push(['Content-Type', 'application/json']);
  for (const p of ep.parameters.filter((p) => p.in === 'header')) {
    headers.push([p.name, p.example || `VALOR_${p.name.toUpperCase().replace(/\W/g, '_')}`]);
  }
  return headers;
}

export function hasBody(ep: Endpoint): boolean {
  return !!ep.requestBody?.trim() && ep.method !== 'GET' && ep.method !== 'DELETE';
}

function compactJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body.replace(/\s*\n\s*/g, ' ');
  }
}

function prettyJson(body: string, indent = 2): string {
  try {
    return JSON.stringify(JSON.parse(body), null, indent);
  } catch {
    return body;
  }
}

function indentLines(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : pad + l))
    .join('\n');
}

const escDouble = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function generateSnippets(api: Api, ep: Endpoint, baseUrl = api.baseUrl): Snippet[] {
  const url = exampleUrl(api, ep, baseUrl);
  const headers = exampleHeaders(api, ep);
  const body = hasBody(ep) ? ep.requestBody : '';
  const m = ep.method;

  const curl = [
    `curl -X ${m} "${url}"`,
    ...headers.map(([k, v]) => `  -H "${k}: ${v}"`),
    ...(body ? [`  -d '${compactJson(body).replace(/'/g, "'\\''")}'`] : []),
  ].join(' \\\n');

  const jsHeaders = headers.map(([k, v]) => `    '${k}': '${v}',`).join('\n');
  const javascript = `const response = await fetch('${url}', {
  method: '${m}',
  headers: {
${jsHeaders}
  },${body ? `\n  body: JSON.stringify(${indentLines(prettyJson(body), 2)}),` : ''}
});

if (!response.ok) {
  throw new Error(\`Erro \${response.status}: \${await response.text()}\`);
}
const data = await response.json();
console.log(data);`;

  const pyHeaders = headers.map(([k, v]) => `    "${k}": "${v}",`).join('\n');
  const pyBody = body ? prettyJson(body, 4).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None') : '';
  const python = `import requests

url = "${url}"
headers = {
${pyHeaders}
}${pyBody ? `\npayload = ${pyBody}\n` : '\n'}
response = requests.${m.toLowerCase()}(url, headers=headers${pyBody ? ', json=payload' : ''}, timeout=30)
response.raise_for_status()
print(response.json())`;

  const javaHeaders = headers
    .filter(([k]) => k !== 'Content-Type' || !body)
    .map(([k, v]) => `    .header("${k}", "${v}")`)
    .join('\n');
  const javaPublisher = body
    ? `HttpRequest.BodyPublishers.ofString("""\n        ${indentLines(prettyJson(body), 8)}\n        """)`
    : 'HttpRequest.BodyPublishers.noBody()';
  const java = `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

HttpClient client = HttpClient.newHttpClient();
HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("${url}"))
${javaHeaders}${body ? '\n    .header("Content-Type", "application/json")' : ''}
    .method("${m}", ${javaPublisher})
    .build();

HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(response.statusCode() + " " + response.body());`;

  const csHeaders = headers
    .filter(([k]) => k !== 'Content-Type')
    .map(([k, v]) => `request.Headers.TryAddWithoutValidation("${k}", "${v}");`)
    .join('\n');
  const csharp = `using System.Net.Http;
using System.Text;

using var client = new HttpClient();
var request = new HttpRequestMessage(new HttpMethod("${m}"), "${url}");
${csHeaders}${
    body
      ? `\nrequest.Content = new StringContent(\n    """\n    ${indentLines(prettyJson(body), 4)}\n    """,\n    Encoding.UTF8, "application/json");`
      : ''
  }

var response = await client.SendAsync(request);
response.EnsureSuccessStatusCode();
Console.WriteLine(await response.Content.ReadAsStringAsync());`;

  const goHeaders = headers.map(([k, v]) => `\treq.Header.Set("${k}", "${v}")`).join('\n');
  const go = `package main

import (
\t"fmt"
\t"io"
\t"net/http"${body ? '\n\t"strings"' : ''}
)

func main() {${body ? `\n\tbody := strings.NewReader(\`${compactJson(body)}\`)` : ''}
\treq, err := http.NewRequest("${m}", "${url}", ${body ? 'body' : 'nil'})
\tif err != nil {
\t\tpanic(err)
\t}
${goHeaders}

\tresp, err := http.DefaultClient.Do(req)
\tif err != nil {
\t\tpanic(err)
\t}
\tdefer resp.Body.Close()
\tdata, _ := io.ReadAll(resp.Body)
\tfmt.Println(resp.StatusCode, string(data))
}`;

  const phpHeaders = headers.map(([k, v]) => `        "${k}: ${escDouble(v)}",`).join('\n');
  const php = `<?php
$ch = curl_init("${url}");
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => "${m}",
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
${phpHeaders}
    ],${body ? `\n    CURLOPT_POSTFIELDS => '${compactJson(body).replace(/'/g, "\\'")}',` : ''}
]);

$response = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
echo $status . " " . $response;`;

  const code: Record<string, string> = { curl, javascript, python, java, csharp, go, php };
  return LANGUAGES.map((l) => ({ ...l, code: code[l.lang] }));
}
