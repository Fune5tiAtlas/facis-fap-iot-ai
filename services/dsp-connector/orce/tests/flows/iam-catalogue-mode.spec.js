/* eslint-disable */
//
// iam-catalogue-mode.spec.js — pure-logic test for the catalogue verification
// gate. Mirrors the `dsp-cat-mode-check` function node in
// facis-dsp-catalogue.json. Catalogue verification is OPTIONAL (catalogues
// are commonly public) — this gate decides whether the request even reaches
// the shared iam.verify link-call.
//

const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors dsp-cat-mode-check's func body exactly.
function catalogueMode(envValue) {
    const mode = (envValue || 'open').toLowerCase();
    return mode === 'verified' ? 'verified' : 'open';
}

test('unset env defaults to open', () => {
    assert.equal(catalogueMode(undefined), 'open');
});

test('empty string env defaults to open', () => {
    assert.equal(catalogueMode(''), 'open');
});

test('explicit "open" stays open', () => {
    assert.equal(catalogueMode('open'), 'open');
});

test('explicit "verified" (any case) requires verification', () => {
    assert.equal(catalogueMode('verified'), 'verified');
    assert.equal(catalogueMode('VERIFIED'), 'verified');
    assert.equal(catalogueMode('Verified'), 'verified');
});

test('unrecognized value falls back to open (fail-open by design — catalogues are public by default)', () => {
    assert.equal(catalogueMode('bogus'), 'open');
});
