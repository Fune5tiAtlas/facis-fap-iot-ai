# TLS minimum-version policy

The public FACIS ingress (`fap-iotai.facis.cloud`) enforces **TLS 1.3 as the
minimum protocol version**. TLS 1.2 and below are refused.

## Where the setting lives

TLS is terminated by the cluster's `ingress-nginx` controller (Helm release
`ingress-nginx`, namespace `ingress-nginx`). The minimum version is set by a
single ConfigMap key:

```
ConfigMap ingress-nginx-controller (namespace ingress-nginx)
  data:
    ssl-protocols: "TLSv1.3"
```

nginx applies this on its next reload (no controller restart required). The
default for this chart is `TLSv1.2 TLSv1.3`; setting the key to `TLSv1.3`
alone drops 1.2.

Apply:

```bash
kubectl patch configmap ingress-nginx-controller -n ingress-nginx \
  --type merge -p '{"data":{"ssl-protocols":"TLSv1.3"}}'
```

## Drift note

`ingress-nginx` is a cluster-wide, Helm-managed controller that is **not**
part of this repository's chart set. A `helm upgrade` of that release without
carrying this value forward would revert the policy. When the controller's
Helm values are next edited, set:

```yaml
controller:
  config:
    ssl-protocols: "TLSv1.3"
```

so the policy survives upgrades. Until then it lives only as the applied
ConfigMap key above.

## Scope

This controller fronts the `fap-iotai.facis.cloud` paths (`/orce`, `/ai`,
`/dsp`, `/api/...`, `/iam`, `/.well-known/...`). Internal service-to-service
traffic (Trino, Kafka mTLS) does not traverse this controller.

The Superset subdomain (`fap-iotai-superset.facis.cloud`) is served by a
**separate** Stackable load balancer and is therefore **not** covered by this
ConfigMap. To bring the whole public surface to a TLS 1.3 minimum, the
Stackable ingress fronting Superset must be configured separately (its own
`ssl-protocols`/min-version setting on that load balancer). Until that is done,
`verify-tls.sh fap-iotai-superset.facis.cloud` will show TLS 1.2 still accepted
on that host; the FACIS application ingress above is the endpoint under this
policy.

## Evidence

Run `verify-tls.sh` to reproduce the acceptance scan (negotiated version +
downgrade refusal):

```bash
infrastructure/tls/verify-tls.sh
# or against another host:
infrastructure/tls/verify-tls.sh fap-iotai.facis.cloud
```

Exit status 0 confirms the policy holds.
