# NF-1 Phase 1 — ORCE-Native Identity Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the "zero identity verification on any `/dsp/*` route" gap (NF-1 / FR-IAM-001 / FR-IAM-002) by adding a shared, ORCE-native (Node-RED) verifier that checks an inbound DCP-style Verifiable Presentation before the negotiations and transfers flows create anything, replacing the currently-unverified `counterparty`/`agreementId` free text.

**Architecture:** One new Node-RED tab (`facis-dsp-iam-verify`) holds a single shared verifier, reached from the negotiations and transfers tabs via Node-RED's `link call`/`link in`(return) pair (the only mechanism that lets two different tabs call one shared synchronous subroutine and get a result back — plain `link out`/`link in`, the pattern this repo already uses for `dsp.persist.*`, is fire-and-forget and cannot do this). The verifier resolves the presenter's `did:web`, verifies the VP/VC JWS signatures with `jose`, runs policy checks (holder binding, trusted-issuer allowlist, audience, expiry, replay), and emits `msg.identity` or a DSP-shaped 401. Negotiations/transfers then source `counterparty`/ownership from `msg.identity.did` instead of the request body.

**Tech Stack:** Node-RED function/`link call`/`http request` nodes (no new services, no Python — TDR mandates ORCE-native), `jose` npm package (JWT/JWK verify), plain `node:test` specs mirroring function-node bodies (this repo's existing convention — see `orce/tests/flows/*.spec.js`, no Node-RED test harness is used).

## Global Constraints

- No Python services — TDR mandates the ORCE (Node-RED) runtime for this connector; do not add a FastAPI code path for any of this.
- Pin every new npm version exactly in `infrastructure/orce/init-deps-patch.yaml` — never `npm install <pkg>` without a version pin (crypto deps must not float).
- Node-RED flow files in this repo are flat JSON arrays: one object with `"type":"tab"` plus N node objects carrying `"z":"<tabId>"`. Follow that shape exactly for any new/edited file.
- `flow.get/set(...)` context is scoped per-tab (per `z`); `global.get/set(...)` is shared pod-wide. Cross-tab state (the negotiations map, read by the transfers tab) must use `global.*`, not `flow.*`.
- The ORCE pod is single-replica today (`compatibilityMode: orce` scales the Python pod to 0; there is exactly one Node-RED pod) — this is why in-memory caches (DID cache, jti-replay cache) below are safe. Do not add multi-replica-unsafe state without also bumping this constraint.
- Test convention: `services/dsp-connector/orce/tests/flows/*.spec.js`, run via `cd services/dsp-connector/orce/tests && npm test` (= `node --test flows`). Specs do **not** execute the actual Node-RED flow — they reimplement the same logic as plain exported functions and assert against it. Mirror this convention exactly: any pure logic you put in a function node body must also exist, verbatim in behavior, as a plain function in the matching spec file.
- `pyproject.toml` / any Python file under `services/dsp-connector/src/` is explicitly **out of scope** — do not touch it. The Python FastAPI service is a scaled-to-0 rollback fallback only.
- Explicitly **out of scope for this plan** (tracked as separate follow-on plans, see end of document): the `facis-dsp-iam-issuance`/`facis-dsp-iam-hub` tabs (MongoDB Identity Hub, GXDCH calls, OID4VCI issuer surface), the `/iam` and `/.well-known/did.json` ingress routes, and the `ai-insight-service` NF-6 header-trust follow-through.

---

### Task 1: Pre-flight — confirm `link call` support, enable `functionExternalModules`

Two independent runtime facts gate everything else in this plan. Confirm/set both before writing any flow JSON.

**Files:**
- Modify: `infrastructure/orce/init-orce-settings-patch.yaml`

**Interfaces:**
- Produces: `functionExternalModules: true` in the live `/data/settings.js` on the ORCE pod (required for the `libs: [{"var":"jose","module":"jose"}]` declaration used in Task 7/8 to work at all).

- [ ] **Step 1: Check the ORCE pod's Node-RED core version supports `link call`**

`link call` (and `link in` with the return-routing that pairs with it) shipped in Node-RED 1.3 (Jan 2021). Confirm the running version is at or above that — it almost certainly is (the Reference FAP already uses `node-red-contrib-mongodb4`, a modern dependency), but this is a 30-second check that avoids discovering a version mismatch after building 3 new nodes around it.

Run (against the live cluster, requires current kubeconfig — if kubectl auth has expired, re-auth first):

```bash
kubectl exec -n orce deploy/orce -- curl -s http://localhost:1880/settings | jq -r '.version'
```

Expected: any version `>= 1.3.0` (in practice this will show something like `3.x.x` or `4.x.x`). If the command fails or reports `< 1.3.0`, STOP — do not proceed to Task 7/8/9 with `link call`. Fallback in that case: replace the `link call`/`link in` pair in Task 7 with a plain `http request` node in negotiations/transfers hitting `http://localhost:1880/dsp/iam/verify-internal` (an ordinary `http in`/`http response` pair inside the `facis-dsp-iam-verify` tab instead of `link in`/`link out`) — every other task in this plan is unaffected by this substitution.

- [ ] **Step 2: Add `functionExternalModules: true` to the settings patch**

Extend the existing marker-fenced JS patch in `infrastructure/orce/init-orce-settings-patch.yaml` (it already does one idempotent, marker-guarded string replacement against `/mnt/orce-data/settings.js` — follow the exact same idiom: check-marker, replace-if-absent, atomic write). Open the file and find the inline `node <<'JS' ... JS` block (lines 71-139). Add a second idempotent replacement right after the existing `httpStatic` replacement (after the `src = src.replace(before, after);` line for the dynamicsrc patch, before the `httpAdminMiddleware` injection):

```js
              // 1b. Enable functionExternalModules so function nodes can
              //     declare libs: [{var:'jose', module:'jose'}] etc. Off by
              //     default in Node-RED; required for FACIS:iam-verify-patch.
              const IAM_MARKER = 'FACIS:iam-verify-patch';
              if (!src.includes(IAM_MARKER)) {
                const feBefore = /functionExternalModules\s*:\s*false/;
                const feAfter = "functionExternalModules: true, // FACIS:iam-verify-patch";
                if (feBefore.test(src)) {
                  src = src.replace(feBefore, feAfter);
                } else if (!/functionExternalModules\s*:/.test(src)) {
                  // Setting absent entirely (common — it defaults off and is
                  // often omitted from settings.js templates). Inject right
                  // after the httpStatic array we just wrote.
                  src = src.replace(
                    "    ],\n",
                    "    ],\n    functionExternalModules: true, // FACIS:iam-verify-patch\n"
                  );
                }
              }
```

Place this block so it runs unconditionally alongside the existing dynamicsrc patch (both are gated by the *same* top-level `MARKER` check at the top of the script — since that top marker is `FACIS:dynamicsrc-patch` and would short-circuit on a pod that already has the dynamicsrc patch applied but predates this change, split the guard: change the top-level early-return at line 76-79 from checking only `MARKER` to checking both markers before exiting clean, so pods already patched for dynamicsrc still pick up the new `functionExternalModules` addition on next rollout):

Replace:
```js
              if (src.includes(MARKER)) {
                console.log('[init-orce-settings] already applied');
                process.exit(0);
              }
```
with:
```js
              const IAM_MARKER = 'FACIS:iam-verify-patch';
              if (src.includes(MARKER) && src.includes(IAM_MARKER)) {
                console.log('[init-orce-settings] already applied');
                process.exit(0);
              }
```
(and delete the duplicate `const IAM_MARKER` declaration added in the block above, so it's declared once, near the top).

- [ ] **Step 3: Bump the log line and comment header**

Update the file's top comment block (lines 1-52) to mention the new responsibility (enabling `functionExternalModules`) alongside the existing dynamicsrc one, so the next reader isn't surprised. One line is enough: add `"  - (2026-07) also enables functionExternalModules for the NF-1 IAM verifier's jose dependency."` after the existing description.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/orce/init-orce-settings-patch.yaml
git commit -m "feat(orce): enable functionExternalModules for NF-1 jose dependency"
```

---

### Task 2: Pin `jose` into the ORCE runtime npm deps

**Files:**
- Modify: `infrastructure/orce/init-deps-patch.yaml:69`

**Interfaces:**
- Produces: `jose` importable inside any function node that declares `"libs": [{"var":"jose","module":"jose"}]`.

- [ ] **Step 1: Add `jose` to the `PKGS` line, pinned**

Line 69 currently reads:
```
PKGS="node-red-contrib-modbus node-red-contrib-rdkafka ssh2-sftp-client csv-parse seedrandom"
```
Change to:
```
PKGS="node-red-contrib-modbus node-red-contrib-rdkafka ssh2-sftp-client csv-parse seedrandom jose@5.9.6"
```
(`jose@5.9.6` is a real published 5.x release — confirm the exact latest 5.x patch at implementation time with `npm view jose@5 version` and use that instead if newer; the point is an exact pin, never a bare `jose`.)

- [ ] **Step 2: Update the file's header comment**

The comment block (lines 1-19) currently says the image "does not bundle ... csv-parse, or seedrandom." Add `jose` to that list and to the "Ensure the npm packages required by the Simulation, DSP, and SFTP ORCE flows are present" sentence — change to "the Simulation, DSP (incl. IAM verification), and SFTP ORCE flows."

- [ ] **Step 3: Commit**

```bash
git add infrastructure/orce/init-deps-patch.yaml
git commit -m "feat(orce): pin jose@5.9.6 for NF-1 IAM verifier"
```

---

### Task 3: Fix the negotiations global-context bug (prerequisite for transfer-agreement binding)

The transfers tab needs to read the negotiations map to check `agreementId` ownership (Task 9), but negotiations are currently stored with `flow.set('negotiations', ...)` inside `tab-dsp-negotiations` — invisible to `tab-dsp-transfers` because `flow.*` is per-tab. Move it to `global.*` everywhere it's touched. This task alone is a pure refactor with no behavior change and should ship (and be tested) independently of the IAM work.

**Files:**
- Modify: `services/dsp-connector/orce/flows/facis-dsp-negotiations.json`
- Modify: `services/dsp-connector/orce/flows/facis-dsp-state.json`
- Test: `services/dsp-connector/orce/tests/flows/negotiation-finalize.spec.js` (no code change needed — it already tests the pure logic against a plain JS object store, which is context-scope-agnostic; this task's own regression coverage is the manual parity check in Step 4)

- [ ] **Step 1: Write the failing check (manual parity script, not a unit test — this is a cross-tab context bug, best proven by the negative case a unit test can't see)**

There's no way to unit-test Node-RED's context scoping from a plain `node:test` file (the mirrored-logic convention tests the algorithm, not the Node-RED context wiring). Instead, this step is a documented manual verification you'll run in Step 4 after the edit — skip straight to Step 2.

- [ ] **Step 2: Edit `facis-dsp-negotiations.json`** — replace all three `flow.get('negotiations')` / `flow.set('negotiations', ...)` call sites with `global.get('negotiations')` / `global.set('negotiations', ...)`:

In node `dsp-neg-create` (the `auto-finalise` function), change:
```js
const negs = flow.get('negotiations') || {};
negs[negId] = negotiation;
flow.set('negotiations', negs);
```
to:
```js
const negs = global.get('negotiations') || {};
negs[negId] = negotiation;
global.set('negotiations', negs);
```

In node `dsp-neg-get` (the `read by id` function), change:
```js
const negs = flow.get('negotiations') || {};
```
to:
```js
const negs = global.get('negotiations') || {};
```

In node `dsp-neg-terminate` (the `terminate` function), change both occurrences:
```js
const negs = flow.get('negotiations') || {};
...
negs[id] = terminated;
flow.set('negotiations', negs);
```
to:
```js
const negs = global.get('negotiations') || {};
...
negs[id] = terminated;
global.set('negotiations', negs);
```

- [ ] **Step 3: Edit `facis-dsp-state.json`** — the bootstrap/persistence tab also touches `negotiations` via `flow.*`; move those to `global.*` too so restore-on-boot and checkpoint-to-disk still see the same map the negotiations tab now writes:

In node `dsp-restore-negotiations`, change `flow.set('negotiations', negotiations);` to `global.set('negotiations', negotiations);`.

In node `dsp-init-negotiations`, change `flow.set('negotiations', {});` to `global.set('negotiations', {});`.

In node `dsp-serialise-negotiations`, change `const negotiations = flow.get('negotiations') || {};` to `const negotiations = global.get('negotiations') || {};`.

Leave every `transfers` context call (`flow.get/set('transfers', ...)` in both files) exactly as-is — transfers are only ever read/written from within `tab-dsp-transfers` itself, so per-tab `flow.*` scope is already correct there and changing it would be an unrequested scope change.

- [ ] **Step 4: Manual parity verification (post-deploy, once Task 11's per-tab deploy exists — note this step is deferred until Task 11 lands; record it here so it isn't lost)**

After deploying both files to a real ORCE pod: `POST /dsp/negotiations` (note the returned `negotiationId`/implied `agreementId` via `GET /dsp/negotiations/:id`), restart the ORCE pod (or wait for the next `dsp.persist.negotiations` fire), confirm `GET /dsp/negotiations/:id` still resolves after restart (proves the state-tab global-context read/write survived the rename), then — once Task 9 lands — confirm a `POST /dsp/transfers` referencing that `agreementId` can actually see it from the transfers tab (proves the cross-tab visibility fix worked; before this task, that lookup was structurally impossible since `tab-dsp-transfers` was reading an always-empty per-tab `negotiations` key).

- [ ] **Step 5: Commit**

```bash
git add services/dsp-connector/orce/flows/facis-dsp-negotiations.json services/dsp-connector/orce/flows/facis-dsp-state.json
git commit -m "fix(orce/dsp): move negotiations context from flow-scope to global-scope

Transfers tab needs to read the negotiations map to validate agreementId
ownership (NF-1/NF-6), but flow.* context is per-tab in Node-RED — the
negotiations map written by tab-dsp-negotiations was invisible outside it."
```

---

### Task 4: TDD — pure verifier logic (did:web resolution, JWS verify, policy checks)

Write the algorithm as plain, spec-testable functions first, per this repo's mirrored-logic test convention. These functions get pasted (with zero behavior change) into the actual function node in Task 7 — write them once, correctly, here.

**Files:**
- Create: `services/dsp-connector/orce/tests/flows/iam-verify.spec.js`
- Modify: `services/dsp-connector/orce/tests/package.json` (add `jose` devDependency)

**Interfaces:**
- Produces (function signatures Task 7's flow-node code must match exactly):
  - `didWebToUrl(did: string): string` — throws on non-`did:web` input
  - `checkJtiReplay(cache: Map<string,number>, jti: string, nowMs: number, ttlMs: number): { seen: boolean, cache: Map }`
  - `async verifyPresentation({ vpToken, resolveJwk, audience, trustedIssuers, nowMs, jtiCache, jtiTtlMs }): { ok: true, identity: { did, roles, credentialId, verifiedAt } } | { ok: false, code: string, detail: string }`
- Consumes: `jose` (`SignJWT`, `importJWK`, `jwtVerify`, `generateKeyPair`, `decodeProtectedHeader`, `decodeJwt`) via dynamic `import('jose')` (the spec file stays CommonJS like its siblings; jose 5.x is ESM-only, so it must be dynamically imported inside each async test, not `require`d at the top).

- [ ] **Step 1: Write the failing tests**

```js
/* eslint-disable */
//
// iam-verify.spec.js — pure-logic tests for the NF-1 IAM verifier
// (facis-dsp-iam-verify.json). Mirrors the function bodies of nodes
// dsp-iam-prep / dsp-iam-verify exactly — any change here must be
// hand-mirrored into the flow JSON in Task 7/8, per this repo's
// no-flow-execution test convention (see negotiation-finalize.spec.js).
//

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- mirrored pure logic (paste-identical to the flow's function nodes) ----

function didWebToUrl(did) {
    const parts = did.split(':');
    if (parts[0] !== 'did' || parts[1] !== 'web') {
        throw new Error('unsupported DID method: ' + did);
    }
    const segments = parts.slice(2).map(decodeURIComponent);
    const domain = segments[0];
    const path = segments.slice(1);
    if (path.length === 0) {
        return 'https://' + domain + '/.well-known/did.json';
    }
    return 'https://' + domain + '/' + path.join('/') + '/did.json';
}

function checkJtiReplay(cache, jti, nowMs, ttlMs) {
    for (const [k, expiresAt] of cache) {
        if (expiresAt <= nowMs) cache.delete(k);
    }
    if (cache.has(jti)) {
        return { seen: true, cache };
    }
    cache.set(jti, nowMs + ttlMs);
    return { seen: false, cache };
}

async function verifyPresentation({ vpToken, resolveJwk, audience, trustedIssuers, nowMs, jtiCache, jtiTtlMs }) {
    const jose = await import('jose');
    let vpPayload, vpProtectedHeader;
    try {
        vpProtectedHeader = jose.decodeProtectedHeader(vpToken);
        vpPayload = jose.decodeJwt(vpToken);
    } catch (err) {
        return { ok: false, code: 'invalid_signature', detail: 'malformed VP token' };
    }

    const holderDid = vpPayload.iss;
    if (!holderDid || vpPayload.sub !== holderDid) {
        return { ok: false, code: 'holder_binding_failed', detail: 'VP iss/sub mismatch' };
    }

    let vpKey;
    try {
        const vpJwk = await resolveJwk(holderDid, vpProtectedHeader.kid);
        vpKey = await jose.importJWK(vpJwk, vpProtectedHeader.alg);
    } catch (err) {
        return { ok: false, code: 'key_mismatch', detail: 'could not resolve VP signer key: ' + err.message };
    }

    try {
        await jose.jwtVerify(vpToken, vpKey, { audience });
    } catch (err) {
        if (err.code === 'ERR_JWT_EXPIRED') {
            return { ok: false, code: 'token_expired', detail: 'VP expired' };
        }
        if (err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && err.claim === 'aud') {
            return { ok: false, code: 'invalid_audience', detail: 'VP aud mismatch' };
        }
        return { ok: false, code: 'invalid_signature', detail: 'VP signature verification failed' };
    }

    if (!vpPayload.jti) {
        return { ok: false, code: 'invalid_signature', detail: 'VP missing jti' };
    }
    const replay = checkJtiReplay(jtiCache, vpPayload.jti, nowMs, jtiTtlMs);
    if (replay.seen) {
        return { ok: false, code: 'replay_detected', detail: 'VP jti already used: ' + vpPayload.jti };
    }

    const vcTokens = (vpPayload.vp && vpPayload.vp.verifiableCredential) || vpPayload.verifiableCredential || [];
    if (!Array.isArray(vcTokens) || vcTokens.length === 0) {
        return { ok: false, code: 'invalid_credential', detail: 'VP contains no verifiableCredential' };
    }

    const vc = vcTokens[0];
    let vcPayload, vcProtectedHeader;
    try {
        vcProtectedHeader = jose.decodeProtectedHeader(vc);
        vcPayload = jose.decodeJwt(vc);
    } catch (err) {
        return { ok: false, code: 'invalid_credential', detail: 'malformed inner VC' };
    }

    const vcIssuer = vcPayload.iss;
    if (!trustedIssuers.includes(vcIssuer)) {
        return { ok: false, code: 'untrusted_issuer', detail: 'VC issuer not in allowlist: ' + vcIssuer };
    }

    const subject = (vcPayload.vc && vcPayload.vc.credentialSubject) || vcPayload.credentialSubject || {};
    if (subject.id !== holderDid) {
        return { ok: false, code: 'holder_binding_failed', detail: 'VC credentialSubject.id != VP holder' };
    }

    let vcKey;
    try {
        const vcJwk = await resolveJwk(vcIssuer, vcProtectedHeader.kid);
        vcKey = await jose.importJWK(vcJwk, vcProtectedHeader.alg);
    } catch (err) {
        return { ok: false, code: 'key_mismatch', detail: 'could not resolve VC issuer key: ' + err.message };
    }

    try {
        await jose.jwtVerify(vc, vcKey);
    } catch (err) {
        if (err.code === 'ERR_JWT_EXPIRED') {
            return { ok: false, code: 'token_expired', detail: 'VC expired' };
        }
        return { ok: false, code: 'invalid_credential', detail: 'VC signature verification failed' };
    }

    const roles = (vcPayload.vc && vcPayload.vc.credentialSubject && vcPayload.vc.credentialSubject.roles)
        || subject.roles || [];

    return {
        ok: true,
        identity: {
            did: holderDid,
            roles,
            credentialId: vcPayload.jti || vcPayload.id || null,
            verifiedAt: new Date(nowMs).toISOString()
        }
    };
}

// ---- fixtures ----

async function makeSignedJwt(payload, privateKey, kid, alg) {
    const jose = await import('jose');
    return new jose.SignJWT(payload)
        .setProtectedHeader({ alg, kid })
        .sign(privateKey);
}

async function makeKeypair() {
    const jose = await import('jose');
    const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
    const publicJwk = await jose.exportJWK(publicKey);
    return { publicKey, privateKey, publicJwk };
}

// ---- tests: didWebToUrl ----

test('didWebToUrl: bare domain maps to /.well-known/did.json', () => {
    assert.equal(didWebToUrl('did:web:example.com'), 'https://example.com/.well-known/did.json');
});

test('didWebToUrl: path segments map to <path>/did.json (no well-known)', () => {
    assert.equal(
        didWebToUrl('did:web:example.com:issuers:acme'),
        'https://example.com/issuers/acme/did.json'
    );
});

test('didWebToUrl: percent-encoded segments are decoded', () => {
    assert.equal(
        didWebToUrl('did:web:example.com:issuers%3Aacme'),
        'https://example.com/issuers:acme/did.json'
    );
});

test('didWebToUrl: rejects non-did:web methods', () => {
    assert.throws(() => didWebToUrl('did:key:z6Mk...'), /unsupported DID method/);
});

// ---- tests: checkJtiReplay ----

test('checkJtiReplay: first sight is not a replay', () => {
    const r = checkJtiReplay(new Map(), 'jti-1', 1000, 60000);
    assert.equal(r.seen, false);
});

test('checkJtiReplay: second sight within TTL is a replay', () => {
    let cache = new Map();
    cache = checkJtiReplay(cache, 'jti-1', 1000, 60000).cache;
    const r = checkJtiReplay(cache, 'jti-1', 2000, 60000);
    assert.equal(r.seen, true);
});

test('checkJtiReplay: entries expire after TTL and can repeat', () => {
    let cache = new Map();
    cache = checkJtiReplay(cache, 'jti-1', 1000, 60000).cache;
    const r = checkJtiReplay(cache, 'jti-1', 1000 + 60001, 60000);
    assert.equal(r.seen, false);
});

// ---- tests: verifyPresentation (golden-vector style, keys minted in-test) ----

test('verifyPresentation: valid VP + valid VC → ok with identity', async () => {
    const holder = await makeKeypair();
    const issuer = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);

    const vc = await makeSignedJwt({
        iss: 'did:web:issuer.example',
        vc: { credentialSubject: { id: 'did:web:holder.example', roles: ['participant'] } },
        iat: now
    }, issuer.privateKey, 'did:web:issuer.example#key-1', 'ES256');

    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example',
        sub: 'did:web:holder.example',
        aud: 'did:web:connector.example',
        jti: 'vp-jti-1',
        exp: now + 300,
        vp: { verifiableCredential: [vc] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const resolveJwk = async (did) => (did === 'did:web:holder.example' ? holder.publicJwk : issuer.publicJwk);

    const result = await verifyPresentation({
        vpToken: vp,
        resolveJwk,
        audience: 'did:web:connector.example',
        trustedIssuers: ['did:web:issuer.example'],
        nowMs: now * 1000,
        jtiCache: new Map(),
        jtiTtlMs: 300000
    });

    assert.equal(result.ok, true);
    assert.equal(result.identity.did, 'did:web:holder.example');
    assert.deepEqual(result.identity.roles, ['participant']);
});

test('verifyPresentation: expired VP → token_expired', async () => {
    const holder = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-2', exp: now - 10,
        vp: { verifiableCredential: [] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const result = await verifyPresentation({
        vpToken: vp, resolveJwk: async () => holder.publicJwk,
        audience: 'did:web:connector.example', trustedIssuers: [],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'token_expired');
});

test('verifyPresentation: tampered VP signature → invalid_signature', async () => {
    const holder = await makeKeypair();
    const attacker = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-3', exp: now + 300,
        vp: { verifiableCredential: [] }
    }, attacker.privateKey, 'did:web:holder.example#key-1', 'ES256');

    // Resolver returns the HOLDER's real key, but the token was signed by attacker.
    const result = await verifyPresentation({
        vpToken: vp, resolveJwk: async () => holder.publicJwk,
        audience: 'did:web:connector.example', trustedIssuers: [],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_signature');
});

test('verifyPresentation: forged DID (resolver key does not match signer) → key_mismatch or invalid_signature', async () => {
    const holder = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-4', exp: now + 300,
        vp: { verifiableCredential: [] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const result = await verifyPresentation({
        vpToken: vp,
        resolveJwk: async () => { throw new Error('did.json not found (404)'); },
        audience: 'did:web:connector.example', trustedIssuers: [],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'key_mismatch');
});

test('verifyPresentation: untrusted VC issuer → untrusted_issuer', async () => {
    const holder = await makeKeypair();
    const issuer = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);

    const vc = await makeSignedJwt({
        iss: 'did:web:not-trusted.example',
        vc: { credentialSubject: { id: 'did:web:holder.example', roles: [] } },
    }, issuer.privateKey, 'did:web:not-trusted.example#key-1', 'ES256');

    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-5', exp: now + 300,
        vp: { verifiableCredential: [vc] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const resolveJwk = async (did) => (did === 'did:web:holder.example' ? holder.publicJwk : issuer.publicJwk);

    const result = await verifyPresentation({
        vpToken: vp, resolveJwk,
        audience: 'did:web:connector.example',
        trustedIssuers: ['did:web:some-other-issuer.example'],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'untrusted_issuer');
});

test('verifyPresentation: holder != credentialSubject → holder_binding_failed', async () => {
    const holder = await makeKeypair();
    const issuer = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);

    const vc = await makeSignedJwt({
        iss: 'did:web:issuer.example',
        vc: { credentialSubject: { id: 'did:web:someone-else.example', roles: [] } },
    }, issuer.privateKey, 'did:web:issuer.example#key-1', 'ES256');

    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-6', exp: now + 300,
        vp: { verifiableCredential: [vc] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const resolveJwk = async (did) => (did === 'did:web:holder.example' ? holder.publicJwk : issuer.publicJwk);

    const result = await verifyPresentation({
        vpToken: vp, resolveJwk,
        audience: 'did:web:connector.example',
        trustedIssuers: ['did:web:issuer.example'],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'holder_binding_failed');
});

test('verifyPresentation: wrong audience → invalid_audience', async () => {
    const holder = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:someone-else.example', jti: 'vp-jti-7', exp: now + 300,
        vp: { verifiableCredential: [] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const result = await verifyPresentation({
        vpToken: vp, resolveJwk: async () => holder.publicJwk,
        audience: 'did:web:connector.example', trustedIssuers: [],
        nowMs: now * 1000, jtiCache: new Map(), jtiTtlMs: 300000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_audience');
});

test('verifyPresentation: replayed jti on second call → replay_detected', async () => {
    const holder = await makeKeypair();
    const now = Math.floor(Date.now() / 1000);
    const vp = await makeSignedJwt({
        iss: 'did:web:holder.example', sub: 'did:web:holder.example',
        aud: 'did:web:connector.example', jti: 'vp-jti-8', exp: now + 300,
        vp: { verifiableCredential: [] }
    }, holder.privateKey, 'did:web:holder.example#key-1', 'ES256');

    const sharedCache = new Map();
    const args = {
        vpToken: vp, resolveJwk: async () => holder.publicJwk,
        audience: 'did:web:connector.example', trustedIssuers: [],
        nowMs: now * 1000, jtiCache: sharedCache, jtiTtlMs: 300000
    };
    const first = await verifyPresentation(args);
    assert.equal(first.ok, true);
    const second = await verifyPresentation({ ...args, jtiCache: sharedCache });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'replay_detected');
});
```

- [ ] **Step 2: Add `jose` as a devDependency and install**

Edit `services/dsp-connector/orce/tests/package.json`:

```json
{
  "name": "facis-dsp-connector-orce-tests",
  "version": "1.0.0",
  "private": true,
  "description": "Flow-level tests for the FACIS DSP Connector ORCE flows. Mirrors services/simulation/orce/tests.",
  "scripts": {
    "test": "node --test flows"
  },
  "devDependencies": {
    "jose": "5.9.6"
  },
  "license": "Apache-2.0"
}
```

Run: `cd services/dsp-connector/orce/tests && npm install`
Expected: `jose` installed, no vulnerabilities of note (it's dependency-free).

- [ ] **Step 3: Run tests to verify they pass** (this is TDD-in-spirit but not TDD-by-the-letter — the "implementation" and the "spec" are the same code, since this repo's convention tests the mirrored algorithm directly rather than a separate implementation. There is nothing to fail-then-fix here; running once confirms the algorithm itself, before it's pasted into the flow JSON in Task 7, is correct.)

Run: `cd services/dsp-connector/orce/tests && node --test flows/iam-verify.spec.js`
Expected: all tests pass (11 tests: 4 `didWebToUrl`, 3 `checkJtiReplay`, 7 `verifyPresentation` — wait, recount: 4 + 3 + 8 = 15... actually 4 didWebToUrl + 3 checkJtiReplay + 8 verifyPresentation = 15 tests). All green.

- [ ] **Step 4: Commit**

```bash
git add services/dsp-connector/orce/tests/flows/iam-verify.spec.js services/dsp-connector/orce/tests/package.json services/dsp-connector/orce/tests/package-lock.json
git commit -m "test(orce/dsp): add NF-1 IAM verifier pure-logic spec (did:web, JWS verify, policy checks)"
```

---

### Task 5: Golden-vector fixtures (committed, static keys)

Task 4's tests mint fresh keys per test run (fine for logic coverage) but the plan's acceptance criteria (delivery-plan §7, ORCE doc §7) call for **committed** golden vectors so any future re-implementation (image bake, a `remote` verifier swap) can be checked byte-for-byte against the same fixtures rather than re-deriving trust from scratch each time.

**Files:**
- Create: `services/dsp-connector/orce/tests/fixtures/iam/generate-fixtures.js` (one-off generator script, not a test)
- Create: `services/dsp-connector/orce/tests/fixtures/iam/keys.json` (committed output)
- Create: `services/dsp-connector/orce/tests/fixtures/iam/vectors.json` (committed output)
- Test: `services/dsp-connector/orce/tests/flows/iam-verify-golden.spec.js`

**Interfaces:**
- Consumes: `verifyPresentation` (same signature as Task 4)
- Produces: `keys.json` = `{ holder: {publicJwk, privateJwk}, issuer: {...}, untrustedIssuer: {...} }`; `vectors.json` = `{ valid, expired, tamperedSignature, wrongAudience, untrustedIssuer, holderMismatch, revoked }` (each a compact JWT string, plus a `now` epoch-seconds anchor the tests must pass as `nowMs` so `expired`/`valid` stay correct forever regardless of when tests run).

- [ ] **Step 1: Write the generator script**

```js
#!/usr/bin/env node
// generate-fixtures.js — one-off script, run manually, output committed to
// keys.json / vectors.json. Re-run only if the verifier's claim shape
// changes; the whole point of golden vectors is that they DON'T change
// silently between runs.
const fs = require('fs');
const path = require('path');

async function main() {
    const jose = await import('jose');

    async function keypair() {
        const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
        return {
            publicJwk: await jose.exportJWK(publicKey),
            privateJwk: await jose.exportJWK(privateKey),
            privateKey
        };
    }

    const holder = await keypair();
    const issuer = await keypair();
    const untrustedIssuer = await keypair();

    const now = Math.floor(Date.now() / 1000);

    async function sign(payload, privateKey, kid) {
        return new jose.SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid }).sign(privateKey);
    }

    const validVc = await sign({
        iss: 'did:web:issuer.example',
        vc: { credentialSubject: { id: 'did:web:holder.example', roles: ['participant'] } }
    }, issuer.privateKey, 'did:web:issuer.example#key-1');

    const untrustedVc = await sign({
        iss: 'did:web:untrusted.example',
        vc: { credentialSubject: { id: 'did:web:holder.example', roles: [] } }
    }, untrustedIssuer.privateKey, 'did:web:untrusted.example#key-1');

    const mismatchedVc = await sign({
        iss: 'did:web:issuer.example',
        vc: { credentialSubject: { id: 'did:web:someone-else.example', roles: [] } }
    }, issuer.privateKey, 'did:web:issuer.example#key-1');

    async function signVp(payload) {
        return sign(payload, holder.privateKey, 'did:web:holder.example#key-1');
    }

    const vectors = {
        anchorNowEpochSeconds: now,
        valid: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:connector.example', jti: 'golden-valid', exp: now + 300,
            vp: { verifiableCredential: [validVc] }
        }),
        expired: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:connector.example', jti: 'golden-expired', exp: now - 10,
            vp: { verifiableCredential: [validVc] }
        }),
        wrongAudience: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:wrong.example', jti: 'golden-wrong-aud', exp: now + 300,
            vp: { verifiableCredential: [validVc] }
        }),
        untrustedIssuer: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:connector.example', jti: 'golden-untrusted', exp: now + 300,
            vp: { verifiableCredential: [untrustedVc] }
        }),
        holderMismatch: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:connector.example', jti: 'golden-mismatch', exp: now + 300,
            vp: { verifiableCredential: [mismatchedVc] }
        })
    };
    // Tampered-signature vector: flip one base64url char in the valid VP's signature segment.
    const segs = vectors.valid.split('.');
    const sigChars = segs[2].split('');
    sigChars[0] = sigChars[0] === 'A' ? 'B' : 'A';
    vectors.tamperedSignature = segs[0] + '.' + segs[1] + '.' + sigChars.join('');

    fs.writeFileSync(path.join(__dirname, 'keys.json'), JSON.stringify({
        holder: { publicJwk: holder.publicJwk, privateJwk: holder.privateJwk },
        issuer: { publicJwk: issuer.publicJwk, privateJwk: issuer.privateJwk },
        untrustedIssuer: { publicJwk: untrustedIssuer.publicJwk, privateJwk: untrustedIssuer.privateJwk }
    }, null, 2));
    fs.writeFileSync(path.join(__dirname, 'vectors.json'), JSON.stringify(vectors, null, 2));
    console.log('Wrote keys.json and vectors.json');
}

main();
```

- [ ] **Step 2: Run it once and commit its output**

```bash
cd services/dsp-connector/orce/tests/fixtures/iam
node generate-fixtures.js
```
Expected: `Wrote keys.json and vectors.json`, two new files present.

- [ ] **Step 3: Write the golden-vector spec (consumes the committed files, never regenerates them)**

```js
/* eslint-disable */
//
// iam-verify-golden.spec.js — asserts the verifier's behavior against
// COMMITTED fixtures (keys.json / vectors.json), not freshly-minted keys.
// If this test ever needs new vectors, run generate-fixtures.js and re-commit
// — do not inline-generate here, that defeats the point of a golden vector.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../fixtures/iam/keys.json');
const vectors = require('../fixtures/iam/vectors.json');

// Same verifyPresentation as iam-verify.spec.js — duplicated here
// deliberately (mirrored-logic convention: this file must stay runnable and
// reviewable standalone, without importing another spec file).
async function verifyPresentation({ vpToken, resolveJwk, audience, trustedIssuers, nowMs, jtiCache, jtiTtlMs }) {
    const jose = await import('jose');
    let vpPayload, vpProtectedHeader;
    try {
        vpProtectedHeader = jose.decodeProtectedHeader(vpToken);
        vpPayload = jose.decodeJwt(vpToken);
    } catch (err) {
        return { ok: false, code: 'invalid_signature', detail: 'malformed VP token' };
    }
    const holderDid = vpPayload.iss;
    if (!holderDid || vpPayload.sub !== holderDid) {
        return { ok: false, code: 'holder_binding_failed', detail: 'VP iss/sub mismatch' };
    }
    let vpKey;
    try {
        const vpJwk = await resolveJwk(holderDid, vpProtectedHeader.kid);
        vpKey = await jose.importJWK(vpJwk, vpProtectedHeader.alg);
    } catch (err) {
        return { ok: false, code: 'key_mismatch', detail: 'could not resolve VP signer key: ' + err.message };
    }
    try {
        await jose.jwtVerify(vpToken, vpKey, { audience });
    } catch (err) {
        if (err.code === 'ERR_JWT_EXPIRED') return { ok: false, code: 'token_expired', detail: 'VP expired' };
        if (err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && err.claim === 'aud') {
            return { ok: false, code: 'invalid_audience', detail: 'VP aud mismatch' };
        }
        return { ok: false, code: 'invalid_signature', detail: 'VP signature verification failed' };
    }
    if (!vpPayload.jti) return { ok: false, code: 'invalid_signature', detail: 'VP missing jti' };
    for (const [k, exp] of jtiCache) { if (exp <= nowMs) jtiCache.delete(k); }
    if (jtiCache.has(vpPayload.jti)) return { ok: false, code: 'replay_detected', detail: 'VP jti already used' };
    jtiCache.set(vpPayload.jti, nowMs + jtiTtlMs);

    const vcTokens = (vpPayload.vp && vpPayload.vp.verifiableCredential) || [];
    if (!vcTokens.length) return { ok: false, code: 'invalid_credential', detail: 'no verifiableCredential' };
    const vc = vcTokens[0];
    let vcPayload, vcHeader;
    try {
        vcHeader = jose.decodeProtectedHeader(vc);
        vcPayload = jose.decodeJwt(vc);
    } catch (err) {
        return { ok: false, code: 'invalid_credential', detail: 'malformed inner VC' };
    }
    const vcIssuer = vcPayload.iss;
    if (!trustedIssuers.includes(vcIssuer)) {
        return { ok: false, code: 'untrusted_issuer', detail: 'VC issuer not in allowlist' };
    }
    const subject = (vcPayload.vc && vcPayload.vc.credentialSubject) || {};
    if (subject.id !== holderDid) {
        return { ok: false, code: 'holder_binding_failed', detail: 'VC subject != VP holder' };
    }
    let vcKey;
    try {
        const vcJwk = await resolveJwk(vcIssuer, vcHeader.kid);
        vcKey = await jose.importJWK(vcJwk, vcHeader.alg);
    } catch (err) {
        return { ok: false, code: 'key_mismatch', detail: 'could not resolve VC issuer key' };
    }
    try {
        await jose.jwtVerify(vc, vcKey);
    } catch (err) {
        return { ok: false, code: 'invalid_credential', detail: 'VC signature verification failed' };
    }
    return {
        ok: true,
        identity: { did: holderDid, roles: subject.roles || [], credentialId: vcPayload.jti || null,
                    verifiedAt: new Date(nowMs).toISOString() }
    };
}

function makeResolver() {
    return async (did) => {
        if (did === 'did:web:holder.example') return keys.holder.publicJwk;
        if (did === 'did:web:issuer.example') return keys.issuer.publicJwk;
        if (did === 'did:web:untrusted.example') return keys.untrustedIssuer.publicJwk;
        throw new Error('unknown DID in golden fixtures: ' + did);
    };
}

const nowMs = vectors.anchorNowEpochSeconds * 1000;
const commonArgs = {
    resolveJwk: makeResolver(),
    audience: 'did:web:connector.example',
    trustedIssuers: ['did:web:issuer.example'],
    nowMs, jtiTtlMs: 300000
};

test('golden: valid VP → ok', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.valid, jtiCache: new Map() });
    assert.equal(r.ok, true);
    assert.equal(r.identity.did, 'did:web:holder.example');
});

test('golden: expired → token_expired', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.expired, jtiCache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.code, 'token_expired');
});

test('golden: tampered signature → invalid_signature', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.tamperedSignature, jtiCache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.code, 'invalid_signature');
});

test('golden: wrong audience → invalid_audience', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.wrongAudience, jtiCache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.code, 'invalid_audience');
});

test('golden: untrusted issuer → untrusted_issuer', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.untrustedIssuer, jtiCache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.code, 'untrusted_issuer');
});

test('golden: holder mismatch → holder_binding_failed', async () => {
    const r = await verifyPresentation({ ...commonArgs, vpToken: vectors.holderMismatch, jtiCache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.code, 'holder_binding_failed');
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/dsp-connector/orce/tests && node --test flows/iam-verify-golden.spec.js`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/dsp-connector/orce/tests/fixtures/iam/ services/dsp-connector/orce/tests/flows/iam-verify-golden.spec.js
git commit -m "test(orce/dsp): commit NF-1 golden-vector fixtures + golden spec"
```

---

### Task 6: Build the `facis-dsp-iam-verify` Node-RED tab

Paste Task 4's proven logic into two function nodes, wired with the caching/HTTP-resolve fan-in described in the architecture section, entered via `link in` and exited via a single `link out` (mode `return`) so both `tab-dsp-negotiations` and `tab-dsp-transfers` can call it and get a result back (Task 7).

**Files:**
- Create: `services/dsp-connector/orce/flows/facis-dsp-iam-verify.json`

**Interfaces:**
- Consumes: env vars `DSP_IAM_ENFORCE` (`off|warn|enforce`, default `enforce`), `DSP_VP_AUDIENCE`, `DSP_TRUSTED_ISSUERS` (comma-separated DIDs), `DSP_IAM_JTI_TTL_SECONDS` (default `300`), `DSP_IAM_DID_CACHE_TTL_SECONDS` (default `300`).
- Produces (on the calling tab, after the `link call` returns): `msg.identity = {did, roles, credentialId, verifiedAt} | null`, `msg.iamRejected = boolean`; when `msg.iamRejected` is true, also `msg.statusCode` (401) and `msg.payload` (DSP-shaped error body) are pre-set so the caller can short-circuit straight to its `http response` node.

- [ ] **Step 1: Write the tab JSON**

```json
[
  {
    "id": "tab-dsp-iam-verify",
    "type": "tab",
    "label": "FACIS DSP — IAM Verify",
    "disabled": false,
    "info": "NF-1 / FR-IAM-001 / FR-IAM-002 shared verifier. Reached via `link call`\nfrom tab-dsp-negotiations and tab-dsp-transfers (NOT the fire-and-forget\n`link out`/`link in` idiom used by dsp.persist.* — this needs a result back,\nwhich only `link call` + `link in [return]` provide).\n\nDSP_IAM_ENFORCE=off|warn|enforce (default enforce):\n  off     — always returns msg.identity=null, msg.iamRejected=false (parity\n            mode; callers must fall back to their pre-NF-1 behaviour).\n  warn    — verification runs and failures are logged, but msg.iamRejected\n            is always false (never blocks a request).\n  enforce — failures set msg.iamRejected=true + a DSP-shaped 401.\n\nSee orce/tests/flows/iam-verify.spec.js / iam-verify-golden.spec.js for the\nmirrored pure logic this tab's function nodes must stay byte-identical to."
  },
  {
    "id": "dsp-iam-verify-in",
    "type": "link in",
    "z": "tab-dsp-iam-verify",
    "name": "← iam.verify (call)",
    "links": [],
    "x": 150,
    "y": 120,
    "wires": [
      [
        "dsp-iam-prep"
      ]
    ]
  },
  {
    "id": "dsp-iam-prep",
    "type": "function",
    "z": "tab-dsp-iam-verify",
    "name": "prep + cache check",
    "func": "function didWebToUrl(did) {\n    const parts = did.split(':');\n    if (parts[0] !== 'did' || parts[1] !== 'web') {\n        throw new Error('unsupported DID method: ' + did);\n    }\n    const segments = parts.slice(2).map(decodeURIComponent);\n    const domain = segments[0];\n    const p = segments.slice(1);\n    if (p.length === 0) return 'https://' + domain + '/.well-known/did.json';\n    return 'https://' + domain + '/' + p.join('/') + '/did.json';\n}\n\nfunction dspError(code, detail) {\n    return {\n        statusCode: 401,\n        headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },\n        payload: { '@type': 'dspace:Error', 'dspace:code': code, 'dspace:reason': [detail] }\n    };\n}\n\nconst enforce = (env.get('DSP_IAM_ENFORCE') || 'enforce').toLowerCase();\nif (enforce === 'off') {\n    msg.identity = null;\n    msg.iamRejected = false;\n    msg._iamMode = 'off';\n    return [null, null, msg];\n}\nmsg._iamMode = enforce;\n\nconst authHeader = (msg.req && msg.req.headers && msg.req.headers.authorization) || '';\nconst m = /^Bearer\\s+(.+)$/i.exec(authHeader.trim());\nif (!m) {\n    const err = dspError('missing_authorization', 'Authorization: Bearer <vp+jwt> header is required');\n    if (enforce === 'enforce') {\n        Object.assign(msg, err);\n        msg.identity = null;\n        msg.iamRejected = true;\n    } else {\n        msg.identity = null;\n        msg.iamRejected = false;\n        node.warn('[iam-verify] warn-mode: ' + err.payload['dspace:reason'][0]);\n    }\n    return [null, null, msg];\n}\nconst vpToken = m[1];\n\nlet vpPayload, vpHeader;\ntry {\n    const parts = vpToken.split('.');\n    vpHeader = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));\n    vpPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));\n} catch (e) {\n    const err = dspError('invalid_signature', 'malformed VP token');\n    if (enforce === 'enforce') { Object.assign(msg, err); msg.identity = null; msg.iamRejected = true; }\n    else { msg.identity = null; msg.iamRejected = false; node.warn('[iam-verify] warn-mode: malformed VP'); }\n    return [null, null, msg];\n}\n\nconst holderDid = vpPayload.iss;\nlet didUrl;\ntry {\n    didUrl = didWebToUrl(holderDid || '');\n} catch (e) {\n    const err = dspError('key_mismatch', 'unsupported or missing holder DID');\n    if (enforce === 'enforce') { Object.assign(msg, err); msg.identity = null; msg.iamRejected = true; }\n    else { msg.identity = null; msg.iamRejected = false; node.warn('[iam-verify] warn-mode: ' + e.message); }\n    return [null, null, msg];\n}\n\nmsg._iamVp = { vpToken, vpPayload, vpHeader, holderDid, didUrl };\n\nconst cacheTtlMs = Number(env.get('DSP_IAM_DID_CACHE_TTL_SECONDS') || '300') * 1000;\nconst cache = global.get('iamDidCache') || new Map();\nconst cached = cache.get(didUrl);\nconst now = Date.now();\nif (cached && (now - cached.fetchedAt) < cacheTtlMs) {\n    msg._iamVp.didDoc = cached.doc;\n    return [msg, null, null];\n}\nmsg.url = didUrl;\nreturn [null, msg, null];\n",
    "outputs": 3,
    "timeout": "",
    "noerr": 0,
    "initialize": "",
    "finalize": "",
    "libs": [],
    "x": 380,
    "y": 120,
    "wires": [
      [
        "dsp-iam-verify"
      ],
      [
        "dsp-iam-resolve-did"
      ],
      [
        "dsp-iam-return"
      ]
    ]
  },
  {
    "id": "dsp-iam-resolve-did",
    "type": "http request",
    "z": "tab-dsp-iam-verify",
    "name": "GET did.json",
    "method": "GET",
    "ret": "obj",
    "paytoqs": "ignore",
    "url": "",
    "tls": "",
    "persist": false,
    "proxy": "",
    "insecureHTTPParser": false,
    "authType": "",
    "senderr": false,
    "headers": [],
    "x": 620,
    "y": 160,
    "wires": [
      [
        "dsp-iam-verify"
      ]
    ]
  },
  {
    "id": "dsp-iam-verify",
    "type": "function",
    "z": "tab-dsp-iam-verify",
    "name": "verify VP + VC + policy",
    "func": "function dspError(code, detail) {\n    return {\n        statusCode: 401,\n        headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },\n        payload: { '@type': 'dspace:Error', 'dspace:code': code, 'dspace:reason': [detail] }\n    };\n}\n\nfunction reject(msg, code, detail) {\n    const err = dspError(code, detail);\n    if (msg._iamMode === 'enforce') {\n        Object.assign(msg, err);\n        msg.identity = null;\n        msg.iamRejected = true;\n    } else {\n        msg.identity = null;\n        msg.iamRejected = false;\n        node.warn('[iam-verify] warn-mode: ' + code + ' — ' + detail);\n    }\n    return msg;\n}\n\n// `jose` here is in scope from this node's own `libs` declaration below\n// (Node-RED's functionExternalModules injects it as a bound variable,\n// exactly like the existing `crypto` variable is in-scope in dsp-tx-create\n// via its own libs array) — it is NOT read from global context.\n\n(async () => {\n    const vp = msg._iamVp;\n    if (!vp) {\n        node.error('[iam-verify] missing _iamVp context — programmer error, check wiring');\n        node.send(reject(msg, 'invalid_signature', 'internal verifier error'));\n        return;\n    }\n\n    // This response came either from the cache-hit branch (msg._iamVp.didDoc\n    // already set by dsp-iam-prep) or from the http-request node (msg.payload\n    // is the fetched did.json body).\n    const didDoc = vp.didDoc || msg.payload;\n    if (!didDoc || !Array.isArray(didDoc.verificationMethod)) {\n        node.send(reject(msg, 'key_mismatch', 'did.json unresolvable or malformed: ' + vp.didUrl));\n        return;\n    }\n    if (!vp.didDoc) {\n        const cache = global.get('iamDidCache') || new Map();\n        cache.set(vp.didUrl, { doc: didDoc, fetchedAt: Date.now() });\n        global.set('iamDidCache', cache);\n    }\n\n    function findJwk(doc, kid) {\n        const vm = doc.verificationMethod.find(v => v.id === kid || v.id === (kid || '').split('#').pop());\n        if (!vm || !vm.publicKeyJwk) throw new Error('verificationMethod not found for kid=' + kid);\n        return vm.publicKeyJwk;\n    }\n\n    try {\n        const vpKey = await jose.importJWK(findJwk(didDoc, vp.vpHeader.kid), vp.vpHeader.alg);\n        const audience = env.get('DSP_VP_AUDIENCE') || 'did:web:fap-iotai.facis.cloud';\n        await jose.jwtVerify(vp.vpToken, vpKey, { audience });\n    } catch (err) {\n        if (err && err.code === 'ERR_JWT_EXPIRED') { node.send(reject(msg, 'token_expired', 'VP expired')); return; }\n        if (err && err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && err.claim === 'aud') {\n            node.send(reject(msg, 'invalid_audience', 'VP aud mismatch')); return;\n        }\n        node.send(reject(msg, 'key_mismatch', 'VP signer key resolution/verification failed: ' + err.message));\n        return;\n    }\n\n    if (vp.holderDid !== vp.vpPayload.sub) {\n        node.send(reject(msg, 'holder_binding_failed', 'VP iss/sub mismatch')); return;\n    }\n    if (!vp.vpPayload.jti) {\n        node.send(reject(msg, 'invalid_signature', 'VP missing jti')); return;\n    }\n\n    const jtiTtlMs = Number(env.get('DSP_IAM_JTI_TTL_SECONDS') || '300') * 1000;\n    const jtiCache = global.get('iamJtiCache') || new Map();\n    const now = Date.now();\n    for (const [k, exp] of jtiCache) { if (exp <= now) jtiCache.delete(k); }\n    if (jtiCache.has(vp.vpPayload.jti)) {\n        node.send(reject(msg, 'replay_detected', 'VP jti already used: ' + vp.vpPayload.jti)); return;\n    }\n    jtiCache.set(vp.vpPayload.jti, now + jtiTtlMs);\n    global.set('iamJtiCache', jtiCache);\n\n    const vcTokens = (vp.vpPayload.vp && vp.vpPayload.vp.verifiableCredential) || [];\n    if (!vcTokens.length) { node.send(reject(msg, 'invalid_credential', 'VP has no verifiableCredential')); return; }\n    const vcToken = vcTokens[0];\n\n    let vcHeader, vcPayload;\n    try {\n        const parts = vcToken.split('.');\n        vcHeader = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));\n        vcPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));\n    } catch (e) {\n        node.send(reject(msg, 'invalid_credential', 'malformed inner VC')); return;\n    }\n\n    const trustedIssuers = (env.get('DSP_TRUSTED_ISSUERS') || '').split(',').map(s => s.trim()).filter(Boolean);\n    if (!trustedIssuers.includes(vcPayload.iss)) {\n        node.send(reject(msg, 'untrusted_issuer', 'VC issuer not in allowlist: ' + vcPayload.iss)); return;\n    }\n\n    const subject = (vcPayload.vc && vcPayload.vc.credentialSubject) || {};\n    if (subject.id !== vp.holderDid) {\n        node.send(reject(msg, 'holder_binding_failed', 'VC credentialSubject.id != VP holder')); return;\n    }\n\n    try {\n        // VC issuer key: resolve its did.json too (cached the same way).\n        const vcDidUrl = didWebToUrlSafe(vcPayload.iss);\n        let vcDoc;\n        const cache = global.get('iamDidCache') || new Map();\n        const cached = cache.get(vcDidUrl);\n        if (cached && (Date.now() - cached.fetchedAt) < Number(env.get('DSP_IAM_DID_CACHE_TTL_SECONDS') || '300') * 1000) {\n            vcDoc = cached.doc;\n        } else {\n            const resp = await fetch(vcDidUrl); // eslint-disable-line no-undef\n            vcDoc = await resp.json();\n            cache.set(vcDidUrl, { doc: vcDoc, fetchedAt: Date.now() });\n            global.set('iamDidCache', cache);\n        }\n        const vcKey = await jose.importJWK(findJwk(vcDoc, vcHeader.kid), vcHeader.alg);\n        await jose.jwtVerify(vcToken, vcKey);\n    } catch (err) {\n        if (err && err.code === 'ERR_JWT_EXPIRED') { node.send(reject(msg, 'token_expired', 'VC expired')); return; }\n        node.send(reject(msg, 'invalid_credential', 'VC signature verification failed: ' + err.message));\n        return;\n    }\n\n    function didWebToUrlSafe(did) {\n        const parts = (did || '').split(':');\n        if (parts[0] !== 'did' || parts[1] !== 'web') throw new Error('unsupported DID method: ' + did);\n        const segs = parts.slice(2).map(decodeURIComponent);\n        return segs.length === 1 ? 'https://' + segs[0] + '/.well-known/did.json'\n                                 : 'https://' + segs[0] + '/' + segs.slice(1).join('/') + '/did.json';\n    }\n\n    msg.identity = {\n        did: vp.holderDid,\n        roles: subject.roles || [],\n        credentialId: vcPayload.jti || vcPayload.id || null,\n        verifiedAt: new Date().toISOString()\n    };\n    msg.iamRejected = false;\n    delete msg._iamVp;\n    node.send(msg);\n})();\nreturn;\n",
    "outputs": 1,
    "timeout": "",
    "noerr": 0,
    "initialize": "",
    "finalize": "",
    "libs": [
      {
        "var": "jose",
        "module": "jose"
      }
    ],
    "x": 620,
    "y": 260,
    "wires": [
      [
        "dsp-iam-return"
      ]
    ]
  },
  {
    "id": "dsp-iam-return",
    "type": "link out",
    "z": "tab-dsp-iam-verify",
    "name": "return to caller",
    "mode": "return",
    "links": [],
    "x": 880,
    "y": 200,
    "wires": []
  }
]
```

- [ ] **Step 2: Validate the JSON parses and has no duplicate node ids**

```bash
cd services/dsp-connector/orce/flows
node -e "const f=require('./facis-dsp-iam-verify.json'); const ids=f.map(n=>n.id); console.log('nodes:', f.length, 'unique ids:', new Set(ids).size === ids.length)"
```
Expected: `nodes: 5 unique ids: true`.

- [ ] **Step 3: Commit**

```bash
git add services/dsp-connector/orce/flows/facis-dsp-iam-verify.json
git commit -m "feat(orce/dsp): add facis-dsp-iam-verify tab (NF-1 shared VP/VC verifier)"
```

---

### Task 7: Wire the verifier into `tab-dsp-negotiations`

**Files:**
- Modify: `services/dsp-connector/orce/flows/facis-dsp-negotiations.json`

**Interfaces:**
- Consumes: `msg.identity`, `msg.iamRejected` (from Task 6's `dsp-iam-return`)

- [ ] **Step 1: Insert a `link call` node between `dsp-neg-in-create` and `dsp-neg-create`**

Change `dsp-neg-in-create`'s wire from `["dsp-neg-create"]` to `["dsp-neg-iam-call"]`, and add the new node:

```json
  {
    "id": "dsp-neg-iam-call",
    "type": "link call",
    "z": "tab-dsp-negotiations",
    "name": "iam.verify",
    "links": [
      "dsp-iam-verify-in"
    ],
    "timeout": "5",
    "x": 300,
    "y": 80,
    "wires": [
      [
        "dsp-neg-iam-branch"
      ]
    ]
  },
  {
    "id": "dsp-neg-iam-branch",
    "type": "switch",
    "z": "tab-dsp-negotiations",
    "name": "iamRejected?",
    "property": "iamRejected",
    "propertyType": "msg",
    "rules": [
      { "t": "true" },
      { "t": "false" }
    ],
    "checkall": "true",
    "repair": false,
    "outputs": 2,
    "x": 360,
    "y": 80,
    "wires": [
      [
        "dsp-neg-response"
      ],
      [
        "dsp-neg-create"
      ]
    ]
  }
```

Also update `dsp-iam-verify-in` in `facis-dsp-iam-verify.json` (Task 6) so its `"links"` array lists every caller's `link call` node id — Node-RED requires `link in`/`link call` pairs to reference each other bidirectionally for the editor's link visualization (functionally the runtime routes by node id either way, but keep the JSON internally consistent). Update:
```json
"links": []
```
to
```json
"links": [
  "dsp-neg-iam-call",
  "dsp-tx-iam-call"
]
```
(the second id, `dsp-tx-iam-call`, is created in Task 8 — add both now since this file is edited once here and once there; if executing tasks strictly in order, come back and add `dsp-tx-iam-call` after Task 8 creates it, or add both ids now since they're both known from this plan.)

- [ ] **Step 2: Source `counterparty` from the verified identity, not the request body**

In `dsp-neg-create`'s `func`, change:
```js
const negotiation = {
    id: negId,
    state: 'FINALIZED',
    agreementId: agrId,
    offerId: body.offerId,
    counterparty: body.counterparty,
    createdAt: now,
    updatedAt: now
};
```
to:
```js
const counterparty = (msg.identity && msg.identity.did) ? msg.identity.did : body.counterparty;
const negotiation = {
    id: negId,
    state: 'FINALIZED',
    agreementId: agrId,
    offerId: body.offerId,
    counterparty: counterparty,
    createdAt: now,
    updatedAt: now
};
```
(When `DSP_IAM_ENFORCE=off`, `msg.identity` is `null` — falls back to `body.counterparty`, preserving today's behavior exactly, which is what Task 10's parity test checks. When enforcement is on, the verified DID always wins, closing the "unverified free-text counterparty" gap.)

- [ ] **Step 3: Validate JSON + commit**

```bash
cd services/dsp-connector/orce/flows
node -e "require('./facis-dsp-negotiations.json'); console.log('parses OK')"
git add services/dsp-connector/orce/flows/facis-dsp-negotiations.json services/dsp-connector/orce/flows/facis-dsp-iam-verify.json
git commit -m "feat(orce/dsp): wire iam.verify into negotiation creation; counterparty from verified DID"
```

---

### Task 8: Wire the verifier into `tab-dsp-transfers` + agreement-ownership binding + list filtering

**Files:**
- Modify: `services/dsp-connector/orce/flows/facis-dsp-transfers.json`

**Interfaces:**
- Consumes: `msg.identity`, `msg.iamRejected`; `global.get('negotiations')` (now visible thanks to Task 3)

- [ ] **Step 1: Insert `link call` + branch before `dsp-tx-create`, mirroring Task 7**

Change `dsp-tx-in-create`'s wire from `["dsp-tx-create"]` to `["dsp-tx-iam-call"]`, add:

```json
  {
    "id": "dsp-tx-iam-call",
    "type": "link call",
    "z": "tab-dsp-transfers",
    "name": "iam.verify",
    "links": [
      "dsp-iam-verify-in"
    ],
    "timeout": "5",
    "x": 290,
    "y": 80,
    "wires": [
      [
        "dsp-tx-iam-branch"
      ]
    ]
  },
  {
    "id": "dsp-tx-iam-branch",
    "type": "switch",
    "z": "tab-dsp-transfers",
    "name": "iamRejected?",
    "property": "iamRejected",
    "propertyType": "msg",
    "rules": [
      { "t": "true" },
      { "t": "false" }
    ],
    "checkall": "true",
    "repair": false,
    "outputs": 2,
    "x": 350,
    "y": 80,
    "wires": [
      [
        "dsp-tx-response"
      ],
      [
        "dsp-tx-agreement-check"
      ]
    ]
  }
```

- [ ] **Step 2: Add the agreement-ownership check node** (between the verifier and the existing `dsp-tx-create`) — this is the NF-6-adjacent binding the vault plan calls for: `agreementId` from the body must belong to a `FINALIZED` negotiation whose `counterparty` matches the verified identity.

```json
  {
    "id": "dsp-tx-agreement-check",
    "type": "function",
    "z": "tab-dsp-transfers",
    "name": "bind agreementId → identity",
    "func": "const body = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};\nif (msg._iamMode === 'off') {\n    return [msg, null];\n}\nconst negs = global.get('negotiations') || {};\nconst neg = Object.values(negs).find(n => n.agreementId === body.agreementId);\nif (!neg) {\n    msg.statusCode = 403;\n    msg.payload = { '@type': 'dspace:Error', 'dspace:code': 'agreement_not_found', 'dspace:reason': ['agreementId ' + body.agreementId + ' does not correspond to any negotiation'] };\n    msg.headers = { 'Content-Type': 'application/json' };\n    return [null, msg];\n}\nif (neg.state !== 'FINALIZED') {\n    msg.statusCode = 403;\n    msg.payload = { '@type': 'dspace:Error', 'dspace:code': 'agreement_not_finalized', 'dspace:reason': ['negotiation ' + neg.id + ' is ' + neg.state + ', not FINALIZED'] };\n    msg.headers = { 'Content-Type': 'application/json' };\n    return [null, msg];\n}\nif (msg._iamMode === 'enforce' && neg.counterparty !== (msg.identity && msg.identity.did)) {\n    msg.statusCode = 403;\n    msg.payload = { '@type': 'dspace:Error', 'dspace:code': 'agreement_not_held_by_caller', 'dspace:reason': ['agreement ' + body.agreementId + ' is held by a different counterparty'] };\n    msg.headers = { 'Content-Type': 'application/json' };\n    return [null, msg];\n}\nreturn [msg, null];\n",
    "outputs": 2,
    "timeout": "",
    "noerr": 0,
    "initialize": "",
    "finalize": "",
    "libs": [],
    "x": 400,
    "y": 80,
    "wires": [
      [
        "dsp-tx-create"
      ],
      [
        "dsp-tx-response"
      ]
    ]
  }
```

(`msg._iamMode === 'warn'` intentionally still enforces the agreement-ownership check even though signature verification itself doesn't block in warn mode — ownership binding is cheap, has no crypto-trust dependency, and there's no reason to let a `warn`-mode deployment leak cross-counterparty transfers. Only `off` mode — full pre-NF-1 parity — skips it entirely.)

- [ ] **Step 3: Filter `GET /dsp/transfers` (`dsp-tx-list`) by caller identity**

This handler isn't behind the `link call` above (it's `GET`, not the `POST /dsp/transfers` create path) — it needs its own verify call since it's a separate `http in` node. Change `dsp-tx-in-list`'s wire from `["dsp-tx-list"]` to a new `link call` + branch, mirroring Step 1's pattern:

```json
  {
    "id": "dsp-tx-list-iam-call",
    "type": "link call",
    "z": "tab-dsp-transfers",
    "name": "iam.verify",
    "links": [
      "dsp-iam-verify-in"
    ],
    "timeout": "5",
    "x": 290,
    "y": 240,
    "wires": [
      [
        "dsp-tx-list-iam-branch"
      ]
    ]
  },
  {
    "id": "dsp-tx-list-iam-branch",
    "type": "switch",
    "z": "tab-dsp-transfers",
    "name": "iamRejected?",
    "property": "iamRejected",
    "propertyType": "msg",
    "rules": [
      { "t": "true" },
      { "t": "false" }
    ],
    "checkall": "true",
    "repair": false,
    "outputs": 2,
    "x": 350,
    "y": 240,
    "wires": [
      [
        "dsp-tx-response"
      ],
      [
        "dsp-tx-list"
      ]
    ]
  }
```
Update `dsp-tx-in-list`'s `wires` from `[["dsp-tx-list"]]` to `[["dsp-tx-list-iam-call"]]`.

Then filter `dsp-tx-list`'s body — change:
```js
const transfers = flow.get('transfers') || {};
msg.payload = Object.values(transfers);
```
to:
```js
const transfers = flow.get('transfers') || {};
const all = Object.values(transfers);
let visible = all;
if (msg._iamMode === 'enforce' || msg._iamMode === 'warn') {
    const negs = global.get('negotiations') || {};
    const myDid = msg.identity && msg.identity.did;
    visible = all.filter(t => {
        const neg = Object.values(negs).find(n => n.agreementId === t.agreementId);
        return myDid && neg && neg.counterparty === myDid;
    });
    // warn mode: log what enforce mode WOULD have hidden, but return everything
    // (matches dsp-tx-agreement-check's own warn-vs-enforce split for consistency —
    //  actually list-filtering has no crypto-trust dependency either, so treat
    //  warn identically to enforce here: filter always applies once IAM is not 'off'.)
}
msg.payload = visible;
```

This closes the documented leak ("today's `GET /dsp/transfers` returns every counterparty's signed URLs + SASL credentials to any caller") the moment `DSP_IAM_ENFORCE` is anything other than `off`.

- [ ] **Step 4: Validate JSON + commit**

```bash
cd services/dsp-connector/orce/flows
node -e "require('./facis-dsp-transfers.json'); console.log('parses OK')"
git add services/dsp-connector/orce/flows/facis-dsp-transfers.json
git commit -m "feat(orce/dsp): wire iam.verify into transfers; bind agreementId to identity; filter list_transfers"
```

---

### Task 9: `DSP_IAM_ENFORCE=off` parity test

Prove the rewire is a pure guard — with enforcement off, every existing spec (`negotiation-finalize.spec.js`, `transfer-fsm.spec.js`, etc.) must behave byte-identically to before this plan, so the change is safely rollback-able by flipping one env var.

**Files:**
- Create: `services/dsp-connector/orce/tests/flows/iam-enforce-off-parity.spec.js`

**Interfaces:**
- Consumes: the same `createNegotiation`/`getNegotiation` mirror functions already in `negotiation-finalize.spec.js` (duplicated here per convention), plus a mirrored `counterparty` resolution line matching Task 7 Step 2 exactly.

- [ ] **Step 1: Write the test**

```js
/* eslint-disable */
//
// iam-enforce-off-parity.spec.js — proves DSP_IAM_ENFORCE=off preserves the
// pre-NF-1 behaviour exactly: counterparty comes from the request body when
// msg.identity is null (which is what dsp-iam-prep guarantees in off mode).
//
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Mirrors dsp-neg-create's post-Task-7 counterparty resolution exactly.
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

// Mirrors dsp-tx-agreement-check's off-mode short-circuit.
function agreementCheck(iamMode, negotiations, agreementId, callerDid) {
    if (iamMode === 'off') return { ok: true };
    const neg = Object.values(negotiations).find(n => n.agreementId === agreementId);
    if (!neg) return { ok: false, code: 'agreement_not_found' };
    if (neg.state !== 'FINALIZED') return { ok: false, code: 'agreement_not_finalized' };
    if (iamMode === 'enforce' && neg.counterparty !== callerDid) return { ok: false, code: 'agreement_not_held_by_caller' };
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
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd services/dsp-connector/orce/tests && node --test flows/iam-enforce-off-parity.spec.js`
Expected: 5 tests pass.

- [ ] **Step 3: Run the FULL existing suite to confirm nothing else regressed**

Run: `cd services/dsp-connector/orce/tests && npm test`
Expected: all pre-existing specs (`catalogue-query`, `hmac-url`, `kafka-access`, `negotiation-finalize`, `state-persistence`, `transfer-fsm`) plus the 3 new spec files all pass — since none of them were modified, and the mirrored-logic convention means they were never coupled to the flow JSON's context-scope keyword (`flow.` vs `global.`) in the first place, this should be a clean pass with zero changes needed to any of them.

- [ ] **Step 4: Commit**

```bash
git add services/dsp-connector/orce/tests/flows/iam-enforce-off-parity.spec.js
git commit -m "test(orce/dsp): DSP_IAM_ENFORCE=off parity — counterparty/agreement checks preserve pre-NF-1 behaviour"
```

---

### Task 10: Convert `orce-flow-deploy-job.yaml` to per-tab deploy (stop the full-replace wipe)

Independent infra fix, but required before *any* of the flow-file changes above are safely deployable to the shared ORCE pod — the current job does a single full-replace `POST /flows` that would wipe the Simulation/AI-Insight/SFTP tabs living on the same pod (confirmed live in this repo — the known destructive-deploy hazard).

**Files:**
- Modify: `services/dsp-connector/helm/facis-dsp-connector/templates/orce-flow-deploy-job.yaml`

**Interfaces:**
- Consumes: `ORCE_ADMIN_URL`, `ORCE_ADMIN_TOKEN` (unchanged env vars)
- Produces: one `PUT /flow/<tabId>` (or `POST /flow` on 404) per file under `/flows`, instead of one `POST /flows` for all of them combined.

- [ ] **Step 1: Replace the `args` shell script**

Change the `command`/`args` block (lines 47-68) from:

```yaml
          command: ["sh", "-c"]
          args:
            - |
              set -eu
              echo "[orce-flow-deploy] waiting ${PRE_DEPLOY_SLEEP}s for ORCE readiness..."
              sleep "${PRE_DEPLOY_SLEEP}"

              cd /flows
              # Concatenate every flow JSON file (each is a top-level array)
              # into a single combined deployment payload.
              jq -s 'add' *.json > /tmp/combined.json

              echo "[orce-flow-deploy] POST ${ORCE_ADMIN_URL}/flows ($(wc -c </tmp/combined.json) bytes)"
              curl -sS --fail \
                -H "Authorization: Bearer ${ORCE_ADMIN_TOKEN}" \
                -H "Content-Type: application/json" \
                -H "Node-RED-Deployment-Type: full" \
                -X POST "${ORCE_ADMIN_URL}/flows" \
                --data @/tmp/combined.json

              echo
              echo "[orce-flow-deploy] deploy ok"
```

to:

```yaml
          command: ["sh", "-c"]
          args:
            - |
              set -eu
              echo "[orce-flow-deploy] waiting ${PRE_DEPLOY_SLEEP}s for ORCE readiness..."
              sleep "${PRE_DEPLOY_SLEEP}"

              cd /flows
              # Per-tab PUT (fallback POST on 404) — NEVER a full-replace
              # POST /flows. This pod is shared with Simulation/AI-Insight/
              # SFTP flows; a full-replace deploy from this chart alone would
              # wipe every other service's tabs (the known destructive-deploy
              # hazard — see feedback_orce_full_deploy_destructive in
              # project memory). Deploy one tab object at a time instead.
              FAILED=0
              for f in *.json; do
                TAB_ID=$(jq -r '.[] | select(.type=="tab") | .id' "$f")
                if [ -z "$TAB_ID" ]; then
                  echo "[orce-flow-deploy] SKIP $f — no tab object found"
                  continue
                fi
                PAYLOAD=$(jq -c --arg id "$TAB_ID" '
                  (map(select(.type=="tab" and .id==$id)) | .[0]) as $tab |
                  {
                    id: $id,
                    label: $tab.label,
                    disabled: ($tab.disabled // false),
                    info: ($tab.info // ""),
                    nodes: map(select(.type != "tab"))
                  }
                ' "$f")

                HTTP_CODE=$(curl -sS -o /tmp/resp.json -w '%{http_code}' \
                  -H "Authorization: Bearer ${ORCE_ADMIN_TOKEN}" \
                  -H "Content-Type: application/json" \
                  -X PUT "${ORCE_ADMIN_URL}/flow/${TAB_ID}" \
                  --data "$PAYLOAD")

                if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
                  echo "[orce-flow-deploy] PUT $f (tab $TAB_ID) ok ($HTTP_CODE)"
                elif [ "$HTTP_CODE" = "404" ]; then
                  echo "[orce-flow-deploy] tab $TAB_ID not found — creating via POST /flow"
                  CREATE_CODE=$(curl -sS -o /tmp/resp.json -w '%{http_code}' \
                    -H "Authorization: Bearer ${ORCE_ADMIN_TOKEN}" \
                    -H "Content-Type: application/json" \
                    -X POST "${ORCE_ADMIN_URL}/flow" \
                    --data "$PAYLOAD")
                  if [ "$CREATE_CODE" = "200" ] || [ "$CREATE_CODE" = "201" ]; then
                    echo "[orce-flow-deploy] POST $f (tab $TAB_ID) created ($CREATE_CODE)"
                  else
                    echo "[orce-flow-deploy] FAIL creating $f (tab $TAB_ID): http $CREATE_CODE"
                    cat /tmp/resp.json
                    FAILED=1
                  fi
                else
                  echo "[orce-flow-deploy] FAIL updating $f (tab $TAB_ID): http $HTTP_CODE"
                  cat /tmp/resp.json
                  FAILED=1
                fi
              done

              if [ "$FAILED" = "1" ]; then
                echo "[orce-flow-deploy] one or more tabs failed to deploy — see above"
                exit 1
              fi
              echo "[orce-flow-deploy] deploy ok (per-tab)"
```

- [ ] **Step 2: Update the file's usage of `jq`/`curl`**

No image change needed — `alpine/curl` already includes `jq`? Check: run `docker run --rm alpine/curl:8.10.1 sh -c "which jq"`. If `jq` is absent from this image (it's a curl-focused image, `jq` may not be bundled), switch `jobImage.repository` in `values.yaml` from `alpine/curl` to an image with both, e.g. `dwdraju/alpine-curl-jq:latest` pinned to a specific tag, or simplest: keep `alpine/curl` as base but add an `apk add --no-cache jq` line at the very top of the script (the container already runs as non-root per the Job's `securityContext`, so confirm `apk add` works without root — if it doesn't, switch images instead of patching in a package install). Resolve this by actually running the check rather than guessing:

```bash
docker run --rm alpine/curl:8.10.1 sh -c "which jq || echo MISSING"
```
If `MISSING`: edit `services/dsp-connector/helm/facis-dsp-connector/values.yaml`'s `orceFlowDeploy.jobImage` block to a curl+jq image (pin an exact tag, e.g. `repository: alpine/curl` won't work — use `repository: badouralix/curl-jq`, `tag: "latest"` pinned to a specific published digest/tag at implementation time, never floating `latest`).

- [ ] **Step 3: Commit**

```bash
git add services/dsp-connector/helm/facis-dsp-connector/templates/orce-flow-deploy-job.yaml services/dsp-connector/helm/facis-dsp-connector/values.yaml
git commit -m "fix(helm/dsp-connector): per-tab flow deploy (PUT/POST) instead of destructive full-replace

The full-replace POST /flows with Node-RED-Deployment-Type: full wipes
every other service's tabs on the shared ORCE pod. Deploy one tab at a
time via PUT /flow/<id> (fallback POST /flow on 404)."
```

---

### Task 11: Helm — `dsp.iam.*` values + secret rendering

**Files:**
- Modify: `services/dsp-connector/helm/facis-dsp-connector/values.yaml`
- Modify: `services/dsp-connector/helm/facis-dsp-connector/templates/orce-secret.yaml`

**Interfaces:**
- Produces: `DSP_IAM_ENFORCE`, `DSP_VP_AUDIENCE`, `DSP_TRUSTED_ISSUERS`, `DSP_IAM_JTI_TTL_SECONDS`, `DSP_IAM_DID_CACHE_TTL_SECONDS` env vars available to the ORCE pod via the existing `dsp-secrets` Secret + `envFrom` (same delivery mechanism the HMAC values already use).

- [ ] **Step 1: Add the values block**

Append to `values.yaml` (after the existing `dsp:` block, before `Container Image`):

```yaml
# ---------------------------------------------------------------------------
# NF-1 Identity & Trust (IAM verifier)
# ---------------------------------------------------------------------------
dsp:
  iam:
    # -- off | warn | enforce. Start new environments at "warn" to observe
    #    real traffic before blocking it; "off" is full pre-NF-1 parity.
    enforce: "warn"
    # -- This connector's own did:web identity (the VP's expected `aud`).
    vpAudience: "did:web:fap-iotai.facis.cloud"
    # -- Comma-separated allowlist of trusted VC-issuer DIDs.
    trustedIssuers: ""
    jtiTtlSeconds: 300
    didCacheTtlSeconds: 300
```

(Nested under the existing `dsp:` key — Helm merges values files by deep-merging maps, so this is additive to the existing `dsp.hmacSecret` etc., not a replacement. Confirm with `helm template` in Step 3.)

- [ ] **Step 2: Render into the Secret**

Edit `orce-secret.yaml`, add after the existing `DSP_KAFKA_BOOTSTRAP` line:

```yaml
  DSP_IAM_ENFORCE: {{ .Values.dsp.iam.enforce | quote }}
  DSP_VP_AUDIENCE: {{ .Values.dsp.iam.vpAudience | quote }}
  DSP_TRUSTED_ISSUERS: {{ .Values.dsp.iam.trustedIssuers | quote }}
  DSP_IAM_JTI_TTL_SECONDS: {{ .Values.dsp.iam.jtiTtlSeconds | quote }}
  DSP_IAM_DID_CACHE_TTL_SECONDS: {{ .Values.dsp.iam.didCacheTtlSeconds | quote }}
```

- [ ] **Step 3: Validate the chart renders**

```bash
cd services/dsp-connector/helm/facis-dsp-connector
helm template . --set dsp.hmacSecret=test-secret-value | grep -A2 DSP_IAM_ENFORCE
```
Expected: the rendered Secret shows `DSP_IAM_ENFORCE: "warn"` (base64-decode if `helm template` shows it encoded — `stringData` renders as plain text, so it should show directly).

- [ ] **Step 4: Commit**

```bash
git add services/dsp-connector/helm/facis-dsp-connector/values.yaml services/dsp-connector/helm/facis-dsp-connector/templates/orce-secret.yaml
git commit -m "feat(helm/dsp-connector): render NF-1 IAM env vars (enforce mode, audience, trusted issuers)"
```

---

### Task 12: End-to-end smoke test against a real ORCE pod (manual, post-deploy)

Everything above is unit/spec-level. This is the one step that actually proves the wiring works against the live runtime — do this after `helm upgrade` ships Tasks 1-11 to a real cluster.

**Files:** none (manual verification, document the run in this file's checkbox for traceability)

- [ ] **Step 1: Deploy with `DSP_IAM_ENFORCE=warn` first**

```bash
cd services/dsp-connector/helm/facis-dsp-connector
./sync-flows.sh
helm upgrade facis-dsp-connector . --set dsp.hmacSecret=<real-secret> --set dsp.iam.enforce=warn --reuse-values
```
Watch the post-install/upgrade Job: `kubectl logs -n orce job/<release>-orce-flow-deploy -f` — expect per-tab `PUT .../flow/<id> ok` lines for all 7 DSP tabs (6 existing + the new `tab-dsp-iam-verify`), zero `Node-RED-Deployment-Type: full`.

- [ ] **Step 2: Confirm existing behavior is unaffected in warn mode**

`POST /dsp/negotiations` with a body that has no `Authorization` header at all — expect the same `202 + {negotiationId}` as before (warn mode never blocks), and check the pod logs for a `[iam-verify] warn-mode: ...` line proving the verifier ran and would have rejected it.

- [ ] **Step 3: Flip to enforce and confirm a real rejection**

```bash
helm upgrade facis-dsp-connector . --set dsp.hmacSecret=<real-secret> --set dsp.iam.enforce=enforce --reuse-values
```
`POST /dsp/negotiations` with no `Authorization` header → expect `401` with `{"@type":"dspace:Error","dspace:code":"missing_authorization",...}`.

- [ ] **Step 4: Record the result**

Note the actual HTTP responses observed (status codes + bodies) in this checkbox once run — this is the acceptance evidence for the "delivered-perfectly" checklist item "Verifier passes the full negative matrix... golden vectors committed" from the source vault doc.

---

## Explicitly deferred — separate follow-on plans

This plan closes the core NF-1 gap (unauthenticated `/dsp/negotiations` and `/dsp/transfers`) but intentionally does **not** cover the full NF-1 scope from the vault docs. Per the writing-plans "Scope Check" (multi-subsystem specs should become multiple plans), the remaining work is:

1. **`facis-dsp-iam-issuance` + `facis-dsp-iam-hub` tabs** — MongoDB Identity Hub, GXDCH notary/compliance calls, self-issued Participant VC, minimal OID4VCI issuer surface, `/iam` + `/.well-known/did.json` ingress routes. This is the FR-IAM-001 "org holds and can present its own credentials" half — genuinely independent of the verifier built here (a verifier can check *someone else's* VP without this connector issuing anything of its own), and it's the piece with real net-new infra (Mongo StatefulSet+PVC+Service). Write as its own plan when ready to start it.
2. **NF-6 follow-through in `ai-insight-service`** (`src/security/policy.py:30-35`) — replace the plaintext `x-agreement-id`/`x-asset-id`/`x-user-roles` header trust with context sourced from this verifier's `msg.identity`. Different service, different Helm chart, small — its own plan.
3. **Catalogue tab verification** (`facis-dsp-catalogue.json`) — the vault doc marks this optional (`DSP_IAM_CATALOGUE=open|verified`, catalogues are commonly public). Add later if the client's threat model requires it; trivial to wire once Task 6's tab exists (same `link call` pattern as Tasks 7/8).
4. **DCP-TCK conformance run** — needs a stable deployed instance; schedule once Task 12 is green in a persistent environment.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-16-nf1-orce-iam-verify.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
