/* eslint-disable */
//
// ui-flows.spec.js — NF-13: structural guards for the AI Insight UI ORCE
// flows. Pure flow-JSON assertions (no Node-RED runtime), matching the
// parity-test convention used across the other services.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FLOWS_DIR = path.join(__dirname, '..', '..', 'flows');

function readFlow(name) {
    return JSON.parse(fs.readFileSync(path.join(FLOWS_DIR, name), 'utf8'));
}

test('every UI flow file is a valid Node-RED flow array with a tab', () => {
    for (const file of fs.readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.json'))) {
        const flow = readFlow(file);
        assert.ok(Array.isArray(flow), `${file} must be an array`);
        assert.ok(flow.some((n) => n.type === 'tab'), `${file} must declare a tab`);
        for (const n of flow) {
            assert.ok(n.id, `${file}: every node needs an id`);
            assert.ok(n.type, `${file}: every node needs a type`);
        }
    }
});

test('node ids are unique across the UI flow set (shared ORCE pod safety)', () => {
    const seen = new Map();
    for (const file of fs.readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.json'))) {
        for (const n of readFlow(file)) {
            assert.ok(!seen.has(n.id), `duplicate id ${n.id} in ${file} and ${seen.get(n.id)}`);
            seen.set(n.id, file);
        }
    }
});

test('admin proxy verifies a Keycloak token and requires the admin role (NF-6)', () => {
    const fn = readFlow('admin.json').find((n) => n.id === 'fn_admin_route');
    assert.ok(fn, 'fn_admin_route missing');
    assert.match(fn.func, /userinfo/, 'admin route must verify the caller token via Keycloak');
    assert.match(fn.func, /realm_access/, 'roles must come from the verified token');
    assert.match(fn.func, /admin/, 'admin role gate');
});

test('SPA fallback serves index.html and sets HTML headers', () => {
    const flow = readFlow('spa-fallback.json');
    const httpIn = flow.find((n) => n.type === 'http in');
    assert.equal(httpIn.url, '/aiInsight/*');
    assert.ok(flow.find((n) => n.id === 'fn_spa_set_html_headers'), 'HTML header node missing');
    assert.ok(flow.find((n) => n.type === 'http response'), 'response node missing');
});
