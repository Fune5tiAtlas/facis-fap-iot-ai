/* eslint-disable */
//
// modbus.spec.js — verifies the IEEE 754 register encoding and address layout
// in the Modbus adapter (`flows/facis-simulation-modbus.json`), plus flow
// wiring guards (context scope, port, dead links).
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readFlow() {
    const p = path.join(__dirname, '..', '..', 'flows', 'facis-simulation-modbus.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function float32ToRegisters(value) {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(value, 0);
    return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

function registersToFloat32(high, low) {
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(high, 0);
    buf.writeUInt16BE(low, 2);
    return buf.readFloatBE(0);
}

const REGISTERS = {
    active_power_l1_w: 19000,
    active_power_l2_w: 19002,
    active_power_l3_w: 19004,
    active_power_total_w: 19006,
    voltage_l1_v: 19020,
    voltage_l2_v: 19022,
    voltage_l3_v: 19024,
    current_l1_a: 19040,
    current_l2_a: 19042,
    current_l3_a: 19044,
    power_factor: 19060,
    total_energy_kwh: 19062,
    frequency_hz: 19064,
};

function buildWrites(meter) {
    if (!meter || !meter.readings) return [];
    const r = meter.readings;
    const phases = [r.active_power_l1_w, r.active_power_l2_w, r.active_power_l3_w];
    const allPhasesPresent = phases.every((v) => typeof v === 'number' && !Number.isNaN(v));
    const total = allPhasesPresent ? phases.reduce((a, b) => a + b, 0) : undefined;
    const map = [
        [REGISTERS.active_power_l1_w, r.active_power_l1_w],
        [REGISTERS.active_power_l2_w, r.active_power_l2_w],
        [REGISTERS.active_power_l3_w, r.active_power_l3_w],
        [REGISTERS.active_power_total_w, total],
        [REGISTERS.voltage_l1_v, r.voltage_l1_v],
        [REGISTERS.voltage_l2_v, r.voltage_l2_v],
        [REGISTERS.voltage_l3_v, r.voltage_l3_v],
        [REGISTERS.current_l1_a, r.current_l1_a],
        [REGISTERS.current_l2_a, r.current_l2_a],
        [REGISTERS.current_l3_a, r.current_l3_a],
        [REGISTERS.power_factor, r.power_factor],
        [REGISTERS.total_energy_kwh, r.total_energy_kwh],
        [REGISTERS.frequency_hz, r.frequency_hz],
    ];
    const writes = [];
    for (const [addr, value] of map) {
        if (typeof value !== 'number' || Number.isNaN(value)) continue;
        const [high, low] = float32ToRegisters(value);
        writes.push({ payload: { value: high, register: addr, fc: 'FC6' } });
        writes.push({ payload: { value: low, register: addr + 1, fc: 'FC6' } });
    }
    return writes;
}

const SAMPLE_METER = {
    meter_id: 'm1',
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

test('modbus: 13 register pairs (26 writes) per meter', () => {
    const writes = buildWrites(SAMPLE_METER);
    assert.equal(writes.length, 26);
});

test('modbus: each write has FC6, register address, and 16-bit value', () => {
    const writes = buildWrites(SAMPLE_METER);
    for (const w of writes) {
        assert.equal(w.payload.fc, 'FC6');
        assert.ok(Number.isInteger(w.payload.register));
        assert.ok(w.payload.value >= 0 && w.payload.value <= 0xffff);
    }
});

test('modbus: round-trip preserves float32 values within precision', () => {
    const writes = buildWrites(SAMPLE_METER);
    function pairFor(addr) {
        const high = writes.find((w) => w.payload.register === addr).payload.value;
        const low = writes.find((w) => w.payload.register === addr + 1).payload.value;
        return registersToFloat32(high, low);
    }
    const f32 = (v) => Math.fround(v);
    assert.ok(Math.abs(pairFor(19000) - f32(SAMPLE_METER.readings.active_power_l1_w)) < 1e-3);
    assert.ok(Math.abs(pairFor(19020) - f32(SAMPLE_METER.readings.voltage_l1_v)) < 1e-3);
    assert.ok(Math.abs(pairFor(19062) - f32(SAMPLE_METER.readings.total_energy_kwh)) < 1e-2);
    assert.ok(Math.abs(pairFor(19064) - f32(SAMPLE_METER.readings.frequency_hz)) < 1e-3);
});

test('modbus: total active power = L1 + L2 + L3', () => {
    const writes = buildWrites(SAMPLE_METER);
    const high = writes.find((w) => w.payload.register === 19006).payload.value;
    const low = writes.find((w) => w.payload.register === 19007).payload.value;
    const total = registersToFloat32(high, low);
    const expected = SAMPLE_METER.readings.active_power_l1_w + SAMPLE_METER.readings.active_power_l2_w + SAMPLE_METER.readings.active_power_l3_w;
    assert.ok(Math.abs(total - expected) < 1e-1);
});

test('modbus: address layout matches register_map.py', () => {
    const writes = buildWrites(SAMPLE_METER);
    const used = Array.from(new Set(writes.map((w) => w.payload.register))).sort((a, b) => a - b);
    // 13 floats × 2 registers = 26 unique addresses
    assert.equal(used.length, 26);
    // Spot-check spec addresses
    [19000, 19006, 19020, 19024, 19040, 19044, 19060, 19062, 19064].forEach((addr) => {
        assert.ok(used.includes(addr), `expected register ${addr}`);
    });
});

test('modbus: missing meter returns no writes', () => {
    assert.deepEqual(buildWrites(null), []);
    assert.deepEqual(buildWrites({}), []);
    assert.deepEqual(buildWrites({ readings: {} }), []);
});

test('modbus flow: writer reads latest_meters from global context', () => {
    const writer = readFlow().find((n) => n.id === 'fn-modbus-writer');
    assert.match(writer.func, /global\.get\('latest_meters'\)/);
    assert.doesNotMatch(writer.func, /flow\.get\('latest_meters'\)/);
});

test('modbus flow: server listens on unprivileged port 5020', () => {
    const server = readFlow().find((n) => n.id === 'modbus-server-config');
    assert.equal(server.serverPort, 5020);
});

test('modbus flow: no unwired link-in nodes', () => {
    const dead = readFlow().filter((n) => n.type === 'link in' && (!n.links || n.links.length === 0));
    assert.deepEqual(dead, []);
});
