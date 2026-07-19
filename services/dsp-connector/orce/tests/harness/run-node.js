// run-node.js — executes a single `type:"function"` node's REAL `func`
// string, read live from the flow JSON file, inside a vm sandbox built to
// match Node-RED's actual function-node sandbox as closely as this
// codebase has confirmed it (see the session notes referenced in
// iam-verify.spec.js's header: sandbox globals are console, util, Buffer,
// Date, RED, context, flow, global, env, timers, libs — no bare `fetch`,
// no bare `crypto`/`zlib` unless the node's own `libs` array declares
// them, exactly like the real ORCE pod).
//
// This exists to close a specific, previously-confirmed gap: every other
// *.spec.js file in this directory hand-copies a node's `func` body into
// the spec file itself ("mirrored logic"), which means a real edit to the
// flow JSON can silently drift from its test without any test failing —
// this is exactly how several live-only bugs shipped this session (wrong
// require() target, missing libs entry, a msg.payload-clobbering bug) and
// were only caught by manual live testing after deploy, never by CI.
// Reading `func` directly from the JSON at test time makes that class of
// drift structurally impossible for any node tested this way: there is no
// second copy of the logic to fall out of sync.
//
// Scope, honestly: this executes ONE function node in isolation, given a
// fixture `msg` and fixture `env`/`global`/`flow` context — it does not
// boot a real Node-RED runtime, does not route HTTP-in triggers, and does
// not walk `link call`/wire chains automatically. A node whose body
// dispatches to a downstream `http request` node (by setting `msg.url`
// and returning) is exercised only up to that boundary; the fixture
// caller is responsible for feeding the *next* node its expected input,
// the same way iam-verify-golden.spec.js already chains multi-stage
// fixtures for the hand-mirrored nodes. This is a deliberate, scoped
// middle ground: eliminates hand-copy drift for the part of this codebase
// that has actually caused bugs (business logic in function-node bodies),
// without attempting a full embedded-Node-RED-runtime harness in one
// sitting.

const vm = require('vm');
const util = require('util');
const path = require('path');

function loadFlow(flowPath) {
    // Fresh parse every call (not require()'s cached module) so a test
    // that mutates the returned array never leaks state into another
    // test's read of the same file.
    const fs = require('fs');
    return JSON.parse(fs.readFileSync(flowPath, 'utf8'));
}

function getNode(flowJson, nodeId) {
    const n = flowJson.find((x) => x.id === nodeId);
    if (!n) throw new Error('run-node: no node with id "' + nodeId + '" in this flow file');
    if (n.type !== 'function') throw new Error('run-node: node "' + nodeId + '" is type "' + n.type + '", not "function" — only function nodes are supported');
    return n;
}

// Builtins resolve directly (crypto, zlib, buffer); everything else
// resolves against this test package's own node_modules — kept in
// lockstep with the ORCE pod's init-deps PKGS list via package.json
// devDependencies, not a separate copy to fall out of sync.
function resolveLib(moduleName) {
    return require(moduleName);
}

/**
 * Run one function node's real `func` body from a flow JSON file.
 *
 * @param {string} flowPath - absolute or relative path to the flow JSON file
 * @param {string} nodeId - the node's id
 * @param {object} opts
 * @param {object} opts.msg - the input msg object
 * @param {object} [opts.env] - plain object backing env.get(key)
 * @param {Map} [opts.globalCtx] - Map backing global.get/set (shared across calls if reused)
 * @param {Map} [opts.flowCtx] - Map backing flow.get/set
 * @returns {Promise<{result: any, sent: any[], warnings: string[], errors: any[], node: object}>}
 *   `result` is the function body's own top-level return value (the
 *   `return msg;` / `return [a,b];` style some nodes use). `sent` collects
 *   every node.send(...) call, in order, flattened one level (a
 *   node.send([a,b]) push a SINGLE entry that is itself the [a,b] array,
 *   matching Node-RED's own multi-output send semantics — callers check
 *   sent[0] for the first send call's payload). A node using the
 *   `(async () => {...})(); return;` pattern (this repo's convention for
 *   any node with an await inside) will have `result` be `undefined` and
 *   the real output in `sent`.
 */
async function runNode(flowPath, nodeId, opts) {
    const flowJson = loadFlow(path.resolve(flowPath));
    const node = getNode(flowJson, nodeId);

    const msg = (opts && opts.msg) || {};
    const env = (opts && opts.env) || {};
    const globalCtx = (opts && opts.globalCtx) || new Map();
    const flowCtx = (opts && opts.flowCtx) || new Map();

    // opts.libs lets a test inject a stub for a node's declared lib var
    // instead of the real module — required for nodes whose libs resolve to
    // a native/uninstalled dependency (e.g. dsp-tx-kafka-admin's node-rdkafka),
    // which would otherwise throw at require() time and be untestable here.
    const libOverride = (opts && opts.libs) || {};
    const libs = {};
    for (const l of node.libs || []) {
        libs[l.var] = Object.prototype.hasOwnProperty.call(libOverride, l.var)
            ? libOverride[l.var]
            : resolveLib(l.module);
    }

    const sent = [];
    const warnings = [];
    const errors = [];

    const nodeApi = {
        send: (m) => { sent.push(m); },
        warn: (m) => { warnings.push(m); },
        error: (m, m2) => { errors.push(m); },
        status: () => {},
        log: () => {}
    };
    const envApi = { get: (k) => (Object.prototype.hasOwnProperty.call(env, k) ? env[k] : undefined) };
    const globalApi = {
        get: (k) => globalCtx.get(k),
        set: (k, v) => { globalCtx.set(k, v); }
    };
    const flowApi = {
        get: (k) => flowCtx.get(k),
        set: (k, v) => { flowCtx.set(k, v); }
    };
    const contextApi = { get: () => undefined, set: () => {} };

    const sandbox = {
        msg,
        node: nodeApi,
        env: envApi,
        global: globalApi,
        flow: flowApi,
        context: contextApi,
        console,
        util,
        Buffer,
        Date,
        timers: { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate },
        RED: { util: { cloneMessage: (m) => JSON.parse(JSON.stringify(m)) } },
        ...libs
    };

    const context = vm.createContext(sandbox);
    // Wrapping the whole func body in one more async IIFE is safe for
    // both this repo's function-node conventions: a plain top-level
    // `return msg;` becomes this IIFE's own return value (captured
    // below as `result`); a node that already wraps itself in
    // `(async () => {...})(); return;` just has its own inner IIFE
    // execute inside this outer one and communicates via node.send()
    // (captured in `sent`), with the outer IIFE's own return value
    // simply undefined — exactly like the real Node-RED runtime, which
    // also does not care which style a function node uses.
    const script = new vm.Script('(async () => {\n' + node.func + '\n})()', { filename: nodeId + '.func.js' });
    const resultPromise = script.runInContext(context);
    const result = await resultPromise;

    // This repo's convention (see iam-verify.spec.js's header) is that
    // any function node with an internal await wraps itself in its OWN
    // async IIFE and returns synchronously WITHOUT awaiting it — the
    // function node itself finishes immediately (`return null;` or
    // `return;`, so `result` here is null/undefined) while node.send()
    // fires later, once that inner IIFE's own promise chain settles. The
    // wrapper above only awaits the OUTER return, so on first return here
    // `sent` may still be empty even though a send is already in flight.
    // Poll briefly rather than assume synchronous completion; real crypto
    // ops (jose) settle in low single-digit milliseconds, so 2s is a
    // generous ceiling, not a real expected wait. `result == null` (loose)
    // deliberately catches both — a node that legitimately returns `false`
    // or `0` isn't using this pattern and shouldn't be held up waiting.
    if (result == null && sent.length === 0 && errors.length === 0) {
        // 5s, not 2s: dsp-iam-issuance-vc-fn's real code path includes a
        // best-effort jsonld.expand() call that resolves remote JSON-LD
        // @context documents over the actual network (matching production
        // — see that node's own comment on why this is non-fatal/logged,
        // not mocked here). A slow real network hop under this deadline
        // reads as a flaky test failure, not a bug in the node under test.
        const deadline = Date.now() + 5000;
        while (sent.length === 0 && errors.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
    }

    return { result, sent, warnings, errors, node };
}

module.exports = { runNode, loadFlow, getNode };
