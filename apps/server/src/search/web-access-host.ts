import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { ToolDefinition, ExtensionFactory, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { WebAccessConfig } from './web-access-config.js';
import { extensionConfig } from './web-access-config.js';

type Result = Awaited<ReturnType<ToolDefinition['execute']>>;
type Pending = { resolve(result: Result): void; reject(error: Error): void; update?: (result: Result) => void };
export class WebAccessHost {
  private worker?: Worker;
  private directory?: string;
  private fingerprint = '';
  private pending?: Pending;
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  publish?: (type: string, data: unknown) => void;
  private secrets: string[] = [];
  private failStart?: (error: Error) => void;
  constructor(private readonly cacheRoot: string, private readonly entrypoint = new URL('./web-access-worker.mjs', import.meta.url)) {}
  private redact<T>(value: T): T {
    let json = JSON.stringify(value);
    for (const secret of this.secrets.filter(Boolean)) json = json.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    return JSON.parse(json) as T;
  }
  private async stop() {
    const worker = this.worker; this.worker = undefined; this.fingerprint = '';
    this.failStart?.(new Error('网页扩展启动已取消')); this.failStart = undefined;
    const directory = this.directory; this.directory = undefined;
    const pending = this.pending; this.pending = undefined;
    pending?.reject(new Error('网页工具调用已取消'));
    if (worker) {
      // Abort upstream first, including proxy curl children; terminate is only
      // a bounded fallback for a provider that ignores cancellation.
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2000);
        worker.once('exit', () => { clearTimeout(timer); resolve(); });
        worker.postMessage({ type: 'abort' });
      });
      await worker.terminate();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  async dispose() { this.closed = true; await this.stop(); await this.serial.catch(() => {}); }
  private async start(config: WebAccessConfig) {
    if (this.closed) throw new Error('网页工具会话已关闭');
    const snapshot = extensionConfig(config), signature = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    if (this.worker && signature === this.fingerprint) return;
    await this.stop();
    if (this.closed) throw new Error('网页工具会话已关闭');
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
    this.directory = await mkdtemp(join(tmpdir(), 'series-web-access-'));
    if (this.closed) { await this.stop(); throw new Error('网页工具会话已关闭'); }
    this.secrets = [...Object.values(config.keys), config.proxy];
    if (config.proxy) { const url = new URL(config.proxy); this.secrets.push(url.password, decodeURIComponent(url.password)); }
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'SYSTEMROOT', 'SystemRoot', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const worker = new Worker(this.entrypoint, {
      execArgv: [],
      env: { ...env, PI_CODING_AGENT_DIR: this.directory, PI_WEB_ACCESS_CACHE_ROOT: this.cacheRoot },
      workerData: { configDir: this.directory, config: snapshot },
    });
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('网页扩展启动超时')), 30_000);
      this.failStart = error => { clearTimeout(timer); reject(error); };
      const failed = () => { clearTimeout(timer); reject(new Error('网页扩展启动失败')); this.pending?.reject(new Error('网页扩展执行中断')); this.pending = undefined; this.fingerprint = ''; };
      worker.on('error', failed);
      worker.on('exit', () => { if (this.worker === worker) { this.worker = undefined; failed(); } });
      worker.on('message', (message: {type: string; customType?: string; data?: unknown; result?: Result; update?: Result}) => {
        try {
          if (message.type === 'ready') { clearTimeout(timer); this.failStart = undefined; resolve(); }
          if (message.type === 'entry') this.publish?.(message.customType!, this.redact(message.data));
          if (message.type === 'update') this.pending?.update?.(this.redact(message.update!));
          if (message.type === 'result') { const pending = this.pending; this.pending = undefined; pending?.resolve(this.redact(message.result!)); }
        } catch { this.pending?.reject(new Error('网页结果保存失败')); this.pending = undefined; void this.stop(); }
      });
    }).catch(async error => { await this.stop(); throw error; });
    this.fingerprint = signature;
  }
  call(config: WebAccessConfig, name: string, args: unknown, entries: readonly SessionEntry[], signal?: AbortSignal, update?: Pending['update']): Promise<Result> {
    const execute = async () => {
      signal?.throwIfAborted();
      await this.start(config);
      signal?.throwIfAborted();
      return new Promise<Result>((resolve, reject) => {
        const abort = () => { void this.stop(); };
        const timeout = setTimeout(abort, 90_000);
        const done = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
        this.pending = { resolve: result => { done(); resolve(result); }, reject: error => { done(); reject(error); }, update };
        signal?.addEventListener('abort', abort, { once: true });
        // Keep the upstream schema: explicit domainFilter (including []) wins.
        const parameters = name === 'web_search' ? { domainFilter: config.domain_filter ?? [], ...(args as Record<string, unknown>) } : args;
        this.worker!.postMessage({ type: 'call', id: randomUUID(), name, args: parameters,
          entries: entries.filter(entry => entry.type === 'custom' && entry.customType === 'web-search-results') });
      });
    };
    const next = this.serial.then(execute); this.serial = next.catch(() => {}); return next;
  }
}

export const webAccessRuntime = { create: (cacheRoot: string) => new WebAccessHost(cacheRoot) };

export const WEB_HOST = Symbol('pi-web-access-host');
export type WebHostBinding = { host?: WebAccessHost; publish?: WebAccessHost['publish']; closed?: boolean };
export function webAccessLifecycle(tools: readonly ToolDefinition[] = []): ExtensionFactory {
  const bindings = [...new Set(tools.flatMap(tool => {
    const binding = (tool as ToolDefinition & { [WEB_HOST]?: WebHostBinding })[WEB_HOST]; return binding ? [binding] : [];
  }))];
  return pi => {
    for (const binding of bindings) binding.publish = (type, data) => pi.appendEntry(type, data);
    pi.on('session_shutdown', async () => { for (const binding of bindings) { binding.closed = true; await binding.host?.dispose(); } });
  };
}
export function sessionCacheRoot(sessionFile: string | undefined, cwd: string, id: string) {
  return join(sessionFile ? dirname(sessionFile) : cwd, '.web-access', createHash('sha256').update(id).digest('hex'));
}
