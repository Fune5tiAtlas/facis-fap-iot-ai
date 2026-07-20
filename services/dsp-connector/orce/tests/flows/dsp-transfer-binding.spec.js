/* eslint-disable */
//
// dsp-transfer-binding.spec.js — NF-7 Gap 1: the DSP 2025-1 canonical transfer
// binding paths are a translation surface over the EXISTING transfer FSM, not a
// second state machine. Runs the real func strings from facis-dsp-transfers.json
// via ../harness/run-node.js, so a drift between these aliases and the FSM they
// wrap fails here.
//
// Surface under test:
//   POST /dsp/transfers/request                 -> dsp-tx-dsp-adapt-request -> dsp-tx-create
//   POST /dsp/transfers/:id/termination         -> (mark DSP) -> dsp-tx-terminate
//   POST /dsp/transfers/:providerPid/start       -> dsp-tx-dsp-transition (STARTED)
//   POST /dsp/transfers/:providerPid/completion  -> dsp-tx-dsp-transition (COMPLETED)
//

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runNode } = require('../harness/run-node.js');

const FLOW = path.join(__dirname, '..', '..', 'flows', 'facis-dsp-transfers.json');
const CTX = 'https://w3id.org/dspace/2025/1/context.jsonld';

function transferStore(t) {
    const m = new Map();
    m.set('transfers', { [t.id]: t });
    return m;
}

function baseTransfer(state) {
    return {
        id: 'tp-abc123def456',
        providerPid: 'tp-abc123def456',
        consumerPid: 'urn:consumer:1',
        agreementId: 'agr-1',
        assetId: 'dataset:facis:net-grid-hourly',
        format: 'http-pull',
        state: state,
        access: null,
        reason: null,
        parameters: {},
        createdAt: '2026-01-01T00:00:00.000000+00:00',
        updatedAt: '2026-01-01T00:00:00.000000+00:00'
    };
}

// ── adapt request: dspace:TransferRequestMessage -> FACIS create body ──

test('adapt-request maps a TransferRequestMessage and resolves assetId from the agreement', async () => {
    const negs = new Map();
    negs.set('negotiations', { 'neg-1': { agreementId: 'agr-1', state: 'FINALIZED', offerId: 'offer:facis:net-grid-hourly:read' } });
    const r = await runNode(FLOW, 'dsp-tx-dsp-adapt-request', {
        msg: {
            payload: {
                '@type': 'dspace:TransferRequestMessage',
                'dspace:agreementId': 'agr-1',
                'dspace:consumerPid': 'urn:consumer:1',
                'dct:format': 'HttpData-PULL',
                'dspace:callbackAddress': 'https://consumer.example/callback'
            },
            req: {}
        },
        globalCtx: negs
    });
    const out = r.result;
    assert.equal(out._dspBinding, true, 'flags the create chain to emit a DSP ACK');
    assert.equal(out.payload.agreementId, 'agr-1');
    assert.equal(out.payload.consumerPid, 'urn:consumer:1');
    assert.equal(out.payload.format, 'http-pull', 'dct:format HttpData-PULL -> http-pull');
    assert.equal(out.payload.assetId, 'dataset:facis:net-grid-hourly', 'asset resolved from negotiation offerId');
    assert.equal(out.payload.parameters.callbackAddress, 'https://consumer.example/callback');
});

test('adapt-request maps a kafka format token and honours an explicit assetId', async () => {
    const r = await runNode(FLOW, 'dsp-tx-dsp-adapt-request', {
        msg: { payload: { agreementId: 'agr-9', assetId: 'dataset:facis:x', format: 'Kafka-STREAMING' }, req: {} },
        globalCtx: new Map()
    });
    assert.equal(r.result.payload.format, 'kafka-streaming');
    assert.equal(r.result.payload.assetId, 'dataset:facis:x', 'explicit assetId wins');
});

// ── create via the binding: TransferProcess ACK, not FACIS {transferId} ──

test('create with _dspBinding returns a TransferProcess ACK (http-pull auto-completes)', async () => {
    const globalCtx = new Map();
    const r = await runNode(FLOW, 'dsp-tx-create', {
        msg: { _dspBinding: true, payload: { agreementId: 'agr-1', assetId: 'dataset:facis:net-grid-hourly', consumerPid: 'urn:consumer:1', format: 'http-pull' } },
        env: { DSP_HMAC_SECRET: 'test-secret' },
        globalCtx
    });
    const resp = r.result[0];
    assert.equal(resp.statusCode, 202, 'status unchanged (201-vs-202 is NF-11 PMO)');
    assert.equal(resp.payload['@context'][0], CTX);
    assert.equal(resp.payload['@context'].length, 1);
    assert.equal(resp.payload['@type'], 'TransferProcess');
    assert.equal(resp.payload.state, 'COMPLETED');
    assert.ok(resp.payload.providerPid, 'providerPid present');
    assert.equal(resp.payload.consumerPid, 'urn:consumer:1');
    assert.equal(resp.payload.transferId, undefined, 'not the FACIS {transferId} shape');
    // Same store the FACIS path writes — proves it hit the real FSM.
    assert.ok(globalCtx.get('transfers')[resp.payload.providerPid], 'transfer persisted in the shared store');
});

test('create WITHOUT _dspBinding still returns the FACIS {transferId} shape (no regression)', async () => {
    const r = await runNode(FLOW, 'dsp-tx-create', {
        msg: { payload: { agreementId: 'agr-1', assetId: 'dataset:facis:net-grid-hourly', format: 'http-pull' } },
        env: { DSP_HMAC_SECRET: 'test-secret' },
        globalCtx: new Map()
    });
    assert.ok(r.result[0].payload.transferId, 'FACIS shape preserved');
    assert.equal(r.result[0].payload['@type'], undefined);
});

// ── termination via the binding reuses dsp-tx-terminate (free kafka delete) ──

test('termination binding: dsp-tx-terminate reshapes to a TransferProcess ACK', async () => {
    const t = baseTransfer('STARTED');
    const r = await runNode(FLOW, 'dsp-tx-terminate', {
        msg: { _dspBinding: true, req: { params: { id: t.id } } },
        globalCtx: transferStore(t)
    });
    const resp = r.result[0];
    assert.equal(resp.statusCode, 200);
    assert.equal(resp.payload['@type'], 'TransferProcess');
    assert.equal(resp.payload.state, 'TERMINATED');
    assert.equal(resp.payload['@context'][0], CTX);
    assert.equal(resp.payload['@context'].length, 1);
});

// ── start / completion via the generic DSP transition node ──

test('start binding: SUSPENDED -> STARTED with a TransferProcess ACK', async () => {
    const t = baseTransfer('SUSPENDED');
    const store = transferStore(t);
    const r = await runNode(FLOW, 'dsp-tx-dsp-transition', {
        msg: { req: { url: '/dsp/transfers/' + t.id + '/start', params: { providerPid: t.id } } },
        globalCtx: store
    });
    const resp = r.result[0];
    assert.equal(resp.statusCode, 200);
    assert.equal(resp.payload['@type'], 'TransferProcess');
    assert.equal(resp.payload.state, 'STARTED');
    assert.equal(store.get('transfers')[t.id].state, 'STARTED', 'FSM store mutated');
    assert.ok(r.result[1], 'persist trigger fires');
});

test('completion binding: STARTED -> COMPLETED with a TransferProcess ACK', async () => {
    const t = baseTransfer('STARTED');
    const store = transferStore(t);
    const r = await runNode(FLOW, 'dsp-tx-dsp-transition', {
        msg: { req: { url: '/dsp/transfers/' + t.id + '/completion', params: { providerPid: t.id } } },
        globalCtx: store
    });
    assert.equal(r.result[0].payload.state, 'COMPLETED');
    assert.equal(store.get('transfers')[t.id].state, 'COMPLETED');
});

test('transition binding rejects an illegal move with a typed TransferError (400)', async () => {
    const t = baseTransfer('COMPLETED'); // terminal
    const r = await runNode(FLOW, 'dsp-tx-dsp-transition', {
        msg: { req: { url: '/dsp/transfers/' + t.id + '/start', params: { providerPid: t.id } } },
        globalCtx: transferStore(t)
    });
    assert.equal(r.result[0].statusCode, 400);
    assert.equal(r.result[0].payload['@type'], 'TransferError');
    assert.equal(r.result[0].payload.code, 'invalid_state_transition');
    assert.equal(r.result[1], null, 'no persist on a rejected transition');
});

test('transition binding 404s for an unknown providerPid', async () => {
    const r = await runNode(FLOW, 'dsp-tx-dsp-transition', {
        msg: { req: { url: '/dsp/transfers/tp-nope/completion', params: { providerPid: 'tp-nope' } } },
        globalCtx: new Map()
    });
    assert.equal(r.result[0].statusCode, 404);
    assert.equal(r.result[0].payload['@type'], 'TransferError');
});
