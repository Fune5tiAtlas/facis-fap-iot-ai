/* eslint-disable */
//
// data-rate-limit.spec.js — NF-12: the data-pull endpoint enforces a
// per-agreement rate limit (429 + Retry-After), keyed by the HMAC-bound
// agreementId. Parity of the sliding-window logic + flow-JSON guards.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readFlow() {
    const p = path.join(__dirname, '..', '..', 'flows', 'facis-dsp-data.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Mirrors the limiter block in dsp-data-verify-fn.
function rateLimit({ agreementId, buckets, nowMs, rpm = 10, enabled = true }) {
    if (!enabled) return { decision: 'ok' };
    const limiterKey = agreementId || 'anonymous';
    const windowMs = 60 * 1000;
    let bucket = buckets[limiterKey];
    if (!bucket || nowMs - bucket.windowStart >= windowMs) {
        bucket = { windowStart: nowMs, count: 0 };
    }
    if (bucket.count >= rpm) {
        const retryAfter = Math.max(1, Math.ceil((bucket.windowStart + windowMs - nowMs) / 1000));
        buckets[limiterKey] = bucket;
        return { decision: 'rate_limited', statusCode: 429, retryAfter };
    }
    bucket.count += 1;
    buckets[limiterKey] = bucket;
    return { decision: 'ok' };
}

test('data-pull: requests within the window pass, the rpm+1-th gets 429', () => {
    const buckets = {};
    const now = 1_000_000;
    for (let i = 0; i < 10; i += 1) {
        assert.equal(rateLimit({ agreementId: 'agr-1', buckets, nowMs: now + i }).decision, 'ok');
    }
    const limited = rateLimit({ agreementId: 'agr-1', buckets, nowMs: now + 20 });
    assert.equal(limited.decision, 'rate_limited');
    assert.equal(limited.statusCode, 429);
    assert.ok(limited.retryAfter >= 1 && limited.retryAfter <= 60);
});

test('data-pull: windows are per agreement', () => {
    const buckets = {};
    const now = 2_000_000;
    for (let i = 0; i < 10; i += 1) rateLimit({ agreementId: 'agr-1', buckets, nowMs: now });
    assert.equal(rateLimit({ agreementId: 'agr-1', buckets, nowMs: now }).decision, 'rate_limited');
    assert.equal(rateLimit({ agreementId: 'agr-2', buckets, nowMs: now }).decision, 'ok');
});

test('data-pull: window resets after 60s', () => {
    const buckets = {};
    const now = 3_000_000;
    for (let i = 0; i < 10; i += 1) rateLimit({ agreementId: 'agr-1', buckets, nowMs: now });
    assert.equal(rateLimit({ agreementId: 'agr-1', buckets, nowMs: now + 1000 }).decision, 'rate_limited');
    assert.equal(rateLimit({ agreementId: 'agr-1', buckets, nowMs: now + 61_000 }).decision, 'ok');
});

test('data-pull flow: limiter runs after HMAC verification, keyed by agreementId', () => {
    const fn = readFlow().find((n) => n.id === 'dsp-data-verify-fn');
    const func = fn.func;
    const verifyIdx = func.indexOf('timingSafeEqualStr(token, expected)');
    const limiterIdx = func.indexOf('dspDataRateLimitBuckets');
    assert.ok(verifyIdx !== -1 && limiterIdx > verifyIdx,
        'limiter must sit after signature verification (HMAC-bound key)');
    assert.match(func, /rate_limit_exceeded/);
    assert.match(func, /Retry-After/);
    assert.match(func, /DSP_RATE_LIMIT__REQUESTS_PER_MINUTE/);
});
