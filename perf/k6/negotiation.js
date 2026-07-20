// QA test #17: negotiation completes within 5 seconds.
// The FACIS stub auto-finalizes, so create + immediate GET measures the full
// request->FINALIZED cycle.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.DSP_BASE_URL;
const AUTH = __ENV.DSP_AUTH_HEADER || '';

export const options = {
    vus: Number(__ENV.PERF_VUS || 5),
    duration: __ENV.PERF_DURATION || '60s',
    thresholds: {
        http_req_duration: ['p(95)<5000'],
        checks: ['rate>0.99'],
    },
};

export default function () {
    const headers = { 'Content-Type': 'application/json' };
    if (AUTH) headers.Authorization = AUTH;

    const create = http.post(
        `${BASE}/dsp/negotiations`,
        JSON.stringify({ counterparty: 'did:web:perf.facis.cloud', offerId: 'offer:perf' }),
        { headers }
    );
    const ok = check(create, { 'create 202': (r) => r.status === 202 });
    if (!ok) return;

    const negId = create.json('negotiationId');
    const state = http.get(`${BASE}/dsp/negotiations/${negId}`, { headers });
    check(state, {
        'get 200': (r) => r.status === 200,
        'finalized': (r) => r.json('state') === 'FINALIZED',
    });
}
