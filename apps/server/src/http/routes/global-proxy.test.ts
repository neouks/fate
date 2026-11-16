import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTCPServer } from 'node:net';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerConfigRoutes } from './config.js';
import { normalizeProbeProxy, parseExitInfo, probeGlobalProxy } from './global-proxy.js';

test('proxy validation accepts supported transports and rejects invalid inputs', () => {
  for (const input of [null, undefined, 42, {}, 'localhost:8080', 'ftp://host', 'http://host/path',
    'http://host?query', 'http://host/#fragment', 'http://host:0', 'http://host:65536',
    'http://bad host', 'http://host\nproxy=evil', 'http://user:%ZZ@host']) {
    assert.throws(() => normalizeProbeProxy(input), String(input));
  }
  assert.equal(normalizeProbeProxy('  '), '');
  assert.equal(normalizeProbeProxy(' http://user:p%40ss@localhost:8080 '), 'http://user:p%40ss@localhost:8080/');
  assert.equal(normalizeProbeProxy('https://localhost:8443'), 'https://localhost:8443/');
  assert.equal(normalizeProbeProxy('socks5://[::1]:1080'), 'socks5h://[::1]:1080');
});

test('exit IP parsing requires a valid IP and preserves Chinese location and provider', () => {
  assert.deepEqual(parseExitInfo('IP\t: 203.0.113.9\n地址\t: 中国 山东 济南\n运营商\t: 联通\n'), {
    ok: true, ip: '203.0.113.9', location: '中国 山东 济南', isp: '联通',
  });
  assert.equal(parseExitInfo('IP : 2001:db8::1').ip, '2001:db8::1');
  for (const body of ['', '<html>access denied</html>', 'IP : 999.1.1.1', 'IP : unknown']) {
    assert.equal(parseExitInfo(body).ok, false);
  }
});

test('normal config route rejects bad input and reports HTTP proxy authentication failure without leaking secrets', async () => {
  let destination = '';
  let authorization = '';
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    destination = request.url ?? '';
    authorization = request.headers['proxy-authorization'] ?? '';
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === 'object');
  const app = Fastify();
  registerConfigRoutes(app);
  try {
    const bad = await app.inject({ method: 'POST', url: '/api/settings/global-proxy/test', payload: { proxy: 3 } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().ok, false);
    const response = await app.inject({ method: 'POST', url: '/api/settings/global-proxy/test',
      payload: { proxy: `http://audit:secret%40value@127.0.0.1:${address.port}` } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, false);
    assert.match(response.json().error, /代理/);
    assert.equal(typeof response.json().latency_ms, 'number');
    assert.equal(destination, 'cip.cc:443');
    assert.equal(authorization, 'Basic ' + Buffer.from('audit:secret@value').toString('base64'));
    assert.doesNotMatch(response.body, /secret|audit|127\.0\.0\.1/);
  } finally {
    await app.close();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

test('SOCKS5 probe reaches the proxy and reports handshake rejection without direct fallback', async () => {
  let version = 0;
  const proxy = createTCPServer(socket => {
    socket.once('data', bytes => { version = bytes[0]!; socket.end(Buffer.from([5, 255])); });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === 'object');
  try {
    const result = await probeGlobalProxy(normalizeProbeProxy(`socks5://127.0.0.1:${address.port}`));
    assert.equal(version, 5);
    assert.equal(result.ok, false);
    assert.match(result.error!, /SOCKS5/);
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
