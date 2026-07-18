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
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('../harness/run-node.js');

const DATA_FLOW = '../flows/facis-dsp-data.json';

// dsp-data-lookup-fn reads its path via env.get('DSP_DATASETS_PATH') with
// the real pod's ConfigMap mount (/data/dsp-config/datasets.json) as the
// production default — this test overrides that env var to point at a
// tmpdir fixture instead, so it never has to touch "/" (always writable,
// no root needed, works on every OS/CI). Fixture content is copied from
// the committed source file, never duplicated inline, so it can't drift
// from the real catalogue.
const TMP_DATASETS_FILE = path.join(os.tmpdir(), 'dsp-data-trino-harness-datasets.json');
const REAL_DATASETS_FILE = path.join(__dirname, '../../config/datasets.json');

before(() => {
    fs.copyFileSync(REAL_DATASETS_FILE, TMP_DATASETS_FILE);
});

after(() => {
    fs.rmSync(TMP_DATASETS_FILE, { force: true });
});

function baseWindow(overrides) {
    return Object.assign({ assetId: 'dataset:facis:net-grid-hourly', from: '', to: '', agreementId: '', roles: '' }, overrides);
}

test('lookup: known assetId resolves schema/table/timeColumn from the real datasets.json', async () => {
    const r = await runNode(DATA_FLOW, 'dsp-data-lookup-fn', {
        env: { DSP_DATASETS_PATH: TMP_DATASETS_FILE },
        msg: { _dspDataWindow: baseWindow() }
    });
    assert.equal(r.result[0]._dspDataWindow.schema, 'gold');
    assert.equal(r.result[0]._dspDataWindow.table, 'net_grid_hourly');
    assert.equal(r.result[0]._dspDataWindow.timeColumn, 'hour');
    assert.equal(r.result[1], null);
});

test('lookup: unknown assetId → 404 asset_not_found', async () => {
    const r = await runNode(DATA_FLOW, 'dsp-data-lookup-fn', {
        env: { DSP_DATASETS_PATH: TMP_DATASETS_FILE },
        msg: { _dspDataWindow: baseWindow({ assetId: 'dataset:facis:does-not-exist' }) }
    });
    assert.equal(r.result[0], null);
    assert.equal(r.result[1].statusCode, 404);
    assert.equal(r.result[1].payload['dspace:code'], 'asset_not_found');
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
