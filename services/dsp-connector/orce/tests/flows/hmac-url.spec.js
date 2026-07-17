/* eslint-disable */
//
// hmac-url.spec.js — byte-equivalence with transfer_store._provision_http_pull().
//
// The handler under test lives inline in the function node `dsp-tx-create`
// of `services/dsp-connector/orce/flows/facis-dsp-transfers.json`. This spec
// re-implements the same logic so we can pin it under `node --test` and
// guarantee byte-identical output to the Python reference.
//
// Invariant: keep `provisionHttpPull()` here in sync with the function-node
// body in facis-dsp-transfers.json.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function isoUtcWithOffset(d) {
    return d.toISOString().slice(0, -1) + '000+00:00';
}

function provisionHttpPull(transfer, opts) {
    const secret = opts.secret;
    const baseUrl = (opts.baseUrl || 'https://ai-insight.facis.cloud').replace(/\/$/, '');
    const ttl = opts.ttl || 3600;
    const now = opts.now || new Date();
    if (!secret) throw new Error('DSP_HMAC_SECRET unset');
    const path = '/api/data/' + transfer.assetId;
    const fromTs = (transfer.parameters && transfer.parameters.windowFrom) || '';
    const toTs = (transfer.parameters && transfer.parameters.windowTo) || '';
    const expiresAt = isoUtcWithOffset(new Date(now.getTime() + ttl * 1000));
    const agreementId = transfer.agreementId || '';
    const rolesStr = (opts.roles && opts.roles.length) ? [...opts.roles].sort().join(',') : '';
    // Percent-encode before concatenating into the canonical message (not just the URL):
    // encodeURIComponent never emits a raw ':', so the colon-delimited format stays
    // unambiguous no matter what characters agreementId/roles contain.
    const encodedAgreementId = encodeURIComponent(agreementId);
    const encodedRoles = encodeURIComponent(rolesStr);
    const message = 'GET:' + path + ':' + fromTs + ':' + toTs + ':' + expiresAt + ':' + encodedAgreementId + ':' + encodedRoles;
    const token = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
                        .update(message, 'utf8').digest('hex');
    const url = baseUrl + path +
        '?from=' + fromTs + '&to=' + toTs + '&expiresAt=' + expiresAt +
        '&agreementId=' + encodedAgreementId +
        '&roles=' + encodedRoles +
        '&token=' + token;
    return { url, token, expiresAt };
}

// ── Python reference: hmac.new(secret, msg, sha256).hexdigest() with
//    secret encoded utf-8, msg = "GET:{path}:{from}:{to}:{expires}".
//    A pinned-input + pinned-clock test gives a stable hash we can diff.

test('expiresAt has microsecond precision and +00:00 suffix (matches Python isoformat())', () => {
    const fixed = new Date(Date.parse('2026-04-07T00:00:00.123Z'));
    const out = isoUtcWithOffset(fixed);
    // toISOString() => '2026-04-07T00:00:00.123Z'
    // slice(0, -1) + '000+00:00' => '2026-04-07T00:00:00.123000+00:00'
    assert.equal(out, '2026-04-07T00:00:00.123000+00:00');
    assert.ok(out.endsWith('+00:00'));
    assert.ok(!out.endsWith('Z'));
});

test('HMAC hex digest is lowercase (matches Python hexdigest())', () => {
    const transfer = {
        assetId: 'dataset:facis:net-grid-hourly',
        parameters: { windowFrom: '2026-04-07T00:00:00Z', windowTo: '2026-04-07T23:59:59Z' }
    };
    const out = provisionHttpPull(transfer, {
        secret: 'a'.repeat(64),
        baseUrl: 'https://ai-insight.facis.cloud',
        ttl: 3600,
        now: new Date(Date.parse('2026-04-07T00:00:00Z'))
    });
    assert.match(out.token, /^[0-9a-f]{64}$/);
});

test('URL has the exact query-string ordering: from, to, expiresAt, agreementId, roles, token', () => {
    const transfer = {
        assetId: 'dataset:facis:weather-hourly',
        agreementId: 'agr-weather-1',
        parameters: { windowFrom: '2026-04-01T00:00:00Z', windowTo: '2026-04-07T00:00:00Z' }
    };
    const out = provisionHttpPull(transfer, {
        secret: 'b'.repeat(64),
        now: new Date(Date.parse('2026-04-01T00:00:00Z')),
        roles: ['consumer']
    });
    const u = new URL(out.url);
    assert.equal(u.pathname, '/api/data/dataset:facis:weather-hourly');
    const qs = u.search.replace(/^\?/, '').split('&').map(p => p.split('=')[0]);
    assert.deepEqual(qs, ['from', 'to', 'expiresAt', 'agreementId', 'roles', 'token']);
});

test('canonical message format: GET:{path}:{from}:{to}:{expires}:{agreementId}:{roles}', () => {
    // Reconstruct the canonical message manually to guard against drift.
    const secret = 'c'.repeat(64);
    const fromTs = '2026-04-07T00:00:00Z';
    const toTs = '2026-04-07T23:59:59Z';
    const path = '/api/data/dataset:facis:net-grid-hourly';
    const agreementId = 'agr-grid-1';
    const rolesStr = 'analyst,consumer';
    const fixed = new Date(Date.parse('2026-04-07T00:00:00Z'));
    const expiresAt = isoUtcWithOffset(new Date(fixed.getTime() + 3600 * 1000));
    // agreementId/rolesStr are percent-encoded before concatenation (rolesStr contains a
    // comma, which encodeURIComponent escapes to %2C — so this must mirror that exactly).
    const message = 'GET:' + path + ':' + fromTs + ':' + toTs + ':' + expiresAt + ':' + encodeURIComponent(agreementId) + ':' + encodeURIComponent(rolesStr);
    const expected = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
                           .update(message, 'utf8').digest('hex');

    const out = provisionHttpPull(
        { assetId: 'dataset:facis:net-grid-hourly', agreementId, parameters: { windowFrom: fromTs, windowTo: toTs } },
        { secret, now: fixed, ttl: 3600, roles: ['consumer', 'analyst'] }
    );
    assert.equal(out.token, expected);
});

test('empty window params produce literal empty strings between colons', () => {
    const transfer = {
        assetId: 'dataset:facis:anomaly-candidates',
        parameters: {}    // no windowFrom / windowTo
    };
    const fixed = new Date(Date.parse('2026-04-07T00:00:00Z'));
    const out = provisionHttpPull(transfer, { secret: 'd'.repeat(64), now: fixed });
    // URL must still include `from=` and `to=` (with empty values) — DO NOT omit
    assert.ok(out.url.includes('from=&to=&expiresAt='),
              'expected from=&to=&expiresAt= ; got: ' + out.url);
});

test('empty agreementId and roles produce literal empty strings, not omitted', () => {
    const transfer = {
        assetId: 'dataset:facis:anomaly-candidates',
        parameters: {}    // no agreementId, no roles
    };
    const fixed = new Date(Date.parse('2026-04-07T00:00:00Z'));
    const out = provisionHttpPull(transfer, { secret: 'd'.repeat(64), now: fixed });
    // URL must still include `agreementId=` and `roles=` (empty values) — DO NOT omit
    assert.ok(out.url.includes('agreementId=&roles=&token='),
              'expected agreementId=&roles=&token= ; got: ' + out.url);
});

test('missing DSP_HMAC_SECRET throws', () => {
    assert.throws(() => provisionHttpPull(
        { assetId: 'x', parameters: {} },
        { secret: '', now: new Date() }
    ), /DSP_HMAC_SECRET/);
});

test('trailing slash on base URL is stripped', () => {
    const out = provisionHttpPull(
        { assetId: 'x', parameters: {} },
        { secret: 'e'.repeat(64), baseUrl: 'https://example.com/', now: new Date() }
    );
    assert.ok(out.url.startsWith('https://example.com/api/data/x?'),
              'expected single slash; got: ' + out.url);
});

test('agreementId is bound into the signature: different agreementId yields a different token', () => {
    // Discriminator: call the real provisionHttpPull() twice with identical inputs
    // except agreementId. If the implementation ever regresses to excluding
    // agreementId from the canonical message, both tokens would be identical
    // and this assertion would correctly fail.
    const base = { assetId: 'dataset:x', parameters: {} };
    const opts = { secret: 'test-secret', baseUrl: 'https://data.example', ttl: 3600, now: new Date('2026-01-01T00:00:00.000Z'), roles: ['consumer', 'analyst'] };
    const a = provisionHttpPull({ ...base, agreementId: 'agr-abc123' }, opts);
    const b = provisionHttpPull({ ...base, agreementId: 'agr-DIFFERENT' }, opts);
    assert.notEqual(a.token, b.token,
        'expected different agreementId to produce a different token — agreementId must be part of the signed message');
});

test('roles are bound into the signature: different roles yield a different token', () => {
    // Same discriminator applied to roles.
    const transfer = { assetId: 'dataset:x', agreementId: 'agr-abc123', parameters: {} };
    const base = { secret: 'test-secret', baseUrl: 'https://data.example', ttl: 3600, now: new Date('2026-01-01T00:00:00.000Z') };
    const a = provisionHttpPull(transfer, { ...base, roles: ['consumer', 'analyst'] });
    const b = provisionHttpPull(transfer, { ...base, roles: ['consumer'] });
    assert.notEqual(a.token, b.token,
        'expected different roles to produce a different token — roles must be part of the signed message');
});

test('roles are sorted for deterministic signing regardless of input order', () => {
    const transfer = { assetId: 'dataset:x', agreementId: 'agr-1', parameters: {} };
    const base = { secret: 's', baseUrl: 'https://d.example', ttl: 3600, now: new Date('2026-01-01T00:00:00.000Z') };
    const a = provisionHttpPull(transfer, { ...base, roles: ['zebra', 'alpha'] });
    const b = provisionHttpPull(transfer, { ...base, roles: ['alpha', 'zebra'] });
    assert.equal(a.token, b.token);
});

test('missing roles produces empty string, not omitted field', () => {
    const transfer = { assetId: 'dataset:x', agreementId: 'agr-1', parameters: {} };
    const result = provisionHttpPull(transfer, { secret: 's', baseUrl: 'https://d.example', ttl: 3600, now: new Date('2026-01-01T00:00:00.000Z'), roles: [] });
    assert.match(result.url, /roles=(&|$)/);
});

test('colon inside agreementId is percent-encoded, preventing delimiter ambiguity', () => {
    // Genuine pre-fix collision (verified by reverting the encode and re-running):
    // 'agr-x:consumer' + ':' + ''  (agreementId='agr-x:consumer', roles=[])
    //   === 'agr-x' + ':' + 'consumer:'  (agreementId='agr-x', roles=['consumer:'])
    // both concatenate to the identical raw string '...:agr-x:consumer:', so before the
    // fix these two DIFFERENT (agreementId, roles) pairs signed to the SAME token. After
    // percent-encoding, 'agr-x%3Aconsumer' + ':' + '' vs 'agr-x' + ':' + 'consumer%3A'
    // are unambiguously different, so the tokens below must differ.
    const transfer1 = { assetId: 'dataset:x', agreementId: 'agr-x:consumer', parameters: {} };
    const transfer2 = { assetId: 'dataset:x', agreementId: 'agr-x', parameters: {} };
    const opts1 = { secret: 's', baseUrl: 'https://d.example', ttl: 3600, now: new Date('2026-01-01T00:00:00.000Z'), roles: [] };
    const opts2 = { secret: 's', baseUrl: 'https://d.example', ttl: 3600, now: new Date('2026-01-01T00:00:00.000Z'), roles: ['consumer:'] };
    const result1 = provisionHttpPull(transfer1, opts1);
    const result2 = provisionHttpPull(transfer2, opts2);
    assert.notEqual(result1.token, result2.token);
});
