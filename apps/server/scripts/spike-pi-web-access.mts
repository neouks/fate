/** Isolated compatibility probe. Usage: pnpm exec tsx scripts/spike-pi-web-access.mts /path/to/pi-web-access
 * Install 0.48.0 and its runtime dependencies in a temporary directory first.
 * This does not enable the extension in the application or use real credentials.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';

const packageDir = process.argv[2];
if (!packageDir) throw new Error('Pass an isolated pi-web-access@0.48.0 package directory');
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'pi-web-access');
assert.equal(manifest.version, '0.48.0');
const directory = await mkdtemp(join(tmpdir(), 'series-web-access-spike-'));
// Set once in this dedicated probe process, before importing PI or the extension.
// Never swap this variable between concurrently running production sessions.
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_WEB_ACCESS_CACHE_ROOT = directory;
delete process.env.DEEPSEEK_API_KEY;
const config = {
  provider: 'deepseek', deepseekApiKey: 'synthetic-key-before',
  workflow: 'none', autoOpenBrowser: false,
  toolActivation: 'none', toolExposure: 'deferred',
  maxInlineContentChars: 4000,
  webSearch: { allowedProviders: ['deepseek'] },
  tools: { sourceCheck: { enabled: false } },
  fetch: { defaultMode: 'raw', allowedModes: ['raw', 'readable'] },
  githubClone: { enabled: false }, githubPrIssue: { enabled: false },
  commands: Object.fromEntries(['websearch', 'curator', 'search', 'google-account'].map(name => [name, { enabled: false }])),
};
const configPath = join(directory, 'web-search.json');
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const pageURL = 'https://93.184.216.34/pi-web-access-fixture';
const page = Array.from({ length: 180 }, (_, i) => `Line ${i}: synthetic page evidence for platform compatibility.\n`).join('');
const requests: Array<{ url: string; authorization: string | null }> = [];
const fetchBefore = globalThis.fetch;
// All outbound fetches are intercepted. Unknown destinations fail closed.
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
  if (url === 'https://api.deepseek.com/v1/tools/search') {
    return Response.json({ results: [{ title: 'Synthetic source', url: pageURL, summary: 'Synthetic search evidence' }] });
  }
  if (url === pageURL) return new Response(page, { headers: { 'content-type': 'text/plain' } });
  throw new Error('Unexpected outbound request in isolated probe');
};

const { default: webAccess } = await import(pathToFileURL(resolve(packageDir, 'dist/index.js')).href) as { default: ExtensionFactory };
const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai');
const { AgentRunner } = await import('../src/pi/runner.js');
const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json'), refreshOnCreate: false });
const faux = fauxProvider({ provider: 'web-access-fixture' });
await runtime.registerNativeProvider(faux.provider);
const names = ['web_search', 'fetch_content', 'get_search_content'];
const runners: InstanceType<typeof AgentRunner>[] = [];
const registered = new Map<string, ToolDefinition>();
const factory: ExtensionFactory = pi => webAccess(new Proxy(pi, {
  get(target, key) {
    if (key === 'registerTool') return (tool: ToolDefinition) => {
      registered.set(tool.name, tool);
      target.registerTool(tool);
    };
    return Reflect.get(target, key);
  },
}));
// Prototype host boundary: keep upstream schemas/execution, check ownership at
// the native tool entry using the current branch (including restored entries).
const guardedFactory: ExtensionFactory = pi => webAccess(new Proxy(pi, {
  get(target, key) {
    if (key === 'registerTool') return (tool: ToolDefinition) => target.registerTool(tool.name !== 'get_search_content' ? tool : {
      ...tool,
      async execute(callID, params, signal, update, context) {
        const owned = context.sessionManager.getBranch().some(entry => entry.type === 'custom' && entry.customType === 'web-search-results' &&
          (entry.data as {id?: string})?.id === (params as {responseId?: string}).responseId);
        if (!owned) return { isError: true, content: [{ type: 'text' as const, text: 'Search result does not belong to this session branch' }], details: {} };
        return tool.execute(callID, params, signal, update, context);
      },
    });
    return Reflect.get(target, key);
  },
}));
const options = (name: string) => ({
  cwd: directory, agentDir: directory, resumeSessionPath: join(directory, `${name}.jsonl`),
  modelRuntime: runtime, model: faux.getModel(), systemPrompt: 'Only synthetic local fixtures.',
  boundedRunHistory: false, toolAllowlist: names,
  toolLoading: { version: 'lean-tools-v1' as const, initialActive: names, deferred: [], compatibility: [] },
  extensionFactories: [factory],
});
async function invoke(runner: InstanceType<typeof AgentRunner>, tool: string, args: Record<string, unknown>) {
  faux.setResponses([fauxAssistantMessage([fauxToolCall(tool, args)]), fauxAssistantMessage('fixture completed')]);
  await runner.prompt('Run the synthetic compatibility fixture');
  const result = runner.messages.filter(message => message.role === 'toolResult').at(-1);
  assert.ok(result && result.role === 'toolResult', 'Native loop must publish a tool result');
  assert.equal(result.toolName, tool);
  return result;
}
function resultID(runner: InstanceType<typeof AgentRunner>, type: string): string {
  const entry = runner.sessionEntries.filter(entry => entry.type === 'custom' && entry.customType === 'web-search-results' && (entry.data as {type?: string})?.type === type).at(-1);
  assert.ok(entry && entry.type === 'custom', 'Extension must persist its native custom entry');
  return (entry.data as {id: string}).id;
}
const text = (result: Awaited<ReturnType<typeof invoke>>) => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
try {
  const a = await AgentRunner.create(options('a')); runners.push(a);
  assert.deepEqual([...registered.keys()].sort(), [...names].sort());
  const searched = await invoke(a, 'web_search', { query: 'synthetic platform integration' });
  assert.equal(searched.isError, false, text(searched));
  const searchID = resultID(a, 'search');
  const readSearch = await invoke(a, 'get_search_content', { responseId: searchID, queryIndex: 0 });
  assert.match(text(readSearch), /Synthetic source/);

  const fetched = await invoke(a, 'fetch_content', { url: pageURL, mode: 'raw' });
  assert.equal(fetched.isError, false, text(fetched));
  const fetchID = resultID(a, 'fetch');
  const readPage = await invoke(a, 'get_search_content', { responseId: fetchID, urlIndex: 0, offset: 0, limit: 1000 });
  assert.match(text(readPage), /Line 0/);
  assert.ok((readPage.details as {nextOffset?: number}).nextOffset);
  const next = await invoke(a, 'get_search_content', { responseId: fetchID, urlIndex: 0, offset: (readPage.details as {nextOffset: number}).nextOffset, limit: 1000 });
  assert.notEqual(text(readPage), text(next));

  const beforeDenied = requests.length;
  const denied = await invoke(a, 'web_search', { query: 'synthetic blocked provider', provider: 'brave' });
  assert.equal(denied.isError, true);
  assert.equal(requests.length, beforeDenied, 'Provider allowlist must reject before outbound fetch');

  // Reproduce host integration gaps without using real customer sessions.
  const b = await AgentRunner.create(options('b')); runners.push(b);
  const foreign = await invoke(b, 'get_search_content', { responseId: fetchID, urlIndex: 0, limit: 1000 });
  const crossSessionRead = !foreign.isError && text(foreign).includes('Line 0');
  assert.equal(crossSessionRead, true, '0.48.0 global cache requires an additional host ownership guard');

  await writeFile(configPath, JSON.stringify({ ...config, deepseekApiKey: 'synthetic-key-after' }));
  const rotated = await invoke(b, 'web_search', { query: 'synthetic config reload' });
  assert.equal(rotated.isError, false, text(rotated));
  const staleKey = requests.at(-1)?.authorization === 'Bearer synthetic-key-before';
  assert.equal(staleKey, true, '0.48.0 provider config is cached across extension instances');

  const guarded = await AgentRunner.create({ ...options('guarded'), extensionFactories: [guardedFactory] }); runners.push(guarded);
  const guardedForeign = await invoke(guarded, 'get_search_content', { responseId: fetchID, urlIndex: 0, limit: 1000 });
  assert.equal(guardedForeign.isError, true);
  assert.doesNotMatch(text(guardedForeign), /Line 0/);
  const ownSearch = await invoke(guarded, 'web_search', { query: 'synthetic own results' });
  assert.equal(ownSearch.isError, false);
  const ownContent = await invoke(guarded, 'get_search_content', { responseId: resultID(guarded, 'search'), queryIndex: 0 });
  assert.match(text(ownContent), /Synthetic source/);
  await guarded.dispose(); runners.splice(runners.indexOf(guarded), 1);

  await b.dispose(); runners.splice(runners.indexOf(b), 1);
  const afterSiblingClose = await invoke(a, 'get_search_content', { responseId: fetchID, urlIndex: 0, limit: 1000 });
  assert.equal(afterSiblingClose.isError, false);
  await a.dispose(); runners.splice(runners.indexOf(a), 1);
  const restored = await AgentRunner.create({ ...options('a'), extensionFactories: [guardedFactory] }); runners.push(restored);
  const resumed = await invoke(restored, 'get_search_content', { responseId: fetchID, urlIndex: 0, limit: 1000 });
  assert.match(text(resumed), /Line 0/);

  console.log(JSON.stringify({
    package: `${manifest.name}@${manifest.version}`, sdk: '1.5.2',
    nativeRunnerRegistration: true, nativeSearch: true, fetchAndPagination: true,
    nativeSessionRestore: true, siblingShutdownPreservesContent: true,
    providerAllowlist: true, crossSessionReadReproduced: crossSessionRead,
    hostOwnershipGuardBlocksForeignResults: true, hostOwnershipGuardPreservesRestore: true,
    staleKeyAfterConfigWriteReproduced: staleKey,
    mockedRequests: requests.length, liveProviderRequests: 0,
  }, null, 2));
} finally {
  for (const runner of runners.reverse()) await runner.dispose();
  globalThis.fetch = fetchBefore;
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
