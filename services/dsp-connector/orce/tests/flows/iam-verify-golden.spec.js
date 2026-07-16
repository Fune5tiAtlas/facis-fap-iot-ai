/* eslint-disable */
//
// iam-verify-golden.spec.js — asserts the verifier's behavior against
// COMMITTED fixtures (keys.json / vectors.json), not freshly-minted keys.
// If this test ever needs new vectors, run generate-fixtures.js and re-commit
// — do not inline-generate here, that defeats the point of a golden vector.
//
// verifyPresentation/checkJtiReplay below are paste-identical mirrors of
// iam-verify.spec.js's mirrored logic (mirrored-logic convention: this file
// must stay runnable and reviewable standalone, without importing another
// spec file). Keep any future change to the real verifier hand-mirrored into
// BOTH spec files identically.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../fixtures/iam/keys.json');
const vectors = require('../fixtures/iam/vectors.json');

// ---- mirrored pure logic (paste-identical to iam-verify.spec.js) ----

function checkJtiReplay(cache, jti, nowMs, ttlMs) {
    for (const [k, expiresAt] of cache) {
        if (expiresAt <= nowMs) cache.delete(k);
    }
    if (cache.has(jti)) {
        return { seen: true, cache };
    }
    cache.set(jti, nowMs + ttlMs);
    return { seen: false, cache };
}

async function verifyPresentation({ vpToken, resolveJwk, audience, trustedIssuers, nowMs, jtiCache, jtiTtlMs }) {
    const jose = await import('jose');
    let vpPayload, vpProtectedHeader;
    try {
        vpProtectedHeader = jose.decodeProtectedHeader(vpToken);
        vpPayload = jose.decodeJwt(vpToken);
    } catch (err) {
        return { ok: false, code: 'invalid_signature', detail: 'malformed VP token' };
    }

    const holderDid = vpPayload.iss;
    if (!holderDid || vpPayload.sub !== holderDid) {
        return { ok: false, code: 'holder_binding_failed', detail: 'VP iss/sub mismatch' };
    }

    let vpKey;
    try {
        const vpJwk = await resolveJwk(holderDid, vpProtectedHeader.kid);
        vpKey = await jose.importJWK(vpJwk, vpProtectedHeader.alg);
    } catch (err) {
        return { ok: false, code: 'key_mismatch', detail: 'could not resolve VP signer key: ' + err.message };
    }

    try {
        await jose.jwtVerify(vpToken, vpKey, { audience });
    } catch (err) {
        if (err.code === 'ERR_JWT_EXPIRED') {
            return { ok: false, code: 'token_expired', detail: 'VP expired' };
        }
        if (err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && err.claim === 'aud') {
            return { ok: false, code: 'invalid_audience', detail: 'VP aud mismatch' };
        }
        return { ok: false, code: 'invalid_signature', detail: 'VP signature verification failed' };
    }

    if (!vpPayload.jti) {
        return { ok: false, code: 'invalid_signature', detail: 'VP missing jti' };
    }
    const replay = checkJtiReplay(jtiCache, vpPayload.jti, nowMs, jtiTtlMs);
    if (replay.seen) {
        return { ok: false, code: 'replay_detected', detail: 'VP jti already used: ' + vpPayload.jti };
    }

    const vcTokens = (vpPayload.vp && vpPayload.vp.verifiableCredential) || vpPayload.verifiableCredential || [];
    if (!Array.isArray(vcTokens) || vcTokens.length === 0) {
        return { ok: false, code: 'invalid_credential', detail: 'VP contains no verifiableCredential' };
    }

    const vc = vcTokens[0];
    let vcPayload, vcProtectedHeader;
    try {
        vcProtectedHeader = jose.decodeProtectedHeader(vc);
        vcPayload = jose.decodeJwt(vc);
    } catch (err) {
        return { ok: false, code: 'invalid_credential', detail: 'malformed inner VC' };
    }

    const vcIssuer = vcPayload.iss;
    if (!trustedIssuers.includes(vcIssuer)) {
        return { ok: false, code: 'untrusted_issuer', detail: 'VC issuer not in allowlist: ' + vcIssuer };
    }

    const subject = (vcPayload.vc && vcPayload.vc.credentialSubject) || vcPayload.credentialSubject || {};
    if (subject.id !== holderDid) {
        return { ok: false, code: 'holder_binding_failed', detail: 'VC credentialSubject.id != VP holder' };
    }

    let vcKey;
    try {
        const vcJwk = await resolveJwk(vcIssuer, vcProtectedHeader.kid);
        vcKey = await jose.importJWK(vcJwk, vcProtectedHeader.alg);
    } catch (err) {
        return { ok: false, code: 'key_mismatch', detail: 'could not resolve VC issuer key: ' + err.message };
    }

    try {
        await jose.jwtVerify(vc, vcKey);
    } catch (err) {
        if (err.code === 'ERR_JWT_EXPIRED') {
            return { ok: false, code: 'token_expired', detail: 'VC expired' };
        }
        return { ok: false, code: 'invalid_credential', detail: 'VC signature verification failed' };
    }

    const roles = (vcPayload.vc && vcPayload.vc.credentialSubject && vcPayload.vc.credentialSubject.roles)
        || subject.roles || [];

    return {
        ok: true,
        identity: {
            did: holderDid,
            roles,
            credentialId: vcPayload.jti || vcPayload.id || null,
            verifiedAt: new Date(nowMs).toISOString()
        }
    };
}

function makeResolver() {
    return async (did) => {
        if (did === 'did:web:holder.example') return keys.holder.publicJwk;
        if (did === 'did:web:issuer.example') return keys.issuer.publicJwk;
        if (did === 'did:web:untrusted.example') return keys.untrustedIssuer.publicJwk;
        throw new Error('unknown DID in golden fixtures: ' + did);
    };
}

const nowMs = vectors.anchorNowEpochSeconds * 1000;
const commonArgs = {
    resolveJwk: makeResolver(),
    audience: 'did:web:connector.example',
    trustedIssuers: ['did:web:issuer.example'],
    nowMs, jtiTtlMs: 300000
};

test('golden: valid VP → ok', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.valid, jtiCache: new Map() });
    assert.equal(r.ok, true);
    assert.equal(r.identity.did, 'did:web:holder.example');
});

test('golden: expired → token_expired', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.expired, jtiCache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.code, 'token_expired');
});

test('golden: tampered signature → invalid_signature', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.tamperedSignature, jtiCache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.code, 'invalid_signature');
});

test('golden: wrong audience → invalid_audience', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.wrongAudience, jtiCache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.code, 'invalid_audience');
});

test('golden: untrusted issuer → untrusted_issuer', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.untrustedIssuer, jtiCache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.code, 'untrusted_issuer');
});

test('golden: holder mismatch → holder_binding_failed', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.holderMismatch, jtiCache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.code, 'holder_binding_failed');
});
