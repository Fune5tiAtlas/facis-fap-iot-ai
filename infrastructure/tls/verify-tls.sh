#!/usr/bin/env bash
# verify-tls.sh — evidence scan for the TLS 1.3 minimum-version policy on the
# public FACIS ingress. Re-runnable by QA to reproduce the acceptance evidence.
#
# Policy: the ingress-nginx controller fronting fap-iotai.facis.cloud is
# configured with `ssl-protocols: TLSv1.3` (ConfigMap
# ingress-nginx-controller in the ingress-nginx namespace). This scan proves
# TLS 1.3 negotiates and TLS 1.2 / 1.1 are refused.
#
# Usage:
#   infrastructure/tls/verify-tls.sh [host]
# Default host: fap-iotai.facis.cloud
#
# Exit status: 0 if the policy holds (1.3 accepted, 1.2 refused), 1 otherwise.
set -u

HOST="${1:-fap-iotai.facis.cloud}"
PATH_="/api/v1/health"
URL="https://${HOST}${PATH_}"

echo "# TLS policy scan — ${HOST}"
echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

# Negotiated protocol on a default handshake (curl reports the chosen version).
NEG=$(curl -skv --max-time 12 "$URL" 2>&1 | grep -i "SSL connection using" | sed 's/^\* *//')
echo "default negotiation : ${NEG:-<none>}"

# Force TLS 1.2 as the maximum. A refused handshake makes curl exit non-zero
# and emit no http_code (000); ANY http_code (200/301/404/...) means the 1.2
# handshake completed and the endpoint served over 1.2 — a policy failure.
CODE_12=$(curl -sk --max-time 12 --tls-max 1.2 -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null)
echo "force TLS 1.2 max    : http=${CODE_12}  (000 = handshake refused, the intended result)"

# Force TLS 1.1 as the maximum — must be refused (000).
CODE_11=$(curl -sk --max-time 12 --tls-max 1.1 -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null)
echo "force TLS 1.1 max    : http=${CODE_11}  (000 = handshake refused)"

# A normal request (TLS 1.3) must still succeed.
CODE_OK=$(curl -sk --max-time 12 -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null)
echo "normal request (1.3): http=${CODE_OK}"

echo
PASS=1
case "$NEG" in *TLSv1.3*) ;; *) echo "FAIL: default handshake did not negotiate TLS 1.3"; PASS=0;; esac
# Any completed 1.2/1.1 handshake (non-000 code) is a failure — the endpoint
# must not serve over those versions at all, regardless of the HTTP status.
[ "$CODE_12" = "000" ] || { echo "FAIL: TLS 1.2 handshake completed (endpoint served over 1.2)"; PASS=0; }
[ "$CODE_11" = "000" ] || { echo "FAIL: TLS 1.1 handshake completed (endpoint served over 1.1)"; PASS=0; }
[ "$CODE_OK" = "200" ] || { echo "FAIL: TLS 1.3 request did not return 200"; PASS=0; }
if [ "$PASS" = "1" ]; then
  echo "PASS: TLS 1.3 negotiates; TLS 1.2 and 1.1 are refused."
  exit 0
fi
exit 1
