# Notices for FACIS Industrial Ingestion Service

This content is produced and maintained by the Eclipse FACIS project.

- Project home: https://projects.eclipse.org/projects/technology.facis

## Copyright

Copyright ATLAS IoT Lab GmbH and others.

## Declared Project Licenses

This program and the accompanying materials are made available under the
terms of the Apache License, Version 2.0 which is available at
https://www.apache.org/licenses/LICENSE-2.0.

SPDX-License-Identifier: Apache-2.0

## Third-Party Content

This service runs as ORCE (Node-RED) flows and depends on the following
third-party software provisioned on the shared ORCE runtime:

| Package | License | Usage |
|---|---|---|
| Node-RED | Apache-2.0 | ORCE orchestration (runtime) |
| node-red-contrib-modbus | BSD-3-Clause | Modbus TCP client nodes |
| node-red-contrib-opcua | Apache-2.0 | OPC UA client/endpoint nodes |
| node-red-contrib-rdkafka | MIT | Kafka producer for Node-RED |
| Apache Kafka | Apache-2.0 | Message broker (runtime) |

## Cryptography

This service does not include cryptographic software directly. TLS/mTLS
certificates for Kafka communication are provisioned by the Stackable
platform operator and are not bundled with this distribution.
