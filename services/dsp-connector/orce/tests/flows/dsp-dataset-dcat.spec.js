// NF-7 (audit 2026-07-24): GET /dsp/catalog/datasets/:id must return a dcat:Dataset
// JSON-LD (with @context, @id, @type) so a DSP consumer / the TCK can JSON-LD-expand
// it — previously it returned the raw internal record, causing Catalog01Test cat_01_02/03
// to NPE on the expanded @id/@type.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runNode } = require('../harness/run-node.js');
const FLOW = path.join(__dirname, '..', '..', 'flows', 'facis-dsp-catalogue.json');

test('dataset lookup returns a dcat:Dataset JSON-LD with @context/@id/@type', async () => {
  const flowCtx = new Map();
  flowCtx.set('catalogue', [
    { id: 'CAT0101', metadata: { title: 'T', description: 'D', format: 'iceberg/parquet' }, offers: [{ id: 'offer:CAT0101:read' }] },
  ]);
  const r = await runNode(FLOW, 'dsp-cat-dataset-fn', {
    msg: { req: { params: { id: 'CAT0101' } } }, flowCtx,
  });
  const p = r.result.payload;
  assert.equal(r.result.statusCode, 200);
  assert.ok(Array.isArray(p['@context']) && p['@context'][0].includes('dspace'));
  assert.equal(p['@type'], 'dcat:Dataset');
  assert.equal(p['@id'], 'CAT0101');
  assert.equal(p['dct:title'], 'T');
  assert.ok(Array.isArray(p['dcat:distribution']) && p['dcat:distribution'][0]['@type'] === 'dcat:Distribution');
  assert.equal(p['odrl:hasPolicy'][0]['@id'], 'offer:CAT0101:read');
  assert.equal(p.id, undefined, 'must not leak the raw internal record shape');
});

test('dataset lookup 404s a typed CatalogError for a missing id', async () => {
  const flowCtx = new Map(); flowCtx.set('catalogue', []);
  const r = await runNode(FLOW, 'dsp-cat-dataset-fn', { msg: { req: { params: { id: 'nope' } } }, flowCtx });
  assert.equal(r.result.statusCode, 404);
  assert.equal(r.result.payload['@type'], 'CatalogError');
});
