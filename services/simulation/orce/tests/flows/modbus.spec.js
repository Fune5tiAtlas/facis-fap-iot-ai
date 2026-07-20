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

// Mirrors fn-modbus-writer: ONE contiguous byte-array block write.
// The server node's input path is byte-addressed at address*8; TCP reads
// serve register R from byte R*2 — so the block must be delivered as a
// single copy at (BASE_REGISTER*2)/8 to land at the Janitza addresses.
const BASE_REGISTER = 19000;
const BLOCK_REGISTERS = 66;
const WRITE_ADDRESS = (BASE_REGISTER * 2) / 8;

function buildBlockWrite(meter) {
    if (!meter || !meter.readings) return null;
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
    const block = Buffer.alloc(BLOCK_REGISTERS * 2);
    let written = 0;
    for (const [addr, value] of map) {
        if (typeof value !== 'number' || Number.isNaN(value)) continue;
        block.writeFloatBE(value, (addr - BASE_REGISTER) * 2);
        written++;
    }
    if (written === 0) return null;
    return { payload: { value: Array.from(block), register: 'holding', address: WRITE_ADDRESS, disableMsgOutput: 1 } };
}

function blockFloatAt(write, registerAddr) {
    const off = (registerAddr - BASE_REGISTER) * 2;
    const buf = Buffer.from(write.payload.value);
    return buf.readFloatBE(off);
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

test('modbus: one contiguous 66-register (132-byte) block write per meter', () => {
    const w = buildBlockWrite(SAMPLE_METER);
    assert.ok(w);
    assert.equal(w.payload.register, 'holding');
    assert.equal(w.payload.value.length, BLOCK_REGISTERS * 2);
    for (const b of w.payload.value) {
        assert.ok(Number.isInteger(b) && b >= 0 && b <= 0xff);
    }
});

test('modbus: write address maps byte offset 19000*2 through the *8 write factor', () => {
    // Read side serves register R from byte R*2; write side lands at address*8.
    assert.equal(WRITE_ADDRESS, 4750);
    assert.equal(WRITE_ADDRESS * 8, BASE_REGISTER * 2);
    assert.ok(Number.isInteger(WRITE_ADDRESS), 'BASE_REGISTER must be divisible by 4');
});

test('modbus: round-trip preserves float32 values within precision', () => {
    const w = buildBlockWrite(SAMPLE_METER);
    const f32 = (v) => Math.fround(v);
    assert.ok(Math.abs(blockFloatAt(w, 19000) - f32(SAMPLE_METER.readings.active_power_l1_w)) < 1e-3);
    assert.ok(Math.abs(blockFloatAt(w, 19020) - f32(SAMPLE_METER.readings.voltage_l1_v)) < 1e-3);
    assert.ok(Math.abs(blockFloatAt(w, 19062) - f32(SAMPLE_METER.readings.total_energy_kwh)) < 1e-2);
    assert.ok(Math.abs(blockFloatAt(w, 19064) - f32(SAMPLE_METER.readings.frequency_hz)) < 1e-3);
});

test('modbus: total active power = L1 + L2 + L3', () => {
    const w = buildBlockWrite(SAMPLE_METER);
    const expected = SAMPLE_METER.readings.active_power_l1_w + SAMPLE_METER.readings.active_power_l2_w + SAMPLE_METER.readings.active_power_l3_w;
    assert.ok(Math.abs(blockFloatAt(w, 19006) - expected) < 1e-1);
});

test('modbus: unmapped gap registers stay zero', () => {
    const w = buildBlockWrite(SAMPLE_METER);
    const buf = Buffer.from(w.payload.value);
    // 19008..19019 carry no fields in the Janitza layout
    for (let reg = 19008; reg < 19020; reg++) {
        assert.equal(buf.readUInt16BE((reg - BASE_REGISTER) * 2), 0, `register ${reg}`);
    }
});

test('modbus: missing meter produces no write', () => {
    assert.equal(buildBlockWrite(null), null);
    assert.equal(buildBlockWrite({}), null);
    assert.equal(buildBlockWrite({ readings: {} }), null);
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

test('modbus flow: writer emits one block write at the derived address', () => {
    const writer = readFlow().find((n) => n.id === 'fn-modbus-writer');
    assert.match(writer.func, /register: 'holding', address: WRITE_ADDRESS/);
    assert.match(writer.func, /Array\.from\(block\)/);
    assert.doesNotMatch(writer.func, /fc: 'FC6'/);
});
