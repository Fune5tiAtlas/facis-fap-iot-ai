#!/usr/bin/env node
// dsp-ingest-e2e.js — live verification of the full NF-2 chain:
//   negotiate (existing) -> POST /dsp/ingest (Task 5) -> poll Trino for
//   the new bronze.dsp_ingest row count to increase.
//
// This exercises the AUTHENTICATED path: the connector's /dsp/ingest handler
// mints a self-issued VP (iam.issue) and Bearer-attaches it to its own
// internal provider hops, so this E2E works whether DSP_IAM_ENFORCE is warn
// or enforce. This script's own /dsp/* calls are ALSO iam.verify-gated (the
// two POSTs: /dsp/negotiations and /dsp/ingest), so under enforce it must
// present a Bearer VP on each.
//
// Replay-safe VP: the provider's iam.verify records each VP `jti` in a global
// 300s cache and rejects reuse with replay_detected — so ONE static token
// cannot cover two gated calls (the second 401s). This script therefore MINTS
// A FRESH VP (unique jti) immediately before each gated request, reusing the
// exact claim shape dsp-iam-issue-fn produces. Provide the connector's private
// JWK via DSP_CONNECTOR_JWK (raw JSON) or --jwk-file <path>, and its DID via
// DSP_CONNECTOR_DID (default did:web:fap-iotai.facis.cloud). The operator
// running this E2E has cluster access to the identity key Secret that backs
// DSP_CONNECTOR_KEY; export that same JWK here. VP `aud` is DSP_VP_AUDIENCE
// (defaults to the connector DID).
//
// Fallback: --vp-token <jwt> (or DSP_VP_TOKEN) presents one static token on
// every gated call — usable only for a single-gated-call run, since its reused
// jti trips replay_detected on a second gated call. The per-call mint (JWK)
// path is the default authenticated run.
//
// Under warn/off no token is needed — omit both JWK and --vp-token.
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
//   node tests/e2e/dsp-ingest-e2e.js --env-file .env.cluster --jwk-file connector.jwk.json

const fs = require('fs');
const https = require('https');
const jose = require('jose');

// Mint a fresh short-lived self-issued VP. Keep the claim shape byte-aligned
// with dsp-iam-issue-fn in facis-dsp-iam-issuance.json (no credentialStatus,
// so the verifier skips the status-list fetch): iss=sub=DID, aud=DSP_VP_AUDIENCE,
// unique jti per call, ~5min exp, kid=DID#key-1, alg from the JWK, inner VC
// signed the same way. The UNIQUE jti is what makes each gated call replay-safe.
async function mintVp(jwk, did, audience) {
    const alg = jwk.alg || 'ES256';
    const kid = did + '#key-1';
    const key = await jose.importJWK(jwk, alg);
    const newJti = () => 'urn:uuid:' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const vc = {
        '@context': ['https://www.w3.org/2018/credentials/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
        type: ['VerifiableCredential', 'ParticipantCredential'],
        id: kid,
        issuer: did,
        credentialSubject: { id: did, type: 'gx:LegalParticipant', 'gx:legalName': 'FACIS IoT-AI DSP Connector' }
    };
    const vcJwt = await new jose.SignJWT({ vc })
        .setProtectedHeader({ alg, kid, typ: 'vc+jwt' })
        .setIssuer(did).setSubject(did).setJti(newJti()).setIssuedAt().setExpirationTime('5m')
        .sign(key);
    return new jose.SignJWT({ vp: { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiablePresentation'], verifiableCredential: [vcJwt] } })
        .setProtectedHeader({ alg, kid, typ: 'vp+jwt' })
        .setIssuer(did).setSubject(did).setAudience(audience).setJti(newJti()).setIssuedAt().setExpirationTime('5m')
        .sign(key);
}

function loadConnectorJwk() {
    const idx = process.argv.indexOf('--jwk-file');
    if (idx !== -1) return JSON.parse(fs.readFileSync(process.argv[idx + 1], 'utf8'));
    if (process.env.DSP_CONNECTOR_JWK) return JSON.parse(process.env.DSP_CONNECTOR_JWK);
    return null;
}

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
    // DSP_IAM_ENFORCE=enforce, ignored (harmlessly) under warn/off. A fresh VP
    // is minted per gated call (replay-safe); the static --vp-token is a
    // single-gated-call fallback only.
    const jwk = loadConnectorJwk();
    const connectorDid = process.env.DSP_CONNECTOR_DID || 'did:web:fap-iotai.facis.cloud';
    const audience = process.env.DSP_VP_AUDIENCE || connectorDid;
    const staticVp = process.argv.includes('--vp-token') ? process.argv[process.argv.indexOf('--vp-token') + 1] : process.env.DSP_VP_TOKEN;
    async function dspAuth() {
        if (jwk) return { Authorization: 'Bearer ' + (await mintVp(jwk, connectorDid, audience)) };
        // ponytail: static token reuses one jti — trips replay_detected on a
        // 2nd gated call. Only safe for a run that makes a single gated call.
        if (staticVp) return { Authorization: 'Bearer ' + staticVp };
        return {};
    }
    console.log('0. auth:', jwk ? 'minting a fresh VP per gated call (enforce-ready)' : (staticVp ? 'static --vp-token (single-gated-call fallback)' : 'no VP (warn/off only)'));

    console.log('1. Negotiating agreement for', assetId);
    const neg = await req('POST', baseUrl + '/dsp/negotiations', { counterparty: 'did:web:fap-iotai.facis.cloud', offerId: assetId.replace('dataset:', 'offer:') + ':read' }, await dspAuth());
    if (neg.statusCode >= 300 || !neg.body.negotiationId) throw new Error('negotiation failed: ' + JSON.stringify(neg.body));
    console.log('   negotiation created, negotiationId =', neg.body.negotiationId);

    // POST /dsp/negotiations auto-finalises server-side but only returns
    // {negotiationId} (see dsp-neg-create in facis-dsp-negotiations.json);
    // the agreementId is only available via a follow-up GET.
    const negGet = await req('GET', baseUrl + '/dsp/negotiations/' + neg.body.negotiationId, undefined, await dspAuth());
    if (negGet.statusCode >= 300 || !negGet.body.agreementId) throw new Error('negotiation lookup failed: ' + JSON.stringify(negGet.body));
    console.log('   agreement finalized, agreementId =', negGet.body.agreementId);

    console.log('2. Checking bronze.dsp_ingest row count before ingest');
    const before = await trinoRowCount(trinoUrl, catalog, trinoUser, trinoPassword);
    console.log('   before =', before);

    console.log('3. POST /dsp/ingest');
    const ingest = await req('POST', baseUrl + '/dsp/ingest', { providerBaseUrl: baseUrl, assetId, agreementId: negGet.body.agreementId }, await dspAuth());
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

module.exports = { mintVp };

if (require.main === module) {
    main().catch((err) => { console.error(err); process.exit(1); });
}
