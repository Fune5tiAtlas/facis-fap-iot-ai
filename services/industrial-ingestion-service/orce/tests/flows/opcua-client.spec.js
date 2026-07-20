/* eslint-disable */
//
// opcua-client.spec.js — verifies the OPC UA ingestion client
// (`flows/facis-inding-opcua-client.json`): cycle aggregation, StatusCode →
// quality mapping, fail-the-cycle semantics, and flow configuration.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const METRICS = [
    'active_power_l1_w', 'active_power_l2_w', 'active_power_l3_w',
    'active_power_total_w',
    'voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v',
    'current_l1_a', 'current_l2_a', 'current_l3_a',
    'power_factor', 'total_energy_kwh', 'frequency_hz',
];
const PREFIX = 'ns=1;s=FACIS.EnergyMeter.';

function readClientFlow() {
    const p = path.join(__dirname, '..', '..', 'flows', 'facis-inding-opcua-client.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Mirrors the `aggregate cycle + quality` node: feed per-item messages,
// return {snapshot} once complete, {error} on Bad/non-numeric, null while
// the cycle is still filling.
function makeAggregator() {
    const state = { cycles: {}, failed: {} };
    return function feed(msg) {
        if (!msg.cycle_id || msg.topic === 'readmultiple' || msg.topic === 'clearitems') return null;
        if (state.failed[msg.cycle_id]) return null;
        const expected = Number(msg.expected_items || 13);
        const cycle = state.cycles[msg.cycle_id] || { items: [] };
        const statusName = msg.statusCode && msg.statusCode.name ? String(msg.statusCode.name) : 'Good';
        const metric = String(msg.topic).startsWith(PREFIX)
            ? String(msg.topic).slice(PREFIX.length)
            : String(msg.topic);
        const fail = (reason) => {
            delete state.cycles[msg.cycle_id];
            state.failed[msg.cycle_id] = true;
            return { error: reason };
        };
        if (/^Bad/.test(statusName)) return fail(`Bad status for ${metric}`);
        const value = Number(msg.payload);
        if (!Number.isFinite(value)) return fail(`non-numeric value for ${metric}`);
        cycle.items.push({ metric, value, status: statusName, source_timestamp: msg.sourceTimestamp || null });
        if (cycle.items.length < expected) {
            state.cycles[msg.cycle_id] = cycle;
            return null;
        }
        delete state.cycles[msg.cycle_id];
        const readings = {};
        let quality = 'good';
        for (const item of cycle.items) {
            readings[item.metric] = item.value;
            if (/^Uncertain/.test(item.status)) quality = 'uncertain';
        }
        return { snapshot: { readings, quality } };
    };
}

function itemMsg(cycleId, metric, value, statusName) {
    return {
        cycle_id: cycleId,
        expected_items: 13,
        topic: PREFIX + metric,
        payload: value,
        statusCode: { name: statusName || 'Good' },
        sourceTimestamp: new Date(0),
    };
}

test('opcua-client: a complete Good cycle emits one snapshot with 13 readings', () => {
    const feed = makeAggregator();
    let out = null;
    METRICS.forEach((m, i) => {
        out = feed(itemMsg('c1', m, 100 + i));
        if (i < METRICS.length - 1) assert.equal(out, null);
    });
    assert.ok(out.snapshot);
    assert.equal(Object.keys(out.snapshot.readings).length, 13);
    assert.equal(out.snapshot.quality, 'good');
    assert.equal(out.snapshot.readings.active_power_l1_w, 100);
});

test('opcua-client: Uncertain status downgrades quality but still publishes', () => {
    const feed = makeAggregator();
    let out = null;
    METRICS.forEach((m, i) => {
        out = feed(itemMsg('c1', m, 1, i === 3 ? 'UncertainLastUsableValue' : 'Good'));
    });
    assert.ok(out.snapshot);
    assert.equal(out.snapshot.quality, 'uncertain');
});

test('opcua-client: Bad status fails the whole cycle (no partial snapshot)', () => {
    const feed = makeAggregator();
    let sawError = null;
    METRICS.forEach((m, i) => {
        const out = feed(itemMsg('c1', m, 1, i === 5 ? 'BadNodeIdUnknown' : 'Good'));
        if (out && out.error) sawError = out.error;
        if (out && out.snapshot) assert.fail('partial cycle must not emit a snapshot');
    });
    assert.match(sawError, /Bad status/);
});

test('opcua-client: non-numeric value fails the whole cycle', () => {
    const feed = makeAggregator();
    let sawError = null;
    METRICS.forEach((m, i) => {
        const out = feed(itemMsg('c1', m, i === 0 ? 'not-a-number' : 1));
        if (out && out.error) sawError = out.error;
        if (out && out.snapshot) assert.fail('cycle with invalid value must not emit');
    });
    assert.match(sawError, /non-numeric/);
});

test('opcua-client: incomplete cycle never emits', () => {
    const feed = makeAggregator();
    for (let i = 0; i < 12; i += 1) {
        assert.equal(feed(itemMsg('c1', METRICS[i], 1)), null);
    }
});

test('opcua-client flow: readmultiple against a None/anonymous demo endpoint', () => {
    const flow = readClientFlow();
    const client = flow.find((n) => n.type === 'OpcUa-Client');
    assert.equal(client.action, 'readmultiple');
    const endpoint = flow.find((n) => n.type === 'OpcUa-Endpoint');
    assert.equal(endpoint.endpoint, '${OPCUA_ENDPOINT}');
    assert.equal(endpoint.secpol, 'None');
    assert.equal(endpoint.secmode, 'None');
    assert.equal(endpoint.login, false);
});

test('opcua-client flow: scheduler clears items and polls all 13 metrics', () => {
    const scheduler = readClientFlow().find((n) => n.id === 'inding-opcua-scheduler');
    assert.match(scheduler.func, /clearitems/);
    assert.match(scheduler.func, /readmultiple/);
    assert.match(scheduler.func, /OPCUA_POLL_MS/);
    for (const m of METRICS) {
        assert.ok(scheduler.func.includes(`'${m}'`), `metric ${m} missing from scheduler`);
    }
});

test('opcua-client flow: read-only (no write/method actions)', () => {
    const clients = readClientFlow().filter((n) => n.type === 'OpcUa-Client');
    for (const c of clients) {
        assert.ok(!/write|method/.test(c.action), `client action ${c.action} is not read-only`);
    }
});
