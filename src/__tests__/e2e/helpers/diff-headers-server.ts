/**
 * Minimal server for Task 21.2.1: GET /diff-headers returns the request headers as JSON.
 * Used so the test can assert the diff CLI injected the coordination headers.
 */

const http = require('http');

const PORT = parseInt(process.env.PORT || '0', 10) || 39401;

const server = http.createServer((req: any, res: any) => {
  if (req.url === '/' || req.url === '') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  if (req.url === '/diff-headers' && req.method === 'GET') {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(headers));
    return;
  }
  // Task 21.3.1: returns 500 + error body so CLI diff can assert mismatch vs recorded 200.
  if (req.url === '/diff-mismatch' && req.method === 'GET') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'live' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: PORT }) + '\n');
});
