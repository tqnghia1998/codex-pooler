import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

// Test-only overlay: never changes a downstream vendor pin or publishes files.
export async function resolve(specifier, context, nextResolve) {
  const prefix = '@quotahub/gateway/gateway/';
  const source = process.env.CODEX_GATEWAY_TEST_SOURCE;
  if (!source || !specifier.startsWith(prefix)) return nextResolve(specifier, context);
  const root = resolvePath(source, 'node', 'src');
  const target = resolvePath(root, specifier.slice(prefix.length));
  if (!target.startsWith(`${root}/`) || !target.endsWith('.js')) throw new Error('Invalid candidate gateway module');
  return { url: pathToFileURL(target).href, shortCircuit: true };
}
