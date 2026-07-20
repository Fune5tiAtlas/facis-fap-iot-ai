/* eslint-disable */
//
// state-pg-harness.spec.js — tests the Postgres-backed DSP state tab
// (facis-dsp-state.json) via ../harness/run-node.js, running the committed
// `func` bodies of dsp-state-restore-fn / dsp-persist-{transfers,negotiations}-fn
// against a mock `pg` (and, for the migration case, a mock `fs`) injected
// through opts.libs. The mock Client records every query(sql, params) call
// and returns canned rows keyed by SQL shape; specific shapes can be made to
// reject to exercise the rollback / retry paths.
//
// Restore/persist bodies use this repo's `(async () => {...})().catch(...)`
// convention: the outer node returns null immediately while the real work
// settles on the microtask queue. The harness polls sent/errors; a pure
// context-set success surfaces neither, so we also poll the mock's own state.
//

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runNode } = require('../harness/run-node.js');

const STATE_FLOW = '../flows/facis-dsp-state.json';

// Objects/arrays built inside the vm sandbox carry that realm's prototypes,
// so deepStrictEqual against a spec-side literal trips its reference-equal
// check. Normalise structure through JSON before comparing.
const norm = (v) => JSON.parse(JSON.stringify(v));

function tableOf(sql) {
    const m = sql.match(/(?:FROM|INTO)\s+(\w+)/i);
    return m ? m[1] : null;
}

// Mock pg. `opts`:
//   connectReject   — Client.connect() rejects
//   counts          — { table: n } backing SELECT count(*)
//   rows            — { table: [{id, doc}] } backing SELECT id, doc
//   rejectPrefix    — a SQL prefix (e.g. 'INSERT') whose query() rejects
// `calls` is the shared recording array the test asserts against.
function mockPg(opts, calls) {
    const o = opts || {};
    return {
        Client: class {
            constructor(cfg) { this.cfg = cfg; }
            async connect() {
                if (o.connectReject) throw new Error('connect ECONNREFUSED');
            }
            async query(sql, params) {
                calls.push({ sql: sql.trim(), params });
                const s = sql.trim();
                if (o.rejectPrefix && s.startsWith(o.rejectPrefix)) {
                    throw new Error('mock reject: ' + o.rejectPrefix);
                }
                if (s.startsWith('SELECT count(*)')) {
                    return { rows: [{ n: (o.counts && o.counts[tableOf(s)]) || 0 }] };
                }
                if (s.startsWith('SELECT id, doc')) {
                    return { rows: (o.rows && o.rows[tableOf(s)]) || [] };
                }
                return { rows: [] };
            }
            async end() {}
        }
    };
}

// Poll the mock's recorded calls until `pred` holds or a short deadline
// passes — the success path fires neither node.send nor node.error, so
// runNode's own poll can't observe it for us.
async function settle(calls, pred) {
    const deadline = Date.now() + 2000;
    while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2));
    }
}

const ENV = { DSP_PG_URI: 'postgresql://dsp:pw@dsp-postgres:5432/dsp' };

test('restore creates schema and loads rows into GLOBAL maps', async () => {
    const calls = [];
    const globalCtx = new Map();
    const txDoc1 = { id: 'tp-1', state: 'COMPLETED' };
    const txDoc2 = { id: 'tp-2', state: 'STARTED' };
    const negDoc1 = { id: 'neg-1', state: 'FINALIZED' };
    await runNode(STATE_FLOW, 'dsp-state-restore-fn', {
        env: ENV,
        msg: {},
        globalCtx,
        libs: {
            pg: mockPg({
                counts: { dsp_transfers: 2, dsp_negotiations: 1 },
                rows: {
                    dsp_transfers: [{ id: 'tp-1', doc: txDoc1 }, { id: 'tp-2', doc: txDoc2 }],
                    dsp_negotiations: [{ id: 'neg-1', doc: negDoc1 }]
                }
            }, calls)
        }
    });
    await settle(calls, () => globalCtx.get('transfers') && globalCtx.get('negotiations'));

    const ddl = calls.filter((c) => c.sql.startsWith('CREATE TABLE IF NOT EXISTS'));
    assert.ok(ddl.some((c) => c.sql.includes('dsp_transfers')), 'DDL for dsp_transfers ran');
    assert.ok(ddl.some((c) => c.sql.includes('dsp_negotiations')), 'DDL for dsp_negotiations ran');

    assert.deepEqual(norm(globalCtx.get('transfers')), { 'tp-1': txDoc1, 'tp-2': txDoc2 });
    assert.deepEqual(norm(globalCtx.get('negotiations')), { 'neg-1': negDoc1 });
    // Non-empty tables → migration path skipped entirely.
    assert.equal(calls.some((c) => c.sql.startsWith('INSERT')), false, 'no migration INSERT when tables populated');
});

test('one-time migration imports legacy JSON only when a table is empty', async () => {
    const legacy = {
        '/data/dsp-state/transfers.json': JSON.stringify({
            'tp-a': { id: 'tp-a', state: 'STARTED' },
            'tp-b': { id: 'tp-b', state: 'COMPLETED' }
        }),
        '/data/dsp-state/negotiations.json': JSON.stringify({
            'neg-a': { id: 'neg-a', state: 'REQUESTED' }
        })
    };
    const fsMock = {
        readFileSync: (p) => {
            if (legacy[p]) return legacy[p];
            const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
        }
    };

    // First boot: both tables empty → import + re-select the imported rows.
    const calls1 = [];
    const globalCtx = new Map();
    await runNode(STATE_FLOW, 'dsp-state-restore-fn', {
        env: ENV,
        msg: {},
        globalCtx,
        libs: {
            fs: fsMock,
            pg: mockPg({
                counts: { dsp_transfers: 0, dsp_negotiations: 0 },
                rows: {
                    dsp_transfers: [
                        { id: 'tp-a', doc: { id: 'tp-a', state: 'STARTED' } },
                        { id: 'tp-b', doc: { id: 'tp-b', state: 'COMPLETED' } }
                    ],
                    dsp_negotiations: [{ id: 'neg-a', doc: { id: 'neg-a', state: 'REQUESTED' } }]
                }
            }, calls1)
        }
    });
    await settle(calls1, () => globalCtx.get('transfers') && globalCtx.get('negotiations'));

    const inserts1 = calls1.filter((c) => c.sql.startsWith('INSERT INTO dsp_transfers'));
    assert.equal(inserts1.length, 2, 'one INSERT per legacy transfer');
    assert.deepEqual(norm(inserts1[0].params), ['tp-a', 'STARTED', { id: 'tp-a', state: 'STARTED' }]);
    assert.equal(calls1.filter((c) => c.sql.startsWith('INSERT INTO dsp_negotiations')).length, 1);
    assert.deepEqual(norm(globalCtx.get('transfers')), {
        'tp-a': { id: 'tp-a', state: 'STARTED' },
        'tp-b': { id: 'tp-b', state: 'COMPLETED' }
    });

    // Second boot: tables non-empty → migration must NOT re-import.
    const calls2 = [];
    await runNode(STATE_FLOW, 'dsp-state-restore-fn', {
        env: ENV,
        msg: {},
        globalCtx: new Map(),
        libs: {
            fs: fsMock,
            pg: mockPg({
                counts: { dsp_transfers: 2, dsp_negotiations: 1 },
                rows: { dsp_transfers: [], dsp_negotiations: [] }
            }, calls2)
        }
    });
    await settle(calls2, () => calls2.some((c) => c.sql.startsWith('SELECT id, doc')));
    assert.equal(calls2.some((c) => c.sql.startsWith('INSERT')), false, 'no re-import on non-empty tables');
});

test('persist transfers snapshot replaces the table in one transaction', async () => {
    const calls = [];
    const globalCtx = new Map([['transfers', {
        'tp-1': { id: 'tp-1', state: 'COMPLETED' },
        'tp-2': { id: 'tp-2', state: 'STARTED' }
    }]]);
    await runNode(STATE_FLOW, 'dsp-persist-transfers-fn', {
        env: ENV,
        msg: {},
        globalCtx,
        libs: { pg: mockPg({}, calls) }
    });
    await settle(calls, () => calls.some((c) => c.sql === 'COMMIT'));

    const order = calls.map((c) => c.sql);
    assert.equal(order[0], 'BEGIN');
    assert.equal(order[1], 'DELETE FROM dsp_transfers');
    assert.equal(order[order.length - 1], 'COMMIT');
    const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO dsp_transfers'));
    assert.equal(inserts.length, 2, 'one parameterised INSERT per transfer');
    assert.deepEqual(norm(inserts[0].params), ['tp-1', 'COMPLETED', { id: 'tp-1', state: 'COMPLETED' }]);
});

test('persist failure rolls back and node.errors without throwing out of the node', async () => {
    const calls = [];
    const globalCtx = new Map([['transfers', { 'tp-1': { id: 'tp-1', state: 'STARTED' } }]]);
    const res = await runNode(STATE_FLOW, 'dsp-persist-transfers-fn', {
        env: ENV,
        msg: {},
        globalCtx,
        libs: { pg: mockPg({ rejectPrefix: 'INSERT' }, calls) }
    });
    assert.ok(calls.some((c) => c.sql === 'ROLLBACK'), 'ROLLBACK issued on INSERT failure');
    assert.ok(res.errors.length >= 1, 'node.error called');
    // no COMMIT and no unhandled rejection (runNode resolved cleanly)
    assert.equal(calls.some((c) => c.sql === 'COMMIT'), false);
});

test('restore failure raises a catchable error and leaves populated maps intact', async () => {
    const calls = [];
    const existingTransfers = { 'tp-keep': { id: 'tp-keep', state: 'COMPLETED' } };
    const globalCtx = new Map([['transfers', existingTransfers], ['negotiations', { 'neg-keep': {} }]]);
    const res = await runNode(STATE_FLOW, 'dsp-state-restore-fn', {
        env: ENV,
        msg: {},
        globalCtx,
        libs: { pg: mockPg({ connectReject: true }, calls) }
    });
    assert.ok(res.errors.length >= 1, 'node.error called so the catch→retry loop can fire');
    // Failed restore must not clobber an already-populated map.
    assert.equal(globalCtx.get('transfers'), existingTransfers, 'transfers map untouched');
    assert.deepEqual(norm(globalCtx.get('negotiations')), { 'neg-keep': {} });
});

// Regression guard for the NF-5 global-scope unification: the transfers store
// MUST live in GLOBAL context in every flow, so the Postgres persist/restore
// (which reads/writes global) and the transfers producer + health counters see
// the same map. A flow-scoped `flow.get/set('transfers')` anywhere silently
// splits the store back into per-tab copies — the exact data-loss bug this task
// fixed. Reading the raw files (not the parsed func bodies) also catches a stray
// reference in a doc/info field, which parsed-func tests would miss.
test('no flow-scoped transfers store remains in any DSP flow (must be global)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const flows = ['facis-dsp-transfers.json', 'facis-dsp-health.json'];
    for (const f of flows) {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'flows', f), 'utf8');
        const hits = src.match(/flow\.(get|set)\('transfers'/g) || [];
        assert.equal(hits.length, 0, f + " still has flow-scoped 'transfers': " + JSON.stringify(hits));
    }
});
