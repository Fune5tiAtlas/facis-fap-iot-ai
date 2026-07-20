/* eslint-disable */
//
// modbus-client.spec.js — verifies the Modbus TCP ingestion client
// (`flows/facis-inding-modbus-client.json`): float32 decode parity with the
// simulation fixture encoding, offset layout, and flow configuration.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const OFFSETS = {
    active_power_l1_w: 0,
    active_power_l2_w: 2,
    active_power_l3_w: 4,
    active_power_total_w: 6,
    voltage_l1_v: 20,
    voltage_l2_v: 22,
    voltage_l3_v: 24,
    current_l1_a: 40,
    current_l2_a: 42,
    current_l3_a: 44,
    power_factor: 60,
    total_energy_kwh: 62,
    frequency_hz: 64,
};

function readFlow(rel) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8'));
}

function readClientFlow() {
    return readFlow(path.join('flows', 'facis-inding-modbus-client.json'));
}

function float32ToRegisters(value) {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(value, 0);
    return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

// Mirrors the decode logic in the `decode registers + normalize` node.
function decodeRegisters(raw) {
    if (!Array.isArray(raw) || raw.length < 66) return null;
    const readings = {};
    for (const [metric, offset] of Object.entries(OFFSETS)) {
        const buf = Buffer.alloc(4);
        buf.writeUInt16BE(raw[offset], 0);
        buf.writeUInt16BE(raw[offset + 1], 2);
        const value = buf.readFloatBE(0);
        if (!Number.isFinite(value)) return null;
        readings[metric] = value;
    }
    return readings;
}

// Same values as the simulation fixture's SAMPLE_METER, so the decode is
// validated against the exact server-side encoding.
const SAMPLE_READINGS = {
    active_power_l1_w: 10234.5,
    active_power_l2_w: 10123.4,
    active_power_l3_w: 10345.6,
    active_power_total_w: 10234.5 + 10123.4 + 10345.6,
    voltage_l1_v: 230.5,
    voltage_l2_v: 231.0,
    voltage_l3_v: 229.8,
    current_l1_a: 45.2,
    current_l2_a: 44.7,
    current_l3_a: 45.9,
    power_factor: 0.97,
    total_energy_kwh: 123456.789,
    frequency_hz: 50.02,
};

function buildRegisterBlock(readings) {
    const raw = new Array(66).fill(0);
    for (const [metric, offset] of Object.entries(OFFSETS)) {
        const [high, low] = float32ToRegisters(readings[metric]);
        raw[offset] = high;
        raw[offset + 1] = low;
    }
    return raw;
}

test('modbus-client: decode inverts the fixture float32 ABCD encoding', () => {
    const raw = buildRegisterBlock(SAMPLE_READINGS);
    const readings = decodeRegisters(raw);
    assert.ok(readings);
    for (const [metric, expected] of Object.entries(SAMPLE_READINGS)) {
        assert.ok(
            Math.abs(readings[metric] - Math.fround(expected)) < 1e-2,
            `${metric}: ${readings[metric]} != ${expected}`
        );
    }
});

test('modbus-client: offsets match the fixture register map (base 19000)', () => {
    const simFlow = readFlow(path.join(
        '..', '..', 'simulation', 'orce', 'flows', 'facis-simulation-modbus.json'
    ));
    const writer = simFlow.find((n) => n.id === 'fn-modbus-writer');
    // The fixture writer declares offsets relative to BASE_REGISTER.
    const base = writer.func.match(/BASE_REGISTER = (\d+)/);
    assert.ok(base, 'fixture BASE_REGISTER not found');
    assert.equal(Number(base[1]), 19000, 'fixture base register');
    for (const [metric, offset] of Object.entries(OFFSETS)) {
        const m = writer.func.match(new RegExp(`${metric}:\\s*(\\d+)`));
        assert.ok(m, `fixture register for ${metric} not found`);
        assert.equal(Number(m[1]), offset, `offset mismatch for ${metric}`);
    }
});

test('modbus-client: incomplete register block is rejected', () => {
    assert.equal(decodeRegisters(null), null);
    assert.equal(decodeRegisters([]), null);
    assert.equal(decodeRegisters(new Array(65).fill(0)), null);
});

test('modbus-client flow: reads FC3, quantity 66, env-driven source', () => {
    const flow = readClientFlow();
    const scheduler = flow.find((n) => n.id === 'inding-modbus-scheduler');
    assert.match(scheduler.func, /fc:\s*3/);
    assert.match(scheduler.func, /quantity:\s*66/);
    assert.match(scheduler.func, /MODBUS_POLL_MS/);
    assert.match(scheduler.func, /MODBUS_BASE_ADDRESS/);
    const client = flow.find((n) => n.type === 'modbus-client');
    assert.equal(client.tcpHost, '${MODBUS_HOST}');
    assert.equal(client.tcpPort, '${MODBUS_PORT}');
    const getter = flow.find((n) => n.type === 'modbus-flex-getter');
    assert.equal(getter.keepMsgProperties, true);
});

test('modbus-client flow: read-only (no modbus write nodes)', () => {
    const writers = readClientFlow().filter((n) => /modbus-(write|flex-write)/.test(n.type));
    assert.deepEqual(writers, []);
});

test('modbus-client flow: errors route to the shared DLQ link', () => {
    const flow = readClientFlow();
    const catchNode = flow.find((n) => n.type === 'catch');
    assert.equal(catchNode.scope, null);
    const linkOut = flow.find((n) => n.id === 'inding-modbus-link-out-dlq');
    assert.deepEqual(linkOut.links, ['inding-link-in-dlq']);
});
