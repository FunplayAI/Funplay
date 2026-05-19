import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') &&
      (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) &&
      !specifier.match(/\.[cm]?[jt]sx?$/)
    ) {
      try {
        return await nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(`${specifier}.tsx`, context);
      }
    }

    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.tsx')) {
    return nextLoad(url, context);
  }

  const source = await readFile(fileURLToPath(url), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      allowImportingTsExtensions: true
    },
    fileName: fileURLToPath(url)
  });

  return {
    format: 'module',
    shortCircuit: true,
    source: transpiled.outputText
  };
}
