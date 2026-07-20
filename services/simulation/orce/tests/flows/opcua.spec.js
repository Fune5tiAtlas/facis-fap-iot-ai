/* eslint-disable */
//
// opcua.spec.js — verifies the OPC UA demo server adapter
// (`flows/facis-simulation-opcua.json`): variable-update building logic,
// address-space registration, and endpoint security posture.
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

function readFlow() {
    const p = path.join(__dirname, '..', '..', 'flows', 'facis-simulation-opcua.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildUpdates(meter) {
    if (!meter || !meter.readings) return [];
    const r = meter.readings;
    const phases = [r.active_power_l1_w, r.active_power_l2_w, r.active_power_l3_w];
    const allPhasesPresent = phases.every((v) => typeof v === 'number' && Number.isFinite(v));
    const totalActiveW = allPhasesPresent ? phases.reduce((a, b) => a + b, 0) : undefined;
    const values = {
        active_power_l1_w: r.active_power_l1_w,
        active_power_l2_w: r.active_power_l2_w,
        active_power_l3_w: r.active_power_l3_w,
        active_power_total_w: totalActiveW,
        voltage_l1_v: r.voltage_l1_v,
        voltage_l2_v: r.voltage_l2_v,
        voltage_l3_v: r.voltage_l3_v,
        current_l1_a: r.current_l1_a,
        current_l2_a: r.current_l2_a,
        current_l3_a: r.current_l3_a,
        power_factor: r.power_factor,
        total_energy_kwh: r.total_energy_kwh,
        frequency_hz: r.frequency_hz,
    };
    const updates = [];
    for (const [name, value] of Object.entries(values)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        updates.push({
            messageType: 'Variable',
            namespace: 1,
            variableName: 'FACIS.EnergyMeter.' + name,
            variableValue: value,
            sourceTimestamp: meter.timestamp,
        });
    }
    return updates;
}

const SAMPLE_METER = {
    meter_id: 'm1',
    timestamp: '2026-07-19T14:00:00Z',
    readings: {
        active_power_l1_w: 10234.5,
        active_power_l2_w: 10123.4,
        active_power_l3_w: 10345.6,
        voltage_l1_v: 230.5,
        voltage_l2_v: 231.0,
        voltage_l3_v: 229.8,
        current_l1_a: 45.2,
        current_l2_a: 44.7,
        current_l3_a: 45.9,
        power_factor: 0.97,
        total_energy_kwh: 123456.789,
        frequency_hz: 50.02,
    },
};

test('opcua: 13 variable updates per meter', () => {
    const updates = buildUpdates(SAMPLE_METER);
    assert.equal(updates.length, 13);
    for (const u of updates) {
        assert.equal(u.messageType, 'Variable');
        assert.equal(u.namespace, 1);
        assert.match(u.variableName, /^FACIS\.EnergyMeter\./);
        assert.ok(Number.isFinite(u.variableValue));
        assert.equal(u.sourceTimestamp, SAMPLE_METER.timestamp);
    }
});

test('opcua: total active power = L1 + L2 + L3', () => {
    const updates = buildUpdates(SAMPLE_METER);
    const total = updates.find((u) => u.variableName.endsWith('active_power_total_w'));
    const expected = SAMPLE_METER.readings.active_power_l1_w
        + SAMPLE_METER.readings.active_power_l2_w
        + SAMPLE_METER.readings.active_power_l3_w;
    assert.ok(Math.abs(total.variableValue - expected) < 1e-6);
});

test('opcua: variable names mirror the Modbus metric set', () => {
    const names = buildUpdates(SAMPLE_METER).map((u) => u.variableName.replace('FACIS.EnergyMeter.', ''));
    assert.deepEqual(names.sort(), [...METRICS].sort());
});

test('opcua: non-finite values are skipped', () => {
    const meter = JSON.parse(JSON.stringify(SAMPLE_METER));
    meter.readings.frequency_hz = NaN;
    const updates = buildUpdates(meter);
    assert.equal(updates.length, 12);
    assert.ok(!updates.some((u) => u.variableName.endsWith('frequency_hz')));
});

test('opcua: missing meter returns no updates', () => {
    assert.deepEqual(buildUpdates(null), []);
    assert.deepEqual(buildUpdates({}), []);
    assert.deepEqual(buildUpdates({ readings: {} }), []);
});

test('opcua flow: server is demo-only (port 4840, None policy, anonymous, no encrypted endpoints)', () => {
    const server = readFlow().find((n) => n.type === 'OpcUa-Server');
    assert.ok(server, 'OpcUa-Server node missing');
    assert.equal(server.port, '4840');
    assert.equal(server.allowAnonymous, true);
    assert.equal(server.endpointNone, true);
    assert.equal(server.endpointSign, false);
    assert.equal(server.endpointSignEncrypt, false);
});

test('opcua flow: writer reads latest_meters from global context', () => {
    const writer = readFlow().find((n) => n.id === 'fn-opcua-writer');
    assert.match(writer.func, /global\.get\('latest_meters'\)/);
    assert.doesNotMatch(writer.func, /flow\.get\('latest_meters'\)/);
});

test('opcua flow: init registers all 13 metrics as Double variables', () => {
    const init = readFlow().find((n) => n.id === 'fn-opcua-init');
    assert.match(init.func, /addVariable/);
    assert.match(init.func, /datatype=Double/);
    for (const m of METRICS) {
        assert.ok(init.func.includes(`'${m}'`), `metric ${m} missing from init`);
    }
});

test('opcua flow: registration self-heals via catch -> rate limit -> init', () => {
    const flow = readFlow();
    const c = flow.find((n) => n.type === 'catch' && (n.scope || []).includes('opcua-server-config'));
    assert.ok(c, 'catch node scoped to the OPC UA server');
    const limiter = flow.find((n) => n.id === c.wires[0][0]);
    assert.equal(limiter.type, 'delay');
    assert.equal(limiter.pauseType, 'rate');
    assert.equal(limiter.drop, true);
    assert.deepEqual(limiter.wires[0], ['fn-opcua-init']);
});

test('opcua flow: initial registration waits out server boot', () => {
    const inj = readFlow().find((n) => n.id === 'inject-opcua-init');
    assert.ok(Number(inj.onceDelay) >= 15);
});
