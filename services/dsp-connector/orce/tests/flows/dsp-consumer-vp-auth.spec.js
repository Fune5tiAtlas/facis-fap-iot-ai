/* eslint-disable */
//
// dsp-consumer-vp-auth.spec.js — NF-2 authenticated-hop coverage.
//
// Two guards, both driving the REAL committed `func` strings via
// ../harness/run-node.js (no hand-mirrored logic to drift):
//
//   1. The consumer's two internal provider hops (POST /dsp/transfers,
//      GET /dsp/transfers/:id) now attach the minted VP as an
//      Authorization: Bearer header alongside Content-Type — the core
//      regression guard for the enforce-mode ingest path.
//
//   2. A real self-issue -> self-verify round trip: dsp-iam-issue-fn mints a
//      VP, dsp-iam-issuance-did-fn publishes this connector's did:web
//      document, and jose verifies the VP's signature + audience + holder
//      binding against that published key with the connector DID as the
//      trusted issuer — i.e. exactly what the provider's iam.verify does.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const jose = require('jose');
const { runNode } = require('../harness/run-node.js');

const CONSUMER_FLOW = '../flows/facis-dsp-consumer.json';
const ISSUANCE_FLOW = '../flows/facis-dsp-iam-issuance.json';

const DID = 'did:web:connector.example';
const AUDIENCE = 'did:web:provider.example';
const FAKE_VP = 'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ4In0.sig';

// ---- 1. hop headers carry the Bearer VP ----

test('prep-transfer: msg.vpToken becomes Authorization: Bearer on the POST hop, stashed for the GET hop', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-transfer-fn', {
        msg: { vpToken: FAKE_VP, payload: { providerBaseUrl: 'https://p.example', assetId: 'a', agreementId: 'agr-1' } }
    });
    const out = r.result[1];
    assert.equal(out.headers['Content-Type'], 'application/json');
    assert.equal(out.headers['Authorization'], 'Bearer ' + FAKE_VP);
    assert.equal(out._dspConsumer.vp, FAKE_VP);
});

test('prep-transfer: no VP (mint failed / warn mode) → Content-Type only, no Authorization, still proceeds', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-transfer-fn', {
        msg: { payload: { providerBaseUrl: 'https://p.example', assetId: 'a', agreementId: 'agr-1' } }
    });
    const out = r.result[1];
    assert.equal(out.headers['Content-Type'], 'application/json');
    assert.ok(!('Authorization' in out.headers));
    assert.equal(out._dspConsumer.vp, '');
});

test('prep-get-transfer: stashed VP becomes Authorization: Bearer on the GET hop', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-get-transfer-fn', {
        msg: { statusCode: 202, payload: { transferId: 'tp-1' }, _dspConsumer: { providerBaseUrl: 'https://p.example', vp: FAKE_VP } }
    });
    const out = r.result[1];
    assert.equal(out.headers['Content-Type'], 'application/json');
    assert.equal(out.headers['Authorization'], 'Bearer ' + FAKE_VP);
});

test('prep-get-transfer: no stashed VP → Content-Type only, no Authorization', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-get-transfer-fn', {
        msg: { statusCode: 202, payload: { transferId: 'tp-1' }, _dspConsumer: { providerBaseUrl: 'https://p.example' } }
    });
    const out = r.result[1];
    assert.equal(out.headers['Content-Type'], 'application/json');
    assert.ok(!('Authorization' in out.headers));
});

// ---- 2. self-issue -> self-verify round trip ----

async function connectorKeyEnv() {
    const { privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
    const jwk = await jose.exportJWK(privateKey);
    jwk.alg = 'ES256';
    return { DSP_CONNECTOR_DID: DID, DSP_CONNECTOR_KEY: JSON.stringify(jwk), DSP_VP_AUDIENCE: AUDIENCE };
}

test('iam.issue mints a VP the provider verifier accepts (real signature + audience + holder binding + trusted issuer)', async () => {
    const env = await connectorKeyEnv();

    // Mint the VP with the committed iam.issue node.
    const mint = await runNode(ISSUANCE_FLOW, 'dsp-iam-issue-fn', { env, msg: {} });
    const vpToken = mint.sent[0].vpToken;
    assert.ok(typeof vpToken === 'string' && vpToken.split('.').length === 3, 'iam.issue must produce a compact JWS VP');

    // Publish this connector's did:web document with the committed did.json node.
    const didDocRun = await runNode(ISSUANCE_FLOW, 'dsp-iam-issuance-did-fn', { env, msg: {} });
    const didDoc = didDocRun.sent[0].payload;
    const publicJwk = didDoc.verificationMethod[0].publicKeyJwk;
    const key = await jose.importJWK(publicJwk, publicJwk.alg);

    // Verify exactly like dsp-iam-prep/verify-vp does: signature + aud.
    const { payload: vpPayload } = await jose.jwtVerify(vpToken, key, { audience: AUDIENCE });

    // Holder binding: VP iss == sub == holder DID (dsp-iam-prep gate).
    assert.equal(vpPayload.iss, DID);
    assert.equal(vpPayload.sub, DID);
    assert.ok(vpPayload.jti, 'VP must carry a jti (replay protection)');

    // Inner VC: trusted issuer + credentialSubject binds to the holder.
    const trustedIssuers = [DID];
    const vcJwt = vpPayload.vp.verifiableCredential[0];
    const { payload: vcPayload } = await jose.jwtVerify(vcJwt, key);
    assert.ok(trustedIssuers.includes(vcPayload.iss), 'inner VC issuer must be the trusted connector DID');
    assert.equal(vcPayload.vc.credentialSubject.id, DID);
});

test('iam.issue without a provisioned key nulls vpToken instead of crashing', async () => {
    const r = await runNode(ISSUANCE_FLOW, 'dsp-iam-issue-fn', { env: { DSP_CONNECTOR_DID: DID }, msg: {} });
    assert.equal(r.result.vpToken, null);
    assert.equal(r.errors.length, 1);
});
