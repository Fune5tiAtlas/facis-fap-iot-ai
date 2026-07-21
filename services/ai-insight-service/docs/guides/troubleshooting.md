# Troubleshooting Guide

**Project:** FACIS FAP IoT & AI — AI Insight Service  
**Version:** 0.1.0  
**Date:** 05 April 2026

---

## 1. LLM Connection Failures

### Problem: HTTP 401 (Unauthorized)

**The symptom:** Requests return 500 with `LLMClientError` mentioning "status 401" in logs.

**The cause:** The LLM provider rejected the request because the API key is missing or invalid. The client builds an `Authorization: Bearer <api_key>` header from `LLM_API_KEY` env var. If missing or wrong, the provider returns 401.

**The fix:**
1. Verify the env var is set: `echo $AI_INSIGHT_LLM__API_KEY`
2. If empty, set it: `export AI_INSIGHT_LLM__API_KEY="your-api-key"`
3. Verify with the provider that the key is valid and not expired
4. Restart the service

**Expected result:** Requests proceed to the LLM without 401 errors. The insight response is generated or falls back cleanly if the LLM produces other errors.

---

### Problem: HTTP 429 (Rate Limit from Provider)

**The symptom:** Requests occasionally fail with `LLMRateLimitError` in logs. Response includes no insight data.

**The cause:** The LLM provider has rate limits (requests per minute or per second). When the limit is exceeded, the provider returns HTTP 429. The client implements automatic retry with exponential backoff (base delay: 0.5s, max delay: 8s, default max 3 retries). If all retries fail, it raises `LLMRateLimitError`.

**The fix:**
1. Check provider rate limits (e.g., OpenAI tiered limits based on subscription)
2. Increase max retries: `export AI_INSIGHT_LLM__MAX_RETRIES=5`
3. Increase retry base delay: `export AI_INSIGHT_LLM__RETRY_BASE_DELAY_SECONDS=1.0`
4. If this persists, contact your LLM provider about upgrading your rate limit tier
5. Use Redis cache to reduce redundant LLM calls: enable `AI_INSIGHT_CACHE__ENABLED=true`

**Expected result:** Retries succeed before max_retries is exhausted. Insights are generated without client-side rate limit errors.

---

### Problem: HTTP Timeout

**The symptom:** Requests hang for 30+ seconds, then fail with `LLMUpstreamError` mentioning "failed after N attempts".

**The cause:** The LLM service is slow to respond or unreachable. By default, each request waits 30 seconds (`timeout_seconds=30`). After timeout, the client retries. If all retries timeout, it raises `LLMUpstreamError`.

**The fix:**
1. Check LLM service status with the provider
2. Check network connectivity: `curl -v <LLM_CHAT_COMPLETIONS_URL> --timeout 5`
3. Increase timeout if the service is legitimately slow: `export AI_INSIGHT_LLM__TIMEOUT_SECONDS=60`
4. Check logs for DNS resolution issues: `nslookup <api.hostname>`

**Expected result:** Requests complete within timeout window. If the LLM is down, fallback logic provides a result.

---

### Problem: Invalid or Missing chat_completions_url

**The symptom:** Service fails to start with `LLMClientError: LLM chat_completions_url is required`.

**The cause:** The config does not include a `chat_completions_url`. This is required to send requests to the LLM endpoint.

**The fix:**
1. Set the env var: `export AI_INSIGHT_LLM__CHAT_COMPLETIONS_URL="https://api.openai.com/v1/chat/completions"`
2. Restart the service

**Expected result:** Service starts and LLM requests are sent to the configured endpoint.

---

### Problem: HTTPS Enforcement Failure

**The symptom:** Service fails with `LLMClientError: LLM chat_completions_url must use https`.

**The cause:** By default, the client requires HTTPS for security. If the configured URL uses `http://`, the client rejects it.

**The fix:**
1. Use an HTTPS endpoint: `export AI_INSIGHT_LLM__CHAT_COMPLETIONS_URL="https://..."`
2. If testing locally with `http://`, disable HTTPS requirement: `export AI_INSIGHT_LLM__REQUIRE_HTTPS=false`

**Expected result:** Requests proceed with secure (or test-allowed) endpoints.

---

## 2. Trino Authentication Errors

### Problem: OIDC Token Exchange Failure

**The symptom:** Service fails to connect to Trino with error "OIDC token response does not include access_token" or "Trino OIDC password flow requires...".

**The cause:** The token endpoint rejected the credentials (wrong username, password, client_id, or client_secret). The client calls the OIDC token endpoint with a password grant (`grant_type=password`) and extracts the `access_token` field. If the response doesn't include `access_token`, it fails.

**The fix:**
1. Verify all OIDC credentials are set:
   - `TRINO_OIDC_TOKEN_URL` — OIDC token endpoint (e.g., Keycloak)
   - `TRINO_OIDC_CLIENT_ID` — OIDC client identifier
   - `TRINO_OIDC_CLIENT_SECRET` — OIDC client secret
   - `TRINO_OIDC_USERNAME` — Trino username
   - `TRINO_OIDC_PASSWORD` — Trino password
2. Test the token endpoint manually:
   ```bash
   curl -X POST \
     -d "grant_type=password&client_id=<id>&client_secret=<secret>&username=<user>&password=<pass>" \
     <OIDC_TOKEN_URL>
   ```
   Look for `"access_token"` in the response.
3. If the token endpoint returns an error, check credentials with your identity provider
4. Restart the service

**Expected result:** OIDC token is obtained successfully. Trino queries proceed with JWT authentication.

---

### Problem: Expired Token

**The symptom:** After working for hours, Trino queries start failing with "JWT token is expired" or similar auth error.

**The cause:** OIDC tokens have expiration times (typically 1 hour). The client fetches a fresh token on each Trino connection attempt, but if the service caches the connection, it may reuse an expired token.

**The fix:**
1. Check Trino connection caching (should be minimal for token-based auth)
2. Ensure token refresh happens on each Trino query attempt
3. Restart the service to clear any stale connections
4. Increase OIDC token TTL with your identity provider if possible

**Expected result:** Fresh tokens are obtained on each connection. Trino queries continue working over extended periods.

---

### Problem: CA Certificate Verification Failure

**The symptom:** OIDC token request fails with "SSL: CERTIFICATE_VERIFY_FAILED" or "certificate verify failed".

**The cause:** The OIDC token endpoint uses HTTPS with a certificate (self-signed or internal CA). The client verifies the certificate by default. If the CA certificate is not in the system trust store, verification fails.

**The fix:**
1. Provide the CA certificate path:
   ```bash
   export TRINO_OIDC_VERIFY="/path/to/ca.crt"
   ```
2. Or disable verification (test only):
   ```bash
   export TRINO_OIDC_VERIFY=false
   ```
3. Verify the path exists: `ls -la /path/to/ca.crt`
4. Restart the service

**Expected result:** Token endpoint requests succeed with proper certificate validation.

---

## 3. Policy Enforcement Issues

### Problem: Missing X-Agreement-Id or X-Asset-Id Header

**The symptom:** Request returns 403 Forbidden with `detail: "Missing agreement identifier"` or `"Missing asset identifier"`.

**The cause:** Policy enforcement is enabled (default). The client must provide `X-Agreement-Id` and `X-Asset-Id` headers. These identify the subscription and asset being accessed. If missing, the request is denied.

**The fix:**
1. Add headers to the request:
   ```bash
   curl -H "X-Agreement-Id: agreement-001" \
        -H "X-Asset-Id: asset-123" \
        -H "X-User-Roles: ai_insight_consumer" \
        http://localhost:8080/api/v1/insights/anomaly-report
   ```
2. If you don't have an agreement ID, contact your administrator
3. Or disable policy enforcement (development only): `export AI_INSIGHT_POLICY__ENABLED=false`

**Expected result:** Request includes all required headers. Policy check passes and insight is generated.

---

### Problem: Missing Required Role

**The symptom:** Request returns 403 Forbidden with `detail: "Missing required role"`.

**The cause:** The client did not include the `X-User-Roles` header, or the header doesn't include the required role. By default, `ai_insight_consumer` is required.

**The fix:**
1. Add the role header with the consumer role:
   ```bash
   curl -H "X-User-Roles: ai_insight_consumer" ...
   ```
2. If you have a different role (e.g., `ai_admin`), check the allowed roles:
   - `echo $AI_INSIGHT_POLICY__REQUIRED_ROLES`
   - If empty, default is `["ai_insight_consumer"]`
3. Add your role to the allowed list: `export AI_INSIGHT_POLICY__REQUIRED_ROLES="ai_insight_consumer,ai_admin"`

**Expected result:** Request includes the required role. Policy check passes.

---

### Problem: Role Not in Allow-List

**The symptom:** Request returns 403 Forbidden with `detail: "Missing required role"`, even with `X-User-Roles` set.

**The cause:** The header includes a role (e.g., `user`), but it's not in the configured `required_roles` list. The policy checks: is there any intersection between `required_roles` and the roles in the header? If not, access is denied.

**The fix:**
1. Check the configured required roles:
   ```bash
   grep -r "required_roles" config/
   ```
2. Ensure your role is in that list
3. Or add it: `export AI_INSIGHT_POLICY__REQUIRED_ROLES="ai_insight_consumer"`

**Expected result:** Your role is in the allow-list. Request proceeds.

---

### Problem: Agreement Not in Allow-List

**The symptom:** Request returns 403 Forbidden with `detail: "Agreement is not authorized"`.

**The cause:** An allow-list of specific agreement IDs is configured (via `allowed_agreement_ids`). The request's `X-Agreement-Id` is not in that list.

**The fix:**
1. Check if allow-list is configured:
   ```bash
   echo $AI_INSIGHT_POLICY__ALLOWED_AGREEMENT_IDS
   ```
2. If this is set and your agreement ID is missing, add it:
   ```bash
   export AI_INSIGHT_POLICY__ALLOWED_AGREEMENT_IDS="agreement-1,agreement-2,agreement-3"
   ```
3. If the list is empty or unset, this restriction is not active

**Expected result:** Your agreement ID is in the allow-list. Request proceeds.

---

## 4. Rate Limiting

### Problem: HTTP 429 (Too Many Requests)

**The symptom:** After some requests succeed, subsequent requests return 429 "Rate limit exceeded" with a `Retry-After` header.

**The cause:** The service implements per-agreement rate limiting (default: 10 requests/minute). The limiter tracks requests in a sliding 60-second window per agreement ID. When a new request arrives, if the agreement already has 10 requests in the past 60 seconds, the request is rejected with 429.

**The fix:**
1. Wait before retrying: check the `Retry-After` response header (in seconds):
   ```bash
   curl -H "X-Agreement-Id: agreement-1" ... | grep -i retry-after
   ```
2. Increase the rate limit:
   ```bash
   export AI_INSIGHT_RATE_LIMIT__REQUESTS_PER_MINUTE=30
   ```
3. Use caching to avoid redundant requests: enable `AI_INSIGHT_CACHE__ENABLED=true`
4. Or disable rate limiting (development only): `export AI_INSIGHT_RATE_LIMIT__ENABLED=false`

**Expected result:** Requests succeed up to the limit. Subsequent requests wait or return 429 with proper Retry-After timing.

---

### Problem: Retry-After Header Missing

**The symptom:** Rate limit response (429) has no `Retry-After` header.

**The cause:** The client calculates `Retry-After` from the sliding window. If the window is malformed or the calculation is skipped, the header may be missing or incorrect.

**The fix:**
1. Check the response headers explicitly:
   ```bash
   curl -i -H "X-Agreement-Id: agreement-1" ... 2>&1 | grep -i retry
   ```
2. Use a default retry delay of 60 seconds if the header is missing
3. Check service logs for rate limiter errors: `grep -i "rate_limit" logs/`

**Expected result:** Rate limit responses include `Retry-After: <seconds>` header.

---

## 5. Redis Cache Issues

### Problem: Connection Refused

**The symptom:** Service logs show "connection refused" when accessing Redis. Insights still generate (fallback to no-op cache).

**The cause:** The service tries to connect to Redis at `redis_url` (e.g., `redis://localhost:6379`). If Redis is not running or the URL is wrong, connection fails. The cache gracefully falls back to a no-op cache that doesn't store or retrieve anything.

**The fix:**
1. Check Redis is running: `redis-cli ping` (should return PONG)
2. Verify Redis URL:
   ```bash
   echo $AI_INSIGHT_CACHE__REDIS_URL
   # Should be: redis://localhost:6379 or redis://<host>:<port>
   ```
3. Start Redis if it's not running:
   ```bash
   # macOS
   brew services start redis
   # Linux
   sudo systemctl start redis
   # Docker
   docker run -d -p 6379:6379 redis:latest
   ```
4. Test connection: `redis-cli -u $AI_INSIGHT_CACHE__REDIS_URL ping`

**Expected result:** Redis connection succeeds. Insights are cached and cache hits reduce LLM calls.

---

### Problem: TTL Behavior and Cache Expiration

**The symptom:** Cached insights are returned longer than expected, or cache entries disappear too quickly.

**The cause:** Each cached insight has a TTL (time-to-live) set by `cache_ttl_seconds` (default varies by deployment). When TTL expires, Redis auto-deletes the key. If the TTL is too long, stale insights persist. If too short, cache misses increase.

**The fix:**
1. Check the configured TTL:
   ```bash
   echo $AI_INSIGHT_CACHE__TTL_SECONDS
   # Or in config YAML: cache.ttl_seconds
   ```
2. Adjust TTL (in seconds): `export AI_INSIGHT_CACHE__TTL_SECONDS=3600` (1 hour)
3. Manually clear cache for testing:
   ```bash
   redis-cli FLUSHDB
   ```

**Expected result:** Insights are cached for the configured duration, then automatically expire.

---

### Problem: Cache Bypass When Redis Unavailable

**The symptom:** Redis is down, but insights still generate (no failures).

**The cause:** When Redis initialization fails, the cache falls back to `NoopInsightCache` — a no-op implementation that always returns None on get() and does nothing on set(). This allows the service to continue without caching, maintaining availability.

**The fix:**
1. This is expected behavior. Restart Redis to re-enable caching:
   ```bash
   redis-cli ping  # Should return PONG
   ```
2. Once Redis is healthy, cache hits resume reducing LLM calls
3. To validate the fallback is working, check logs:
   ```bash
   grep -i "Failed to initialize Redis" logs/
   ```

**Expected result:** Service continues generating insights even if Redis is unavailable. Caching resumes when Redis recovers.

---

## 6. Fallback Behavior

### Problem: LLM Unavailable Triggers Fallback

**The symptom:** LLM is down (HTTP 5xx or timeout), but the response succeeds with metadata showing `fallback_reason: "integration llm down"`.

**The cause:** The orchestrator catches LLM errors (timeouts, 5xx, connection errors) and falls back to rule-based (deterministic) insight generation. Context is analyzed without LLM — outliers are detected, trends are computed, events are correlated, but with no LLM refinement.

**The fix:**
1. Check LLM service status: `curl -v <LLM_URL>`
2. Check service logs for LLM errors: `grep -i "LLMUpstreamError\|LLMRateLimitError" logs/`
3. Restart LLM service or contact provider
4. Once LLM is healthy, new requests use LLM again

**Expected result:** When LLM is unavailable, fallback provides a valid insight. When LLM recovers, insights use LLM.

---

### Problem: How to Identify Fallback vs LLM Response

**The symptom:** You want to know if the insight came from LLM or fallback.

**The cause:** The response includes metadata indicating whether LLM was used:
- `llm_used: true` — LLM was called and generated the insight
- `llm_used: false` — Fallback (deterministic) logic generated the insight
- `fallback_reason` field (if fallback) — explains why LLM was skipped

**The fix:**
1. Check the response metadata:
   ```json
   {
     "record": { ... },
     "metadata": {
       "llm_used": false,
       "fallback_reason": "integration llm down"
     }
   }
   ```
2. Possible fallback reasons:
   - `"integration llm down"` — LLM HTTP error (5xx, timeout, connection refused)
   - `"LLM output is not valid JSON"` — LLM returned non-JSON
   - `"LLM output does not match expected schema"` — JSON but wrong structure
   - `"LLM skipped due to insufficient data (rows_analyzed=0)"` — No data to analyze

**Expected result:** You can distinguish LLM-based and fallback insights in monitoring and alerting.

---

## 7. Configuration Issues

### Problem: Layered Config Not Resolving Correctly

**The symptom:** Config values are not what you expect. Environment variables seem ignored, or YAML overrides aren't applied.

**The cause:** Config resolution follows this order (highest priority first):
1. Environment variables (e.g., `AI_INSIGHT_LLM__API_KEY`)
2. YAML overlay (if path set in `CONFIG_OVERLAY_PATH`)
3. Default `config/default.yaml`

If an env var is set, it overrides YAML and defaults. Environment variable names use double underscore (`__`) as separator: `AI_INSIGHT_LLM__API_KEY` → `ai_insight.llm.api_key`.

**The fix:**
1. Check what config is loaded:
   ```bash
   curl http://localhost:8080/api/v1/health | jq '.config'
   # Or: python -c "from src.config import load_config; print(load_config())"
   ```
2. Verify env var format:
   - Bad: `AI_INSIGHT_LLM_API_KEY` (single underscore)
   - Good: `AI_INSIGHT_LLM__API_KEY` (double underscore)
3. Check YAML overlay path: `echo $CONFIG_OVERLAY_PATH`
4. If using overlay, verify file exists and is valid YAML

**Expected result:** Config resolves in expected order. Highest-priority sources override lower ones.

---

### Problem: YAML Overlay Not Loading

**The symptom:** Config YAML file exists, but values are not applied. Defaults are used instead.

**The cause:** The overlay path is not set, or the file path is wrong, or the YAML is malformed.

**The fix:**
1. Set the overlay path:
   ```bash
   export CONFIG_OVERLAY_PATH="/etc/facis/ai-insight-overlay.yaml"
   ```
2. Verify file exists and is readable:
   ```bash
   ls -la /etc/facis/ai-insight-overlay.yaml
   cat /etc/facis/ai-insight-overlay.yaml
   ```
3. Validate YAML syntax:
   ```bash
   python -c "import yaml; yaml.safe_load(open('/etc/facis/ai-insight-overlay.yaml'))"
   ```
4. If YAML has errors, fix them and restart

**Expected result:** Overlay YAML is loaded and applied. Config values are as specified in the overlay.

---

## 8. Startup Failures

### Problem: Missing Required Config (Trino Host)

**The symptom:** Service fails to start with `ValueError: Trino host is required` or similar.

**The cause:** A required config value is not set. For example, `TRINO_HOST` (or `AI_INSIGHT_TRINO__HOST`) is needed but not provided.

**The fix:**
1. Check which config is missing from the error message
2. Set the env var:
   ```bash
   export AI_INSIGHT_TRINO__HOST="trino.example.com"
   export AI_INSIGHT_TRINO__PORT=8080
   ```
3. Or set in YAML overlay:
   ```yaml
   trino:
     host: "trino.example.com"
     port: 8080
   ```
4. Restart the service

**Expected result:** All required configs are set. Service starts successfully.

---

### Problem: Port Conflicts

**The symptom:** Service fails with `Address already in use` or `bind() got an invalid argument`.

**The cause:** The configured HTTP port (default 8080) is already in use by another process.

**The fix:**
1. Check what's using the port:
   ```bash
   lsof -i :8080
   # Or: netstat -tlnp | grep 8080
   ```
2. Change the service port:
   ```bash
   export AI_INSIGHT_HTTP__PORT=8081
   ```
3. Or kill the other process (if safe):
   ```bash
   kill -9 <PID>
   ```
4. Restart the service

**Expected result:** Service binds to the configured port without conflicts.

---

### Problem: Import Errors

**The symptom:** Service fails to start with `ModuleNotFoundError: No module named 'xxx'`.

**The cause:** A Python dependency is missing or not installed in the venv.

**The fix:**
1. Check the venv is activated: `which python` should show venv path
2. Reinstall dependencies:
   ```bash
   pip install -e ".[dev]"
   ```
3. Or if specific module is missing:
   ```bash
   pip install <module-name>
   ```
4. Restart the service

**Expected result:** All dependencies are installed. Service starts without import errors.

---

### Problem: Health Endpoint Returns Unhealthy

**The symptom:** Service starts but `GET /api/v1/health` returns `status: "unhealthy"` or a non-200 response.

**The cause:** One or more health checks failed. The health endpoint validates:
- Config is loaded
- LLM client is configured
- Trino client can authenticate
- Redis (if enabled) is reachable

**The fix:**
1. Check the health response:
   ```bash
   curl -s http://localhost:8080/api/v1/health | python -m json.tool
   ```
2. Look at the detailed status for each component
3. Fix any failing components:
   - LLM: verify `API_KEY` and `CHAT_COMPLETIONS_URL`
   - Trino: verify OIDC credentials
   - Redis: verify connection or disable cache
4. Restart the service

**Expected result:** Health endpoint returns `status: "ok"` with all components healthy.

---

## 9. Diagnostic Commands

### Check Service Status

```bash
# Is the service running?
curl -s http://localhost:8080/api/v1/health | python -m json.tool

# What config is loaded?
curl -s http://localhost:8080/api/v1/health | jq '.config'
```

### Test LLM Connection

```bash
# Is LLM configured and reachable?
curl -X POST \
  -H "Authorization: Bearer $AI_INSIGHT_LLM__API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"meta-llama/Llama-3.3-70B-Instruct","messages":[{"role":"user","content":"hello"}]}' \
  "$AI_INSIGHT_LLM__CHAT_COMPLETIONS_URL"
```

### Test Trino Connection

```bash
# Can we get an OIDC token?
curl -X POST \
  -d "grant_type=password&client_id=$TRINO_OIDC_CLIENT_ID&client_secret=$TRINO_OIDC_CLIENT_SECRET&username=$TRINO_OIDC_USERNAME&password=$TRINO_OIDC_PASSWORD" \
  "$TRINO_OIDC_TOKEN_URL"
```

### Test Redis Connection

```bash
# Is Redis running and accessible?
redis-cli -u "$AI_INSIGHT_CACHE__REDIS_URL" ping
# Should return: PONG

# Clear cache for testing
redis-cli -u "$AI_INSIGHT_CACHE__REDIS_URL" FLUSHDB
```

### Check Service Logs

```bash
# Follow logs in real-time
tail -f logs/app.log

# Search for errors
grep -i "error\|exception\|failed" logs/app.log

# Search for rate limit events
grep -i "rate_limit\|429" logs/app.log

# Search for policy denials
grep -i "policy.*denied\|403" logs/app.log

# Search for fallback events
grep -i "fallback\|llm.*down" logs/app.log
```

### Test an Insight Request

```bash
# Basic request (no policy/rate-limit)
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Agreement-Id: test-agreement" \
  -H "X-Asset-Id: test-asset" \
  -H "X-User-Roles: ai_insight_consumer" \
  -d '{
    "window": {
      "start": "2026-01-01T00:00:00Z",
      "end": "2026-01-02T00:00:00Z"
    },
    "timezone": "UTC",
    "robust_z_threshold": 2.5
  }' \
  http://localhost:8080/api/v1/insights/anomaly-report | jq .

# Check response for fallback reason
# "fallback_reason" field indicates why LLM was skipped
```

### Monitor Cache Hits

```bash
# Check Redis key count
redis-cli -u "$AI_INSIGHT_CACHE__REDIS_URL" DBSIZE

# Monitor operations in real-time
redis-cli -u "$AI_INSIGHT_CACHE__REDIS_URL" MONITOR
```

---

(c) ATLAS IoT Lab GmbH -- FACIS FAP IoT & AI Demonstrator
Licensed under Apache License 2.0
