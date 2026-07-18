#!/usr/bin/env node
// dsp-ingest-e2e.js — live verification of the full NF-2 chain:
//   negotiate (existing) -> POST /dsp/ingest (Task 5) -> poll Trino for
//   the new bronze.dsp_ingest row count to increase.
//
// Requires a reachable live cluster and DSP_BASE_URL / TRINO_* env vars
// (or a --env-file matching setup_lakehouse.py's KEY=VALUE convention).
// Not part of `npm test` — run manually per orce/README.md's NF-2 section.
//
// Usage:
//   node tests/e2e/dsp-ingest-e2e.js --env-file .env.cluster

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

    console.log('1. Negotiating agreement for', assetId);
    const neg = await req('POST', baseUrl + '/dsp/negotiations', { counterparty: 'did:web:fap-iotai.facis.cloud', offerId: assetId.replace('dataset:', 'offer:') + ':read' });
    if (neg.statusCode >= 300 || !neg.body.agreementId) throw new Error('negotiation failed: ' + JSON.stringify(neg.body));
    console.log('   agreementId =', neg.body.agreementId);

    console.log('2. Checking bronze.dsp_ingest row count before ingest');
    const before = await trinoRowCount(trinoUrl, catalog, trinoUser, trinoPassword);
    console.log('   before =', before);

    console.log('3. POST /dsp/ingest');
    const ingest = await req('POST', baseUrl + '/dsp/ingest', { providerBaseUrl: baseUrl, assetId, agreementId: neg.body.agreementId });
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
