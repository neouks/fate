// Local synthetic transport; no provider or public page is contacted.
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('https://93.184.216.34/search?')) {
    const query = new URL(url).searchParams.get('q');
    return Response.json({ results: ['cnblogs.com', 'csdn.net', 'example.com'].map(domain => ({ title: query, url: `https://${domain}/fixture`, content: 'Synthetic site result.' })) });
  }
  if (url === 'https://api.deepseek.com/v1/tools/search') {
    const body = JSON.parse(init.body);
    if (body.query === 'wait forever') return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const key = new Headers(init.headers).get('authorization');
    return Response.json({ results: [{ title: key === 'Bearer synthetic-before' ? 'configuration A' : 'configuration B', url: 'https://93.184.216.34/native-web-fixture', summary: 'Synthetic evidence.' }] });
  }
  if (url === 'https://93.184.216.34/native-web-fixture') return new Response(Array.from({ length: 300 }, (_, i) => `Paragraph ${i}: synthetic page evidence.\n`).join(''), { headers: { 'content-type': 'text/plain' } });
  throw new Error('Unexpected outbound request in synthetic web test');
};
await import('../web-access-worker.mjs');
