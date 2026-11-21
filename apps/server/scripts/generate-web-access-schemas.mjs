// Regenerate when upgrading the pinned extension; uses no network or credentials.
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'series-web-schemas-'));
const worker = new Worker(new URL('../src/search/web-access-worker.mjs', import.meta.url), {
  env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: dir, PI_WEB_ACCESS_CACHE_ROOT: dir },
  workerData: { configDir: dir, config: { webSearch: { allowedProviders: ['deepseek', 'exa', 'brave', 'tavily', 'bocha', 'jina', 'searxng', 'duckduckgo'] }, tools: { sourceCheck: { enabled: false } }, toolActivation: 'none', toolExposure: 'deferred', maxInlineContentChars: 12000, fetch: { allowedModes: ['readable', 'raw'] } } },
});
try {
  const tools = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', value => resolve(value.tools)); });
  await writeFile(new URL('../src/search/web-access-schemas.json', import.meta.url), JSON.stringify(tools, null, 2) + '\n');
  console.log('Captured native pi-web-access 0.48.0 schemas');
} finally { await worker.terminate(); await rm(dir, { recursive: true, force: true }); }
