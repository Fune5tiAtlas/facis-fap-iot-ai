// QA test #16: catalog request responds < 500 ms at p95.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.DSP_BASE_URL;
const AUTH = __ENV.DSP_AUTH_HEADER || '';

export const options = {
    vus: Number(__ENV.PERF_VUS || 10),
    duration: __ENV.PERF_DURATION || '60s',
    thresholds: {
        http_req_duration: ['p(95)<500'],
        checks: ['rate>0.99'],
    },
};

export default function () {
    const headers = { 'Content-Type': 'application/json' };
    if (AUTH) headers.Authorization = AUTH;
    const res = http.post(
        `${BASE}/dsp/catalogue/request`,
        JSON.stringify({ filter: {}, page: { limit: 50, cursor: null } }),
        { headers }
    );
    check(res, {
        'status 200': (r) => r.status === 200,
        'has datasets': (r) => Array.isArray(r.json('datasets')),
    });
}
