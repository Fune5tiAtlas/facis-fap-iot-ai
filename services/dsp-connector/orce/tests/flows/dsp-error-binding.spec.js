/* eslint-disable */
//
// dsp-error-binding.spec.js — NF-7: every DSP control-plane error body is a
// typed DSP 2025-1 error object (TransferError / ContractNegotiationError /
// CatalogError) in the normative wire format: unprefixed compact terms and
// an @context ARRAY containing the 2025-1 context URI. TransferError and
// ContractNegotiationError carry the required providerPid/consumerPid.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CTX = 'https://w3id.org/dspace/2025/1/context.jsonld';

function readFlow(name) {
    const p = path.join(__dirname, '..', '..', 'flows', name);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function funcsOf(flow) {
    return flow.filter((n) => n.type === 'function' && typeof n.func === 'string');
}

test('transfers: no plain-string {detail} error bodies remain', () => {
    for (const n of funcsOf(readFlow('facis-dsp-transfers.json'))) {
        assert.ok(!n.func.includes('{ detail:'), `${n.id} still builds a {detail} body`);
    }
});

test('negotiations: no plain-string {detail} error bodies remain', () => {
    for (const n of funcsOf(readFlow('facis-dsp-negotiations.json'))) {
        assert.ok(!n.func.includes('{ detail:'), `${n.id} still builds a {detail} body`);
    }
});

test('transfer error helper emits the normative TransferError wire shape', () => {
    const flow = readFlow('facis-dsp-transfers.json');
    for (const id of ['dsp-tx-create', 'dsp-tx-get', 'dsp-tx-suspend', 'dsp-tx-terminate', 'dsp-tx-kafka-admin']) {
        const n = flow.find((x) => x.id === id);
        assert.match(n.func, /'@type': 'TransferError'/, `${id}: @type`);
        assert.ok(n.func.includes(`'@context': ['${CTX}']`), `${id}: @context array`);
        assert.match(n.func, /providerPid/, `${id}: providerPid`);
        assert.match(n.func, /consumerPid/, `${id}: consumerPid`);
        assert.doesNotMatch(n.func, /'dspace:code'|'dspace:reason'|'dspace:Error'/, `${id}: prefixed terms`);
    }
});

test('invalid state transition returns 400 with invalid_state_transition (QA-flagged 400)', () => {
    const flow = readFlow('facis-dsp-transfers.json');
    for (const id of ['dsp-tx-suspend', 'dsp-tx-terminate']) {
        const n = flow.find((x) => x.id === id);
        assert.match(n.func, /dspTransferError\(400, 'invalid_state_transition'/, id);
        assert.match(n.func, /cur\.providerPid \|\| id, cur\.consumerPid \|\| id/, `${id}: pids echoed from state`);
    }
});

test('transfer creation failures (403 agreement checks) are TransferError too', () => {
    const n = readFlow('facis-dsp-transfers.json').find((x) => x.id === 'dsp-tx-agreement-check');
    assert.match(n.func, /'@type': 'TransferError'/);
    assert.doesNotMatch(n.func, /dspace:Error/);
});

test('transfers and negotiations persist providerPid/consumerPid', () => {
    const tx = readFlow('facis-dsp-transfers.json').find((x) => x.id === 'dsp-tx-create');
    assert.match(tx.func, /providerPid: transferId/);
    assert.match(tx.func, /consumerPid: body\.consumerPid \|\| transferId/);
    const neg = readFlow('facis-dsp-negotiations.json').find((x) => x.id === 'dsp-neg-create');
    assert.match(neg.func, /providerPid: negId/);
    assert.match(neg.func, /consumerPid: body\.consumerPid \|\| negId/);
});

test('negotiation errors are ContractNegotiationError', () => {
    const flow = readFlow('facis-dsp-negotiations.json');
    for (const id of ['dsp-neg-create', 'dsp-neg-get', 'dsp-neg-terminate']) {
        const n = flow.find((x) => x.id === id);
        assert.match(n.func, /'@type': 'ContractNegotiationError'/, id);
        assert.ok(n.func.includes(`'@context': ['${CTX}']`), `${id}: @context array`);
    }
});

test('catalogue: unsupported filter returns 400 CatalogError; dataset lookup exists', () => {
    const flow = readFlow('facis-dsp-catalogue.json');
    const q = flow.find((x) => x.id === 'dsp-cat-query');
    assert.match(q.func, /dspCatalogError\(400, 'unsupported_filter'/);
    assert.match(q.func, /'@type': 'CatalogError'/);
    const lookupIn = flow.find((x) => x.id === 'dsp-cat-in-dataset');
    assert.equal(lookupIn.url, '/dsp/catalog/datasets/:id');
    const lookupFn = flow.find((x) => x.id === 'dsp-cat-dataset-fn');
    assert.match(lookupFn.func, /dspCatalogError\(404, 'not_found'/);
});

test('catalogue: DSP binding path alias POST /dsp/catalog/request is wired', () => {
    const flow = readFlow('facis-dsp-catalogue.json');
    const alias = flow.find((x) => x.id === 'dsp-cat-in-alias');
    assert.equal(alias.url, '/dsp/catalog/request');
    assert.deepEqual(alias.wires, [['dsp-cat-mode-check']]);
});

test('well-known dspace-version metadata endpoint is served', () => {
    const flow = readFlow('facis-dsp-health.json');
    const httpIn = flow.find((x) => x.id === 'dsp-in-dspace-version');
    assert.equal(httpIn.url, '/.well-known/dspace-version');
    const fn = flow.find((x) => x.id === 'dsp-fn-dspace-version');
    assert.match(fn.func, /protocolVersions/);
    assert.match(fn.func, /version: '2025-1'/);
});
