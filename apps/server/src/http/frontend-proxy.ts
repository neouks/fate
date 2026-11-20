import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { FastifyInstance } from 'fastify';

const hopByHop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
function forwardedHeaders(headers: IncomingHttpHeaders) {
  const excluded = new Set([...hopByHop, ...(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key.toLowerCase())));
}

/** Keep the public API and UI on one origin while Next serves its own build.
 * Raw streams preserve compressed assets, RSC payloads and response cookies. */
export function registerFrontendProxy(app: FastifyInstance, frontendURL: string) {
  const target = new URL(frontendURL);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) {
    throw new Error('frontend_url 必须是无路径及凭证的 HTTP(S) 服务地址');
  }
  const request = target.protocol === 'https:' ? https.request : http.request;
  // Only API requests continue the hook chain. An async hook awaiting reply
  // also resolves on client disconnect, when reply.sent may still be false;
  // that would run the local 404 handler over an already-started asset stream.
  app.addHook('onRequest', (req, reply, done) => {
    const pathname = req.url.split('?')[0]!;
    if (pathname === '/api' || pathname.startsWith('/api/')) return done();
    const publicHost = req.headers.host ?? target.host;
    let responseStarted = false;
    // URL pathname is supplied separately: a request starting with // cannot
    // change the configured upstream host.
    const upstream = request(target, {
      path: req.url, method: req.method,
      headers: {...forwardedHeaders(req.headers), host: target.host,
        'x-forwarded-host': publicHost, 'x-forwarded-proto': req.protocol},
    }, response => {
      responseStarted = true;
      if (reply.raw.destroyed) { response.destroy(); return; }
      const headers = forwardedHeaders(response.headers);
      if (typeof headers.location === 'string') {
        const location = new URL(headers.location, target);
        if (location.origin === target.origin) headers.location = `${location.pathname}${location.search}${location.hash}`;
      }
      reply.code(response.statusCode ?? 502).headers(headers).send(response);
    });
    const cancel = () => upstream.destroy();
    req.raw.once('aborted', cancel);
    reply.raw.once('close', cancel);
    upstream.once('close', () => {
      req.raw.off('aborted', cancel);
      reply.raw.off('close', cancel);
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('frontend timeout')));
    upstream.once('error', error => {
      app.log.warn({err: error}, 'frontend proxy failed');
      if (!responseStarted && !reply.sent && !reply.raw.destroyed) {
        reply.code(502).send({error: '前端服务暂不可用，请稍后刷新'});
      }
    });
    req.raw.pipe(upstream);
  });
}
