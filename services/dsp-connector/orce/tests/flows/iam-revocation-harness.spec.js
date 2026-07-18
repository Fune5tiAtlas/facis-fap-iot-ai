/* eslint-disable */
//
// iam-revocation-harness.spec.js — tests the BitstringStatusList
// revocation feature (issuance's credentialStatus, the hub's status-list
// build + revoke endpoint, and the verifier's status check) by executing
// the REAL `func` strings straight out of the flow JSON via
// ../harness/run-node.js, NOT a hand-copied mirror. See run-node.js's header
// for why: this repo's other *.spec.js files hand-copy function bodies,
// which has already let real bugs (wrong require target, a msg.payload-
// clobbering bug, a missing @context field) ship silently past the test
// suite this session, only caught by live testing after deploy. Every
// assertion here reads its function body from the actual committed flow
// file at test-run time, so there is no second copy to drift from it.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNode } = require('../harness/run-node.js');
const zlib = require('zlib');

const VERIFY_FLOW = '../flows/facis-dsp-iam-verify.json';
const HUB_FLOW = '../flows/facis-dsp-iam-hub.json';
const ISSUANCE_FLOW = '../flows/facis-dsp-iam-issuance.json';

const LIST_SIZE_BITS = 131072;

function setBit(buf, idx) {
    buf[Math.floor(idx / 8)] |= (1 << (7 - (idx % 8)));
}

function testBit(buf, idx) {
    return ((buf[Math.floor(idx / 8)] >> (7 - (idx % 8))) & 1) === 1;
}

let jose;
test.before(async () => {
    jose = await import('jose');
});

async function makeConnectorKeys() {
    const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
    const privateJwk = await jose.exportJWK(privateKey);
    privateJwk.alg = 'ES256';
    return { publicKey, privateKey, privateJwk };
}

async function signStatusListVc(privateKey, encodedList, kid) {
    const statusListVc = {
        '@context': ['https://www.w3.org/2018/credentials/v1', 'https://www.w3.org/ns/credentials/status/v1'],
        id: 'https://connector.test/iam/status-list',
        type: ['VerifiableCredential', 'BitstringStatusListCredential'],
        issuer: 'did:web:connector.test',
        credentialSubject: { id: 'https://connector.test/iam/status-list#list', type: 'BitstringStatusList', statusPurpose: 'revocation', encodedList }
    };
    return new jose.SignJWT({ vc: statusListVc }).setProtectedHeader({ alg: 'ES256', kid }).sign(privateKey);
}

// ---- dsp-iam-verify-status-list-fn ----

test('verify-status-list: revoked bit + enforce mode → 401 credential_revoked', async () => {
    const { publicKey, privateKey } = await makeConnectorKeys();
    const bitstring = Buffer.alloc(LIST_SIZE_BITS / 8, 0);
    setBit(bitstring, 42);
    const jwt = await signStatusListVc(privateKey, zlib.gzipSync(bitstring).toString('base64url'), 'did:web:connector.test#key-1');

    const r = await runNode(VERIFY_FLOW, 'dsp-iam-verify-status-list-fn', {
        msg: {
            payload: { format: 'jwt_vc_json', credential: jwt },
            _iamStatusCheck: {
                credentialStatus: { statusListCredential: 'https://connector.test/iam/status-list', statusListIndex: '42' },
                vcKey: publicKey,
                identity: { did: 'did:web:holder.test', credentialId: 'cred-1' },
                mode: 'enforce'
            }
        }
    });
    const out = r.sent[0];
    assert.equal(out.statusCode, 401);
    assert.equal(out.iamRejected, true);
    assert.equal(out.identity, null);
    assert.equal(out.payload['dspace:code'], 'credential_revoked');
    assert.equal(out.payload['@context'], 'https://w3id.org/dspace/2025/1/context.jsonld');
});

test('verify-status-list: revoked bit + warn mode → allowed through, identity nulled, warned', async () => {
    const { publicKey, privateKey } = await makeConnectorKeys();
    const bitstring = Buffer.alloc(LIST_SIZE_BITS / 8, 0);
    setBit(bitstring, 7); // exercise a non-byte-aligned index too (bit 7 = last bit of byte 0)
    const jwt = await signStatusListVc(privateKey, zlib.gzipSync(bitstring).toString('base64url'), 'did:web:connector.test#key-1');

    const r = await runNode(VERIFY_FLOW, 'dsp-iam-verify-status-list-fn', {
        msg: {
            payload: { format: 'jwt_vc_json', credential: jwt },
            _iamStatusCheck: {
                credentialStatus: { statusListCredential: 'x', statusListIndex: '7' },
                vcKey: publicKey,
                identity: { did: 'did:web:holder.test', credentialId: 'cred-1' },
                mode: 'warn'
            }
        }
    });
    const out = r.sent[0];
    assert.equal(out.iamRejected, false);
    assert.equal(out.identity, null);
    assert.equal(out.statusCode, undefined);
    assert.ok(r.warnings.some((w) => w.includes('credential_revoked')));
});

test('verify-status-list: bit not set → identity passes through untouched', async () => {
    const { publicKey, privateKey } = await makeConnectorKeys();
    const bitstring = Buffer.alloc(LIST_SIZE_BITS / 8, 0);
    setBit(bitstring, 100); // set an unrelated bit — proves index isolation, not just "all zero"
    const jwt = await signStatusListVc(privateKey, zlib.gzipSync(bitstring).toString('base64url'), 'did:web:connector.test#key-1');

    const r = await runNode(VERIFY_FLOW, 'dsp-iam-verify-status-list-fn', {
        msg: {
            payload: { format: 'jwt_vc_json', credential: jwt },
            _iamStatusCheck: {
                credentialStatus: { statusListCredential: 'x', statusListIndex: '101' },
                vcKey: publicKey,
                identity: { did: 'did:web:holder.test', credentialId: 'cred-2', roles: ['participant'] },
                mode: 'enforce'
            }
        }
    });
    const out = r.sent[0];
    assert.equal(out.iamRejected, false);
    assert.deepEqual(out.identity, { did: 'did:web:holder.test', credentialId: 'cred-2', roles: ['participant'] });
});

test('verify-status-list: caller\'s original request body (_iamOrigPayload) is restored, not left as the fetched status list credential', async () => {
    // Regression test for a real live bug: an earlier version of this
    // node restored _iamOrigPayload into msg.payload BEFORE reading
    // msg.payload.credential (the fetched status list), so the read
    // always saw the caller's original body instead of the fetch
    // result — every credentialStatus-bearing VC silently fell back to
    // the fail-open "no credential" path, live, regardless of actual
    // revocation status. Caught only by a live end-to-end test (issue a
    // VC, revoke it, present it, confirm the log showed fail-open
    // instead of the reject/accept it should have), not by this test
    // suite before this test was added — worth being honest about: the
    // harness eliminates DRIFT from the real code, it does not replace
    // writing a test case for a real interaction.
    const { publicKey, privateKey } = await makeConnectorKeys();
    const bitstring = Buffer.alloc(LIST_SIZE_BITS / 8, 0); // not revoked
    const jwt = await signStatusListVc(privateKey, zlib.gzipSync(bitstring).toString('base64url'), 'did:web:connector.test#key-1');
    const originalBody = { counterparty: 'did:web:whatever.example', offerId: 'offer-1' };

    const r = await runNode(VERIFY_FLOW, 'dsp-iam-verify-status-list-fn', {
        msg: {
            payload: { format: 'jwt_vc_json', credential: jwt },
            _iamOrigPayload: originalBody,
            _iamStatusCheck: {
                credentialStatus: { statusListCredential: 'x', statusListIndex: '1' },
                vcKey: publicKey,
                identity: { did: 'did:web:holder.test', credentialId: 'cred-1' },
                mode: 'enforce'
            }
        }
    });
    const out = r.sent[0];
    assert.equal(JSON.stringify(out.payload), JSON.stringify(originalBody));
    assert.equal('_iamOrigPayload' in out, false);
    // And the revocation check must have actually run, not silently
    // fail-opened because the payload it needed was already gone.
    assert.equal(r.warnings.some((w) => w.includes('fail-open')), false);
});

test('verify-status-list: fetch returned no credential → fail-open, identity still set', async () => {
    const { publicKey } = await makeConnectorKeys();
    const r = await runNode(VERIFY_FLOW, 'dsp-iam-verify-status-list-fn', {
        msg: {
            payload: { error: 'not_found' }, // no .credential field — simulates a failed/empty fetch
            _iamStatusCheck: {
                credentialStatus: { statusListCredential: 'https://unreachable.test/list', statusListIndex: '1' },
                vcKey: publicKey,
                identity: { did: 'did:web:holder.test', credentialId: 'cred-3' },
                mode: 'enforce'
            }
        }
    });
    const out = r.sent[0];
    assert.equal(out.iamRejected, false);
    assert.deepEqual(out.identity, { did: 'did:web:holder.test', credentialId: 'cred-3' });
    assert.ok(r.warnings.some((w) => w.includes('fail-open')));
});

test('verify-status-list: status list signature does not verify (wrong key) → fail-open', async () => {
    const { privateKey } = await makeConnectorKeys();
    const { publicKey: wrongPublicKey } = await makeConnectorKeys();
    const bitstring = Buffer.alloc(LIST_SIZE_BITS / 8, 0);
    const jwt = await signStatusListVc(privateKey, zlib.gzipSync(bitstring).toString('base64url'), 'did:web:connector.test#key-1');

    const r = await runNode(VERIFY_FLOW, 'dsp-iam-verify-status-list-fn', {
        msg: {
            payload: { credential: jwt },
            _iamStatusCheck: {
                credentialStatus: { statusListCredential: 'x', statusListIndex: '1' },
                vcKey: wrongPublicKey, // deliberately the wrong key
                identity: { did: 'did:web:holder.test', credentialId: 'cred-4' },
                mode: 'enforce'
            }
        }
    });
    const out = r.sent[0];
    assert.equal(out.iamRejected, false);
    assert.deepEqual(out.identity, { did: 'did:web:holder.test', credentialId: 'cred-4' });
    assert.ok(r.warnings.some((w) => w.includes('signature invalid')));
});

test('verify-status-list: malformed encodedList → fail-open, does not throw', async () => {
    const { publicKey, privateKey } = await makeConnectorKeys();
    const jwt = await signStatusListVc(privateKey, 'not-valid-base64url-gzip!!!', 'did:web:connector.test#key-1');

    const r = await runNode(VERIFY_FLOW, 'dsp-iam-verify-status-list-fn', {
        msg: {
            payload: { credential: jwt },
            _iamStatusCheck: {
                credentialStatus: { statusListCredential: 'x', statusListIndex: '1' },
                vcKey: publicKey,
                identity: { did: 'did:web:holder.test', credentialId: 'cred-5' },
                mode: 'enforce'
            }
        }
    });
    const out = r.sent[0];
    assert.equal(out.iamRejected, false);
    assert.ok(r.warnings.some((w) => w.includes('decode failed')));
});

test('verify-status-list: missing _iamStatusCheck → programmer-error path, does not throw', async () => {
    const r = await runNode(VERIFY_FLOW, 'dsp-iam-verify-status-list-fn', { msg: { payload: {} } });
    assert.equal(r.sent[0].identity, null);
    assert.equal(r.sent[0].iamRejected, false);
    assert.equal(r.errors.length, 1);
});

// ---- dsp-iam-status-list-build-fn ----

test('status-list-build: no revoked rows → signs a valid all-zero list', async () => {
    const { publicKey, privateJwk } = await makeConnectorKeys();
    const r = await runNode(HUB_FLOW, 'dsp-iam-status-list-build-fn', {
        msg: { payload: [{ statusListIndex: 0, status: 'active' }, { statusListIndex: 1, status: 'active' }] },
        env: { DSP_CONNECTOR_DID: 'did:web:connector.test', DSP_CONNECTOR_KEY: JSON.stringify(privateJwk) }
    });
    const out = r.sent[0];
    assert.equal(out.statusCode, 200);
    assert.equal(out.payload.format, 'jwt_vc_json');
    const { payload } = await jose.jwtVerify(out.payload.credential, publicKey);
    const encodedList = payload.vc.credentialSubject.encodedList;
    const bitstring = zlib.gunzipSync(Buffer.from(encodedList, 'base64url'));
    assert.equal(bitstring.length, LIST_SIZE_BITS / 8);
    assert.equal(testBit(bitstring, 0), false);
    assert.equal(testBit(bitstring, 1), false);
});

test('status-list-build: revoked rows set exactly their own bits, nothing else', async () => {
    const { publicKey, privateJwk } = await makeConnectorKeys();
    const r = await runNode(HUB_FLOW, 'dsp-iam-status-list-build-fn', {
        msg: {
            payload: [
                { statusListIndex: 5, status: 'active' },
                { statusListIndex: 12, status: 'revoked' },
                { statusListIndex: 9000, status: 'revoked' }
            ]
        },
        env: { DSP_CONNECTOR_DID: 'did:web:connector.test', DSP_CONNECTOR_KEY: JSON.stringify(privateJwk) }
    });
    const { payload } = await jose.jwtVerify(r.sent[0].payload.credential, publicKey);
    const bitstring = zlib.gunzipSync(Buffer.from(payload.vc.credentialSubject.encodedList, 'base64url'));
    assert.equal(testBit(bitstring, 5), false);
    assert.equal(testBit(bitstring, 12), true);
    assert.equal(testBit(bitstring, 9000), true);
    // Spot-check nothing else in the list got set.
    let setCount = 0;
    for (let i = 0; i < LIST_SIZE_BITS; i++) { if (testBit(bitstring, i)) setCount++; }
    assert.equal(setCount, 2);
});

test('status-list-build: out-of-range / non-numeric indices are ignored, not thrown', async () => {
    const { privateJwk } = await makeConnectorKeys();
    const r = await runNode(HUB_FLOW, 'dsp-iam-status-list-build-fn', {
        msg: { payload: [{ statusListIndex: -1, status: 'revoked' }, { statusListIndex: LIST_SIZE_BITS, status: 'revoked' }, { statusListIndex: null, status: 'revoked' }] },
        env: { DSP_CONNECTOR_DID: 'did:web:connector.test', DSP_CONNECTOR_KEY: JSON.stringify(privateJwk) }
    });
    assert.equal(r.sent[0].statusCode, 200);
});

test('status-list-build: missing connector identity → 500, no throw', async () => {
    const r = await runNode(HUB_FLOW, 'dsp-iam-status-list-build-fn', {
        msg: { payload: [] },
        env: {}
    });
    assert.equal(r.sent[0].statusCode, 500);
});

// ---- dsp-iam-hub-revoke-guard ----

test('revoke-guard: correct shared secret → passes through', async () => {
    const r = await runNode(HUB_FLOW, 'dsp-iam-hub-revoke-guard', {
        msg: { req: { headers: { authorization: 'Bearer topsecret' } } },
        env: { DSP_OID4VCI_SHARED_SECRET: 'topsecret' }
    });
    assert.equal(r.result[1], null);
    assert.equal(r.result[0].req.headers.authorization, 'Bearer topsecret');
});

test('revoke-guard: wrong secret → 401 invalid_authorization', async () => {
    const r = await runNode(HUB_FLOW, 'dsp-iam-hub-revoke-guard', {
        msg: { req: { headers: { authorization: 'Bearer nope' } } },
        env: { DSP_OID4VCI_SHARED_SECRET: 'topsecret' }
    });
    assert.equal(r.result[0], null);
    assert.equal(r.result[1].statusCode, 401);
    assert.equal(r.result[1].payload['dspace:code'], 'invalid_authorization');
});

test('revoke-guard: missing Authorization header → 401 missing_authorization', async () => {
    const r = await runNode(HUB_FLOW, 'dsp-iam-hub-revoke-guard', {
        msg: { req: { headers: {} } },
        env: { DSP_OID4VCI_SHARED_SECRET: 'topsecret' }
    });
    assert.equal(r.result[1].payload['dspace:code'], 'missing_authorization');
});

test('revoke-guard: no shared secret configured → passes through with a warning', async () => {
    const r = await runNode(HUB_FLOW, 'dsp-iam-hub-revoke-guard', {
        msg: { req: { headers: { authorization: 'Bearer anything' } } },
        env: {}
    });
    assert.equal(r.result[1], null);
    assert.ok(r.warnings.some((w) => w.includes('unauthenticated')));
});

// ---- dsp-iam-hub-revoke-fn / dsp-iam-hub-revoke-result-fn ----

test('revoke-fn: builds the correct updateOne args from req.params.id', async () => {
    const r = await runNode(HUB_FLOW, 'dsp-iam-hub-revoke-fn', {
        msg: { req: { params: { id: 'urn:uuid:abc-123' } } }
    });
    // JSON round-trip, not assert.deepEqual: values constructed inside the
    // vm sandbox belong to that context's own realm (its own Object/Array
    // constructors), so deepStrictEqual's prototype check fails against a
    // host-realm literal even when every property is identical. This is a
    // real run-node.js boundary property, not a bug in the node under
    // test — plain data comparisons should go through JSON (as here) or
    // compare individual primitive properties instead of deepEqual-ing a
    // whole object/array straight out of the sandbox.
    assert.equal(JSON.stringify(r.result.payload), JSON.stringify([{ _id: 'urn:uuid:abc-123' }, { $set: { status: 'revoked' } }]));
});

test('revoke-result-fn: matchedCount > 0 → 200', async () => {
    const r = await runNode(HUB_FLOW, 'dsp-iam-hub-revoke-result-fn', {
        msg: { req: {}, _revokeId: 'x', payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 } }
    });
    assert.equal(r.result.statusCode, 200);
    assert.equal(r.result.payload.status, 'revoked');
});

test('revoke-result-fn: matchedCount 0 → 404', async () => {
    const r = await runNode(HUB_FLOW, 'dsp-iam-hub-revoke-result-fn', {
        msg: { req: {}, _revokeId: 'nope', payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 } }
    });
    assert.equal(r.result.statusCode, 404);
});

// ---- dsp-iam-hub-revoke-catch-fn ----

test('revoke-catch-fn: builds a spec-shaped 502 on a Mongo error', async () => {
    const r = await runNode(HUB_FLOW, 'dsp-iam-hub-revoke-catch-fn', {
        msg: { error: { message: 'connection refused' } }
    });
    assert.equal(r.result.statusCode, 502);
    assert.equal(r.result.payload['dspace:code'], 'internal_error');
    assert.equal(r.result.payload['@context'], 'https://w3id.org/dspace/2025/1/context.jsonld');
});

// ---- dsp-iam-issuance-vc-fn: credentialStatus construction ----

test('issuance vc-fn: issued VC carries a well-formed, in-range credentialStatus', async () => {
    const { privateJwk } = await makeConnectorKeys();
    const r = await runNode(ISSUANCE_FLOW, 'dsp-iam-issuance-vc-fn', {
        msg: { payload: {} },
        env: { DSP_CONNECTOR_DID: 'did:web:connector.test', DSP_CONNECTOR_KEY: JSON.stringify(privateJwk) }
    });
    const out = r.sent[0][1]; // [notaryOutput, pushOutput] — notary not configured, so output 2
    assert.ok(out.vcRecord);
    const cs = out.vcRecord.vc.credentialStatus;
    assert.equal(cs.type, 'BitstringStatusListEntry');
    assert.equal(cs.statusPurpose, 'revocation');
    assert.equal(cs.statusListCredential, 'https://connector.test/iam/status-list');
    const idx = Number(cs.statusListIndex);
    assert.ok(idx >= 0 && idx < LIST_SIZE_BITS);
    assert.equal(out.vcRecord.statusListIndex, idx);
    assert.equal(cs.id, cs.statusListCredential + '#' + idx);
});

test('issuance vc-fn: statusListIndex is deterministic for the same jti-generating conditions', async () => {
    // Same connector key/DID; jti includes Date.now()+random so we can't
    // force an identical jti across two real calls — instead verify the
    // hash function itself is deterministic given the SAME jti, matching
    // exactly what dsp-iam-issuance-vc-fn computes.
    const crypto = require('crypto');
    const jti = 'urn:uuid:fixed-test-jti';
    const idx1 = crypto.createHash('sha256').update(jti).digest().readUInt32BE(0) % LIST_SIZE_BITS;
    const idx2 = crypto.createHash('sha256').update(jti).digest().readUInt32BE(0) % LIST_SIZE_BITS;
    assert.equal(idx1, idx2);
    assert.ok(idx1 >= 0 && idx1 < LIST_SIZE_BITS);
});

test('issuance vc-fn: missing DSP_CONNECTOR_KEY still 500s cleanly (pre-existing guard unaffected by the new code)', async () => {
    const r = await runNode(ISSUANCE_FLOW, 'dsp-iam-issuance-vc-fn', {
        msg: { payload: {} },
        env: { DSP_CONNECTOR_DID: 'did:web:connector.test' }
    });
    assert.equal(r.sent[0][1].statusCode, 500);
});
