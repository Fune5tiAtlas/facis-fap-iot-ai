/* eslint-disable */
//
// dsp-catalog-binding.spec.js — NF-7 Gap 5: POST /dsp/catalog/request (the DSP
// binding spelling) answers with a DSP 2025-1 dcat:Catalog of dcat:Dataset
// entries, while the FACIS spelling POST /dsp/catalogue/request keeps its native
// { datasets, nextCursor } shape. Runs the real dsp-cat-query func string via
// ../harness/run-node.js.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runNode } = require('../harness/run-node.js');

const FLOW = path.join(__dirname, '..', '..', 'flows', 'facis-dsp-catalogue.json');
const CTX = 'https://w3id.org/dspace/2025/1/context.jsonld';

const CATALOGUE = [
    {
        id: 'dataset:facis:net-grid-hourly',
        metadata: { title: 'Net Grid Hourly KPIs', description: 'Hourly KPIs', assetType: 'iot.timeseries', format: 'iceberg/parquet' },
        offers: [{ id: 'offer:facis:net-grid-hourly:read', policySummary: { purpose: 'analytics' } }]
    },
    {
        id: 'dataset:facis:weather-hourly',
        metadata: { title: 'Weather Hourly', description: 'Weather', assetType: 'iot.timeseries', format: 'iceberg/parquet' },
        offers: [{ id: 'offer:facis:weather-hourly:read', policySummary: { purpose: 'analytics' } }]
    }
];

function flowWithCatalogue() {
    return new Map([['catalogue', CATALOGUE]]);
}

test('DSP path returns a valid dcat:Catalog with dcat:Dataset entries', async () => {
    const r = await runNode(FLOW, 'dsp-cat-query', {
        msg: { payload: {}, req: { url: '/dsp/catalog/request' } },
        flowCtx: flowWithCatalogue()
    });
    const cat = r.result[0].payload;
    assert.equal(r.result[0].statusCode, 200);
    assert.equal(cat['@context'][0], CTX);
    assert.equal(cat['@context'].length, 1);
    assert.equal(cat['@type'], 'dcat:Catalog');
    assert.ok(cat['@id'], 'catalog has an @id');
    assert.ok(Array.isArray(cat['dcat:dataset']), 'dcat:dataset is an array');
    assert.equal(cat['dcat:dataset'].length, 2);

    const ds = cat['dcat:dataset'][0];
    assert.equal(ds['@type'], 'dcat:Dataset');
    assert.equal(ds['@id'], 'dataset:facis:net-grid-hourly');
    assert.equal(ds['dct:title'], 'Net Grid Hourly KPIs');
    assert.ok(Array.isArray(ds['dcat:distribution']) && ds['dcat:distribution'].length >= 1);
    assert.equal(ds['dcat:distribution'][0]['@type'], 'dcat:Distribution');
    assert.ok(Array.isArray(ds['odrl:hasPolicy']) && ds['odrl:hasPolicy'].length >= 1);
    assert.equal(ds['odrl:hasPolicy'][0]['@id'], 'offer:facis:net-grid-hourly:read');

    assert.equal(cat.datasets, undefined, 'not the FACIS shape');
    assert.equal(cat.nextCursor, undefined);
});

test('DSP catalog carries a pagination cursor as dspace:nextCursor when more remain', async () => {
    const r = await runNode(FLOW, 'dsp-cat-query', {
        msg: { payload: { page: { limit: 1 } }, req: { url: '/dsp/catalog/request' } },
        flowCtx: flowWithCatalogue()
    });
    const cat = r.result[0].payload;
    assert.equal(cat['dcat:dataset'].length, 1);
    assert.equal(cat['dspace:nextCursor'], '1');
});

test('FACIS path is unchanged: { datasets, nextCursor } shape (no regression)', async () => {
    const r = await runNode(FLOW, 'dsp-cat-query', {
        msg: { payload: {}, req: { url: '/dsp/catalogue/request' } },
        flowCtx: flowWithCatalogue()
    });
    const body = r.result[0].payload;
    assert.ok(Array.isArray(body.datasets), 'FACIS datasets array');
    assert.equal(body.datasets.length, 2);
    assert.equal(body.nextCursor, null);
    assert.equal(body['@type'], undefined, 'no DSP envelope on the FACIS path');
});

test('unsupported filter still returns a typed CatalogError on the DSP path (400)', async () => {
    const r = await runNode(FLOW, 'dsp-cat-query', {
        msg: { payload: { filter: [] }, req: { url: '/dsp/catalog/request' } },
        flowCtx: flowWithCatalogue()
    });
    assert.equal(r.result[0].statusCode, 400);
    assert.equal(r.result[0].payload['@type'], 'CatalogError');
    assert.equal(r.result[0].payload.code, 'unsupported_filter');
});
