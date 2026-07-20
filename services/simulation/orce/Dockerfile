FROM ecofacis/xfsc-orce:2.0.3

USER root

# ── System dependencies ──────────────────────────────────────────────
# librdkafka-dev: native Kafka client for node-red-contrib-rdkafka
# python3, make, g++: required for native npm module compilation
RUN apk add --no-cache librdkafka-dev python3 make g++

# Fix node-gyp compatibility with Node 20.19.
# The ORCE base image ships npm 11.6.0 whose bundled node-gyp has a broken
# logger (TypeError: Cannot read properties of undefined 'pause').
# Updating npm brings a fixed node-gyp.
RUN npm install -g npm@latest

# ── Kafka plugin (rdkafka) ───────────────────────────────────────────
# Install node-red-contrib-rdkafka into a staging directory.
# We cannot install directly into /data (Docker volume mounted at runtime)
# or /opt/maestro (managed by ORCE). A staging dir lets us copy at startup.
# BUILD_LIBRDKAFKA=0 tells node-rdkafka to use the system librdkafka
# instead of downloading and compiling its own copy.
RUN mkdir -p /opt/rdkafka-staging && \
    cd /opt/rdkafka-staging && \
    npm init -y && \
    BUILD_LIBRDKAFKA=0 npm install node-red-contrib-rdkafka

# Patched rdkafka.js with SSL/mTLS support for cluster Kafka connections.
COPY rdkafka-patch.js /opt/rdkafka-staging/rdkafka-patch.js

# ── GUI Generator (JSON Forms) ──────────────────────────────────────
# Install JSON Forms packages and the Node-RED UI builder into a staging
# directory. JSON Forms renders dynamic UIs from JSON Schema + UI Schema
# definitions — used for the DCM catalogue interface.
# Reference: https://jsonforms.io/
RUN mkdir -p /opt/jsonforms-staging && \
    cd /opt/jsonforms-staging && \
    npm init -y && \
    npm install \
        @jsonforms/core \
        @jsonforms/react \
        @jsonforms/material-renderers \
        @mui/material \
        @mui/icons-material \
        @emotion/react \
        @emotion/styled \
        node-red-contrib-uibuilder

# ── Simulation + DSP + SFTP runtime modules ─────────────────────────
# node-red-contrib-modbus: Modbus TCP master + slave nodes used by the
#   ORCE-native Modbus adapter (replaces src/api/modbus/server.py).
# node-red-contrib-opcua (pinned): OPC UA server + client nodes used by
#   the OPC UA demo server adapter and the industrial ingestion flows
#   (services/industrial-ingestion-service/orce/). Pure JS (node-opcua).
# seedrandom: deterministic JS-native PRNG used by the simulation engine
#   subflows. Same (base_seed, entity_id, ts_ms) → same float sequence,
#   byte-stable across pod restarts.
# ssh2-sftp-client: strict-host-key-verifying SFTP client used by the
#   FACIS SFTP Ingestion ORCE flow (services/sftp-ingestion-service/orce/).
#   Replaces paramiko in the legacy Python service.
# csv-parse: header-aware CSV parser used by the FACIS SFTP Ingestion ORCE
#   flow. Replaces csv.DictReader. Runs in strict-column-count mode to
#   surface malformed rows through the DLQ.
#
# NOTE: the SFTP ingestion flows live in a different service tree but share
# this image because the ORCE pod is shared infrastructure. A change here
# rebuilds the simulation image — this cross-service coupling is documented
# in services/sftp-ingestion-service/orce/README.md.
RUN mkdir -p /opt/sim-runtime-staging && \
    cd /opt/sim-runtime-staging && \
    npm init -y && \
    npm install \
        node-red-contrib-modbus \
        node-red-contrib-opcua@0.2.354 \
        seedrandom \
        ssh2-sftp-client \
        csv-parse

# ── Custom entrypoint ───────────────────────────────────────────────
# Copies rdkafka + jsonforms + sim-runtime modules into /data/node_modules
# at startup, applies SSL patch, then delegates to the original ORCE entrypoint.
COPY entrypoint.sh /usr/local/bin/entrypoint-rdkafka.sh
RUN chmod +x /usr/local/bin/entrypoint-rdkafka.sh

ENTRYPOINT ["/usr/local/bin/entrypoint-rdkafka.sh"]

# Do NOT switch to node-red here — the original ORCE entrypoint runs as root
# and handles the user switch internally (run_as_node_red / su-exec).
