/* eslint-disable */
//
// kafka-access-harness.spec.js — NF-3 real Kafka provisioning, pure-logic side.
// Replaces the old hand-mirrored kafka-access.spec.js, which pinned the
// FABRICATED access object (fake SCRAM credentials, tp-tp- topic bug,
// fictitious bootstrap). Runs the real `func` strings from
// facis-dsp-transfers.json via tests/harness/run-node.js.
//
// Mostly NOT covered here (needs a live cluster — tests/e2e/dsp-kafka-transfer-e2e.js):
// dsp-tx-kafka-admin's actual AdminClient createTopic/deleteTopic network calls.
// That node's `libs` requires node-rdkafka (native build, deliberately not a test
// devDependency) and a reachable broker; the happy path is exercised only by E2E.
//
// EXCEPTION (see the create-error test below): the *pure control-flow* of the
// create path's catch branch — "on provisioning error, still record access.topic
// on the transfer so terminate can later delete an orphaned topic" — is tested
// here by injecting a stub `Kafka` lib via the harness's opts.libs hook, so the
// createTopic callback can be made to error without a native module or broker.
// This closes the specific final-review finding about a post-broker-commit client
// error leaving an unrecorded, uncleanable topic.

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

// Stub node-rdkafka: AdminClient.create() returns a client whose createTopic
// invokes its callback with the given err (or null for success). Enough surface
// for dsp-tx-kafka-admin's create path — CODES.ERRORS, AdminClient.create,
// createTopic(obj, timeout, cb), disconnect().
function stubKafka(createErr) {
    return {
        CODES: { ERRORS: { ERR_TOPIC_ALREADY_EXISTS: 36, ERR_UNKNOWN_TOPIC_OR_PART: 3 } },
        AdminClient: {
            create: () => ({
                createTopic: (_t, _timeout, cb) => cb(createErr),
                disconnect: () => {}
            })
        }
    };
}

test('create-error: provisioning failure still records access.topic (so terminate can clean up an orphaned topic)', async () => {
    const transferId = 'tp-abc123def456';
    const topic = 'iot.dataset.dataset-facis-net-grid-hourly.' + transferId;
    const access = { url: null, token: null, bootstrap: '212.132.83.222:9093', topic, sasl: null, accessNote: 'n/a', expiresAt: '2026-07-19T01:00:00.000000+00:00' };
    const transfer = { id: transferId, agreementId: 'agr-1', assetId: 'dataset:facis:net-grid-hourly', format: 'kafka-streaming', state: 'STARTED', access: null, reason: null, parameters: {}, createdAt: '2026-07-19T00:00:00.000000+00:00', updatedAt: '2026-07-19T00:00:00.000000+00:00' };
    const flowCtx = new Map([['transfers', { [transferId]: transfer }]]);
    // err.code is neither ALREADY_EXISTS nor UNKNOWN_TOPIC — the real "broker
    // committed but the client call still errored" (e.g. op timeout) shape.
    const err = Object.assign(new Error('Local: Timed out'), { code: -185 });
    const r = await runNode(FLOW, 'dsp-tx-kafka-admin', {
        msg: { _kafkaAction: 'create', _transferId: transferId, _kafkaAccess: access, req: {}, res: {} },
        flowCtx,
        libs: { Kafka: stubKafka(err) }
    });
    const stored = flowCtx.get('transfers')[transferId];
    assert.equal(stored.state, 'ERROR', 'failed provisioning lands in ERROR');
    assert.ok(stored.access, 'access must be attached even on ERROR');
    assert.equal(stored.access.topic, topic, 'topic name recorded so terminate can delete it');
    assert.equal(r.sent.length, 1, 'the async create path node.send()s exactly once');
    assert.equal(r.sent[0][3].payload.family, 'facis_dsp_transfer_errors_total', 'error metric emitted');
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
