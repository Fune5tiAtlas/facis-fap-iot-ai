/* eslint-disable */
//
// dlq.spec.js — verifies the industrial ingestion DLQ tab
// (`flows/facis-inding-dlq.json`): envelope formatting, wiring, and the
// non-recursive failure handling.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readFlow(name) {
    const p = path.join(__dirname, '..', '..', 'flows', name);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Mirrors the `format DLQ envelope + metric` node (without metrics/env).
function formatDlq(msg) {
    let src = msg.payload;
    if (src && typeof src === 'object' && src.payload && src.payload.error_type) {
        src = src.payload;
    }
    if (!src || typeof src !== 'object') {
        src = { error_type: 'uncaught', error_message: String(msg.payload || msg.error || 'unknown') };
    }
    const dlq = {
        error_type: src.error_type || 'uncaught',
        error_message: src.error_message || 'unknown',
        error_timestamp: src.error_timestamp || new Date().toISOString(),
        source_protocol: src.source_protocol || null,
        device_id: src.device_id || null,
        original_envelope: src.original_envelope || null,
    };
    return { key: dlq.device_id || 'unknown', payload: JSON.stringify(dlq), dlq };
}

test('dlq: typed failure payloads pass through', () => {
    const out = formatDlq({
        payload: {
            error_type: 'read',
            error_message: 'connect ECONNREFUSED',
            error_timestamp: '2026-07-19T14:00:00Z',
            source_protocol: 'modbus-tcp',
            device_id: 'janitza-umg96rm-001',
            original_envelope: null,
        },
    });
    assert.equal(out.dlq.error_type, 'read');
    assert.equal(out.key, 'janitza-umg96rm-001');
    assert.equal(typeof out.payload, 'string');
});

test('dlq: unknown shapes degrade to uncaught with fallback key', () => {
    const out = formatDlq({ payload: 'boom' });
    assert.equal(out.dlq.error_type, 'uncaught');
    assert.equal(out.key, 'unknown');
});

test('dlq: publish failures preserve the original envelope', () => {
    const envelope = { schema_version: '1.0', device_id: 'm1' };
    const out = formatDlq({
        payload: {
            error_type: 'publish',
            error_message: 'delivery failed',
            source_protocol: 'opc-ua',
            device_id: 'm1',
            original_envelope: envelope,
        },
    });
    assert.deepEqual(out.dlq.original_envelope, envelope);
});

test('dlq flow: link-in aggregates every producer link-out', () => {
    const linkIn = readFlow('facis-inding-dlq.json').find((n) => n.type === 'link in');
    assert.deepEqual(
        [...linkIn.links].sort(),
        [
            'inding-modbus-link-out-dlq',
            'inding-obs-link-out-dlq',
            'inding-opcua-link-out-dlq',
        ]
    );
});

test('dlq flow: DLQ publish failure does not recurse', () => {
    const flow = readFlow('facis-inding-dlq.json');
    const catchNode = flow.find((n) => n.type === 'catch');
    assert.deepEqual(catchNode.scope, ['inding-dlq-out']);
    const debug = flow.find((n) => n.type === 'debug');
    assert.equal(debug.console, true);
});

test('dlq flow: topic env-driven with industrial.ingest.dlq default', () => {
    const fn = readFlow('facis-inding-dlq.json').find((n) => n.id === 'inding-dlq-format');
    assert.match(fn.func, /INDING_DLQ_TOPIC/);
    assert.match(fn.func, /industrial\.ingest\.dlq/);
});
