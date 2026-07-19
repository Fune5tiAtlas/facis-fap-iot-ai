/* eslint-disable */
//
// dsp-consumer-harness.spec.js — tests the 5 function nodes in
// facis-dsp-consumer.json (the NF-2 consumer-side ingest chain) by
// executing their real `func` strings via ../harness/run-node.js.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNode } = require('../harness/run-node.js');

const CONSUMER_FLOW = '../flows/facis-dsp-consumer.json';

// ---- dsp-consumer-prep-transfer-fn ----

test('prep-transfer: valid body builds the POST /dsp/transfers request', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-transfer-fn', {
        msg: { payload: { providerBaseUrl: 'https://fap-iotai.facis.cloud/', assetId: 'dataset:facis:net-grid-hourly', agreementId: 'agr-1', windowFrom: '2026-04-01T00:00:00Z', windowTo: '2026-04-02T00:00:00Z' } }
    });
    assert.equal(r.result[0], null);
    const out = r.result[1];
    assert.equal(out.url, 'https://fap-iotai.facis.cloud/dsp/transfers');
    assert.equal(out.method, 'POST');
    assert.equal(JSON.stringify(out.payload), JSON.stringify({ agreementId: 'agr-1', assetId: 'dataset:facis:net-grid-hourly', format: 'http-pull', parameters: { windowFrom: '2026-04-01T00:00:00Z', windowTo: '2026-04-02T00:00:00Z' } }));
});

test('prep-transfer: missing agreementId → 422 invalid_request', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-transfer-fn', {
        msg: { payload: { providerBaseUrl: 'https://x', assetId: 'a' } }
    });
    assert.equal(r.result[0].statusCode, 422);
    assert.equal(r.result[0].payload['dspace:code'], 'invalid_request');
    assert.equal(r.result[1], null);
});

test('prep-transfer: error path preserves msg.res (regression: dspError used to build a fresh object, dropping the http-in response handle)', async () => {
    const resMarker = { _marker: 'test-res-handle' };
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-transfer-fn', {
        msg: { res: resMarker, payload: { providerBaseUrl: 'https://x', assetId: 'a' } }
    });
    assert.equal(r.result[0].statusCode, 422);
    assert.equal(r.result[0].res._marker, 'test-res-handle');
});

// ---- dsp-consumer-prep-get-transfer-fn ----

test('prep-get-transfer: valid create-response builds the GET request', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-get-transfer-fn', {
        msg: { statusCode: 202, payload: { transferId: 'tp-abc123' }, _dspConsumer: { providerBaseUrl: 'https://p.example' } }
    });
    assert.equal(r.result[0], null);
    assert.equal(r.result[1].url, 'https://p.example/dsp/transfers/tp-abc123');
    assert.equal(r.result[1].method, 'GET');
    assert.equal(r.result[1]._dspConsumer.transferId, 'tp-abc123');
});

test('prep-get-transfer: provider returned an error (senderr:false string payload) → 502', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-get-transfer-fn', {
        msg: { statusCode: 'ENOTFOUND', payload: 'getaddrinfo ENOTFOUND p.example', _dspConsumer: { providerBaseUrl: 'https://p.example' } }
    });
    assert.equal(r.result[0].statusCode, 502);
    assert.equal(r.result[0].payload['dspace:code'], 'provider_transfer_create_failed');
    assert.equal(r.result[1], null);
});

test('prep-get-transfer: error path preserves msg.res (regression: dspError used to build a fresh object)', async () => {
    const resMarker = { _marker: 'test-res-handle' };
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-get-transfer-fn', {
        msg: { res: resMarker, statusCode: 'ENOTFOUND', payload: 'getaddrinfo ENOTFOUND p.example', _dspConsumer: { providerBaseUrl: 'https://p.example' } }
    });
    assert.equal(r.result[0].statusCode, 502);
    assert.equal(r.result[0].res._marker, 'test-res-handle');
});

// ---- dsp-consumer-extract-access-fn ----

test('extract-access: COMPLETED http-pull transfer extracts access.url', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-extract-access-fn', {
        msg: { payload: { state: 'COMPLETED', format: 'http-pull', access: { url: 'https://p.example/api/data/x?token=t' } } }
    });
    assert.equal(r.result[0], null);
    assert.equal(r.result[1].url, 'https://p.example/api/data/x?token=t');
    assert.equal(r.result[1].method, 'GET');
});

test('extract-access: transfer still STARTED → 502 provider_transfer_not_completed', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-extract-access-fn', {
        msg: { payload: { state: 'STARTED' } }
    });
    assert.equal(r.result[0].statusCode, 502);
    assert.equal(r.result[0].payload['dspace:code'], 'provider_transfer_not_completed');
});

test('extract-access: COMPLETED but kafka-streaming format (no access.url) → 502 provider_access_object_missing', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-extract-access-fn', {
        msg: { payload: { state: 'COMPLETED', format: 'kafka-streaming', access: { bootstrap: 'x', topic: 'y' } } }
    });
    assert.equal(r.result[0].statusCode, 502);
    assert.equal(r.result[0].payload['dspace:code'], 'provider_access_object_missing');
});

test('extract-access: error path preserves msg.res (regression: dspError used to build a fresh object)', async () => {
    const resMarker = { _marker: 'test-res-handle' };
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-extract-access-fn', {
        msg: { res: resMarker, payload: { state: 'STARTED' } }
    });
    assert.equal(r.result[0].statusCode, 502);
    assert.equal(r.result[0].res._marker, 'test-res-handle');
});

// ---- dsp-consumer-prep-envelope-meta-fn ----

test('prep-envelope-meta: valid rows response fans out to split with metadata attached', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-envelope-meta-fn', {
        msg: { payload: { rows: [{ hour: 'a' }, { hour: 'b' }] }, _dspConsumer: { transferId: 'tp-1', assetId: 'dataset:facis:x', providerBaseUrl: 'https://p.example' } }
    });
    assert.equal(r.result[0], null);
    assert.equal(r.result[1].statusCode, 202);
    assert.equal(r.result[1].payload.rowCount, 2);
    assert.equal(JSON.stringify(r.result[2].payload), JSON.stringify([{ hour: 'a' }, { hour: 'b' }]));
    assert.equal(r.result[2]._dsp_assetId, 'dataset:facis:x');
    assert.equal(r.result[2].source_topic, 'https://p.example/api/data/dataset:facis:x');
});

test('prep-envelope-meta: zero rows still responds 202 but does not fan out', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-envelope-meta-fn', {
        msg: { payload: { rows: [] }, _dspConsumer: { transferId: 'tp-1', assetId: 'x', providerBaseUrl: 'https://p.example' } }
    });
    assert.equal(r.result[1].payload.rowCount, 0);
    assert.equal(r.result[2], null);
});

test('prep-envelope-meta: malformed payload (no rows array) → 502 provider_data_pull_failed', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-envelope-meta-fn', {
        msg: { payload: 'not json', statusCode: 401, _dspConsumer: {} }
    });
    assert.equal(r.result[0].statusCode, 502);
    assert.equal(r.result[0].payload['dspace:code'], 'provider_data_pull_failed');
});

test('prep-envelope-meta: error path preserves msg.res (regression: dspError used to build a fresh object)', async () => {
    const resMarker = { _marker: 'test-res-handle' };
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-envelope-meta-fn', {
        msg: { res: resMarker, payload: 'not json', statusCode: 401, _dspConsumer: {} }
    });
    assert.equal(r.result[0].statusCode, 502);
    assert.equal(r.result[0].res._marker, 'test-res-handle');
});

test('prep-envelope-meta: success path (202 accepted) preserves msg.res (regression: respMsg used to be a fresh object, dropping the response handle on the ONE success path a real caller sees)', async () => {
    const resMarker = { _marker: 'test-res-handle' };
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-prep-envelope-meta-fn', {
        msg: { res: resMarker, payload: { rows: [{ hour: 'a' }] }, _dspConsumer: { transferId: 'tp-1', assetId: 'dataset:facis:x', providerBaseUrl: 'https://p.example' } }
    });
    assert.equal(r.result[1].statusCode, 202);
    assert.equal(r.result[1].res._marker, 'test-res-handle');
});

// ---- dsp-consumer-build-envelope-fn ----

test('build-envelope: builds the 6-field Bronze envelope wrapped as a kafka msg', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-build-envelope-fn', {
        env: { DSP_INGEST_TOPIC: 'dsp.ingest.raw' },
        msg: { payload: { hour: '2026-04-01T00:00:00Z', net_grid_kw: 1.5 }, ingest_timestamp: '2026-04-07T00:00:00.000Z', source_topic: 'https://p.example/api/data/x', _dsp_assetId: 'dataset:facis:x' }
    });
    assert.equal(r.result.topic, 'dsp.ingest.raw');
    assert.equal(r.result.key, 'dataset:facis:x');
    const envelope = JSON.parse(r.result.payload);
    assert.equal(envelope.ingest_timestamp, '2026-04-07T00:00:00.000Z');
    assert.equal(envelope.source_topic, 'https://p.example/api/data/x');
    assert.equal(envelope.kafka_partition, 0);
    assert.equal(envelope.kafka_offset, 0);
    assert.equal(envelope.kafka_key, 'dataset:facis:x');
    assert.equal(JSON.stringify(JSON.parse(envelope.raw_payload)), JSON.stringify({ hour: '2026-04-01T00:00:00Z', net_grid_kw: 1.5 }));
});

test('build-envelope: defaults topic to dsp.ingest.raw when DSP_INGEST_TOPIC unset', async () => {
    const r = await runNode(CONSUMER_FLOW, 'dsp-consumer-build-envelope-fn', {
        msg: { payload: { a: 1 }, ingest_timestamp: 'x', source_topic: 'y', _dsp_assetId: 'z' }
    });
    assert.equal(r.result.topic, 'dsp.ingest.raw');
});
