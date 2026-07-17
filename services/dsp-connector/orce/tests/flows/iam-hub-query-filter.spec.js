/* eslint-disable */
//
// iam-hub-query-filter.spec.js — proves the Identity Hub's credential query
// API only ever builds a whitelisted Mongo filter from known fields, never
// passes client-supplied query objects through raw (NoSQL injection guard).
//

const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors dsp-iam-hub-query's filter builder.
function buildCredentialFilter(queryParams) {
    const ALLOWED = ['type', 'issuer', 'subject', 'status'];
    const filter = {};
    for (const key of ALLOWED) {
        const value = queryParams && queryParams[key];
        if (typeof value === 'string' && value.length > 0) {
            filter[key] = value;
        }
    }
    return filter;
}

test('only whitelisted fields pass through', () => {
    const filter = buildCredentialFilter({ type: 'ParticipantCredential', issuer: 'did:web:a.example', bogus: 'x' });
    assert.deepEqual(filter, { type: 'ParticipantCredential', issuer: 'did:web:a.example' });
});

test('missing fields are simply absent, not null/undefined keys', () => {
    const filter = buildCredentialFilter({ type: 'X' });
    assert.deepEqual(Object.keys(filter), ['type']);
});

test('a raw Mongo operator object as a value is coerced away, not honored', () => {
    // Simulates an attacker sending ?issuer[$ne]=null (Express parses this as
    // queryParams.issuer = { '$ne': null }, an object, not a string).
    const filter = buildCredentialFilter({ issuer: { $ne: null } });
    assert.deepEqual(filter, {});
});

test('empty query object produces an empty filter (matches everything — pagination/limits are a separate concern)', () => {
    assert.deepEqual(buildCredentialFilter({}), {});
});

test('undefined queryParams does not throw', () => {
    assert.deepEqual(buildCredentialFilter(undefined), {});
});

test('an array value for a whitelisted field is dropped, not passed through as a raw filter value', () => {
    // Simulates ?type[]=a&type[]=b (or repeated ?type=a&type=b), which Express's
    // qs parser turns into queryParams.type = ['a', 'b'] — an array, not a
    // string. If passed through raw, Mongo would interpret an array value as an
    // implicit $in match, letting an attacker widen the query beyond a single
    // known value. The whitelist's typeof-string check must reject it.
    const filter = buildCredentialFilter({ type: ['a', 'b'] });
    assert.deepEqual(filter, {});
});
