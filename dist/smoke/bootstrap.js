// smoke/bootstrap.ts
import http from "k6/http";
import { check, sleep } from "k6";
var scenarioOptions = {
  SMOKE: { vus: 2, duration: "30s" },
  STRESS: { vus: 5, duration: "1m" },
  SOAK: { vus: 3, duration: "2m" },
  SPIKE: { vus: 10, duration: "20s" },
  CUSTOM: { vus: 100, duration: "1m" }
};
var selectedMode = (__ENV.MODE ?? "SMOKE").toUpperCase();
var options = {
  ...scenarioOptions[selectedMode] ?? scenarioOptions.SMOKE,
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2200"]
  }
};
var targetUrl = __ENV.TARGET_URL ?? __ENV.API_BASE_URL;
var method = (__ENV.HTTP_METHOD ?? "GET").toUpperCase();
var headers = {};
if (__ENV.HTTP_HEADERS) {
  try {
    headers = JSON.parse(__ENV.HTTP_HEADERS);
  } catch (error) {
    console.warn("Unable to parse HTTP_HEADERS env. Falling back to no headers.", error);
  }
}
var body = __ENV.HTTP_BODY ? String(__ENV.HTTP_BODY) : null;
if (method === "GET" || method === "HEAD") {
  body = null;
}
function runScenario() {
  if (!targetUrl) {
    console.log("Skipping load test: TARGET_URL/API_BASE_URL is not set.");
    sleep(1);
    return;
  }
  const response = http.request(method, targetUrl, body, {
    headers
  });
  check(response, {
    "status is < 500": (res) => res.status !== 0 && res.status < 500
  });
  sleep(1);
}
export {
  runScenario as default,
  options
};
