# Verified-Token Authorization (NF-6)

Closure of QA follow-up **NF-6** ("the policy layer reads agreement ID, asset
ID and roles from client-supplied request headers"): identity now derives
exclusively from a **cryptographically verified Keycloak access token**.
Client-supplied `x-user-roles` headers are never consulted.

## Model

```
caller ── Authorization: Bearer <JWT> ──▶ ai-insight endpoint (ORCE)
                                             │ link call
                                             ▼
                                   ai-insight-auth (shared verifier)
                                   • Bearer extract, issuer check
                                   • JWKS fetch (Keycloak /certs, cached)
                                   • jose.jwtVerify: signature, exp, iss
                                   • identity = { sub, roles: realm_access.roles }
                                             │
                                             ▼
                                   PolicyAndRateLimit
                                   • roles ← verified identity (never headers)
                                   • agreement/asset = request scope (headers),
                                     checked against allow-lists
                                   • rate limit keyed by sub|agreement
```

- **401 + `WWW-Authenticate: Bearer`** — missing, malformed, expired, wrong
  issuer, or wrongly signed token (authentication). Expired tokens return
  **401**, per QA requirement-set item on test 7.
- **403** — verified caller lacking `ai_insight_consumer` (or the configured
  required roles), or agreement/asset outside the allow-lists (authorization).
- **429 + `Retry-After`** — per-subject-per-agreement window exceeded. The
  bucket key is the **verified `sub`**, so a spoofed `x-agreement-id` can no
  longer evade or pollute another caller's window.
- **503** — JWKS endpoint unreachable (fail closed; requests are never
  admitted unverified).

Guarded endpoints: the three insight POSTs, plus `GET /api/v1/insights/latest`
and `GET /api/ai/outputs/{output_id}` (previously unauthenticated).

## Configuration (ORCE pod env)

| Env var | Default | Purpose |
|---|---|---|
| `AI_INSIGHT_AUTH__MODE` | `enforce` | `off` = dev-only legacy header roles (logs a warning) |
| `AI_INSIGHT_AUTH__ISSUER` | `FACIS_KEYCLOAK_URL` (`https://identity.facis.cloud/realms/facis`) | Expected `iss` |
| `AI_INSIGHT_AUTH__JWKS_URL` | `<issuer>/protocol/openid-connect/certs` | Key material |
| `AI_INSIGHT_AUTH__AUDIENCE` | unset | Optional `aud` check |
| `AI_INSIGHT_AUTH__JWKS_TTL_SECONDS` | `300` | JWKS cache TTL |

Deploy prerequisite: legitimate consumers (dashboards, service accounts) must
present a token from realm `facis` whose `realm_access.roles` includes
`ai_insight_consumer` — assign the realm role to the relevant Keycloak
clients/service accounts. The old `x-user-roles` header is ignored; the
`x-agreement-id` / `x-asset-id` headers remain as **request scope** only.

## Live-session evidence (QA tests 14 / 15 / 29)

```bash
BASE=https://<orce-host>
BODY='{"start_ts":"2026-07-01T00:00:00Z","end_ts":"2026-07-02T00:00:00Z"}'

# 1. Header-injection attempt (test 29, NF-6 demonstration):
#    forged roles, no token -> 401 + WWW-Authenticate, no data returned.
curl -si -X POST "$BASE/api/v1/insights/anomaly-report" \
  -H 'Content-Type: application/json' \
  -H 'x-agreement-id: agreement-1' -H 'x-asset-id: asset-7' \
  -H 'x-user-roles: ai_insight_consumer,admin' \
  -d "$BODY" | head -5

# 2. Header injection WITH a valid token lacking the role -> 403
#    (proves the forged header is ignored even for authenticated callers).
TOKEN_NOROLE=$(curl -s "$KC/protocol/openid-connect/token" -d 'grant_type=password' \
  -d "client_id=$CID" -d "client_secret=$CSEC" -d "username=$USER_NO_ROLE" \
  -d "password=$PASS" | jq -r .access_token)
curl -si -X POST "$BASE/api/v1/insights/anomaly-report" \
  -H "Authorization: Bearer $TOKEN_NOROLE" \
  -H 'Content-Type: application/json' \
  -H 'x-agreement-id: agreement-1' -H 'x-asset-id: asset-7' \
  -H 'x-user-roles: ai_insight_consumer' \
  -d "$BODY" | head -5

# 3. Authorized retrieval (tests 14/15): token whose realm_access.roles
#    includes ai_insight_consumer -> 200 with insight data.
curl -si -X POST "$BASE/api/v1/insights/anomaly-report" \
  -H "Authorization: Bearer $TOKEN_CONSUMER" \
  -H 'Content-Type: application/json' \
  -H 'x-agreement-id: agreement-1' -H 'x-asset-id: asset-7' \
  -d "$BODY" | head -5

# 4. Expired token -> 401 token_expired (test 7 semantics).
curl -si "$BASE/api/v1/insights/latest" -H "Authorization: Bearer $EXPIRED" | head -5

# 5. Previously-open GET endpoints now refuse anonymous access.
curl -si "$BASE/api/v1/insights/latest" | head -3
curl -si "$BASE/api/ai/outputs/some-id" | head -3
```

## CI evidence

`services/ai-insight-service/orce/tests/flows/auth.spec.js` (token
verification with real RS256-signed JWTs: valid, expired, forged signature,
wrong issuer, unknown kid, malformed) and `policy-rate-limit.spec.js`
(header-injection rejection, 401 pass-through, allow-lists, subject-keyed
rate limiting). Flow-JSON guards pin the wiring: every data endpoint calls
the shared verifier, and the policy nodes read roles only from
`msg.identity`.

Run: `npm run test:flows` in `services/ai-insight-service/orce`.
