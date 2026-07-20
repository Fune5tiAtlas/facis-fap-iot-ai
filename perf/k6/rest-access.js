// QA test #21: data retrieval via REST interface < 1 s (p95).
// Target: AI Insight REST read path (Trino-backed). Requires a Bearer token
// with realm role ai_insight_consumer (NF-6).
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.AI_BASE_URL;
const TOKEN = __ENV.FACIS_TOKEN || '';

export const options = {
    vus: Number(__ENV.PERF_VUS || 10),
    duration: __ENV.PERF_DURATION || '60s',
    thresholds: {
        http_req_duration: ['p(95)<1000'],
        checks: ['rate>0.99'],
    },
};

export default function () {
    const res = http.get(`${BASE}/api/v1/insights/latest`, {
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    });
    check(res, {
        'status 200': (r) => r.status === 200,
        'has latest map': (r) => r.json('latest') !== undefined,
    });
}
