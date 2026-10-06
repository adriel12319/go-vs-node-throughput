// Runs the benchmark matrix: one backend at a time, alternating order, warm-up before each trial.
// Usage: node scripts/benchmark.mjs [--quick] [--resume <run-id>]
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SERVICES = ['go-api', 'node-api'];
const WORKLOADS = ['json', 'pk', 'list', 'mixed'];
const K6_IMAGE = 'grafana/k6:1.3.0';

const quick = process.argv.includes('--quick');
const matrix = {
  workloads: (process.env.WORKLOADS || WORKLOADS.join(',')).split(','),
  vus: (process.env.VUS_LIST || (quick ? '64' : '16,64,256')).split(',').map(Number),
  repeats: Number(process.env.REPEATS || (quick ? 2 : 3)),
  duration: process.env.DURATION || (quick ? '15s' : '30s'),
  warmup: process.env.WARMUP || (quick ? '5s' : '10s'),
};
if (
  matrix.workloads.some((w) => !WORKLOADS.includes(w)) ||
  matrix.vus.some((n) => !Number.isInteger(n) || n < 1) ||
  !Number.isInteger(matrix.repeats) ||
  matrix.repeats < 1
) {
  throw new Error('invalid benchmark matrix');
}

// --resume continues an interrupted run, skipping the trials it already recorded.
const resumeFlag = process.argv.indexOf('--resume');
const resumed = resumeFlag !== -1;
const runId = resumed
  ? process.argv[resumeFlag + 1]
  : new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(ROOT, 'results', runId);
if (resumed && !existsSync(join(outDir, 'runs.json')))
  throw new Error(`nothing to resume in ${outDir}`);
mkdirSync(outDir, { recursive: true });

function docker(args, { capture = false } = {}) {
  return execFileSync('docker', args, {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function compose(args, options) {
  return docker(['compose', ...args], options);
}

function sql(query) {
  const psql = ['psql', '-U', 'bench', '-d', 'bench', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', query];
  return compose(['exec', '-T', 'postgres', ...psql], { capture: true }).trim();
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitHealthy(service) {
  const id = compose(['ps', '-q', service], { capture: true }).trim();
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = docker(['inspect', '-f', '{{.State.Health.Status}}', id], { capture: true });
    if (status.trim() === 'healthy') return;
    await sleep(1000);
  }
  throw new Error(`${service} did not become healthy`);
}

async function runOnly(service) {
  for (const other of SERVICES.filter((s) => s !== service)) compose(['stop', other]);
  compose(['start', service]);
  await waitHealthy(service);
}

// Every mixed trial starts from the same balances and with no dead tuples.
function resetInventory() {
  sql('UPDATE inventory SET available = 1000000');
  sql('VACUUM (ANALYZE) inventory');
}

function prewarm() {
  const relations = [
    'products',
    'products_pkey',
    'products_tenant_category_page',
    'inventory',
    'inventory_pkey',
  ];
  sql(relations.map((name) => `SELECT pg_prewarm('${name}')`).join('; '));
}

function queryPlans() {
  const columns = 'id, tenant_id, category_id, name, price_cents, stock';
  return sql(`
    EXPLAIN (ANALYZE, BUFFERS)
      SELECT ${columns} FROM products WHERE id = 1234567;
    EXPLAIN (ANALYZE, BUFFERS)
      SELECT ${columns} FROM products
      WHERE tenant_id = 123 AND category_id = 45 AND active = true AND id > 0
      ORDER BY id LIMIT 20;
  `);
}

function postgresSnapshot() {
  return JSON.parse(
    sql(`
      SELECT json_build_object(
        'database', (
          SELECT row_to_json(d) FROM (
            SELECT blks_read, blks_hit, tup_returned, tup_fetched, tup_updated
            FROM pg_stat_database WHERE datname = 'bench'
          ) d
        ),
        'queries', (
          SELECT coalesce(json_agg(q), '[]'::json) FROM (
            SELECT query, calls, rows, total_exec_time, shared_blks_hit, shared_blks_read, wal_bytes
            FROM pg_stat_statements
            WHERE query LIKE 'SELECT id,%' OR query LIKE 'UPDATE inventory SET available = available -%'
          ) q
        )
      )
    `),
  );
}

// Samples `docker stats` while a trial runs and returns the median CPU% per container role.
function sampleCpu() {
  const samples = { backend: [], postgres: [], generator: [] };
  const child = spawn('docker', ['stats', '--format', '{{.Name}} {{.CPUPerc}}'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let pending = '';
  child.stdout.on('data', (chunk) => {
    // docker stats redraws the terminal, so strip the ANSI control sequences first.
    pending += chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const [name, cpu] = line.trim().split(' ');
      const value = Number.parseFloat(cpu);
      if (!name || !Number.isFinite(value)) continue;
      if (name.startsWith('bench-load-')) samples.generator.push(value);
      else if (name.endsWith('-postgres-1')) samples.postgres.push(value);
      else if (SERVICES.some((s) => name.endsWith(`-${s}-1`))) samples.backend.push(value);
    }
  });
  return () => {
    child.kill();
    return Object.fromEntries(
      Object.entries(samples).map(([role, values]) => [role, median(values)]),
    );
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function runK6(service, workload, vus, duration, name) {
  const env = {
    BASE_URL: `http://${service}:8080`,
    WORKLOAD: workload,
    VUS: vus,
    DURATION: duration,
    OUTPUT: `/results/${runId}/${name}.json`,
  };
  const args = [
    'compose',
    'run',
    '--rm',
    '--no-deps',
    '--name',
    `bench-load-${runId.toLowerCase()}`,
  ];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push('k6', 'run', '--quiet', '/scripts/load.js');

  const log = createWriteStream(join(outDir, `${name}.log`));
  const child = spawn('docker', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  try {
    const code = await new Promise((done, fail) => {
      child.on('error', fail);
      child.on('exit', done);
    });
    if (code !== 0) throw new Error(`k6 failed (${code}); see ${name}.log`);
    return JSON.parse(readFileSync(join(outDir, `${name}.json`), 'utf8')).summary;
  } finally {
    log.end();
  }
}

async function runTrial(service, workload, vus, rep, generatorCpus) {
  const name = `${workload}-vus${vus}-rep${rep}-${service}`;
  await runOnly(service);

  if (workload === 'mixed') resetInventory();
  console.log(`warm-up  ${name} (${matrix.warmup})`);
  await runK6(service, workload, vus, matrix.warmup, `${name}-warmup`);
  if (workload === 'mixed') resetInventory();

  console.log(`measure  ${name} (${matrix.duration})`);
  const before = postgresSnapshot();
  const stopSampling = sampleCpu();
  let summary;
  let cpu;
  try {
    summary = await runK6(service, workload, vus, matrix.duration, name);
  } finally {
    cpu = stopSampling();
  }
  writeFileSync(
    join(outDir, `${name}.postgres.json`),
    JSON.stringify({ before, after: postgresSnapshot() }, null, 2),
  );

  // A generator near its CPU quota means the result is a lower bound, not a measurement.
  const generatorSaturated = cpu.generator === null || cpu.generator >= generatorCpus * 100 * 0.9;
  return {
    service,
    rep,
    ...summary,
    backend_cpu: cpu.backend,
    postgres_cpu: cpu.postgres,
    generator_cpu: cpu.generator,
    generator_saturated: generatorSaturated,
  };
}

function collectMetadata(config) {
  const info = JSON.parse(docker(['info', '--format', '{{json .}}'], { capture: true }));
  const imageId = (service) => {
    const id = compose(['images', '-q', service], { capture: true }).trim();
    return id.slice(0, 19);
  };
  const limits = (service) => ({
    cpus: Number(config.services[service].cpus),
    memory_mb: Math.round(Number(config.services[service].mem_limit) / 2 ** 20),
  });
  return {
    started_at: new Date().toISOString(),
    matrix,
    host: {
      cpus: info.NCPU,
      memory_gb: Math.round(info.MemTotal / 2 ** 30),
      os: info.OperatingSystem,
      kernel: info.KernelVersion,
    },
    limits: Object.fromEntries([...SERVICES, 'postgres', 'k6'].map((s) => [s, limits(s)])),
    pool_size: Number(config.services['go-api'].environment.DB_POOL_SIZE),
    versions: {
      go: compose(['exec', '-T', 'go-api', '/app/api', '--version'], { capture: true }).trim(),
      node: compose(['exec', '-T', 'node-api', 'node', '--version'], { capture: true }).trim(),
      postgres: sql('SHOW server_version'),
      k6: K6_IMAGE,
    },
    images: Object.fromEntries([...SERVICES, 'postgres'].map((s) => [s, imageId(s)])),
  };
}

function writeResults(results) {
  const columns = [
    'service',
    'workload',
    'vus',
    'rep',
    'successful_rps',
    'p95_ms',
    'p99_ms',
    'error_rate',
    'backend_cpu',
    'postgres_cpu',
    'generator_cpu',
    'generator_saturated',
  ];
  const format = (value) =>
    typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(2) : value;
  const rows = results.map((r) => columns.map((c) => format(r[c])).join(','));
  writeFileSync(join(outDir, 'runs.csv'), [columns.join(','), ...rows].join('\n') + '\n');
  writeFileSync(join(outDir, 'runs.json'), JSON.stringify(results, null, 2));
}

function printSummary(results) {
  console.log('\nMedian successful requests/s:');
  for (const workload of matrix.workloads) {
    for (const vus of matrix.vus) {
      const trials = results.filter((r) => r.workload === workload && r.vus === vus);
      const rps = (service) =>
        median(trials.filter((r) => r.service === service).map((r) => r.successful_rps));
      const [go, node] = SERVICES.map(rps);
      const note = trials.some((r) => r.generator_saturated)
        ? '  [generator saturated: lower bound only]'
        : '';
      const ratio = ((go / node - 1) * 100).toFixed(0);
      console.log(
        `  ${workload.padEnd(5)} vus=${String(vus).padEnd(4)} go=${go.toFixed(0)} node=${node.toFixed(0)} (${ratio}%)${note}`,
      );
    }
  }
  console.log(`\nResults: ${outDir}`);
}

process.chdir(ROOT);
const results = resumed ? JSON.parse(readFileSync(join(outDir, 'runs.json'), 'utf8')) : [];
const recorded = (service, workload, vus, rep) =>
  results.some(
    (r) => r.service === service && r.workload === workload && r.vus === vus && r.rep === rep,
  );
try {
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '1800', 'postgres', ...SERVICES]);
  compose(['--profile', 'load', 'pull', '--quiet', 'k6']);
  execFileSync(process.execPath, ['scripts/smoke.mjs'], { cwd: ROOT, stdio: 'inherit' });

  const seed = JSON.parse(sql('SELECT row_to_json(m) FROM benchmark_meta m'));
  if (seed.product_count !== 5_100_000 || seed.inventory_count !== 100_000) {
    throw new Error('unexpected seed size');
  }

  const config = JSON.parse(
    compose(['--profile', 'load', 'config', '--format', 'json'], { capture: true }),
  );
  const generatorCpus = Number(config.services.k6.cpus);
  if (!resumed) {
    writeFileSync(join(outDir, 'metadata.json'), JSON.stringify(collectMetadata(config), null, 2));
  }

  prewarm();
  writeFileSync(join(outDir, 'query-plans.txt'), queryPlans());

  for (const [index, workload] of matrix.workloads.entries()) {
    for (const vus of matrix.vus) {
      for (let rep = 1; rep <= matrix.repeats; rep++) {
        // Alternate which backend goes first to cancel out ordering effects.
        const order = (rep + index) % 2 ? SERVICES : [...SERVICES].reverse();
        for (const service of order) {
          if (recorded(service, workload, vus, rep)) continue;
          const result = await runTrial(service, workload, vus, rep, generatorCpus);
          results.push(result);
          writeResults(results);
          console.log(JSON.stringify(result));
        }
      }
    }
  }
  printSummary(results);
} finally {
  compose(['start', ...SERVICES]);
}
