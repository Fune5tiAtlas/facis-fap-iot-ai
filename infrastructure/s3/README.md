# S3 lakehouse encryption at rest

The lakehouse object store (IONOS Object Storage, endpoint
`s3.eu-central-4.ionoscloud.com`, bucket `fap-iotai-stackable`) has
**default server-side encryption enabled**: SSE-S3 with AES-256, using
IONOS-managed keys.

## Where the setting lives

Bucket-level default encryption is an S3 API setting, applied with the
bucket's own credentials (Kubernetes secret `s3-credentials`, namespace
`stackable` — keys `accessKey` / `secretKey`):

```bash
aws s3api put-bucket-encryption \
  --endpoint-url https://s3.eu-central-4.ionoscloud.com \
  --bucket fap-iotai-stackable \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

Every object written after this is encrypted at rest with AES-256; the
per-object response carries `x-amz-server-side-encryption: AES256`. Verify:

```bash
aws s3api get-bucket-encryption \
  --endpoint-url https://s3.eu-central-4.ionoscloud.com \
  --bucket fap-iotai-stackable
```

## Scope of coverage

Default encryption applies to **new** object writes only; it does not
retro-encrypt objects written before it was enabled. Lakehouse data is
regenerable (Bronze is re-ingested from the sources; Silver/Gold are
re-materialised from Bronze), so a full rewrite would re-encrypt the
historical objects if that is ever required.

## Key management

Encryption uses IONOS-managed keys (SSE-S3). External / customer-managed KMS
is **not available on this object store** — see deviation register entry D-3
(`docs/deviation-register.md`) for the technical reason and the alternatives
that were evaluated.
