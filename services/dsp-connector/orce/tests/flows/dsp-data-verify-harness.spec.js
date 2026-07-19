/* eslint-disable */
//
// dsp-data-verify-harness.spec.js — tests dsp-data-verify-fn (the HMAC
// signature check on GET /api/data/:assetId) by executing its real `func`
// string from the committed flow JSON via ../harness/run-node.js. See
// run-node.js's header / orce/README.md for why this pattern is used for
// all new flow logic instead of a hand-copied mirror.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runNode } = require('../harness/run-node.js');

const DATA_FLOW = '../flows/facis-dsp-data.json';
const SECRET = 'a'.repeat(64);

function sign(assetId, fromTs, toTs, expiresAt, agreementId, roles) {
    const path = '/api/data/' + assetId;
    const message = 'GET:' + path + ':' + fromTs + ':' + toTs + ':' + expiresAt + ':' +
        encodeURIComponent(agreementId) + ':' + encodeURIComponent(roles);
    return crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(message, 'utf8').digest('hex');
}

function futureIso(seconds) {
    return new Date(Date.now() + seconds * 1000).toISOString();
}

function runVerify(query, assetId) {
    return runNode(DATA_FLOW, 'dsp-data-verify-fn', {
        env: { DSP_HMAC_SECRET: SECRET },
        msg: { req: { params: { assetId: assetId || 'dataset:facis:net-grid-hourly' }, query } }
    });
}

test('verify: correctly signed, unexpired token passes through with _dspDataWindow set', async () => {
    const assetId = 'dataset:facis:net-grid-hourly';
    const expiresAt = futureIso(3600);
    const token = sign(assetId, '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z', expiresAt, 'agr-1', 'consumer');
    const r = await runVerify({ token, expiresAt, from: '2026-04-01T00:00:00Z', to: '2026-04-02T00:00:00Z', agreementId: 'agr-1', roles: 'consumer' }, assetId);
    assert.equal(r.result[0], null);
    assert.equal(JSON.stringify(r.result[1]._dspDataWindow), JSON.stringify({ assetId, from: '2026-04-01T00:00:00Z', to: '2026-04-02T00:00:00Z', agreementId: 'agr-1', roles: 'consumer' }));
});

test('verify: tampered token → 401 invalid_token', async () => {
    const assetId = 'dataset:facis:net-grid-hourly';
    const expiresAt = futureIso(3600);
    const token = sign(assetId, '', '', expiresAt, '', '');
    const r = await runVerify({ token: token.slice(0, -1) + (token.slice(-1) === '0' ? '1' : '0'), expiresAt, from: '', to: '', agreementId: '', roles: '' }, assetId);
    assert.equal(r.result[0].statusCode, 401);
    assert.equal(r.result[0].payload['dspace:code'], 'invalid_token');
    assert.equal(r.result[0].payload['@context'], 'https://w3id.org/dspace/2025/1/context.jsonld');
});

test('verify: expired token → 401 token_expired', async () => {
    const assetId = 'dataset:facis:net-grid-hourly';
    const expiresAt = new Date(Date.now() - 3600 * 1000).toISOString();
    const token = sign(assetId, '', '', expiresAt, '', '');
    const r = await runVerify({ token, expiresAt, from: '', to: '', agreementId: '', roles: '' }, assetId);
    assert.equal(r.result[0].statusCode, 401);
    assert.equal(r.result[0].payload['dspace:code'], 'token_expired');
});

test('verify: missing token → 401 invalid_token, no crash', async () => {
    const r = await runVerify({}, 'dataset:facis:net-grid-hourly');
    assert.equal(r.result[0].statusCode, 401);
    assert.equal(r.result[0].payload['dspace:code'], 'invalid_token');
});

test('verify: signature is bound to assetId — same query against a different assetId fails', async () => {
    const expiresAt = futureIso(3600);
    const token = sign('dataset:facis:net-grid-hourly', '', '', expiresAt, '', '');
    const r = await runVerify({ token, expiresAt, from: '', to: '', agreementId: '', roles: '' }, 'dataset:facis:weather-hourly');
    assert.equal(r.result[0].statusCode, 401);
    assert.equal(r.result[0].payload['dspace:code'], 'invalid_token');
});

test('verify: expiresAt containing a literal + still verifies after Express/qs decodes it to a space (regression, see README NF-2 section)', async () => {
    const assetId = 'dataset:facis:net-grid-hourly';
    // A real signed expiresAt has a literal '+' in its UTC offset suffix
    // (e.g. provisionHttpPull()'s output), unescaped in the query string.
    // Express's default 'extended' (qs) query parser decodes an unescaped
    // '+' in a raw query string to a space before this function node ever
    // sees it — simulate that here by signing against the real '+' value,
    // then handing the function the space-decoded form, exactly like
    // msg.req.query would actually contain.
    const realExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString().replace('Z', '+00:00');
    const spaceDecodedExpiresAt = realExpiresAt.replace('+', ' ');
    const token = sign(assetId, '', '', realExpiresAt, '', '');
    const r = await runVerify({ token, expiresAt: spaceDecodedExpiresAt, from: '', to: '', agreementId: '', roles: '' }, assetId);
    assert.equal(r.result[0], null);
    assert.equal(r.result[1]._dspDataWindow.assetId, assetId);
});

test('verify: missing DSP_HMAC_SECRET → 503 signing_not_configured', async () => {
    const r = await runNode(DATA_FLOW, 'dsp-data-verify-fn', {
        env: {},
        msg: { req: { params: { assetId: 'x' }, query: { token: 't', expiresAt: futureIso(60) } } }
    });
    assert.equal(r.result[0].statusCode, 503);
    assert.equal(r.result[0].payload['dspace:code'], 'signing_not_configured');
});
