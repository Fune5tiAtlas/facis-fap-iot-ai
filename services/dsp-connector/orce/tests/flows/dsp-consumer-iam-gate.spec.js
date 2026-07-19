/* eslint-disable */
//
// dsp-consumer-iam-gate.spec.js — structural check that POST /dsp/ingest
// is gated behind iam.verify, matching the pattern already used by
// /dsp/transfers (dsp-tx-in-create -> dsp-tx-iam-call -> dsp-tx-iam-branch).
//
// `link call` and `switch` nodes aren't `type:"function"`, so
// ../harness/run-node.js can't execute them — instead this loads the flow
// JSON directly and asserts the wiring topology, to catch a future
// accidental rewiring that would silently drop the IAM gate.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const consumerFlow = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../flows/facis-dsp-consumer.json'), 'utf8'
));
const iamVerifyFlow = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../flows/facis-dsp-iam-verify.json'), 'utf8'
));

function byId(flow, id) {
    return flow.find(n => n.id === id);
}

test('dsp-consumer-in wires to dsp-consumer-iam-call, not directly to the handler', () => {
    const httpIn = byId(consumerFlow, 'dsp-consumer-in');
    assert.ok(httpIn, 'dsp-consumer-in node must exist');
    assert.deepEqual(httpIn.wires, [['dsp-consumer-iam-call']]);
});

test('dsp-consumer-iam-call is a link call targeting dsp-iam-verify-in', () => {
    const iamCall = byId(consumerFlow, 'dsp-consumer-iam-call');
    assert.ok(iamCall, 'dsp-consumer-iam-call node must exist');
    assert.equal(iamCall.type, 'link call');
    assert.deepEqual(iamCall.links, ['dsp-iam-verify-in']);
    assert.deepEqual(iamCall.wires, [['dsp-consumer-iam-branch']]);
});

test('dsp-consumer-iam-branch is a switch on iamRejected wired [response, prep-transfer-fn]', () => {
    const branch = byId(consumerFlow, 'dsp-consumer-iam-branch');
    assert.ok(branch, 'dsp-consumer-iam-branch node must exist');
    assert.equal(branch.type, 'switch');
    assert.equal(branch.property, 'iamRejected');
    assert.equal(branch.propertyType, 'msg');
    assert.deepEqual(branch.rules, [{ t: 'true' }, { t: 'false' }]);
    assert.deepEqual(branch.wires, [
        ['dsp-consumer-response'],
        ['dsp-consumer-prep-transfer-fn']
    ]);
});

test('dsp-iam-verify-in links array includes dsp-consumer-iam-call', () => {
    const linkIn = byId(iamVerifyFlow, 'dsp-iam-verify-in');
    assert.ok(linkIn, 'dsp-iam-verify-in node must exist');
    assert.ok(linkIn.links.includes('dsp-consumer-iam-call'));
});
