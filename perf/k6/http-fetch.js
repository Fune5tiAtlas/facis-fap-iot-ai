// QA test #18: HTTP data fetch completes < 2 s for 1000 sensor readings.
// setup() provisions one http-pull transfer via the DSP control plane and
// every VU then pulls the signed URL.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.DSP_BASE_URL;
const AUTH = __ENV.DSP_AUTH_HEADER || '';
const ASSET = __ENV.PERF_ASSET_ID || 'dataset:facis:net-grid-hourly';

export const options = {
    vus: Number(__ENV.PERF_VUS || 10),
    duration: __ENV.PERF_DURATION || '60s',
    thresholds: {
        'http_req_duration{phase:fetch}': ['p(95)<2000'],
        checks: ['rate>0.99'],
    },
};

export function setup() {
    const headers = { 'Content-Type': 'application/json' };
    if (AUTH) headers.Authorization = AUTH;

    const neg = http.post(
        `${BASE}/dsp/negotiations`,
        JSON.stringify({ counterparty: 'did:web:perf.facis.cloud', offerId: `offer:${ASSET}:read` }),
        { headers }
    );
    if (neg.status !== 202) throw new Error(`negotiation failed: ${neg.status} ${neg.body}`);
    const negState = http.get(`${BASE}/dsp/negotiations/${neg.json('negotiationId')}`, { headers });
    const agreementId = negState.json('agreementId');

    const tx = http.post(
        `${BASE}/dsp/transfers`,
        JSON.stringify({
            agreementId,
            assetId: ASSET,
            format: 'http-pull',
            parameters: {
                windowFrom: __ENV.PERF_WINDOW_FROM || '',
                windowTo: __ENV.PERF_WINDOW_TO || '',
            },
        }),
        { headers }
    );
    if (tx.status !== 202) throw new Error(`transfer failed: ${tx.status} ${tx.body}`);
    const txState = http.get(`${BASE}/dsp/transfers/${tx.json('transferId')}`, { headers });
    const url = txState.json('access.url');
    if (!url) throw new Error(`no access url on transfer: ${txState.body}`);
    return { url };
}

export default function (data) {
    const res = http.get(data.url, { tags: { phase: 'fetch' } });
    check(res, {
        'status 200': (r) => r.status === 200,
        '>= 1000 readings': (r) => {
            const body = r.json();
            const rows = Array.isArray(body) ? body : (body && body.data) || [];
            return rows.length >= 1000;
        },
    });
}
