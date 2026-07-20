/* eslint-disable */
//
// dsp-ingest-e2e-mint.spec.js — guards the E2E script's replay-safe VP mint
// helper (tests/e2e/dsp-ingest-e2e.js `mintVp`). The bug it prevents: reusing
// one static VP across two iam.verify-gated calls trips replay_detected on the
// second (the verifier records each jti in a global 300s cache). So the core
// assertion is: two successive mints carry DISTINCT jti, and each verifies.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const jose = require('jose');
const { mintVp } = require('../e2e/dsp-ingest-e2e.js');

const DID = 'did:web:connector.example';
const AUDIENCE = 'did:web:provider.example';

async function keyPair() {
    const { privateKey, publicKey } = await jose.generateKeyPair('ES256', { extractable: true });
    const jwk = await jose.exportJWK(privateKey);
    jwk.alg = 'ES256';
    return { jwk, publicKey };
}

test('mintVp: two mints carry distinct jti (replay-safe across gated calls)', async () => {
    const { jwk } = await keyPair();
    const [a, b] = [await mintVp(jwk, DID, AUDIENCE), await mintVp(jwk, DID, AUDIENCE)];
    const jtiA = jose.decodeJwt(a).jti;
    const jtiB = jose.decodeJwt(b).jti;
    assert.ok(jtiA && jtiB);
    assert.notEqual(jtiA, jtiB);
});

test('mintVp: produces a VP the provider verifier accepts (sig + aud + holder binding + inner VC)', async () => {
    const { jwk, publicKey } = await keyPair();
    const vp = await mintVp(jwk, DID, AUDIENCE);

    const { payload } = await jose.jwtVerify(vp, publicKey, { audience: AUDIENCE });
    assert.equal(payload.iss, DID);
    assert.equal(payload.sub, DID);
    assert.ok(payload.jti);

    const vcJwt = payload.vp.verifiableCredential[0];
    const { payload: vcPayload } = await jose.jwtVerify(vcJwt, publicKey);
    assert.equal(vcPayload.iss, DID);
    assert.equal(vcPayload.vc.credentialSubject.id, DID);
});
