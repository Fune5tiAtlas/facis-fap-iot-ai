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

test('dsp-consumer-iam-branch is a switch on iamRejected wired [response, issue-call]', () => {
    const branch = byId(consumerFlow, 'dsp-consumer-iam-branch');
    assert.ok(branch, 'dsp-consumer-iam-branch node must exist');
    assert.equal(branch.type, 'switch');
    assert.equal(branch.property, 'iamRejected');
    assert.equal(branch.propertyType, 'msg');
    assert.deepEqual(branch.rules, [{ t: 'true' }, { t: 'false' }]);
    // accepted (iamRejected=false) now routes through the VP mint (iam.issue)
    // before the first provider hop, so the outbound hops carry a Bearer VP.
    assert.deepEqual(branch.wires, [
        ['dsp-consumer-response'],
        ['dsp-consumer-issue-call']
    ]);
});

test('dsp-consumer-issue-call is a link call to iam.issue, wired into prep-transfer-fn', () => {
    const issueCall = byId(consumerFlow, 'dsp-consumer-issue-call');
    assert.ok(issueCall, 'dsp-consumer-issue-call node must exist');
    assert.equal(issueCall.type, 'link call');
    assert.deepEqual(issueCall.links, ['dsp-iam-issue-in']);
    assert.deepEqual(issueCall.wires, [['dsp-consumer-prep-transfer-fn']]);
});

test('issuance flow exposes dsp-iam-issue-in linked back from the consumer, and returns via link out', () => {
    const issuanceFlow = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../../flows/facis-dsp-iam-issuance.json'), 'utf8'
    ));
    const linkIn = byId(issuanceFlow, 'dsp-iam-issue-in');
    assert.ok(linkIn, 'dsp-iam-issue-in node must exist');
    assert.equal(linkIn.type, 'link in');
    assert.ok(linkIn.links.includes('dsp-consumer-issue-call'));
    assert.deepEqual(linkIn.wires, [['dsp-iam-issue-fn']]);

    const linkOut = byId(issuanceFlow, 'dsp-iam-issue-return');
    assert.ok(linkOut, 'dsp-iam-issue-return node must exist');
    assert.equal(linkOut.type, 'link out');
    assert.equal(linkOut.mode, 'return');
});

test('dsp-iam-verify-in links array includes dsp-consumer-iam-call', () => {
    const linkIn = byId(iamVerifyFlow, 'dsp-iam-verify-in');
    assert.ok(linkIn, 'dsp-iam-verify-in node must exist');
    assert.ok(linkIn.links.includes('dsp-consumer-iam-call'));
});
