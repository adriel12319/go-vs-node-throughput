import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL;
const WORKLOAD = __ENV.WORKLOAD || 'pk';
const VUS = Number(__ENV.VUS || 64);
const PRODUCTS = 5_100_000;
const INVENTORY = 100_000;

if (!['json', 'pk', 'list', 'mixed'].includes(WORKLOAD)) throw new Error('invalid workload');

const successful = new Counter('successful_requests');
const badResponses = new Rate('bad_responses');

export const options = {
  scenarios: {
    load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: __ENV.DURATION || '30s',
      gracefulStop: '5s',
    },
  },
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: ['rate<0.001'],
    bad_responses: ['rate<0.001'],
  },
};

// Per-VU xorshift32 seeded by the VU id: both APIs receive the same request stream.
let state = 0;
function random(max) {
  if (!state) state = (exec.vu.idInTest * 2654435761) >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) % max;
}

function pickOperation() {
  if (WORKLOAD !== 'mixed') return WORKLOAD;
  const n = random(10);
  if (n < 7) return 'pk';
  if (n < 9) return 'list';
  return 'write';
}

function send(operation) {
  const params = { tags: { name: operation }, timeout: '10s' };
  switch (operation) {
    case 'json':
      return http.get(`${BASE_URL}/health`, params);
    case 'pk':
      return http.get(`${BASE_URL}/products/${random(PRODUCTS) + 1}`, params);
    case 'list': {
      const tenant = random(1000) + 1;
      const category = random(100) + 1;
      const query = `tenant_id=${tenant}&category_id=${category}&after=0&limit=20`;
      return http.get(`${BASE_URL}/products?${query}`, params);
    }
    case 'write':
      return http.post(`${BASE_URL}/inventory/${random(INVENTORY) + 1}/reserve`, null, params);
  }
}

export default function () {
  const response = send(pickOperation());
  const ok = check(response, {
    'status 200': (r) => r.status === 200,
    'JSON response': (r) => (r.headers['Content-Type'] || '').startsWith('application/json'),
  });
  badResponses.add(!ok);
  if (ok) successful.add(1);
}

export function handleSummary(data) {
  const { metrics } = data;
  const summary = {
    workload: WORKLOAD,
    vus: VUS,
    rps: metrics.http_reqs.values.rate,
    successful_rps: metrics.successful_requests?.values.rate || 0,
    p95_ms: metrics.http_req_duration.values['p(95)'],
    p99_ms: metrics.http_req_duration.values['p(99)'],
    error_rate: metrics.http_req_failed.values.rate,
    bad_response_rate: metrics.bad_responses.values.rate,
  };
  return {
    [__ENV.OUTPUT || '/results/summary.json']: JSON.stringify({ summary, ...data }, null, 2),
    stdout: JSON.stringify(summary) + '\n',
  };
}
