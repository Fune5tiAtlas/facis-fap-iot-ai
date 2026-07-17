/* eslint-disable */
//
// iam-enforce-off-parity.spec.js — proves DSP_IAM_ENFORCE=off preserves the
// pre-NF-1 behaviour exactly: counterparty comes from the request body when
// msg.identity is null (which is what dsp-iam-prep guarantees in off mode).
//
// Also proves the ownership-mismatch gate on dsp-tx-agreement-check applies
// in BOTH warn and enforce modes (msg._iamMode !== 'off'), but only once
// identity has actually resolved to a DID (Task 12 fix) — a null identity
// (unconfigured trustedIssuers, or a warn-mode failure logged-and-allowed)
// must never block; only 'off' unconditionally bypasses the check.
//
const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors dsp-neg-create's counterparty resolution exactly (unchanged since Task 7).
function resolveCounterparty(identity, bodyCounterparty) {
    return (identity && identity.did) ? identity.did : bodyCounterparty;
}

test('off mode: identity is null → counterparty is the raw body value (pre-NF-1 behaviour)', () => {
    const result = resolveCounterparty(null, 'did:web:c.example');
    assert.equal(result, 'did:web:c.example');
});

test('enforce mode: identity present → counterparty is the verified DID, body value ignored', () => {
    const result = resolveCounterparty({ did: 'did:web:verified.example' }, 'did:web:spoofed.example');
    assert.equal(result, 'did:web:verified.example');
});

// Mirrors dsp-tx-agreement-check exactly (post-Task-12 fix): ownership-mismatch
// is gated on `iamMode !== 'off'` AND a *resolved* identity (identity.did present).
// `identity` mirrors msg.identity: null when verification hasn't produced a DID
// (unconfigured trustedIssuers, or a warn-mode VP/VC failure that was logged and
// allowed through), or { did } when it has. Only a resolved, non-matching DID is a
// confident-enough mismatch to reject — even in warn mode. A null identity must
// never block, in any non-off mode, per the tab's "warn never blocks" contract.
function agreementCheck(iamMode, negotiations, agreementId, identity) {
    if (iamMode === 'off') return { ok: true };
    const neg = Object.values(negotiations).find(n => n.agreementId === agreementId);
    if (!neg) return { ok: false, code: 'agreement_not_found' };
    if (neg.state !== 'FINALIZED') return { ok: false, code: 'agreement_not_finalized' };
    if (iamMode !== 'off' && identity && identity.did && neg.counterparty !== identity.did) return { ok: false, code: 'agreement_not_held_by_caller' };
    return { ok: true };
}

test('off mode: agreement check always passes regardless of ownership', () => {
    const r = agreementCheck('off', {}, 'agr-nonexistent', { did: 'did:web:anyone.example' });
    assert.equal(r.ok, true);
});

test('enforce mode: agreement check rejects a caller who does not hold the agreement', () => {
    const negs = { 'neg-1': { agreementId: 'agr-1', state: 'FINALIZED', counterparty: 'did:web:owner.example' } };
    const r = agreementCheck('enforce', negs, 'agr-1', { did: 'did:web:someone-else.example' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'agreement_not_held_by_caller');
});

test('enforce mode: agreement check passes for the actual owner', () => {
    const negs = { 'neg-1': { agreementId: 'agr-1', state: 'FINALIZED', counterparty: 'did:web:owner.example' } };
    const r = agreementCheck('enforce', negs, 'agr-1', { did: 'did:web:owner.example' });
    assert.equal(r.ok, true);
});

test('warn mode: agreement check ALSO rejects a caller with a resolved, non-matching identity', () => {
    const negs = { 'neg-1': { agreementId: 'agr-1', state: 'FINALIZED', counterparty: 'did:web:owner.example' } };
    const r = agreementCheck('warn', negs, 'agr-1', { did: 'did:web:someone-else.example' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'agreement_not_held_by_caller');
});

test('warn mode: agreement check passes through when identity is null (unconfigured/failed verification never blocks in warn)', () => {
    const negs = { 'neg-1': { agreementId: 'agr-1', state: 'FINALIZED', counterparty: 'did:web:owner.example' } };
    const r = agreementCheck('warn', negs, 'agr-1', null);
    assert.equal(r.ok, true);
});
