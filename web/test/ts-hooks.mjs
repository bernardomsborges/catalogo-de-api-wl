// Lets node:test run the portal's TypeScript without a bundler: extensionless relative imports
// resolve to .ts, and each .ts file is compiled with the TypeScript compiler already in web/.
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      /* fall through to the default resolution */
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, context);
  const source = await readFile(fileURLToPath(url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, sourceMap: false, inlineSourceMap: true },
  });
  return { format: 'module', source: outputText, shortCircuit: true };
}
