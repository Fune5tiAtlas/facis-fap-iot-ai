"use strict";

// Mirror of the token-verify pipeline in flows/ai-insight-auth.json
// (prep + jose.jwtVerify), for parity testing with real signed JWTs.

const jose = require("jose");

function authError(code, detail) {
    return {
        authRejected: true,
        statusCode: 401,
        wwwAuthenticate: 'Bearer error="' + code + '"',
        code,
        payload: { detail },
    };
}

async function verifyBearer(options = {}) {
    const {
        authorization = "",
        jwks = { keys: [] },
        issuer,
        audience = null,
        mode = "enforce",
    } = options;

    if (String(mode).toLowerCase() === "off") {
        return { authRejected: false, identity: null, mode: "off" };
    }

    const m = /^Bearer\s+(.+)$/i.exec(String(authorization).trim());
    if (!m) {
        return authError("missing_authorization", "Authorization: Bearer <access token> is required");
    }
    const token = m[1];

    let header;
    let payload;
    try {
        const parts = token.split(".");
        if (parts.length !== 3) throw new Error("not a JWS");
        header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch (_) {
        return authError("invalid_token", "malformed bearer token");
    }

    if (payload.iss !== issuer) {
        return authError("invalid_token", "unexpected token issuer");
    }

    const jwk = (jwks.keys || []).find((k) => !header.kid || k.kid === header.kid);
    if (!jwk) {
        return authError("invalid_token", "unknown signing key");
    }

    try {
        const key = await jose.importJWK(jwk, jwk.alg || "RS256");
        const opts = { issuer, clockTolerance: 5 };
        if (audience) opts.audience = audience;
        const verified = await jose.jwtVerify(token, key, opts);
        const claims = verified.payload;
        const roles = (claims.realm_access && Array.isArray(claims.realm_access.roles))
            ? claims.realm_access.roles
            : [];
        return {
            authRejected: false,
            identity: {
                sub: claims.sub || null,
                username: claims.preferred_username || null,
                client: claims.azp || null,
                roles,
            },
        };
    } catch (e) {
        if (e && e.code === "ERR_JWT_EXPIRED") {
            return authError("token_expired", "access token expired");
        }
        if (e && e.code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
            return authError("invalid_token", "token claim validation failed: " + (e.claim || "unknown"));
        }
        return authError("invalid_token", "token signature verification failed");
    }
}

module.exports = { verifyBearer };
