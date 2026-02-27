/**
 * Pricing demo v1 (baseline).
 * Endpoint: GET /price?sku=<id>
 */

const express = require('express') as typeof import('express');

const PORT = parseInt(process.env.PORT ?? '3020', 10);
const TAX_RATE = 0.08;

function computePriceCents(basePriceCents: number): number {
  return basePriceCents + Math.round(basePriceCents * TAX_RATE);
}

function basePriceForSku(sku: string): number {
  if (sku === 'coffee-beans') return 1000;
  return 500;
}

const app = express();

app.get('/ping', (_req, res) => {
  res.send('ok');
});

app.get('/price', (req, res) => {
  const sku = String(req.query.sku ?? 'coffee-beans');
  const basePriceCents = basePriceForSku(sku);
  const priceCents = computePriceCents(basePriceCents);

  res.json({
    sku,
    basePriceCents,
    priceCents,
    price: `$${(priceCents / 100).toFixed(2)}`,
  });
});

app.listen(PORT, () => {
  console.log(`pricing-demo v1 listening on http://127.0.0.1:${PORT}`);
});
