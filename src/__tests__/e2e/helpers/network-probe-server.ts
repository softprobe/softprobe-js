/**
 * Local probe server for strict-negative replay E2E.
 * Exposes:
 * - GET /probe-call: increments hit counter
 * - GET /payload: returns deterministic payload and increments hit counter
 * - GET /hits: returns current hit count as JSON
 * - POST /reset: resets hit counter to 0
 */

const http = require('http');

const PORT = parseInt(process.env.PORT || '0', 10) || 39501;
const SOURCE = process.env.PROBE_SOURCE || 'probe-static';
let hitCount = 0;

const server = http.createServer((req: any, res: any) => {
  const shouldCountProbeHit = req?.headers?.['x-softprobe-probe'] === '1';
  if (req.url === '/' || req.url === '') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  if (req.url === '/probe-call' && req.method === 'GET') {
    if (shouldCountProbeHit) hitCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ touched: true, hitCount }));
    return;
  }

  if (req.url === '/payload' && req.method === 'GET') {
    if (shouldCountProbeHit) hitCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        source: SOURCE,
        method: req.method,
        url: req.url,
      })
    );
    return;
  }

  if (req.url === '/hits' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hitCount }));
    return;
  }

  if (req.url === '/reset' && req.method === 'POST') {
    hitCount = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hitCount }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: PORT }) + '\n');
});
