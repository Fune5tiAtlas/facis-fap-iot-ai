/* eslint-disable */
//
// kafka-access-harness.spec.js — NF-3 real Kafka provisioning, pure-logic side.
// Replaces the old hand-mirrored kafka-access.spec.js, which pinned the
// FABRICATED access object (fake SCRAM credentials, tp-tp- topic bug,
// fictitious bootstrap). Runs the real `func` strings from
// facis-dsp-transfers.json via tests/harness/run-node.js.
//
// NOT covered here (needs a live cluster — tests/e2e/dsp-kafka-transfer-e2e.js):
// dsp-tx-kafka-admin's actual AdminClient createTopic/deleteTopic calls. That
// node's `libs` requires node-rdkafka (native build, deliberately not a test
// devDependency) and a reachable broker; it is exercised only by the E2E script.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runNode } = require('../harness/run-node.js');

const FLOW = path.join(__dirname, '..', '..', 'flows', 'facis-dsp-transfers.json');

const ACCESS_NOTE = 'Connecting to this topic requires an mTLS client certificate trusted by the FACIS Kafka cluster, arranged out-of-band with the data space operator. This API does not deliver connection credentials.';

function createMsg(bodyOverrides) {
    return {
        payload: Object.assign({
            agreementId: 'agr-1',
            assetId: 'dataset:facis:net-grid-hourly',
            format: 'kafka-streaming'
        }, bodyOverrides || {}),
        req: { params: {} },
        res: { _marker: 'live-res-handle' }
    };
}

test('kafka-streaming: transfer stored STARTED, routed to the admin node on output 6', async () => {
    const flowCtx = new Map();
    const r = await runNode(FLOW, 'dsp-tx-create', { msg: createMsg(), env: {}, flowCtx });
    assert.equal(r.result.length, 6);
    assert.equal(r.result[0], null, 'no synchronous HTTP response — dsp-tx-kafka-admin owns it');
    assert.equal(r.result[1], null, 'no persist yet — dsp-tx-kafka-admin persists the final state');
    assert.equal(r.result[2].payload.family, 'facis_dsp_transfer_requests_total');
    assert.equal(r.result[2].payload.label, 'kafka-streaming');
    const out = r.result[5];
    assert.ok(out, 'output 6 must carry the provisioning msg');
    assert.equal(out._kafkaAction, 'create');
    assert.equal(out.res._marker, 'live-res-handle', 'res handle must survive for the deferred response');
    const stored = flowCtx.get('transfers')[out._transferId];
    assert.equal(stored.state, 'STARTED');
    assert.equal(stored.access, null, 'access only attaches after the topic really exists');
});

test('topic name: single tp- prefix, sanitized assetId (tp-tp- bug + illegal ":" fixed)', async () => {
    const r = await runNode(FLOW, 'dsp-tx-create', { msg: createMsg(), env: {} });
    const access = r.result[5]._kafkaAccess;
    const id = r.result[5]._transferId;
    assert.match(id, /^tp-[0-9a-f]{12}$/);
    assert.equal(access.topic, 'iot.dataset.dataset-facis-net-grid-hourly.' + id);
    assert.ok(!access.topic.includes('tp-tp-'), 'doubled prefix must be gone');
    assert.match(access.topic, /^[a-zA-Z0-9._-]+$/, 'must be a legal Kafka topic name');
});

test('access object carries NO credential material and the explicit accessNote', async () => {
    const r = await runNode(FLOW, 'dsp-tx-create', { msg: createMsg(), env: {} });
    const access = r.result[5]._kafkaAccess;
    assert.equal(access.sasl, null);
    const serialized = JSON.stringify(access);
    assert.ok(!serialized.includes('password'), 'no password anywhere in the access object');
    assert.ok(!serialized.includes('SCRAM'), 'no fabricated SASL mechanism');
    assert.equal(access.accessNote, ACCESS_NOTE);
});

test('bootstrap: real default, env-overridable', async () => {
    const def = await runNode(FLOW, 'dsp-tx-create', { msg: createMsg(), env: {} });
    assert.equal(def.result[5]._kafkaAccess.bootstrap, '212.132.83.222:9093');
    const ov = await runNode(FLOW, 'dsp-tx-create', { msg: createMsg(), env: { DSP_KAFKA_BOOTSTRAP: 'other.example:9093' } });
    assert.equal(ov.result[5]._kafkaAccess.bootstrap, 'other.example:9093');
});

test('expiresAt keeps the Python isoformat µs + +00:00 shape (advisory TTL)', async () => {
    const r = await runNode(FLOW, 'dsp-tx-create', { msg: createMsg(), env: {} });
    assert.match(r.result[5]._kafkaAccess.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
});

test('http-pull regression: still synchronous auto-complete, output 6 null', async () => {
    const flowCtx = new Map();
    const r = await runNode(FLOW, 'dsp-tx-create', {
        msg: createMsg({ format: 'http-pull' }),
        env: { DSP_HMAC_SECRET: 'test-secret' },
        flowCtx
    });
    assert.equal(r.result[0].statusCode, 202);
    assert.equal(r.result[5], null);
    const stored = flowCtx.get('transfers')[r.result[0].payload.transferId];
    assert.equal(stored.state, 'COMPLETED');
    assert.ok(stored.access.url);
});

test('validation errors still 422 with all remaining outputs null', async () => {
    const r = await runNode(FLOW, 'dsp-tx-create', { msg: { payload: { agreementId: 'a' } }, env: {} });
    assert.equal(r.result[0].statusCode, 422);
    // r.result is built inside the vm sandbox (a different JS realm), so
    // node:assert/strict deepEqual spuriously fails on the Array prototype
    // even for [null,...]. Compare serialized, per the repo's cross-realm
    // convention (see iam-revocation-harness.spec.js).
    assert.equal(JSON.stringify(r.result.slice(1)), JSON.stringify([null, null, null, null, null]));
});
