"use strict";

// Mirror of the PolicyAndRateLimit function nodes in
// flows/ai-insight-{anomaly,city-status,energy-summary}.json (NF-6 model:
// identity comes from the verified token, never from request headers).

function toBool(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    const lowered = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lowered)) return true;
    if (["false", "0", "no", "off"].includes(lowered)) return false;
    return fallback;
}

function parseList(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
        // ignore and use fallback
    }
    return fallback;
}

function forbidden(detail) {
    return { decision: "forbidden", statusCode: 403, payload: { detail } };
}

function evaluatePolicyAndRateLimit(options = {}) {
    const {
        headers = {},
        identity = null,
        authMode = "enforce",
        authRejected = false,
        env = {},
        buckets = {},
        nowMs = Date.now(),
    } = options;

    if (authRejected) {
        return { decision: "unauthorized", statusCode: 401 };
    }

    const getEnv = (key) => env[key];
    const pickHeader = (name) => headers[String(name || "").toLowerCase()];

    const policyEnabled = toBool(getEnv("AI_INSIGHT_POLICY__ENABLED"), true);
    const agreementHeader = getEnv("AI_INSIGHT_POLICY__AGREEMENT_HEADER") || "x-agreement-id";
    const assetHeader = getEnv("AI_INSIGHT_POLICY__ASSET_HEADER") || "x-asset-id";
    const requiredRoles = parseList(getEnv("AI_INSIGHT_POLICY__REQUIRED_ROLES"), ["ai_insight_consumer"]);
    const allowedAgreements = parseList(getEnv("AI_INSIGHT_POLICY__ALLOWED_AGREEMENT_IDS"), []);
    const allowedAssets = parseList(getEnv("AI_INSIGHT_POLICY__ALLOWED_ASSET_IDS"), []);

    const agreementId = String(pickHeader(agreementHeader) || "").trim();
    const assetId = String(pickHeader(assetHeader) || "").trim();

    let roles;
    if (String(authMode).toLowerCase() === "off") {
        const roleHeader = getEnv("AI_INSIGHT_POLICY__ROLE_HEADER") || "x-user-roles";
        const rawRoles = String(pickHeader(roleHeader) || "").trim();
        roles = rawRoles ? rawRoles.split(",").map((item) => item.trim()).filter(Boolean) : [];
    } else {
        roles = (identity && Array.isArray(identity.roles)) ? identity.roles : [];
    }

    if (policyEnabled) {
        if (!agreementId || !assetId) {
            return forbidden("Missing required governance headers");
        }
        const missingRole = requiredRoles.find((role) => !roles.includes(role));
        if (missingRole) {
            return forbidden("Policy denied: missing required role " + missingRole);
        }
        if (allowedAgreements.length > 0 && !allowedAgreements.includes(agreementId)) {
            return forbidden("Policy denied for agreement_id");
        }
        if (allowedAssets.length > 0 && !allowedAssets.includes(assetId)) {
            return forbidden("Policy denied for asset_id");
        }
    }

    const rateLimitEnabled = toBool(getEnv("AI_INSIGHT_RATE_LIMIT__ENABLED"), true);
    const rpm = Math.max(1, Number(getEnv("AI_INSIGHT_RATE_LIMIT__REQUESTS_PER_MINUTE") || 10));
    const subject = (identity && identity.sub) || "anonymous";
    const limiterKey = subject + "|" + (agreementId || "unknown-agreement");

    if (rateLimitEnabled) {
        const windowMs = 60 * 1000;
        let bucket = buckets[limiterKey];
        if (!bucket || nowMs - bucket.windowStart >= windowMs) {
            bucket = { windowStart: nowMs, count: 0 };
        }
        if (bucket.count >= rpm) {
            const retryAfter = Math.max(1, Math.ceil((bucket.windowStart + windowMs - nowMs) / 1000));
            buckets[limiterKey] = bucket;
            return {
                decision: "rate_limited",
                statusCode: 429,
                retryAfter,
                payload: { detail: "Agreement rate limit exceeded" },
            };
        }
        bucket.count += 1;
        buckets[limiterKey] = bucket;
    }

    return {
        decision: "ok",
        limiterKey,
        accessContext: {
            agreement_id: agreementId || "unknown-agreement",
            asset_id: assetId || "unknown-asset",
            roles,
            subject,
        },
    };
}

module.exports = { evaluatePolicyAndRateLimit };
