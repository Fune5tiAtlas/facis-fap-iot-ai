"use strict";

// NF-6: token verification parity (real signed JWTs via jose) plus flow-JSON
// guards ensuring every data endpoint is wired through the shared verifier.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jose = require("jose");
const { verifyBearer } = require("./helpers/auth-verify");

const ISSUER = "https://identity.facis.cloud/realms/facis";
const KID = "test-key-1";

let signingKey;
let jwks;
let rogueKey;

test.before(async () => {
    const pair = await jose.generateKeyPair("RS256");
    signingKey = pair.privateKey;
    const publicJwk = await jose.exportJWK(pair.publicKey);
    publicJwk.kid = KID;
    publicJwk.alg = "RS256";
    jwks = { keys: [publicJwk] };

    const roguePair = await jose.generateKeyPair("RS256");
    rogueKey = roguePair.privateKey;
});

async function sign(claims = {}, { key = null, expiresIn = "5m", kid = KID } = {}) {
    return new jose.SignJWT({
        realm_access: { roles: ["ai_insight_consumer"] },
        preferred_username: "svc-facis-orce",
        azp: "facis-orce",
        ...claims,
    })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(claims.iss || ISSUER)
        .setSubject(claims.sub || "svc-account-1")
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(key || signingKey);
}

test("valid token yields identity with realm_access roles", async () => {
    const token = await sign();
    const result = await verifyBearer({ authorization: `Bearer ${token}`, jwks, issuer: ISSUER });
    assert.equal(result.authRejected, false);
    assert.equal(result.identity.sub, "svc-account-1");
    assert.deepEqual(result.identity.roles, ["ai_insight_consumer"]);
});

test("missing Authorization header -> 401 missing_authorization", async () => {
    const result = await verifyBearer({ authorization: "", jwks, issuer: ISSUER });
    assert.equal(result.authRejected, true);
    assert.equal(result.statusCode, 401);
    assert.equal(result.code, "missing_authorization");
});

test("expired token -> 401 token_expired (QA test 7 semantics)", async () => {
    const token = await sign({}, { expiresIn: "-2m" });
    const result = await verifyBearer({ authorization: `Bearer ${token}`, jwks, issuer: ISSUER });
    assert.equal(result.authRejected, true);
    assert.equal(result.statusCode, 401);
    assert.equal(result.code, "token_expired");
});

test("token signed by an untrusted key -> 401 invalid_token", async () => {
    const token = await sign({}, { key: rogueKey });
    const result = await verifyBearer({ authorization: `Bearer ${token}`, jwks, issuer: ISSUER });
    assert.equal(result.authRejected, true);
    assert.equal(result.code, "invalid_token");
});

test("wrong issuer -> 401 invalid_token", async () => {
    const token = await sign({ iss: "https://evil.example/realms/facis" });
    const result = await verifyBearer({ authorization: `Bearer ${token}`, jwks, issuer: ISSUER });
    assert.equal(result.authRejected, true);
    assert.equal(result.code, "invalid_token");
});

test("malformed bearer token -> 401 invalid_token", async () => {
    const result = await verifyBearer({ authorization: "Bearer not.a.jwt.at.all", jwks, issuer: ISSUER });
    assert.equal(result.authRejected, true);
    assert.equal(result.code, "invalid_token");
});

test("unknown kid -> 401 invalid_token", async () => {
    const token = await sign({}, { kid: "other-key" });
    const result = await verifyBearer({ authorization: `Bearer ${token}`, jwks, issuer: ISSUER });
    assert.equal(result.authRejected, true);
    assert.equal(result.code, "invalid_token");
});

test("mode off returns null identity without rejecting (dev only)", async () => {
    const result = await verifyBearer({ authorization: "", jwks, issuer: ISSUER, mode: "off" });
    assert.equal(result.authRejected, false);
    assert.equal(result.identity, null);
});

// ---- flow-JSON guards ----

function readFlow(name) {
    const p = path.join(__dirname, "..", "..", "flows", name);
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

const INSIGHT_FLOWS = [
    "ai-insight-anomaly.json",
    "ai-insight-city-status.json",
    "ai-insight-energy-summary.json",
];

test("auth flow: verifier uses jose via libs and returns via link out", () => {
    const flow = readFlow("ai-insight-auth.json");
    const verify = flow.find((n) => n.id === "fn_auth_verify");
    assert.deepEqual(verify.libs, [{ var: "jose", module: "jose" }]);
    const ret = flow.find((n) => n.id === "aiinsight_auth_return");
    assert.equal(ret.mode, "return");
    const prep = flow.find((n) => n.id === "fn_auth_prep");
    assert.match(prep.func, /AI_INSIGHT_AUTH__MODE.*\|\|\s*'enforce'/);
    assert.match(prep.func, /WWW-Authenticate/);
});

test("every insight POST flow calls the shared verifier before policy", () => {
    for (const name of INSIGHT_FLOWS) {
        const flow = readFlow(name);
        const call = flow.find((n) => n.type === "link call");
        assert.ok(call, `${name}: link call missing`);
        assert.deepEqual(call.links, ["aiinsight_auth_verify_in"]);
    }
});

test("policy nodes never read roles from headers outside the dev-off branch", () => {
    for (const name of INSIGHT_FLOWS) {
        const flow = readFlow(name);
        const policy = flow.find((n) => n.type === "function" && (n.name || "") === "PolicyAndRateLimit");
        assert.ok(policy, `${name}: policy node missing`);
        assert.match(policy.func, /if \(msg\.authRejected\)/);
        assert.match(policy.func, /msg\.identity && Array\.isArray\(msg\.identity\.roles\)/);
        const offBranch = policy.func.indexOf("authMode === 'off'");
        const roleHeaderRead = policy.func.indexOf("AI_INSIGHT_POLICY__ROLE_HEADER");
        assert.ok(offBranch !== -1 && roleHeaderRead > offBranch,
            `${name}: role header may only be read inside the off branch`);
        assert.match(policy.func, /subject \+ '\|' \+ \(agreementId/);
    }
});

test("GET /latest and /outputs are gated behind the verifier", () => {
    for (const [name, httpInId] of [
        ["ai-insight-latest.json", "http_in_insights_latest_v1"],
        ["ai-insight-outputs.json", "http_in_output_by_id_v1"],
    ]) {
        const flow = readFlow(name);
        const httpIn = flow.find((n) => n.id === httpInId);
        const call = flow.find((n) => n.type === "link call");
        assert.ok(call, `${name}: link call missing`);
        assert.deepEqual(httpIn.wires, [[call.id]], `${name}: http in must feed the verifier`);
        const gate = flow.find((n) => (n.name || "") === "RequireVerifiedRole");
        assert.ok(gate, `${name}: gate node missing`);
        assert.match(gate.func, /msg\.authRejected/);
    }
});

test("openapi spec declares bearerAuth and no x-user-roles parameter", () => {
    const flow = readFlow("ai-insight-openapi.json");
    const fn = flow.find((n) => n.type === "function" && (n.func || "").includes("apiSpec"));
    assert.match(fn.func, /bearerAuth/);
    assert.match(fn.func, /Error401/);
    assert.doesNotMatch(fn.func, /UserRolesHeader/);
});
