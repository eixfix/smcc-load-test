import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const scenarioOptions: Record<string, { vus: number; duration: string }> = {
  SMOKE: { vus: 2, duration: '30s' },
  STRESS: { vus: 5, duration: '1m' },
  SOAK: { vus: 3, duration: '2m' },
  SPIKE: { vus: 10, duration: '20s' },
  CUSTOM: { vus: 20, duration: '1m' }
};

const customVusOverride = Number(__ENV.CUSTOM_VUS ?? '');
if (!Number.isNaN(customVusOverride) && customVusOverride > 0) {
  scenarioOptions.CUSTOM = {
    ...scenarioOptions.CUSTOM,
    vus: Math.round(customVusOverride)
  };
}

const customDurationOverride = Number(__ENV.CUSTOM_DURATION_SECONDS ?? '');
if (!Number.isNaN(customDurationOverride) && customDurationOverride > 0) {
  scenarioOptions.CUSTOM = {
    ...scenarioOptions.CUSTOM,
    duration: formatDurationSeconds(Math.round(customDurationOverride))
  };
}

const selectedMode = (__ENV.MODE ?? 'SMOKE').toUpperCase();
const enforceThresholds = (__ENV.ENFORCE_THRESHOLDS ?? 'false').toLowerCase() === 'true';

const statusTrend = new Trend('status_codes', true);
const statusCounts: Record<number, number> = {};
const statusOrder: number[] = [];
const authErrorCounter = new Counter('auth_errors');
const clientErrorCounter = new Counter('client_errors');
const serverErrorCounter = new Counter('server_errors');

function formatDurationSeconds(totalSeconds: number): string {
  const safeSeconds = Math.max(1, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  const parts: string[] = [];

  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join('');
}

export const options = {
  ...(scenarioOptions[selectedMode] ?? scenarioOptions.SMOKE),
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(75)', 'p(90)', 'p(95)', 'p(99)'],
  ...(enforceThresholds
    ? {
        thresholds: {
          http_req_failed: ['rate<0.05'],
          http_req_duration: ['p(95)<3500']
        }
      }
    : {})
};

const targetUrl = __ENV.TARGET_URL ?? __ENV.API_BASE_URL;
const method = (__ENV.HTTP_METHOD ?? 'GET').toUpperCase();

let headers: Record<string, string> = {};
if (__ENV.HTTP_HEADERS) {
  try {
    headers = JSON.parse(__ENV.HTTP_HEADERS) as Record<string, string>;
  } catch (error) {
    console.warn('Unable to parse HTTP_HEADERS env. Falling back to no headers.', error);
  }
}

let body: string | null = __ENV.HTTP_BODY ? String(__ENV.HTTP_BODY) : null;
if (method === 'GET' || method === 'HEAD') {
  body = null;
}

export default function runScenario(): void {
  if (!targetUrl) {
    console.log('Skipping load test: TARGET_URL/API_BASE_URL is not set.');
    sleep(1);
    return;
  }

  let response: http.Response;
  try {
    response = http.request(method, targetUrl, body, {
      headers
    });
  } catch (error) {
    const existing = dataErrors.server ?? [];
    if (existing.length < 3) {
      existing.push({
        status: 0,
        message: (error as Error)?.message ?? 'request threw',
        url: targetUrl
      });
    }
    dataErrors.server = existing;
    serverErrorCounter.add(1);
    sleep(1);
    return;
  }

  check(response, {
    'status is < 400': (res) => res.status !== 0 && res.status < 400
  });

  statusTrend.add(response.status);
  statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
  if (!statusOrder.includes(response.status)) {
    statusOrder.push(response.status);
  }

  if (response.status === 0 || response.status >= 400) {
    const bucket =
      response.status === 401 || response.status === 403
        ? 'auth'
        : response.status >= 500 || response.status === 0
          ? 'server'
          : 'client';
    const existing = dataErrors[bucket] ?? [];
    if (existing.length < 3) {
      existing.push({
        status: response.status,
        message: response.error || `HTTP ${response.status}`,
        url: targetUrl
      });
    }
    dataErrors[bucket] = existing;
    if (bucket === 'auth') {
      authErrorCounter.add(1);
    } else if (bucket === 'client') {
      clientErrorCounter.add(1);
    } else {
      serverErrorCounter.add(1);
    }
  }

  sleep(1);
}

const dataErrors: Record<
  'auth' | 'client' | 'server',
  Array<{ status: number; message: string; url: string }>
> = {
  auth: [],
  client: [],
  server: []
};

export function handleSummary(data: any) {
  if (!enforceThresholds) {
    const failedRate = data.metrics?.http_req_failed?.rate;
    const p95 = data.metrics?.http_req_duration?.['p(95)'];
    if (typeof failedRate === 'number' && failedRate > 0.05) {
      console.warn(`http_req_failed threshold exceeded (rate=${failedRate}). Result will still be saved.`);
    }
    if (typeof p95 === 'number' && p95 > 2200) {
      console.warn(`http_req_duration threshold exceeded (p95=${p95}ms). Result will still be saved.`);
    }
  }

  const metrics = data.metrics ?? {};
  const fmtPct = (value?: number) =>
    typeof value === 'number' ? `${(value * 100).toFixed(2)}%` : 'n/a';
  const fmtMs = (value?: number) => (typeof value === 'number' ? `${value.toFixed(2)} ms` : 'n/a');
  const fmtCount = (value?: number) => (typeof value === 'number' ? value.toLocaleString() : 'n/a');
  const fmtRate = (value?: number) => (typeof value === 'number' ? `${value.toFixed(2)}/s` : 'n/a');

  const httpReqs = metrics.http_reqs?.values ?? {};
  const httpFailed = metrics.http_req_failed ?? {};
  const latency = metrics.http_req_duration?.values ?? {};
  const statusMetrics = metrics.status_codes?.values ?? {};
  const authErrorCount = metrics.auth_errors?.values?.count;
  const clientErrorCount = metrics.client_errors?.values?.count;
  const serverErrorCount = metrics.server_errors?.values?.count;

  const rateFailed = httpFailed.rate ?? httpFailed.values?.rate;
  const successRate = typeof rateFailed === 'number' ? Math.max(0, 1 - rateFailed) : undefined;
  const p95 = latency['p(95)'];
  const p99 = latency['p(99)'];
  const p75 = latency['p(75)'];
  const avg = latency.avg ?? latency.average;
  const authErrors = dataErrors.auth ?? [];
  const clientErrors = dataErrors.client ?? [];
  const serverErrors = dataErrors.server ?? [];

  const color = (ok: boolean) => (ok ? '\u001b[32m' : '\u001b[31m');
  const reset = '\u001b[0m';

  const errorsSection = [
    `${color((rateFailed ?? 0) < 0.05)}Errors${reset}`,
    `- Requests: ${fmtCount(httpReqs.count)} (${fmtRate(httpReqs.rate)})`,
    `- Failed rate: ${fmtPct(rateFailed)}`,
    `- Success rate: ${fmtPct(successRate)}`,
    authErrors.length
      ? `- Auth errors: ${authErrors.length} (example status=${authErrors[0].status} url=${authErrors[0].url} msg=${authErrors[0].message})`
      : '- Auth errors: none',
    clientErrors.length
      ? `- Client errors: ${clientErrors.length} (example status=${clientErrors[0].status} url=${clientErrors[0].url} msg=${clientErrors[0].message})`
      : '- Client errors: none',
    serverErrors.length
      ? `- Server errors: ${serverErrors.length} (example status=${serverErrors[0].status} url=${serverErrors[0].url} msg=${serverErrors[0].message})`
      : '- Server errors: none'
  ];

  const latencySection = [
    `${color((p95 ?? 0) < 2200)}Latency${reset}`,
    `- p95: ${fmtMs(p95)}`,
    `- p99: ${fmtMs(p99)}`,
    `- p75: ${fmtMs(p75)}`,
    `- avg: ${fmtMs(avg)}`,
    `- min/max: ${fmtMs(latency.min)} / ${fmtMs(latency.max)}`,
    `- p50: ${fmtMs(latency.med)} p90: ${fmtMs(latency['p(90)'])}`
  ];

  const throughputSection = [
    'Throughput',
    `- Iterations: ${fmtCount(metrics.iterations?.values?.count)} (${fmtRate(metrics.iterations?.values?.rate)})`,
    `- Data in/out: ${fmtCount(metrics.data_received?.values?.count)} bytes / ${fmtCount(
      metrics.data_sent?.values?.count
    )} bytes`
  ];

  const vusSection = [
    'Resources',
    `- VUs: current=${fmtCount(metrics.vus?.values?.value)} max=${fmtCount(metrics.vus_max?.values?.max)}`
  ];

  const statusSection = [
    'Status codes',
    `- min/max: ${fmtCount(statusMetrics.min)} / ${fmtCount(statusMetrics.max)}`,
    `- p50/p90/p99: ${fmtCount(statusMetrics.med)} / ${fmtCount(statusMetrics['p(90)'])} / ${fmtCount(statusMetrics['p(99)'])}`,
    `- top codes: ${
      statusOrder.length
        ? statusOrder
            .slice(0, 5)
            .map((code) => `${code} (${statusCounts[code] ?? 0})`)
            .join(', ')
        : 'none captured'
    }`,
    `- auth error count: ${fmtCount(authErrorCount)} client: ${fmtCount(clientErrorCount)} server: ${fmtCount(serverErrorCount)}`
  ];

  if ((rateFailed ?? 0) > 0 && authErrors.length + clientErrors.length + serverErrors.length === 0) {
    errorsSection.push('- Failures detected but no error samples captured. Check connectivity/auth.');
  }

  const sections = [
    '=== k6 Summary ===',
    `Scenario: ${data.state?.testRunDurationMs ? `${(data.state.testRunDurationMs / 1000).toFixed(1)}s` : 'n/a'}`,
    '',
    ...errorsSection,
    '',
    ...latencySection,
    '',
    'Checks',
    `- status < 500: passes=${fmtCount(metrics.checks?.values?.passes)} fails=${fmtCount(
      metrics.checks?.values?.fails
    )}`,
    '',
    ...throughputSection,
    '',
    ...vusSection,
    '',
    ...statusSection
  ];

  return {
    stdout: sections.join('\n')
  };
}
