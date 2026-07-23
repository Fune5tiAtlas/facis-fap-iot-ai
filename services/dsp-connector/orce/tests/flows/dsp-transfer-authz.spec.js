// C-1 (audit 2026-07-23): transfer state-mutation and DSP callback verbs must be
// IAM-gated and holder-bound. Before the fix these six routes wired straight to
// their transition handler (live: 404 unauthenticated instead of 401). These tests
// prove (a) every mutation/callback http-in now routes through the shared iam.verify
// gate, and (b) the holder-binding authz function rejects a caller who is not the
// agreement counterparty and otherwise routes to the correct handler.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('../harness/run-node.js');

const FLOW = path.join(__dirname, '..', '..', 'flows', 'facis-dsp-transfers.json');
const CTX = 'https://w3id.org/dspace/2025/1/context.jsonld';
const nodes = JSON.parse(fs.readFileSync(FLOW, 'utf8'));
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

// ── Structural: the six mutation/callback routes are now gated ──

const GATED_ROUTES = [
    'dsp-tx-in-suspend',
    'dsp-tx-in-terminate',
    'dsp-tx-in-dsp-suspension',
    'dsp-tx-in-dsp-termination',
    'dsp-tx-in-dsp-start',
    'dsp-tx-in-dsp-completion'
];

for (const id of GATED_ROUTES) {
    test(`route ${id} is IAM-gated (wires to the shared iam.verify gate, not straight to a handler)`, () => {
        const n = byId[id];
        assert.ok(n, `node ${id} exists`);
        assert.deepEqual(n.wires, [['dsp-tx-mut-iam-call']], `${id} must route through dsp-tx-mut-iam-call`);
    });
}

test('gate calls iam.verify then branches on iamRejected (401 path vs authz path)', () => {
    const call = byId['dsp-tx-mut-iam-call'];
    assert.equal(call.type, 'link call');
    assert.deepEqual(call.links, ['dsp-iam-verify-in'], 'gate must invoke the shared iam.verify link-in');
    assert.deepEqual(call.wires, [['dsp-tx-mut-iam-branch']]);

    const branch = byId['dsp-tx-mut-iam-branch'];
    assert.equal(branch.property, 'iamRejected');
    // output 0 = iamRejected true → response (401 already shaped by iam.verify); output 1 = false → authz
    assert.deepEqual(branch.wires, [['dsp-tx-response'], ['dsp-tx-mut-authz']]);
});

// ── Behavioural: holder-binding authz function ──

function ctx({ transfers, negotiations }) {
    const m = new Map();
    if (transfers) m.set('transfers', transfers);
    if (negotiations) m.set('negotiations', negotiations);
    return m;
}

const TRANSFER = {
    id: 'tp-abc', providerPid: 'tp-abc', consumerPid: 'urn:consumer:1',
    agreementId: 'agr-1', state: 'STARTED'
};
const NEGS = { 'neg-1': { agreementId: 'agr-1', state: 'FINALIZED', counterparty: 'did:web:consumer.example' } };

test('authz: verified counterparty is routed to the suspend handler (output 0)', async () => {
    const r = await runNode(FLOW, 'dsp-tx-mut-authz', {
        msg: { req: { url: '/dsp/transfers/tp-abc/suspend', params: { id: 'tp-abc' } }, identity: { did: 'did:web:consumer.example' } },
        globalCtx: ctx({ transfers: { 'tp-abc': TRANSFER }, negotiations: NEGS })
    });
    assert.ok(Array.isArray(r.result), 'authz returns a multi-output array');
    assert.ok(r.result[0], 'suspend output populated');
    assert.equal(r.result[5], null, 'no reject');
    assert.notEqual(r.result[0].statusCode, 403);
});

test('authz: a caller who is NOT the agreement counterparty gets a typed 403', async () => {
    const r = await runNode(FLOW, 'dsp-tx-mut-authz', {
        msg: { req: { url: '/dsp/transfers/tp-abc/terminate', params: { id: 'tp-abc' } }, identity: { did: 'did:web:attacker.evil' } },
        globalCtx: ctx({ transfers: { 'tp-abc': TRANSFER }, negotiations: NEGS })
    });
    const rej = r.result[5];
    assert.ok(rej, 'reject output populated');
    assert.equal(rej.statusCode, 403);
    assert.equal(rej.payload['@type'], 'TransferError');
    assert.equal(rej.payload.code, 'unauthorized');
    assert.equal(rej.payload['@context'][0], CTX);
    // and it did NOT route to the terminate handler
    assert.equal(r.result[1], null);
});

test('authz: routes terminate(1), dsp-suspension(2), dsp-termination(3), start/completion(4) by URL', async () => {
    const holder = { did: 'did:web:consumer.example' };
    const g = () => ctx({ transfers: { 'tp-abc': TRANSFER }, negotiations: NEGS });
    const cases = [
        ['/dsp/transfers/tp-abc/terminate', { id: 'tp-abc' }, 1],
        ['/dsp/transfers/tp-abc/suspension', { id: 'tp-abc' }, 2],
        ['/dsp/transfers/tp-abc/termination', { id: 'tp-abc' }, 3],
        ['/dsp/transfers/tp-abc/start', { providerPid: 'tp-abc' }, 4],
        ['/dsp/transfers/tp-abc/completion', { providerPid: 'tp-abc' }, 4]
    ];
    for (const [url, params, idx] of cases) {
        const r = await runNode(FLOW, 'dsp-tx-mut-authz', { msg: { req: { url, params }, identity: holder }, globalCtx: g() });
        assert.ok(r.result[idx], `${url} → output ${idx}`);
        assert.equal(r.result[5], null, `${url} not rejected`);
    }
});

test('authz: dev bypass (_iamMode off) routes without a holder check', async () => {
    const r = await runNode(FLOW, 'dsp-tx-mut-authz', {
        msg: { _iamMode: 'off', req: { url: '/dsp/transfers/tp-abc/suspend', params: { id: 'tp-abc' } } },
        globalCtx: ctx({ transfers: { 'tp-abc': TRANSFER }, negotiations: NEGS })
    });
    assert.ok(r.result[0]);
    assert.equal(r.result[5], null);
});

test('authz: an unknown mutation route is rejected 404 (no silent pass-through)', async () => {
    const r = await runNode(FLOW, 'dsp-tx-mut-authz', {
        msg: { req: { url: '/dsp/transfers/tp-abc/bogus', params: { id: 'tp-abc' } }, identity: { did: 'did:web:consumer.example' } },
        globalCtx: ctx({ transfers: { 'tp-abc': TRANSFER }, negotiations: NEGS })
    });
    assert.equal(r.result[5].statusCode, 404);
    assert.equal(r.result[5].payload.code, 'not_found');
});
