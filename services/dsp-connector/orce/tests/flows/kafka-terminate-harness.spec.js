/* eslint-disable */
//
// kafka-terminate-harness.spec.js — NF-3 FSM hooks for real topic deletion.
// Runs the real dsp-tx-terminate / dsp-tx-suspend func strings via the harness.
//
// Suspend deliberately does NOT delete the topic: SUSPENDED → STARTED is a
// legal transition (reversible pause); deleting on suspend would silently turn
// every suspend into a terminate. Terminate is the irreversible exit and is
// the only transition that requests topic deletion. The deletion itself
// (dsp-tx-kafka-admin's AdminClient.deleteTopic) is live-only — see
// tests/e2e/dsp-kafka-transfer-e2e.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runNode } = require('../harness/run-node.js');

const FLOW = path.join(__dirname, '..', '..', 'flows', 'facis-dsp-transfers.json');

function kafkaTransfer(state) {
    return {
        id: 'tp-abc123def456',
        agreementId: 'agr-1',
        assetId: 'dataset:facis:net-grid-hourly',
        format: 'kafka-streaming',
        state: state,
        access: {
            url: null, token: null,
            bootstrap: '212.132.83.222:9093',
            topic: 'iot.dataset.dataset-facis-net-grid-hourly.tp-abc123def456',
            sasl: null,
            accessNote: 'n/a for this test',
            expiresAt: '2026-07-19T01:00:00.000000+00:00'
        },
        reason: null,
        parameters: {},
        createdAt: '2026-07-19T00:00:00.000000+00:00',
        updatedAt: '2026-07-19T00:00:00.000000+00:00'
    };
}

function ctxWith(transfer) {
    const m = new Map();
    m.set('transfers', { [transfer.id]: transfer });
    return m;
}

test('terminate a STARTED kafka transfer: 200 TERMINATED + delete msg on output 3', async () => {
    const t = kafkaTransfer('STARTED');
    const r = await runNode(FLOW, 'dsp-tx-terminate', { msg: { req: { params: { id: t.id } }, res: { _m: 'res' } }, globalCtx: ctxWith(t) });
    assert.equal(r.result.length, 3);
    assert.equal(r.result[0].statusCode, 200);
    assert.equal(r.result[0].payload.state, 'TERMINATED');
    assert.ok(r.result[1], 'persist trigger fires');
    assert.equal(r.result[2]._kafkaAction, 'delete');
    assert.equal(r.result[2]._kafkaTopic, t.access.topic);
    assert.equal(r.result[2].res, undefined, 'delete msg must not carry the HTTP response handle');
});

test('terminate a kafka transfer that never provisioned (access null): no delete msg', async () => {
    const t = Object.assign(kafkaTransfer('STARTED'), { access: null });
    const r = await runNode(FLOW, 'dsp-tx-terminate', { msg: { req: { params: { id: t.id } } }, globalCtx: ctxWith(t) });
    assert.equal(r.result[0].statusCode, 200);
    assert.equal(r.result[2], null);
});

test('terminate a non-kafka transfer: no delete msg', async () => {
    const t = Object.assign(kafkaTransfer('SUSPENDED'), { format: 'http-pull', access: { url: 'https://x', token: 't' } });
    const r = await runNode(FLOW, 'dsp-tx-terminate', { msg: { req: { params: { id: t.id } } }, globalCtx: ctxWith(t) });
    assert.equal(r.result[0].statusCode, 200);
    assert.equal(r.result[2], null);
});

test('invalid transition still 400s with no delete msg (TERMINATED is terminal)', async () => {
    const t = kafkaTransfer('TERMINATED');
    const r = await runNode(FLOW, 'dsp-tx-terminate', { msg: { req: { params: { id: t.id } } }, globalCtx: ctxWith(t) });
    assert.equal(r.result[0].statusCode, 400);
    assert.equal(r.result[2], null);
});

test('404 still returns with no delete msg', async () => {
    const r = await runNode(FLOW, 'dsp-tx-terminate', { msg: { req: { params: { id: 'tp-nope' } } }, globalCtx: new Map() });
    assert.equal(r.result[0].statusCode, 404);
    assert.equal(r.result[2], null);
});

test('terminate an ERROR kafka transfer (topic recorded): 200 TERMINATED + delete msg on output 3', async () => {
    // Final-review fix: a kafka-streaming transfer whose provisioning errored
    // AFTER the broker committed the topic lands in ERROR with access.topic set.
    // ERROR→TERMINATED is now legal so that orphaned topic can be cleaned up.
    const t = kafkaTransfer('ERROR');
    const r = await runNode(FLOW, 'dsp-tx-terminate', { msg: { req: { params: { id: t.id } }, res: { _m: 'res' } }, globalCtx: ctxWith(t) });
    assert.equal(r.result[0].statusCode, 200);
    assert.equal(r.result[0].payload.state, 'TERMINATED');
    assert.equal(r.result[2]._kafkaAction, 'delete');
    assert.equal(r.result[2]._kafkaTopic, t.access.topic);
});

test('suspend an ERROR transfer still 400s (suspend matrix untouched — pausing an errored transfer makes no sense)', async () => {
    const t = kafkaTransfer('ERROR');
    const r = await runNode(FLOW, 'dsp-tx-suspend', { msg: { req: { params: { id: t.id } } }, globalCtx: ctxWith(t) });
    assert.equal(r.result[0].statusCode, 400);
    assert.equal(r.result.length, 2, 'suspend has no kafka-delete output');
});

test('suspend a STARTED kafka transfer: SUSPENDED, topic untouched (2 outputs, no delete)', async () => {
    const t = kafkaTransfer('STARTED');
    const r = await runNode(FLOW, 'dsp-tx-suspend', { msg: { req: { params: { id: t.id } } }, globalCtx: ctxWith(t) });
    assert.equal(r.result.length, 2, 'suspend node is unchanged — deliberately no kafka-delete output');
    assert.equal(r.result[0].payload.state, 'SUSPENDED');
});
