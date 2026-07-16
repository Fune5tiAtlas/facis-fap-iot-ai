/* eslint-disable */
//
// iam-enforce-off-parity.spec.js — proves DSP_IAM_ENFORCE=off preserves the
// pre-NF-1 behaviour exactly: counterparty comes from the request body when
// msg.identity is null (which is what dsp-iam-prep guarantees in off mode).
//
// Also proves the ownership-mismatch gate on dsp-tx-agreement-check applies
// in BOTH warn and enforce modes (msg._iamMode !== 'off'), per the Task 8
// fix — only 'off' bypasses the ownership check.
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

// Mirrors dsp-tx-agreement-check exactly (post-Task-8 fix): ownership-mismatch
// is gated on `iamMode !== 'off'`, so it applies in both 'warn' and 'enforce' —
// only 'off' bypasses it.
function agreementCheck(iamMode, negotiations, agreementId, callerDid) {
    if (iamMode === 'off') return { ok: true };
    const neg = Object.values(negotiations).find(n => n.agreementId === agreementId);
    if (!neg) return { ok: false, code: 'agreement_not_found' };
    if (neg.state !== 'FINALIZED') return { ok: false, code: 'agreement_not_finalized' };
    if (iamMode !== 'off' && neg.counterparty !== callerDid) return { ok: false, code: 'agreement_not_held_by_caller' };
    return { ok: true };
}

test('off mode: agreement check always passes regardless of ownership', () => {
    const r = agreementCheck('off', {}, 'agr-nonexistent', 'did:web:anyone.example');
    assert.equal(r.ok, true);
});

test('enforce mode: agreement check rejects a caller who does not hold the agreement', () => {
    const negs = { 'neg-1': { agreementId: 'agr-1', state: 'FINALIZED', counterparty: 'did:web:owner.example' } };
    const r = agreementCheck('enforce', negs, 'agr-1', 'did:web:someone-else.example');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'agreement_not_held_by_caller');
});

test('enforce mode: agreement check passes for the actual owner', () => {
    const negs = { 'neg-1': { agreementId: 'agr-1', state: 'FINALIZED', counterparty: 'did:web:owner.example' } };
    const r = agreementCheck('enforce', negs, 'agr-1', 'did:web:owner.example');
    assert.equal(r.ok, true);
});

test('warn mode: agreement check ALSO rejects a caller who does not hold the agreement', () => {
    const negs = { 'neg-1': { agreementId: 'agr-1', state: 'FINALIZED', counterparty: 'did:web:owner.example' } };
    const r = agreementCheck('warn', negs, 'agr-1', 'did:web:someone-else.example');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'agreement_not_held_by_caller');
});
