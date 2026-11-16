import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';

export interface GlobalProxyProbeResult {
  ok: boolean;
  ip?: string;
  location?: string;
  isp?: string;
  latency_ms?: number;
  error?: string;
}

export function normalizeProbeProxy(input: unknown): string {
  if (typeof input !== 'string') throw new Error('代理地址必须为字符串，留空使用直连');
  const address = input.trim();
  if (!address) return '';
  if (/[\u0000-\u0020\u007f]/u.test(address)) throw new Error('代理地址不能包含空白或控制字符');
  let url: URL;
  try { url = new URL(address); } catch { throw new Error('代理地址无效，请填写完整的协议、主机和端口'); }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) {
    throw new Error('代理协议仅支持 http、https 和 socks5');
  }
  if (!url.hostname || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('代理地址应仅包含主机、端口及可选的账号密码');
  }
  try { decodeURIComponent(url.username); decodeURIComponent(url.password); }
  catch { throw new Error('代理账号或密码的 URL 编码无效'); }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error('代理端口必须在 1–65535 之间');
  // Resolve the destination through SOCKS as well, so local DNS is not required.
  if (url.protocol === 'socks5:') url.protocol = 'socks5h:';
  return url.href;
}

export function parseExitInfo(body: string): Omit<GlobalProxyProbeResult, 'latency_ms'> {
  const field = (name: string) => body.match(new RegExp(`^${name}\\s*[:：]\\s*(.+)$`, 'mi'))?.[1]?.trim();
  const ip = field('IP');
  if (!ip || !isIP(ip)) return { ok: false, error: '出口查询服务未返回有效 IP，请稍后重试' };
  return { ok: true, ip, location: field('地址'), isp: field('运营商') };
}

export async function probeGlobalProxy(proxy: string): Promise<GlobalProxyProbeResult> {
  const started = performance.now();
  const result = await new Promise<GlobalProxyProbeResult>((resolve) => {
    // -q disables user curlrc. Explicit proxy/noproxy options override ambient proxy variables.
    // Pass credentials through stdin, rather than exposing them in process arguments.
    const child = spawn('curl', ['-q', '--config', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let body = '';
    let bytes = 0;
    let failure = '';
    const timer = setTimeout(() => {
      failure = '出口检测超时，请检查代理或网络连接';
      child.kill('SIGKILL');
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) {
        failure = '出口查询服务返回内容过大';
        child.kill('SIGKILL');
      } else body += chunk;
    });
    // curl diagnostics can contain proxy credentials; return controlled messages instead.
    child.stderr.resume();
    child.stdin.on('error', () => { /* Process exit is handled below. */ });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.code === 'ENOENT' ? '服务器缺少 curl，请安装后重试' : '无法启动出口检测进程' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) { resolve({ ok: false, error: failure }); return; }
      const errors: Record<number, string> = {
        5: '无法解析代理主机，请检查代理地址',
        6: '无法解析出口查询服务域名',
        7: '无法连接代理或出口查询服务，请检查地址、端口和网络',
        22: '代理或出口查询服务返回 HTTP 错误，请检查代理认证和服务状态',
        28: '出口检测超时，请检查代理或网络连接',
        35: 'TLS 握手失败，请检查 HTTPS 代理或网络连接',
        56: '代理隧道或数据接收失败，请检查代理认证和连接',
        60: 'TLS 证书验证失败，请检查代理或服务器证书',
        97: 'SOCKS5 握手失败，请检查代理账号、密码及连接权限',
      };
      resolve(code === 0 ? parseExitInfo(body) : { ok: false, error: errors[code ?? -1] ?? '出口检测失败，请检查代理及网络后重试' });
    });
    const quotedProxy = proxy.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    child.stdin.end([
      'url = "https://cip.cc"', 'user-agent = "curl"',
      `proxy = "${quotedProxy}"`, 'noproxy = ""',
      'connect-timeout = 5', 'max-time = 12', 'max-filesize = 65536',
      'silent', 'show-error', 'fail',
    ].join('\n') + '\n');
  });
  return { ...result, latency_ms: Math.round(performance.now() - started) };
}

export function registerGlobalProxyRoutes(app: FastifyInstance): void {
  app.post('/api/settings/global-proxy/test', async (req, reply) => {
    let proxy: string;
    try { proxy = normalizeProbeProxy((req.body as { proxy?: unknown } | null)?.proxy); }
    catch (error) { return reply.code(400).send({ ok: false, error: (error as Error).message }); }
    return probeGlobalProxy(proxy);
  });
}
