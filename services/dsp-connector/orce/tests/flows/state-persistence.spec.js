/* eslint-disable */
//
// state-persistence.spec.js — verify that the JSON serialisation /
// deserialisation cycle used by the State tab preserves all transfer fields.
//
// The State tab does:  global.set('transfers', map)  →  JSON.stringify(map, null, 2)
//                       → file out → file in on next boot → JSON.parse(...)
//
// Any structural or type drift across that boundary (missing field, key
// reordering changing iteration order, etc.) is caught here.
//

const test = require('node:test');
const assert = require('node:assert/strict');

function roundTrip(map) {
    const serialised = JSON.stringify(map, null, 2);
    return JSON.parse(serialised);
}

function makeTransfer(id, format, state) {
    return {
        id,
        agreementId: 'agr-' + id.slice(3),
        assetId: 'dataset:facis:net-grid-hourly',
        format,
        state,
        access: state === 'COMPLETED' ? {
            url: 'https://ai-insight.facis.cloud/api/data/dataset:facis:net-grid-hourly?from=2026-04-07T00:00:00Z&to=2026-04-07T23:59:59Z&expiresAt=2026-04-07T01:00:00.000000+00:00&sig=abc',
            token: 'abc',
            expiresAt: '2026-04-07T01:00:00.000000+00:00',
            bootstrap: null,
            topic: null,
            sasl: null,
        } : null,
        reason: null,
        parameters: { windowFrom: '2026-04-07T00:00:00Z', windowTo: '2026-04-07T23:59:59Z' },
        createdAt: '2026-04-07T00:00:00.000000+00:00',
        updatedAt: '2026-04-07T00:00:00.500000+00:00',
    };
}

test('round-trip preserves all top-level fields', () => {
    const map = {
        'tp-aaa111111111': makeTransfer('tp-aaa111111111', 'http-pull', 'COMPLETED'),
    };
    const after = roundTrip(map);
    const original = map['tp-aaa111111111'];
    const restored = after['tp-aaa111111111'];
    for (const k of Object.keys(original)) {
        assert.deepEqual(restored[k], original[k], 'field drifted: ' + k);
    }
});

test('round-trip preserves the access object shape (HTTP-PULL)', () => {
    const map = { 'tp-x': makeTransfer('tp-x', 'http-pull', 'COMPLETED') };
    const restored = roundTrip(map)['tp-x'];
    for (const k of ['url', 'token', 'expiresAt', 'bootstrap', 'topic', 'sasl']) {
        assert.ok(k in restored.access, 'access.' + k + ' missing');
    }
});

test('round-trip preserves nested SASL credentials', () => {
    const map = {
        'tp-y': Object.assign(makeTransfer('tp-y', 'kafka-streaming', 'COMPLETED'), {
            access: {
                url: null, token: null, expiresAt: '2026-04-07T01:00:00.000000+00:00',
                bootstrap: 'kafka.example:9092',
                topic: 'iot.dataset.dataset:facis:net-grid-hourly.tp-tp-y',
                sasl: { mechanism: 'SCRAM-SHA-256', username: 'user_tp-y', password: 'AbC' },
            }
        })
    };
    const restored = roundTrip(map)['tp-y'];
    assert.deepEqual(restored.access.sasl, { mechanism: 'SCRAM-SHA-256', username: 'user_tp-y', password: 'AbC' });
});

test('null values survive (reason, access fields not used by current format)', () => {
    const map = { 'tp-z': makeTransfer('tp-z', 'http-pull', 'STARTED') };
    const restored = roundTrip(map)['tp-z'];
    assert.equal(restored.reason, null);
    assert.equal(restored.access, null);
});

test('multiple transfers in the same map all survive', () => {
    const map = {};
    for (let i = 0; i < 10; i++) {
        map['tp-' + String(i).padStart(12, '0')] = makeTransfer('tp-' + String(i).padStart(12, '0'), 'http-pull', 'COMPLETED');
    }
    const after = roundTrip(map);
    assert.equal(Object.keys(after).length, 10);
});

test('empty map round-trips to empty map', () => {
    assert.deepEqual(roundTrip({}), {});
});
