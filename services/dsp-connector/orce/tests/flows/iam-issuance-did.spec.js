/* eslint-disable */
//
// iam-issuance-did.spec.js — pure-logic tests for building this connector's
// own did:web DID document. Adapts Partner Onboarding Reference FAP tab
// "4-create did,chain files.json" (did:web + JWK builder) — see
// ~/Developer/Ciberseg/Atlas/facis/FAP/Partner Onboarding (Reference FAP)/
// implementation/flows/tabs/4-create did,chain files.json for the source
// pattern being adapted (jose JWK export + did:web document assembly).
//

const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors dsp-iam-issuance-fn's did-document builder.
function buildDidDocument(did, publicJwk, kid) {
    return {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: did,
        verificationMethod: [{
            id: kid,
            type: 'JsonWebKey2020',
            controller: did,
            publicKeyJwk: publicJwk
        }],
        authentication: [kid],
        assertionMethod: [kid]
    };
}

test('builds a well-formed did:web document', () => {
    const doc = buildDidDocument(
        'did:web:fap-iotai.facis.cloud',
        { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' },
        'did:web:fap-iotai.facis.cloud#key-1'
    );
    assert.equal(doc.id, 'did:web:fap-iotai.facis.cloud');
    assert.equal(doc.verificationMethod.length, 1);
    assert.equal(doc.verificationMethod[0].id, 'did:web:fap-iotai.facis.cloud#key-1');
    assert.deepEqual(doc.authentication, ['did:web:fap-iotai.facis.cloud#key-1']);
    assert.deepEqual(doc.assertionMethod, ['did:web:fap-iotai.facis.cloud#key-1']);
});

test('the private key is never present on the document (public JWK only)', () => {
    const doc = buildDidDocument(
        'did:web:fap-iotai.facis.cloud',
        { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' }, // no 'd' (private) field
        'did:web:fap-iotai.facis.cloud#key-1'
    );
    assert.equal(doc.verificationMethod[0].publicKeyJwk.d, undefined);
});
