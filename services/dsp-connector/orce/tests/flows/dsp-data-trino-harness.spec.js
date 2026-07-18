/* eslint-disable */
//
// dsp-data-trino-harness.spec.js — tests dsp-data-lookup-fn (catalogue
// lookup) and dsp-data-trino-fn (Trino query + pagination + response
// shaping) from facis-dsp-data.json via ../harness/run-node.js. The Trino
// call is exercised against a real local HTTP server (not mocked at the
// https module level) so the pagination loop and column/row zipping run
// for real, not against a hand-written stand-in for Trino's response shape.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('../harness/run-node.js');

const DATA_FLOW = '../flows/facis-dsp-data.json';

// dsp-data-lookup-fn hardcodes /data/dsp-config/datasets.json — the real
// pod's read-only ConfigMap mount (see that node's own comment in
// facis-dsp-data.json for why it re-reads this file directly instead of
// sharing facis-dsp-catalogue.json's flow-context cache). This test runs
// the node's REAL code via run-node.js, so it needs that exact absolute
// path to exist; provision it from the committed source file (never
// duplicated inline, so this fixture can't drift from the real catalogue)
// and clean it up afterward. Requires a writable "/", true on any normal
// Linux dev box, CI runner, or container — NOT on a macOS host with
// System Integrity Protection's sealed root volume. Guarded rather than
// left to throw: an unguarded before() failure would cascade-fail every
// test in this file, including the four that have nothing to do with
// /data; instead only the two lookup-fn tests that actually need the
// fixture are skipped when it can't be provisioned.
const DSP_CONFIG_DIR = '/data/dsp-config';
const DSP_CONFIG_FILE = path.join(DSP_CONFIG_DIR, 'datasets.json');
const REAL_DATASETS_FILE = path.join(__dirname, '../../config/datasets.json');
let dspConfigAvailable = false;

before(() => {
    try {
        fs.mkdirSync(DSP_CONFIG_DIR, { recursive: true });
        fs.copyFileSync(REAL_DATASETS_FILE, DSP_CONFIG_FILE);
        dspConfigAvailable = true;
    } catch (err) {
        console.warn('dsp-data-trino-harness.spec.js: could not provision ' + DSP_CONFIG_FILE +
            ' (' + (err && err.message ? err.message : err) + ') — skipping the two lookup-fn tests ' +
            'that need it. Run under Docker/Linux CI for a writable "/" to exercise those.');
    }
});

after(() => {
    if (dspConfigAvailable) fs.rmSync(DSP_CONFIG_FILE, { force: true });
});

function baseWindow(overrides) {
    return Object.assign({ assetId: 'dataset:facis:net-grid-hourly', from: '', to: '', agreementId: '', roles: '' }, overrides);
}

test('lookup: known assetId resolves schema/table/timeColumn from the real datasets.json', (t) => {
    if (!dspConfigAvailable) return t.skip('/data/dsp-config not writable on this host');
    return (async () => {
        const r = await runNode(DATA_FLOW, 'dsp-data-lookup-fn', { msg: { _dspDataWindow: baseWindow() } });
        assert.equal(r.result[0]._dspDataWindow.schema, 'gold');
        assert.equal(r.result[0]._dspDataWindow.table, 'net_grid_hourly');
        assert.equal(r.result[0]._dspDataWindow.timeColumn, 'hour');
        assert.equal(r.result[1], null);
    })();
});

test('lookup: unknown assetId → 404 asset_not_found', (t) => {
    if (!dspConfigAvailable) return t.skip('/data/dsp-config not writable on this host');
    return (async () => {
        const r = await runNode(DATA_FLOW, 'dsp-data-lookup-fn', { msg: { _dspDataWindow: baseWindow({ assetId: 'dataset:facis:does-not-exist' }) } });
        assert.equal(r.result[0], null);
        assert.equal(r.result[1].statusCode, 404);
        assert.equal(r.result[1].payload['dspace:code'], 'asset_not_found');
    })();
});

test('trino: single-page result is returned as {assetId, schema, table, columns, rows, rowCount}', async () => {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            columns: [{ name: 'hour' }, { name: 'net_grid_kw' }],
            data: [['2026-04-01T00:00:00.000Z', 1.5], ['2026-04-01T01:00:00.000Z', 2.5]]
        }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const r = await runNode(DATA_FLOW, 'dsp-data-trino-fn', {
            env: { DSP_TRINO_URL: 'http://127.0.0.1:' + port, DSP_TRINO_USER: 'admin', DSP_TRINO_PASSWORD: 'x', DSP_TRINO_CATALOG: 'fap-iotai-stackable' },
            msg: { _dspDataWindow: baseWindow({ schema: 'gold', table: 'net_grid_hourly', timeColumn: 'hour' }) }
        });
        const out = r.sent[0];
        assert.equal(out.statusCode, 200);
        // JSON round-trip, not assert.deepEqual: columns/rows[0] are
        // constructed inside run-node.js's vm sandbox, so they belong to
        // that context's own Array/Object realm — deepStrictEqual's
        // prototype check fails against a host-realm literal even when
        // every property is identical (see iam-revocation-harness.spec.js
        // for the established precedent of this exact harness boundary).
        assert.equal(JSON.stringify(out.payload.columns), JSON.stringify(['hour', 'net_grid_kw']));
        assert.equal(out.payload.rowCount, 2);
        assert.equal(JSON.stringify(out.payload.rows[0]), JSON.stringify({ hour: '2026-04-01T00:00:00.000Z', net_grid_kw: 1.5 }));
    } finally {
        server.close();
    }
});

test('trino: follows nextUri across two pages and concatenates rows', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits++;
        res.setHeader('Content-Type', 'application/json');
        if (hits === 1) {
            res.end(JSON.stringify({
                columns: [{ name: 'hour' }],
                data: [['2026-04-01T00:00:00.000Z']],
                nextUri: 'http://127.0.0.1:' + server.address().port + '/page2'
            }));
        } else {
            res.end(JSON.stringify({ data: [['2026-04-01T01:00:00.000Z']] }));
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const r = await runNode(DATA_FLOW, 'dsp-data-trino-fn', {
            env: { DSP_TRINO_URL: 'http://127.0.0.1:' + server.address().port },
            msg: { _dspDataWindow: baseWindow({ schema: 'gold', table: 'net_grid_hourly', timeColumn: null }) }
        });
        assert.equal(r.sent[0].payload.rowCount, 2);
        assert.equal(hits, 2);
    } finally {
        server.close();
    }
});

test('trino: Trino error response → 502 data_source_unavailable', async () => {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'Table not found' } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const r = await runNode(DATA_FLOW, 'dsp-data-trino-fn', {
            env: { DSP_TRINO_URL: 'http://127.0.0.1:' + server.address().port },
            msg: { _dspDataWindow: baseWindow({ schema: 'gold', table: 'missing_table', timeColumn: null }) }
        });
        assert.equal(r.sent[0].statusCode, 502);
        assert.equal(r.sent[0].payload['dspace:code'], 'data_source_unavailable');
    } finally {
        server.close();
    }
});

test('trino: malformed from/to → 400 invalid_window, no request sent', async () => {
    const r = await runNode(DATA_FLOW, 'dsp-data-trino-fn', {
        env: { DSP_TRINO_URL: 'http://127.0.0.1:1' },
        msg: { _dspDataWindow: baseWindow({ schema: 'gold', table: 'net_grid_hourly', timeColumn: 'hour', from: 'not-a-date', to: '2026-04-01T00:00:00Z' }) }
    });
    assert.equal(r.sent[0].statusCode, 400);
    assert.equal(r.sent[0].payload['dspace:code'], 'invalid_window');
});
