#!/usr/bin/env node
// dsp-ingest-e2e.js — live verification of the full NF-2 chain:
//   negotiate (existing) -> POST /dsp/ingest (Task 5) -> poll Trino for
//   the new bronze.dsp_ingest row count to increase.
//
// This exercises the AUTHENTICATED path: the connector's /dsp/ingest handler
// now mints a self-issued VP (iam.issue) and Bearer-attaches it to its own
// internal provider hops, so this E2E works whether DSP_IAM_ENFORCE is warn
// or enforce. POST /dsp/ingest is itself iam.verify-gated too; under enforce
// this script must present a Bearer VP on the ingest request. Supply one via
// --vp-token <jwt> (or the DSP_VP_TOKEN env var); mint it with the connector's
// own POST /iam/oid4vci/credential + a VP wrapper, or reuse tests/fixtures/iam.
// Under warn/off no token is needed and the flag may be omitted.
//
// NOTE (enforce, flow #3): the connector's own DID (DSP_CONNECTOR_DID) must be
// listed in DSP_TRUSTED_ISSUERS for the provider to accept the self-issued VP
// on the internal hops — see orce/README.md's NF-2 section.
//
// Requires a reachable live cluster and DSP_BASE_URL / TRINO_* env vars
// (or a --env-file matching setup_lakehouse.py's KEY=VALUE convention).
// Not part of `npm test` — run manually per orce/README.md's NF-2 section.
//
// Usage:
//   node tests/e2e/dsp-ingest-e2e.js --env-file .env.cluster [--vp-token <jwt>]

const fs = require('fs');
const https = require('https');

function loadEnvFile(path) {
    if (!path) return;
    for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const [key, ...rest] = trimmed.split('=');
        process.env[key.trim()] = rest.join('=').trim();
    }
}

function req(method, url, body, headers) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const opts = { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), rejectUnauthorized: false };
        const r = https.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
                catch (e) { resolve({ statusCode: res.statusCode, body: data }); }
            });
        });
        r.on('error', reject);
        if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
        r.end();
    });
}

async function trinoRowCount(trinoUrl, catalog, user, password) {
    const auth = 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
    // Headers match dsp-data-trino-fn's own Trino calls (Task 2, proven-working
    // reference): Basic auth, X-Trino-Catalog/Schema, text/plain body (raw SQL).
    const headers = { Authorization: auth, 'X-Trino-User': user, 'X-Trino-Catalog': catalog, 'X-Trino-Schema': 'bronze', 'Content-Type': 'text/plain' };
    const sql = 'SELECT COUNT(*) FROM "' + catalog + '".bronze.dsp_ingest';
    // For brevity this only reads the first page's row count column; a
    // COUNT(*) query always returns exactly one row in one page.
    let result = (await req('POST', trinoUrl + '/v1/statement', sql, headers)).body;
    while (result && result.nextUri && !result.data) {
        result = (await req('GET', result.nextUri, undefined, headers)).body;
    }
    return result && result.data ? Number(result.data[0][0]) : null;
}

async function main() {
    const envFileIdx = process.argv.indexOf('--env-file');
    if (envFileIdx !== -1) loadEnvFile(process.argv[envFileIdx + 1]);

    const baseUrl = (process.env.DSP_BASE_URL || 'https://fap-iotai.facis.cloud').replace(/\/$/, '');
    const trinoUrl = process.env.FACIS_TRINO_URL || 'https://212.132.83.150:8443';
    const catalog = process.env.FACIS_TRINO_CATALOG || 'fap-iotai-stackable';
    const trinoUser = process.env.FACIS_TRINO_USER || 'admin';
    const trinoPassword = process.env.FACIS_TRINO_PASSWORD || '';
    const assetId = process.argv.includes('--asset-id') ? process.argv[process.argv.indexOf('--asset-id') + 1] : 'dataset:facis:net-grid-hourly';

    // Bearer VP for the iam.verify-gated /dsp/* endpoints. Required under
    // DSP_IAM_ENFORCE=enforce, ignored (harmlessly) under warn/off.
    const vpToken = process.argv.includes('--vp-token') ? process.argv[process.argv.indexOf('--vp-token') + 1] : process.env.DSP_VP_TOKEN;
    const dspAuth = vpToken ? { Authorization: 'Bearer ' + vpToken } : {};
    console.log('0. auth:', vpToken ? 'presenting Bearer VP (enforce-ready)' : 'no VP supplied (warn/off only)');

    console.log('1. Negotiating agreement for', assetId);
    const neg = await req('POST', baseUrl + '/dsp/negotiations', { counterparty: 'did:web:fap-iotai.facis.cloud', offerId: assetId.replace('dataset:', 'offer:') + ':read' }, dspAuth);
    if (neg.statusCode >= 300 || !neg.body.negotiationId) throw new Error('negotiation failed: ' + JSON.stringify(neg.body));
    console.log('   negotiation created, negotiationId =', neg.body.negotiationId);

    // POST /dsp/negotiations auto-finalises server-side but only returns
    // {negotiationId} (see dsp-neg-create in facis-dsp-negotiations.json);
    // the agreementId is only available via a follow-up GET.
    const negGet = await req('GET', baseUrl + '/dsp/negotiations/' + neg.body.negotiationId, undefined, dspAuth);
    if (negGet.statusCode >= 300 || !negGet.body.agreementId) throw new Error('negotiation lookup failed: ' + JSON.stringify(negGet.body));
    console.log('   agreement finalized, agreementId =', negGet.body.agreementId);

    console.log('2. Checking bronze.dsp_ingest row count before ingest');
    const before = await trinoRowCount(trinoUrl, catalog, trinoUser, trinoPassword);
    console.log('   before =', before);

    console.log('3. POST /dsp/ingest');
    const ingest = await req('POST', baseUrl + '/dsp/ingest', { providerBaseUrl: baseUrl, assetId, agreementId: negGet.body.agreementId }, dspAuth);
    if (ingest.statusCode !== 202) throw new Error('ingest failed: ' + JSON.stringify(ingest.body));
    console.log('   accepted, rowCount =', ingest.body.rowCount);

    console.log('4. Polling bronze.dsp_ingest for the row count to increase (up to 60s)');
    const deadline = Date.now() + 60000;
    let after = before;
    while (Date.now() < deadline) {
        after = await trinoRowCount(trinoUrl, catalog, trinoUser, trinoPassword);
        if (after !== null && before !== null && after > before) break;
        await new Promise((r) => setTimeout(r, 3000));
    }
    console.log('   after =', after);

    if (before !== null && after !== null && after > before) {
        console.log('PASS: bronze.dsp_ingest grew from', before, 'to', after);
        process.exit(0);
    }
    console.error('FAIL: bronze.dsp_ingest row count did not increase within 60s (NiFi flow may not be running — see Task 3\'s --add-topic step)');
    process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
