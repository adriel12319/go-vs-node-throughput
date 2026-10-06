import cluster from 'node:cluster';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import pg from 'pg';

const MAX_INT32 = 2 ** 31 - 1;
const DIGITS = /^[0-9]+$/;

type Queries = Record<'product' | 'list' | 'reserve', string>;

// Accepts only plain decimal digits, so "+1", "-1" and "1.5" are rejected.
function parseInteger(
  raw: string | null | undefined,
  min: number,
  max: number,
): number | undefined {
  if (!raw || !DIGITS.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

function loadQueries(): Queries {
  let raw: string;
  try {
    raw = readFileSync('queries.json', 'utf8');
  } catch {
    raw = readFileSync('../shared/queries.json', 'utf8');
  }
  return JSON.parse(raw) as Queries;
}

function sendJSON(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJSON(res, status, { error });
}

function startPrimary(workers: number): void {
  // Let the kernel distribute connections instead of routing them through the primary process.
  cluster.schedulingPolicy = cluster.SCHED_NONE;
  for (let i = 0; i < workers; i++) cluster.fork();

  let stopping = false;
  cluster.on('exit', (_worker, code) => {
    if (stopping) return;
    console.error(`worker exited (${code})`);
    process.exitCode = 1;
    cluster.disconnect();
  });

  const shutdown = () => {
    stopping = true;
    for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill('SIGTERM');
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function startWorker(poolSize: number): Promise<void> {
  const queries = loadQueries();
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: poolSize,
    min: poolSize,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    application_name: 'node-api',
  });
  pool.on('error', (err) => console.error('pool error', err.message));

  // Open every connection before accepting traffic.
  const clients = await Promise.all(Array.from({ length: poolSize }, () => pool.connect()));
  for (const client of clients) client.release();

  async function getProduct(res: ServerResponse, rawId: string): Promise<void> {
    const id = parseInteger(rawId, 1, MAX_INT32);
    if (id === undefined) return sendError(res, 400, 'invalid id');

    const result = await pool.query({ name: 'product', text: queries.product, values: [id] });
    if (!result.rowCount) return sendError(res, 404, 'not found');
    sendJSON(res, 200, result.rows[0]);
  }

  async function listProducts(res: ServerResponse, search: string): Promise<void> {
    const params = new URLSearchParams(search);
    const tenant = parseInteger(params.get('tenant_id'), 1, 1000);
    const category = parseInteger(params.get('category_id'), 1, 100);
    const after = parseInteger(params.get('after') || '0', 0, MAX_INT32);
    const limit = parseInteger(params.get('limit') || '20', 1, 100);
    if (
      tenant === undefined ||
      category === undefined ||
      after === undefined ||
      limit === undefined
    ) {
      return sendError(res, 400, 'invalid query');
    }

    const result = await pool.query({
      name: 'list',
      text: queries.list,
      values: [tenant, category, after, limit],
    });
    sendJSON(res, 200, result.rows);
  }

  async function reserve(res: ServerResponse, rawId: string): Promise<void> {
    const id = parseInteger(rawId, 1, MAX_INT32);
    if (id === undefined) return sendError(res, 400, 'invalid id');

    const result = await pool.query({ name: 'reserve', text: queries.reserve, values: [id] });
    if (!result.rowCount) return sendError(res, 409, 'unavailable');
    sendJSON(res, 200, result.rows[0]);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The path and query string are split by hand to avoid allocating a URL object per request.
    const url = req.url ?? '/';
    const queryStart = url.indexOf('?');
    const path = queryStart === -1 ? url : url.slice(0, queryStart);
    const search = queryStart === -1 ? '' : url.slice(queryStart + 1);

    if (req.method === 'GET') {
      if (path === '/health') return sendJSON(res, 200, { status: 'ok' });
      if (path === '/ready') {
        await pool.query('SELECT 1');
        return sendJSON(res, 200, { status: 'ok' });
      }
      if (path === '/products') return listProducts(res, search);
      if (path.startsWith('/products/')) {
        const id = path.slice('/products/'.length);
        if (id && !id.includes('/')) return getProduct(res, id);
      }
    } else if (
      req.method === 'POST' &&
      path.startsWith('/inventory/') &&
      path.endsWith('/reserve')
    ) {
      const id = path.slice('/inventory/'.length, -'/reserve'.length);
      if (id && !id.includes('/')) return reserve(res, id);
    }
    sendError(res, 404, 'not found');
  }

  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    req.resume();
    route(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 503, 'database unavailable');
    });
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.requestTimeout = 10_000;

  const port = Number(process.env.PORT ?? '8080');
  server.listen(port, '0.0.0.0', () => {
    console.log(`worker ${process.pid} ready, pool=${poolSize}`);
  });

  const shutdown = () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const workers = parseInteger(process.env.NODE_WORKERS ?? '2', 1, 64);
const totalPool = parseInteger(process.env.DB_POOL_SIZE ?? '32', 1, 64);
if (!workers || !totalPool || totalPool % workers !== 0) {
  throw new Error('DB_POOL_SIZE must be 1..64 and divisible by NODE_WORKERS');
}

if (cluster.isPrimary) {
  startPrimary(workers);
} else {
  await startWorker(totalPool / workers);
}
