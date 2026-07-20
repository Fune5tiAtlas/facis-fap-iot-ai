/* eslint-disable */
//
// envelope.spec.js — verifies the industrial ingestion envelope contract
// shared by the Modbus and OPC UA client tabs.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_FIELDS = [
    'schema_version', 'event_id', 'ingest_timestamp', 'source_protocol',
    'source_endpoint', 'site_id', 'device_id', 'source_timestamp',
    'quality', 'readings', 'raw_payload',
];

function readFlow(name) {
    const p = path.join(__dirname, '..', '..', 'flows', name);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Mirrors the `build envelope + kafka msg` nodes.
function buildEnvelope(fields) {
    return {
        schema_version: '1.0',
        event_id: fields.source_endpoint + '|' + fields.device_id + '|' + fields.source_timestamp,
        ingest_timestamp: new Date().toISOString(),
        source_protocol: fields.source_protocol,
        source_endpoint: fields.source_endpoint,
        site_id: fields.site_id,
        device_id: fields.device_id,
        source_timestamp: fields.source_timestamp,
        quality: fields.quality,
        readings: fields.readings,
        raw_payload: JSON.stringify(fields.raw),
    };
}

const SAMPLE = {
    source_protocol: 'modbus-tcp',
    source_endpoint: 'modbus-tcp://127.0.0.1:5020/1',
    site_id: 'site-001',
    device_id: 'janitza-umg96rm-001',
    source_timestamp: '2026-07-19T14:00:05.000Z',
    quality: 'good',
    readings: { active_power_l1_w: 10234.5 },
    raw: [17952, 21504],
};

test('envelope: contains every contract field', () => {
    const envelope = buildEnvelope(SAMPLE);
    for (const f of REQUIRED_FIELDS) {
        assert.ok(f in envelope, `missing field ${f}`);
    }
    assert.equal(envelope.schema_version, '1.0');
});

test('envelope: event_id is deterministic for the same reading', () => {
    const a = buildEnvelope(SAMPLE);
    const b = buildEnvelope(SAMPLE);
    assert.equal(a.event_id, b.event_id);
    const c = buildEnvelope({ ...SAMPLE, source_timestamp: '2026-07-19T14:00:10.000Z' });
    assert.notEqual(a.event_id, c.event_id);
});

test('envelope: raw_payload is a string, readings stay structured', () => {
    const envelope = buildEnvelope(SAMPLE);
    assert.equal(typeof envelope.raw_payload, 'string');
    assert.equal(typeof envelope.readings, 'object');
    assert.deepEqual(JSON.parse(envelope.raw_payload), SAMPLE.raw);
});

test('envelope flows: both client tabs build the same contract', () => {
    const files = ['facis-inding-modbus-client.json', 'facis-inding-opcua-client.json'];
    for (const file of files) {
        const fn = readFlow(file).find((n) => n.name === 'build envelope + kafka msg');
        assert.ok(fn, `envelope function missing in ${file}`);
        for (const f of REQUIRED_FIELDS) {
            assert.ok(fn.func.includes(f), `${file}: envelope function missing field ${f}`);
        }
        assert.match(fn.func, /schema_version: '1\.0'/);
    }
});

test('envelope flows: kafka key is the device id, topic env-driven with default', () => {
    const cases = [
        ['facis-inding-modbus-client.json', 'MODBUS_INGEST_TOPIC', 'modbus.ingest.raw'],
        ['facis-inding-opcua-client.json', 'OPCUA_INGEST_TOPIC', 'opcua.ingest.raw'],
    ];
    for (const [file, envVar, fallback] of cases) {
        const fn = readFlow(file).find((n) => n.name === 'build envelope + kafka msg');
        assert.match(fn.func, /key: deviceId/);
        assert.ok(fn.func.includes(envVar), `${file}: topic env ${envVar} missing`);
        assert.ok(fn.func.includes(fallback), `${file}: topic default ${fallback} missing`);
        const producer = readFlow(file).find((n) => n.type === 'rdkafka out');
        assert.equal(producer.topic, '', `${file}: producer topic must be empty so msg.topic wins`);
    }
});
