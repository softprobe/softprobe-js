/**
 * Local probe server for strict-negative replay E2E.
 * Exposes:
 * - GET /probe-call: increments hit counter
 * - GET /payload: returns deterministic payload
 * - GET /hits: returns current hit count as JSON
 */

const http = require('http');

const PORT = parseInt(process.env.PORT || '0', 10) || 39501;
let hitCount = 0;

const server = http.createServer((req: any, res: any) => {
  if (req.url === '/' || req.url === '') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  if (req.url === '/probe-call' && req.method === 'GET') {
    hitCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ touched: true, hitCount }));
    return;
  }

  if (req.url === '/payload' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, source: 'probe-static' }));
    return;
  }

  if (req.url === '/hits' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hitCount }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: PORT }) + '\n');
});
