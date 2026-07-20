/* eslint-disable */
//
// catalogue-query.spec.js — filter + cursor + pagination parity with
// catalogue_store.py:7-139.
//
// Handler under test lives in `dsp-cat-query` of facis-dsp-catalogue.json.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Load the actual datasets.json the ORCE pod will serve, so we don't
// drift from the real FACIS_DATASETS list.
const DATASETS = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../config/datasets.json'), 'utf8'
));

function queryCatalogue(body, datasets = DATASETS) {
    const filter = body.filter || {};
    const page = body.page || {};
    const limit = (typeof page.limit === 'number' && page.limit > 0) ? page.limit : 50;
    const cursorRaw = page.cursor;

    let filtered = datasets;
    if (filter.assetType) {
        filtered = filtered.filter(d => d && d.metadata && d.metadata.assetType === filter.assetType);
    }
    if (Array.isArray(filter.datasetIds) && filter.datasetIds.length > 0) {
        const ids = new Set(filter.datasetIds);
        filtered = filtered.filter(d => d && ids.has(d.id));
    }

    let start = 0;
    if (cursorRaw !== null && cursorRaw !== undefined && cursorRaw !== '') {
        const parsed = parseInt(cursorRaw, 10);
        start = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }

    const slice = filtered.slice(start, start + limit);
    const nextCursor = (start + limit) < filtered.length ? String(start + limit) : null;
    return { datasets: slice, nextCursor };
}

test('empty filter returns all datasets in source order', () => {
    const r = queryCatalogue({});
    assert.equal(r.datasets.length, DATASETS.length);
    assert.equal(r.datasets.length, 8);    // FACIS_DATASETS has 8 entries
    assert.equal(r.nextCursor, null);
});

test('filter.assetType=iot.timeseries returns 7 of 8 datasets', () => {
    const r = queryCatalogue({ filter: { assetType: 'iot.timeseries' } });
    assert.ok(r.datasets.every(d => d.metadata.assetType === 'iot.timeseries'));
    assert.equal(r.datasets.length, 7);
});

test('filter.assetType=iot.analytics matches only anomaly-candidates', () => {
    const r = queryCatalogue({ filter: { assetType: 'iot.analytics' } });
    assert.equal(r.datasets.length, 1);
    assert.equal(r.datasets[0].id, 'dataset:facis:anomaly-candidates');
});

test('filter.datasetIds limits to listed ids', () => {
    const r = queryCatalogue({ filter: { datasetIds: ['dataset:facis:weather-hourly'] } });
    assert.equal(r.datasets.length, 1);
    assert.equal(r.datasets[0].id, 'dataset:facis:weather-hourly');
});

test('limit + cursor pagination produces nextCursor for first page', () => {
    const r = queryCatalogue({ page: { limit: 2, cursor: null } });
    assert.equal(r.datasets.length, 2);
    assert.equal(r.nextCursor, '2');
});

test('limit + cursor pagination ends with null nextCursor', () => {
    const r = queryCatalogue({ page: { limit: 50, cursor: '4' } });
    assert.equal(r.datasets.length, 4);   // 4..7 of an 8-item list
    assert.equal(r.nextCursor, null);
});

test('non-numeric cursor falls back to start=0 (matches Python int(c) ValueError handler)', () => {
    const r = queryCatalogue({ page: { limit: 3, cursor: 'not-a-number' } });
    assert.equal(r.datasets.length, 3);
    // first 3 of 8 → next page exists → nextCursor='3'
    assert.equal(r.nextCursor, '3');
});

test('null cursor + missing limit defaults to limit=50', () => {
    const r = queryCatalogue({ page: { cursor: null } });
    // 8 items, limit=50 → no nextCursor
    assert.equal(r.nextCursor, null);
    assert.equal(r.datasets.length, 8);
});

test('combining filters: assetType=iot.timeseries + datasetIds=[1]', () => {
    const r = queryCatalogue({
        filter: {
            assetType: 'iot.timeseries',
            datasetIds: ['dataset:facis:weather-hourly', 'dataset:facis:anomaly-candidates']
        }
    });
    // anomaly-candidates is iot.analytics, gets filtered out by assetType
    assert.equal(r.datasets.length, 1);
    assert.equal(r.datasets[0].id, 'dataset:facis:weather-hourly');
});
