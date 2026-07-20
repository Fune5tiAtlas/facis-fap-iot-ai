/* eslint-disable */
//
// catalogue-derive-harness.spec.js — tests dsp-cat-derive-fn (catalogue
// derivation from the lakehouse) from facis-dsp-catalogue.json via
// ../harness/run-node.js. The Trino call is exercised against a real local
// HTTP server (same convention as dsp-data-trino-harness.spec.js) so the
// nextUri pagination loop runs for real, not against a hand-written
// stand-in. Trino-down is simulated by pointing DSP_TRINO_URL at an
// unreachable port (ECONNREFUSED → the node's catch branch).
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('../harness/run-node.js');

const CAT_FLOW = '../flows/facis-dsp-catalogue.json';

// Overlay fixture copied from the committed source so it can't drift from
// the real catalogue (same approach as dsp-data-trino-harness.spec.js).
const TMP_DATASETS_FILE = path.join(os.tmpdir(), 'catalogue-derive-harness-datasets.json');
const REAL_DATASETS_FILE = path.join(__dirname, '../../config/datasets.json');
const OVERLAY = JSON.parse(fs.readFileSync(REAL_DATASETS_FILE, 'utf8'));

before(() => {
    fs.copyFileSync(REAL_DATASETS_FILE, TMP_DATASETS_FILE);
});

after(() => {
    fs.rmSync(TMP_DATASETS_FILE, { force: true });
});

function baseEnv(overrides) {
    return Object.assign({
        DSP_TRINO_USER: 'admin',
        DSP_TRINO_PASSWORD: 'x',
        DSP_TRINO_CATALOG: 'fap-iotai-stackable',
        DSP_DATASETS_PATH: TMP_DATASETS_FILE
    }, overrides || {});
}

test('derives catalogue from live tables merged with overlay', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits++;
        res.setHeader('Content-Type', 'application/json');
        if (hits === 1) {
            res.end(JSON.stringify({
                columns: [{ name: 'table_schema' }, { name: 'table_name' }],
                nextUri: 'http://127.0.0.1:' + server.address().port + '/page2'
            }));
        } else {
            res.end(JSON.stringify({ data: [['gold', 'net_grid_hourly'], ['gold', 'brand_new_table']] }));
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const flowCtx = new Map();
        await runNode(CAT_FLOW, 'dsp-cat-derive-fn', {
            env: baseEnv({ DSP_TRINO_URL: 'http://127.0.0.1:' + server.address().port }),
            msg: {},
            flowCtx
        });
        const merged = flowCtx.get('catalogue');
        assert.ok(Array.isArray(merged), 'catalogue must be an array');
        // Overlay entry for a live table: rich metadata preserved as-is.
        const netGrid = merged.find((d) => d.id === 'dataset:facis:net-grid-hourly');
        assert.ok(netGrid, 'net-grid-hourly overlay entry kept');
        assert.equal(netGrid.metadata.title, 'Net Grid Hourly KPIs');
        // Live table with no overlay entry: minimal auto-derived entry.
        const derived = merged.find((d) => d.id === 'dataset:facis:brand-new-table');
        assert.ok(derived, 'brand_new_table auto-derived');
        assert.equal(derived.metadata.table, 'brand_new_table');
        assert.equal(derived.metadata.schema, 'gold');
        assert.equal(derived.metadata.assetType, 'iot.timeseries');
        assert.equal(derived.metadata.format, 'iceberg/parquet');
        assert.equal(derived.metadata.timeColumn, null);
        assert.equal(derived.offers[0].id, 'offer:facis:brand-new-table:read');
        // Overlay tables absent from the live list are excluded.
        assert.equal(merged.some((d) => d.id === 'dataset:facis:energy-balance-hourly'), false);
        assert.equal(merged.length, 2, 'exactly the 1 kept overlay + 1 auto-derived entry');
        assert.equal(flowCtx.get('catalogueSource'), 'lakehouse');
        assert.equal(hits, 2, 'nextUri chain followed across both pages');
    } finally {
        server.close();
    }
});

test('bronze overlay entries validate against live bronze tables; bronze is never auto-derived', async () => {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            columns: [{ name: 'table_schema' }, { name: 'table_name' }],
            data: [
                ['gold', 'net_grid_hourly'],
                ['bronze', 'modbus_ingest_raw'],
                ['bronze', 'some_uncurated_landing_table']
            ]
        }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const flowCtx = new Map();
        await runNode(CAT_FLOW, 'dsp-cat-derive-fn', {
            env: baseEnv({ DSP_TRINO_URL: 'http://127.0.0.1:' + server.address().port }),
            msg: {},
            flowCtx
        });
        const merged = flowCtx.get('catalogue');
        // Curated bronze overlay entry with a live bronze table: kept.
        const modbus = merged.find((d) => d.id === 'dataset:facis:modbus-ingest-raw');
        assert.ok(modbus, 'curated bronze entry kept when its table is live');
        assert.equal(modbus.metadata.schema, 'bronze');
        // Curated bronze entry whose table is NOT live: dropped.
        assert.equal(merged.some((d) => d.id === 'dataset:facis:opcua-ingest-raw'), false);
        // Live bronze table without an overlay entry: NOT auto-derived.
        assert.equal(merged.some((d) => d.metadata.table === 'some_uncurated_landing_table'), false);
        // Gold auto-derivation unaffected (net_grid_hourly claimed by overlay).
        assert.equal(merged.length, 2, 'net-grid overlay + modbus bronze overlay only');
        assert.equal(flowCtx.get('catalogueSource'), 'lakehouse');
    } finally {
        server.close();
    }
});

test('keeps existing catalogue on Trino failure', async () => {
    const sentinel = [{ id: 'sentinel:kept' }];
    const flowCtx = new Map([['catalogue', sentinel]]);
    await runNode(CAT_FLOW, 'dsp-cat-derive-fn', {
        // Port 1 → ECONNREFUSED → request 'error' → catch branch.
        env: baseEnv({ DSP_TRINO_URL: 'http://127.0.0.1:1' }),
        msg: {},
        flowCtx
    });
    assert.equal(flowCtx.get('catalogue'), sentinel, 'existing catalogue untouched');
    assert.equal(flowCtx.get('catalogueSource'), undefined, 'not overwritten to a fallback source');
});

test('falls back to overlay when Trino fails and catalogue empty', async () => {
    const flowCtx = new Map();
    await runNode(CAT_FLOW, 'dsp-cat-derive-fn', {
        env: baseEnv({ DSP_TRINO_URL: 'http://127.0.0.1:1' }),
        msg: {},
        flowCtx
    });
    const cat = flowCtx.get('catalogue');
    assert.ok(Array.isArray(cat));
    assert.equal(cat.length, OVERLAY.length, 'full overlay served');
    assert.ok(cat.find((d) => d.id === 'dataset:facis:net-grid-hourly'));
    assert.equal(flowCtx.get('catalogueSource'), 'overlay-fallback');
});

test('follows nextUri chain', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits++;
        res.setHeader('Content-Type', 'application/json');
        if (hits === 1) {
            res.end(JSON.stringify({ nextUri: 'http://127.0.0.1:' + server.address().port + '/page2' }));
        } else {
            res.end(JSON.stringify({ columns: [{ name: 'table_schema' }, { name: 'table_name' }], data: [['gold', 'net_grid_hourly']] }));
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const flowCtx = new Map();
        await runNode(CAT_FLOW, 'dsp-cat-derive-fn', {
            env: baseEnv({ DSP_TRINO_URL: 'http://127.0.0.1:' + server.address().port }),
            msg: {},
            flowCtx
        });
        assert.equal(hits, 2, 'both the initial statement and the nextUri page were requested');
        assert.equal(flowCtx.get('catalogueSource'), 'lakehouse');
    } finally {
        server.close();
    }
});
