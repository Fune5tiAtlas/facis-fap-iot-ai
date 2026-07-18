/* eslint-disable */
//
// iam-verify.spec.js — pure-logic tests for the NF-1 IAM verifier
// (facis-dsp-iam-verify.json). Mirrors the function bodies of nodes
// dsp-iam-prep / dsp-iam-verify exactly — any change here must be
// hand-mirrored into the flow JSON in Task 7/8, per this repo's
// no-flow-execution test convention (see negotiation-finalize.spec.js).
//

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- mirrored pure logic (paste-identical to the flow's function nodes) ----

function didWebToUrl(did) {
    const parts = did.split(':');
    if (parts[0] !== 'did' || parts[1] !== 'web') {
        throw new Error('unsupported DID method: ' + did);
    }
    const segments = parts.slice(2).map(decodeURIComponent);
    const domain = segments[0];
    const path = segments.slice(1);
    if (path.length === 0) {
        return 'https://' + domain + '/.well-known/did.json';
    }
    return 'https://' + domain + '/' + path.join('/') + '/did.json';
}

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
        await jose.jwtVerify(vpToken, vpKey, { audience, currentDate: new Date(nowMs) });
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
        await jose.jwtVerify(vc, vcKey, { currentDate: new Date(nowMs) });
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

// ---- fixtures ----

async function makeSignedJwt(payload, privateKey, kid, alg) {
    const jose = await import('jose');
    return new jose.SignJWT(payload)
        .setProtectedHeader({ alg, kid })
        .sign(privateKey);
}

async function makeKeypair() {
    const jose = await import('jose');
    const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
    const publicJwk = await jose.exportJWK(publicKey);
    return { publicKey, privateKey, publicJwk };
}

// ---- tests: didWebToUrl ----

test('didWebToUrl: bare domain maps to /.well-known/did.json', () => {
    assert.equal(didWebToUrl('did:web:example.com'), 'https://example.com/.well-known/did.json');
});

test('didWebToUrl: path segments map to <path>/did.json (no well-known)', () => {
    assert.equal(
        didWebToUrl('did:web:example.com:issuers:acme'),
        'https://example.com/issuers/acme/did.json'
    );
});

test('didWebToUrl: percent-encoded segments are decoded', () => {
    assert.equal(
        didWebToUrl('did:web:example.com:issuers%3Aacme'),
        'https://example.com/issuers:acme/did.json'
    );
});

test('didWebToUrl: rejects non-did:web methods', () => {
    assert.throws(() => didWebToUrl('did:key:z6Mk...'), /unsupported DID method/);
});

// ---- tests: checkJtiReplay ----

test('checkJtiReplay: first sight is not a replay', () => {
    const r = checkJtiReplay(new Map(), 'jti-1', 1000, 60000);
    assert.equal(r.seen, false);
});

test('checkJtiReplay: second sight within TTL is a replay', () => {
    let cache = new Map();
    cache = checkJtiReplay(cache, 'jti-1', 1000, 60000).cache;
    const r = checkJtiReplay(cache, 'jti-1', 2000, 60000);
    assert.equal(r.seen, true);
});

test('checkJtiReplay: entries expire after TTL and can repeat', () => {
    let cache = new Map();
    cache = checkJtiReplay(cache, 'jti-1', 1000, 60000).cache;
    const r = checkJtiReplay(cache, 'jti-1', 1000 + 60001, 60000);
    assert.equal(r.seen, false);
});

// ---- tests: verifyPresentation (golden-vector style, keys minted in-test) ----

test('verifyPresentation: valid VP + valid VC → ok with identity', async () => {
    const holder = await makeKeypair();
    const issuer = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);

    const vc = await makeSignedJwt({
        iss: 'did:web:issuer.example',
        vc: { credentialSubject: { id: 'did:web:holder.example', roles: ['participant'] } },
        iat: now
    }, issuer.privateKey, 'did:web:issuer.example#key-1', 'ES256');

    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example',
        sub: 'did:web:holder.example',
        aud: 'did:web:connector.example',
        jti: 'vp-jti-1',
        exp: now + 300,
        vp: { verifiableCredential: [vc] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const resolveJwk = async (did) => (did === 'did:web:holder.example' ? holder.publicJwk : issuer.publicJwk);

    const result = await verifyPresentation({
        vpToken: vp,
        resolveJwk,
        audience: 'did:web:connector.example',
        trustedIssuers: ['did:web:issuer.example'],
        nowMs: now * 1000,
        jtiCache: new Map(),
        jtiTtlMs: 300000
    });

    assert.equal(result.ok, true);
    assert.equal(result.identity.did, 'did:web:holder.example');
    assert.deepEqual(result.identity.roles, ['participant']);
});

test('verifyPresentation: expired VP → token_expired', async () => {
    const holder = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-2', exp: now - 10,
        vp: { verifiableCredential: [] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const result = await verifyPresentation({
        vpToken: vp, resolveJwk: async () => holder.publicJwk,
        audience: 'did:web:connector.example', trustedIssuers: [],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'token_expired');
});

test('verifyPresentation: tampered VP signature → invalid_signature', async () => {
    const holder = await makeKeypair();
    const attacker = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-3', exp: now + 300,
        vp: { verifiableCredential: [] }
    }, attacker.privateKey, 'did:web:holder.example#key-1', 'ES256');

    // Resolver returns the HOLDER's real key, but the token was signed by attacker.
    const result = await verifyPresentation({
        vpToken: vp, resolveJwk: async () => holder.publicJwk,
        audience: 'did:web:connector.example', trustedIssuers: [],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_signature');
});

test('verifyPresentation: forged DID (did.json unresolvable) → key_mismatch', async () => {
    const holder = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-4', exp: now + 300,
        vp: { verifiableCredential: [] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const result = await verifyPresentation({
        vpToken: vp,
        resolveJwk: async () => { throw new Error('did.json not found (404)'); },
        audience: 'did:web:connector.example', trustedIssuers: [],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'key_mismatch');
});

// Distinct from the case above: here did.json resolves successfully (no
// resolver error) but happens to carry a DIFFERENT, unrelated key than the
// one that actually signed the VP — e.g. a stale/wrong verificationMethod
// entry, or an attacker who controls the did:web domain but not the
// holder's real key. importJWK succeeds (it's a well-formed key), so this
// fails downstream at signature verification, not key resolution — hence
// invalid_signature, not key_mismatch. The two forged-DID sub-cases are
// intentionally distinguished: they surface different operational problems
// (resolution failure vs. a resolvable-but-wrong trust anchor).
test('verifyPresentation: forged DID (did.json resolves but key does not match signer) → invalid_signature', async () => {
    const holder = await makeKeypair();
    const wrongKeyHolder = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-4b', exp: now + 300,
        vp: { verifiableCredential: [] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const result = await verifyPresentation({
        vpToken: vp,
        resolveJwk: async () => wrongKeyHolder.publicJwk,
        audience: 'did:web:connector.example', trustedIssuers: [],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_signature');
});

// Outer VP is validly signed by the real holder and passes every VP-level
// check (audience, expiry, jti) — the tamper is on the INNER credential
// only, flipping one base64url char in the VC's own signature segment
// (same technique the file's VP-level tamper test uses, applied one layer
// deeper). Proves the VC signature is actually verified independently of
// the VP wrapper, not just decoded/trusted because the outer envelope
// checked out.
test('verifyPresentation: tampered inner VC signature → invalid_credential', async () => {
    const holder = await makeKeypair();
    const issuer = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);

    const vc = await makeSignedJwt({
        iss: 'did:web:issuer.example',
        vc: { credentialSubject: { id: 'did:web:holder.example', roles: ['participant'] } },
        iat: now
    }, issuer.privateKey, 'did:web:issuer.example#key-1', 'ES256');
    const vcSegs = vc.split('.');
    const vcSigChars = vcSegs[2].split('');
    vcSigChars[0] = vcSigChars[0] === 'A' ? 'B' : 'A';
    const tamperedVc = vcSegs[0] + '.' + vcSegs[1] + '.' + vcSigChars.join('');

    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-vc-tamper', exp: now + 300,
        vp: { verifiableCredential: [tamperedVc] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const resolveJwk = async (did) => (did === 'did:web:holder.example' ? holder.publicJwk : issuer.publicJwk);

    const result = await verifyPresentation({
        vpToken: vp,
        resolveJwk,
        audience: 'did:web:connector.example',
        trustedIssuers: ['did:web:issuer.example'],
        nowMs: now * 1000,
        jtiCache: new Map(),
        jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_credential');
});

test('verifyPresentation: untrusted VC issuer → untrusted_issuer', async () => {
    const holder = await makeKeypair();
    const issuer = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);

    const vc = await makeSignedJwt({
        iss: 'did:web:not-trusted.example',
        vc: { credentialSubject: { id: 'did:web:holder.example', roles: [] } },
    }, issuer.privateKey, 'did:web:not-trusted.example#key-1', 'ES256');

    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-5', exp: now + 300,
        vp: { verifiableCredential: [vc] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const resolveJwk = async (did) => (did === 'did:web:holder.example' ? holder.publicJwk : issuer.publicJwk);

    const result = await verifyPresentation({
        vpToken: vp, resolveJwk,
        audience: 'did:web:connector.example',
        trustedIssuers: ['did:web:some-other-issuer.example'],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'untrusted_issuer');
});

test('verifyPresentation: holder != credentialSubject → holder_binding_failed', async () => {
    const holder = await makeKeypair();
    const issuer = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);

    const vc = await makeSignedJwt({
        iss: 'did:web:issuer.example',
        vc: { credentialSubject: { id: 'did:web:someone-else.example', roles: [] } },
    }, issuer.privateKey, 'did:web:issuer.example#key-1', 'ES256');

    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-6', exp: now + 300,
        vp: { verifiableCredential: [vc] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const resolveJwk = async (did) => (did === 'did:web:holder.example' ? holder.publicJwk : issuer.publicJwk);

    const result = await verifyPresentation({
        vpToken: vp, resolveJwk,
        audience: 'did:web:connector.example',
        trustedIssuers: ['did:web:issuer.example'],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'holder_binding_failed');
});

test('verifyPresentation: wrong audience → invalid_audience', async () => {
    const holder = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:someone-else.example', jti: 'vp-jti-7', exp: now + 300,
        vp: { verifiableCredential: [] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const result = await verifyPresentation({
        vpToken: vp, resolveJwk: async () => holder.publicJwk,
        audience: 'did:web:connector.example', trustedIssuers: [],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_audience');
});

test('verifyPresentation: replayed jti on second call → replay_detected', async () => {
    const holder = await makeKeypair();
    const issuer = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);

    // Needs a valid inner VC so the first call actually reaches ok:true —
    // an empty verifiableCredential array would short-circuit on
    // invalid_credential before ever reaching the jti-replay check.
    const vc = await makeSignedJwt({
        iss: 'did:web:issuer.example',
        vc: { credentialSubject: { id: 'did:web:holder.example', roles: [] } },
    }, issuer.privateKey, 'did:web:issuer.example#key-1', 'ES256');

    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-8', exp: now + 300,
        vp: { verifiableCredential: [vc] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const resolveJwk = async (did) => (did === 'did:web:holder.example' ? holder.publicJwk : issuer.publicJwk);

    const sharedCache = new Map();
    const args = {
        vpToken: vp, resolveJwk,
        audience: 'did:web:connector.example', trustedIssuers: ['did:web:issuer.example'],
        nowMs: now * 1000, jtiCache: sharedCache, jtiTtlMs: 300000
    };
    const first = await verifyPresentation(args);
    assert.equal(first.ok, true);
    const second = await verifyPresentation({ ...args, jtiCache: sharedCache });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'replay_detected');
});
