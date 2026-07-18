/* eslint-disable */
//
// iam-verify-missing-auth.spec.js — pure-logic tests for the "missing VP"
// negative case (no/malformed Authorization header) handled by dsp-iam-prep
// in facis-dsp-iam-verify.json. Mirrors that node's header-extraction +
// missing_authorization gate exactly — any change here must be
// hand-mirrored into the flow JSON, per this repo's no-flow-execution test
// convention (see iam-verify.spec.js / negotiation-finalize.spec.js).
//
// dsp-iam-prep only reaches this gate after the DSP_IAM_ENFORCE=off
// short-circuit (which returns before ever looking at msg.req.headers), so
// mode is passed in already lowercased/defaulted the same way the real node
// computes it: (env.get('DSP_IAM_ENFORCE') || 'enforce').toLowerCase().
//

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- mirrored pure logic (paste-identical to dsp-iam-prep's function body) ----

function dspError(code, detail) {
    return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
        payload: { '@context': 'https://w3id.org/dspace/2025/1/context.jsonld', '@type': 'dspace:Error', 'dspace:code': code, 'dspace:reason': [detail] }
    };
}

function checkAuthorization(authHeader, mode) {
    const msg = {};
    if (mode === 'off') {
        msg.identity = null;
        msg.iamRejected = false;
        msg._iamMode = 'off';
        return msg;
    }
    msg._iamMode = mode;

    const header = authHeader || '';
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) {
        const err = dspError('missing_authorization', 'Authorization: Bearer <vp+jwt> header is required');
        if (mode === 'enforce') {
            Object.assign(msg, err);
            msg.identity = null;
            msg.iamRejected = true;
        } else {
            msg.identity = null;
            msg.iamRejected = false;
        }
        return msg;
    }
    msg.vpToken = m[1];
    return msg;
}

// ---- tests ----

test('enforce mode: no Authorization header at all → rejects with missing_authorization', () => {
    const msg = checkAuthorization(undefined, 'enforce');
    assert.equal(msg.iamRejected, true);
    assert.equal(msg.identity, null);
    assert.equal(msg.statusCode, 401);
    assert.deepEqual(msg.headers, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    assert.deepEqual(msg.payload, {
        '@context': 'https://w3id.org/dspace/2025/1/context.jsonld',
        '@type': 'dspace:Error',
        'dspace:code': 'missing_authorization',
        'dspace:reason': ['Authorization: Bearer <vp+jwt> header is required']
    });
});

test('enforce mode: empty-string Authorization header → rejects with missing_authorization', () => {
    const msg = checkAuthorization('', 'enforce');
    assert.equal(msg.iamRejected, true);
    assert.equal(msg.payload['dspace:code'], 'missing_authorization');
});

test('enforce mode: malformed scheme (not Bearer) → rejects with missing_authorization', () => {
    const msg = checkAuthorization('NotBearer xyz', 'enforce');
    assert.equal(msg.iamRejected, true);
    assert.equal(msg.statusCode, 401);
    assert.equal(msg.payload['dspace:code'], 'missing_authorization');
});

test('enforce mode: Bearer with no token → rejects with missing_authorization', () => {
    const msg = checkAuthorization('Bearer', 'enforce');
    assert.equal(msg.iamRejected, true);
    assert.equal(msg.payload['dspace:code'], 'missing_authorization');
});

test('enforce mode: Bearer followed by only whitespace → rejects with missing_authorization', () => {
    const msg = checkAuthorization('Bearer    ', 'enforce');
    assert.equal(msg.iamRejected, true);
    assert.equal(msg.payload['dspace:code'], 'missing_authorization');
});

test('warn mode: no Authorization header → does NOT reject, passes through with null identity', () => {
    const msg = checkAuthorization(undefined, 'warn');
    assert.equal(msg.iamRejected, false);
    assert.equal(msg.identity, null);
    assert.equal(msg._iamMode, 'warn');
    assert.equal(msg.statusCode, undefined);
    assert.equal(msg.payload, undefined);
});

test('warn mode: malformed header → does NOT reject, passes through with null identity', () => {
    const msg = checkAuthorization('NotBearer xyz', 'warn');
    assert.equal(msg.iamRejected, false);
    assert.equal(msg.identity, null);
});

test('off mode: no Authorization header → full parity bypass, does NOT reject', () => {
    const msg = checkAuthorization(undefined, 'off');
    assert.equal(msg.iamRejected, false);
    assert.equal(msg.identity, null);
    assert.equal(msg._iamMode, 'off');
    assert.equal(msg.statusCode, undefined);
});

test('enforce mode: well-formed Bearer header extracts the token and does not reject', () => {
    const msg = checkAuthorization('Bearer abc.def.ghi', 'enforce');
    assert.equal(msg.vpToken, 'abc.def.ghi');
    assert.equal(msg.iamRejected, undefined);
    assert.equal(msg.identity, undefined);
});
