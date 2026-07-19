#!/usr/bin/env node
// dsp-kafka-transfer-e2e.js — live verification of NF-3 (FR-DP-002):
//   negotiate -> POST /dsp/transfers (kafka-streaming) -> GET transfer must be
//   STARTED with a real topic + bootstrap and NO credential material ->
//   kcat -L proves the topic genuinely exists on the broker ->
//   terminate -> kcat -L proves the topic is genuinely gone.
//
// Requires: a reachable live cluster, `kcat` on PATH (brew install kcat), and
// the mTLS client PEMs on local disk (default /tmp/facis-kafka-certs/ —
// same material as Secret/facis-kafka-certs in the orce namespace, sourced
// from `Credentials and configs/credentials.txt`).
// Not part of `npm test` — run manually per orce/README.md's NF-3 section.
//
// Usage:
//   node tests/e2e/dsp-kafka-transfer-e2e.js [--env-file .env.cluster] [--asset-id dataset:facis:net-grid-hourly]

const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');

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

function kcatTopics(bootstrap, certDir) {
    // Same flags as the broker-discovery runbook. A full-metadata request
    // (`-L` with no -t) never auto-creates topics.
    const out = execFileSync('kcat', [
        '-L', '-b', bootstrap,
        '-X', 'security.protocol=ssl',
        '-X', 'ssl.ca.location=' + certDir + '/ca.crt',
        '-X', 'ssl.certificate.location=' + certDir + '/tls.crt',
        '-X', 'ssl.key.location=' + certDir + '/tls.key',
        '-X', 'ssl.endpoint.identification.algorithm=none'
    ], { encoding: 'utf8', timeout: 30000 });
    return [...out.matchAll(/topic "([^"]+)"/g)].map((m) => m[1]);
}

async function pollTopic(bootstrap, certDir, topic, wantPresent, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (kcatTopics(bootstrap, certDir).includes(topic) === wantPresent) return true;
        await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
}

async function main() {
    const envFileIdx = process.argv.indexOf('--env-file');
    if (envFileIdx !== -1) loadEnvFile(process.argv[envFileIdx + 1]);

    const baseUrl = (process.env.DSP_BASE_URL || 'https://fap-iotai.facis.cloud').replace(/\/$/, '');
    const bootstrap = process.env.DSP_KAFKA_BOOTSTRAP || '212.132.83.222:9093';
    const certDir = process.env.KAFKA_CERT_DIR || '/tmp/facis-kafka-certs';
    const assetId = process.argv.includes('--asset-id') ? process.argv[process.argv.indexOf('--asset-id') + 1] : 'dataset:facis:net-grid-hourly';

    console.log('1. Negotiating agreement for', assetId);
    const neg = await req('POST', baseUrl + '/dsp/negotiations', { counterparty: 'did:web:fap-iotai.facis.cloud', offerId: assetId.replace('dataset:', 'offer:') + ':read' });
    if (neg.statusCode >= 300 || !neg.body.negotiationId) throw new Error('negotiation failed: ' + JSON.stringify(neg.body));
    // POST only returns {negotiationId}; the agreementId needs a follow-up GET
    // (same two-step as dsp-ingest-e2e.js).
    const negGet = await req('GET', baseUrl + '/dsp/negotiations/' + neg.body.negotiationId);
    if (negGet.statusCode >= 300 || !negGet.body.agreementId) throw new Error('negotiation lookup failed: ' + JSON.stringify(negGet.body));
    console.log('   agreementId =', negGet.body.agreementId);

    console.log('2. POST /dsp/transfers (kafka-streaming)');
    const tx = await req('POST', baseUrl + '/dsp/transfers', { agreementId: negGet.body.agreementId, assetId: assetId, format: 'kafka-streaming' });
    if (tx.statusCode !== 202 || !tx.body.transferId) throw new Error('transfer create failed: ' + JSON.stringify(tx.body));
    const transferId = tx.body.transferId;
    console.log('   transferId =', transferId);

    console.log('3. GET /dsp/transfers/' + transferId);
    // The 202 only returns after dsp-tx-kafka-admin finishes (synchronous
    // chain), so the state read here is already final.
    const got = await req('GET', baseUrl + '/dsp/transfers/' + transferId);
    const t = got.body;
    if (t.state === 'ERROR') throw new Error('transfer ERROR: ' + t.reason);
    if (t.state !== 'STARTED' || !t.access || !t.access.topic) throw new Error('expected STARTED with access.topic, got: ' + JSON.stringify(t));
    if (t.access.sasl !== null || JSON.stringify(t.access).includes('password')) throw new Error('SECURITY: access object contains credential material: ' + JSON.stringify(t.access));
    console.log('   state=STARTED topic=' + t.access.topic + ' bootstrap=' + t.access.bootstrap + ' — no credentials (as designed)');

    console.log('4. kcat -L: topic must exist on the broker (up to 30s)');
    if (!(await pollTopic(bootstrap, certDir, t.access.topic, true, 30000))) throw new Error('topic ' + t.access.topic + ' never appeared on ' + bootstrap);
    console.log('   topic exists on the real broker');

    console.log('5. POST /dsp/transfers/' + transferId + '/terminate');
    const term = await req('POST', baseUrl + '/dsp/transfers/' + transferId + '/terminate');
    if (term.statusCode !== 200 || term.body.state !== 'TERMINATED') throw new Error('terminate failed: ' + JSON.stringify(term.body));

    console.log('6. kcat -L: topic must be gone (up to 60s — broker-side deletion is async)');
    if (!(await pollTopic(bootstrap, certDir, t.access.topic, false, 60000))) throw new Error('topic ' + t.access.topic + ' still present after terminate');
    console.log('   topic deleted from the real broker');

    console.log('PASS: real create -> visible on broker -> real delete on terminate');
    process.exit(0);
}

main().catch((err) => { console.error('FAIL:', err.message || err); process.exit(1); });
