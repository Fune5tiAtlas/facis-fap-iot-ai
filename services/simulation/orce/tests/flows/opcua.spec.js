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

test('opcua flow: addVariable registrations are paced through a no-drop rate limit', () => {
    // Firing all 13 addVariable messages in one synchronous burst let the
    // server drop a registration ("Variable not found ... current_l3_a").
    // The init must route through a rate-limit delay that does NOT drop.
    const flow = readFlow();
    const init = flow.find((n) => n.id === 'fn-opcua-init');
    const pace = flow.find((n) => n.id === init.wires[0][0]);
    assert.equal(pace.type, 'delay', 'init must feed a delay node');
    assert.equal(pace.pauseType, 'rate');
    assert.equal(pace.drop, false, 'pacing delay must not drop registrations');
    assert.deepEqual(pace.wires[0], ['opcua-server-config']);
});

test('opcua flow: server output feeds a confirmed-registration tracker', () => {
    // The server emits one { messageType:'Variable', nodeId } confirmation
    // per successful addVariable. The tracker records each confirmed metric
    // into the `opcua_registered` global — ground truth, not a guessed timer.
    const flow = readFlow();
    const server = flow.find((n) => n.type === 'OpcUa-Server');
    assert.deepEqual(server.wires[0], ['fn-opcua-track'], 'server output must feed the tracker');
    const track = flow.find((n) => n.id === 'fn-opcua-track');
    assert.ok(track && track.type === 'function', 'fn-opcua-track missing');
    assert.match(track.func, /messageType !== 'Variable' \|\| !p\.nodeId/,
        'tracker must accept only addVariable confirmations');
    assert.match(track.func, /Array\.isArray\(p\)/, 'tracker must ignore value-update batch echoes');
    assert.match(track.func, /global\.set\('opcua_registered'/);
});

test('opcua flow: init re-registers only variables not already confirmed', () => {
    // Re-adding an existing NodeId throws "already registered" in
    // node-opcua, so the catch-driven retry must add only the missing set.
    const flow = readFlow();
    const init = flow.find((n) => n.id === 'fn-opcua-init');
    assert.match(init.func, /global\.get\('opcua_registered'\)/);
    assert.match(init.func, /\.filter\(\(m\) => !registered\[m\]\)/,
        'init must register only metrics missing from the confirmed set');
});

test('opcua flow: writer is gated on the full confirmed-registration set', () => {
    // The writer must not publish until all 13 variables are confirmed
    // present in the address space — otherwise a redeploy (which rebuilds
    // the server empty) writes to non-existent nodes ("Variable not found").
    const flow = readFlow();
    const writer = flow.find((n) => n.id === 'fn-opcua-writer');
    assert.match(writer.func, /global\.get\('opcua_registered'\)/);
    assert.match(writer.func, /Object\.keys\(registered\)\.length < METRICS_TOTAL/,
        'writer gates on the count of confirmed registrations');
    assert.doesNotMatch(writer.func, /opcua_registered_at/,
        'the guessed time-based gate must be gone');
});

test('opcua flow: a start-time reset clears stale registration state', () => {
    // Global context survives a redeploy but the server address space does
    // not; the reset drops stale confirmations so the writer stays quiet
    // until the fresh registration re-confirms every variable.
    const flow = readFlow();
    const inj = flow.find((n) => n.id === 'inject-opcua-reset');
    assert.ok(inj, 'inject-opcua-reset missing');
    assert.equal(inj.once, true);
    assert.equal(Number(inj.onceDelay), 0, 'reset must fire immediately on deploy');
    assert.deepEqual(inj.wires[0], ['fn-opcua-reset']);
    const reset = flow.find((n) => n.id === 'fn-opcua-reset');
    assert.match(reset.func, /global\.set\('opcua_registered', \{\}\)/);
});
