// Contract test: both APIs must return the same status and body for every case.
import assert from 'node:assert/strict';

const GO = 'http://127.0.0.1:8081';
const NODE = 'http://127.0.0.1:8082';

async function request(base, path, method = 'GET') {
  const res = await fetch(base + path, { method, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: await res.json() };
}

const cases = [
  ['/health', 200],
  ['/ready', 200],
  ['/products/1', 200],
  ['/products/5100000', 200],
  ['/products/5100001', 404],
  ['/products/-1', 400],
  ['/products/1.5', 400],
  ['/products/', 404],
  ['/products/1/2', 404],
  ['/products', 404, 'POST'],
  ['/products?tenant_id=123&category_id=45&limit=20', 200],
  ['/products?tenant_id=1&category_id=1&after=5100000', 200],
  ['/products?tenant_id=0&category_id=1', 400],
  ['/products?tenant_id=1&category_id=1&limit=101', 400],
  ['/products?tenant_id=1&category_id=1&after=-1', 400],
  ['/missing', 404],
  ['/inventory/0/reserve', 400, 'POST'],
  ['/inventory/100001/reserve', 409, 'POST'],
  ['/inventory/1/reserve', 404],
];

for (const [path, status, method] of cases) {
  const [go, node] = await Promise.all([request(GO, path, method), request(NODE, path, method)]);
  assert.equal(go.status, status, `Go ${method ?? 'GET'} ${path}`);
  assert.equal(node.status, status, `Node ${method ?? 'GET'} ${path}`);
  assert.deepEqual(node.body, go.body, path);
}

// Seed values are deterministic, so the first product is known.
const first = (await request(GO, '/products/1')).body;
assert.deepEqual(first, {
  id: 1,
  tenant_id: 1,
  category_id: 1,
  name: 'Product 0000001',
  price_cents: 137,
  stock: 1,
});

// Keyset pagination: ordered by id, and the next page starts after the last one.
const page = (await request(GO, '/products?tenant_id=123&category_id=45')).body;
assert.equal(page.length, 20);
assert(page.every((p) => p.tenant_id === 123 && p.category_id === 45));
assert(page.every((p, i) => i === 0 || p.id > page[i - 1].id));

const lastId = page.at(-1).id;
const nextPage = (await request(NODE, `/products?tenant_id=123&category_id=45&after=${lastId}`))
  .body;
assert(nextPage.length > 0 && nextPage.every((p) => p.id > lastId));

// Concurrent reservations must never lose a decrement.
for (const base of [GO, NODE]) {
  const before = await request(base, '/inventory/1/reserve', 'POST');
  const results = await Promise.all(
    Array.from({ length: 20 }, () => request(base, '/inventory/1/reserve', 'POST')),
  );
  const balances = results.map((r) => r.body.available);
  assert(results.every((r) => r.status === 200));
  assert.equal(new Set(balances).size, 20);
  assert.equal(Math.min(...balances), before.body.available - 20);
}

console.log(`OK: ${cases.length} routes equivalent, pagination and concurrent writes verified.`);
