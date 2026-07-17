"""Transfer process store with DSP state machine and access provisioning."""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from datetime import UTC, datetime, timedelta
from threading import Lock
from urllib.parse import quote
from uuid import uuid4

from src.models import (
    AccessObject,
    TransferFormat,
    TransferProcess,
    TransferRequest,
    TransferState,
)

logger = logging.getLogger(__name__)

# Valid state transitions per DSP 1.0
_VALID_TRANSITIONS: dict[TransferState, set[TransferState]] = {
    TransferState.REQUESTED: {
        TransferState.STARTED,
        TransferState.TERMINATED,
        TransferState.ERROR,
    },
    TransferState.STARTED: {
        TransferState.COMPLETED,
        TransferState.SUSPENDED,
        TransferState.TERMINATED,
        TransferState.ERROR,
    },
    TransferState.SUSPENDED: {TransferState.STARTED, TransferState.TERMINATED},
    TransferState.COMPLETED: set(),
    TransferState.TERMINATED: set(),
    TransferState.ERROR: set(),
}


class TransferStore:
    """
    In-memory transfer process store with DSP state machine.

    In production, this would be backed by PostgreSQL (per SRS §6.1 Table 2).
    The in-memory implementation is functionally equivalent for the demonstrator.
    """

    def __init__(
        self,
        *,
        hmac_secret: str | None = None,
        data_api_base_url: str = "https://ai-insight.facis.cloud",
        default_ttl_seconds: int = 3600,
        kafka_bootstrap: str | None = None,
    ) -> None:
        self._lock = Lock()
        self._transfers: dict[str, TransferProcess] = {}
        if not hmac_secret:
            raise ValueError(
                "DSP_HMAC_SECRET is required. Set the DSP_HMAC_SECRET environment "
                "variable to a hex-encoded secret (e.g., `openssl rand -hex 32`). "
                "Auto-generated secrets break multi-replica deployments and "
                "invalidate URLs on restart."
            )
        self._hmac_secret = hmac_secret.encode("utf-8")
        self._data_api_base_url = data_api_base_url
        self._default_ttl_seconds = default_ttl_seconds
        self._kafka_bootstrap = kafka_bootstrap

    def create(self, request: TransferRequest) -> TransferProcess:
        """Create a new transfer process in REQUESTED state."""
        now = datetime.now(UTC).isoformat()
        transfer = TransferProcess(
            id=f"tp-{uuid4().hex[:12]}",
            agreementId=request.agreementId,
            assetId=request.assetId,
            format=request.format,
            state=TransferState.REQUESTED,
            parameters=request.parameters,
            createdAt=now,
            updatedAt=now,
        )
        with self._lock:
            self._transfers[transfer.id] = transfer
        logger.info(
            f"Transfer {transfer.id} created: {request.format} for asset {request.assetId}"
        )
        return transfer

    def get(self, transfer_id: str) -> TransferProcess | None:
        with self._lock:
            return self._transfers.get(transfer_id)

    def list_all(self) -> list[TransferProcess]:
        with self._lock:
            return list(self._transfers.values())

    def transition(
        self,
        transfer_id: str,
        target_state: TransferState,
        reason: str | None = None,
    ) -> TransferProcess:
        """Transition a transfer to a new state per DSP state machine rules."""
        with self._lock:
            transfer = self._transfers.get(transfer_id)
            if transfer is None:
                raise ValueError(f"Transfer {transfer_id} not found")

            valid_targets = _VALID_TRANSITIONS.get(transfer.state, set())
            if target_state not in valid_targets:
                raise ValueError(
                    f"Invalid transition: {transfer.state} → {target_state}. "
                    f"Valid targets: {valid_targets}"
                )

            now = datetime.now(UTC).isoformat()

            # Build updated transfer
            access = transfer.access
            if target_state == TransferState.COMPLETED:
                access = self._provision_access(transfer)

            updated = TransferProcess(
                id=transfer.id,
                agreementId=transfer.agreementId,
                assetId=transfer.assetId,
                format=transfer.format,
                state=target_state,
                access=access,
                reason=reason,
                parameters=transfer.parameters,
                createdAt=transfer.createdAt,
                updatedAt=now,
            )
            self._transfers[transfer_id] = updated

        logger.info(f"Transfer {transfer_id}: {transfer.state} → {target_state}")
        return updated

    def start_and_complete(self, transfer_id: str) -> TransferProcess:
        """Convenience: REQUESTED → STARTED → COMPLETED with access provisioning."""
        self.transition(transfer_id, TransferState.STARTED)
        return self.transition(transfer_id, TransferState.COMPLETED)

    def _provision_access(self, transfer: TransferProcess) -> AccessObject:
        """Provision data plane access parameters based on transfer format."""
        if transfer.format == TransferFormat.HTTP_PULL:
            return self._provision_http_pull(transfer)
        if transfer.format == TransferFormat.KAFKA_STREAMING:
            return self._provision_kafka_streaming(transfer)
        raise ValueError(f"Unsupported format: {transfer.format}")

    def _provision_http_pull(self, transfer: TransferProcess) -> AccessObject:
        """Generate HMAC-signed pull URL per SRS §7.2.1.

        agreementId (and roles, always empty in legacy/Python mode — NF-1
        identity verification is ORCE-only) are percent-encoded and bound
        into the signed message so a replayed URL can't be pointed at a
        different agreement, and so an unencoded delimiter inside either
        field can't make two different (agreementId, roles) pairs collide
        on the same signed message. Must stay byte-for-byte in lockstep
        with the JS/ORCE twin (facis-dsp-transfers.json), which uses
        encodeURIComponent — equivalent to urllib.parse.quote here.
        """
        path = f"/api/data/{transfer.assetId}"
        from_ts = transfer.parameters.get("windowFrom", "")
        to_ts = transfer.parameters.get("windowTo", "")
        expires_at = (
            datetime.now(UTC) + timedelta(seconds=self._default_ttl_seconds)
        ).isoformat()
        agreement_id = quote(transfer.agreementId)
        roles = quote("")

        # HMAC-SHA256 over canonical message
        message = f"GET:{path}:{from_ts}:{to_ts}:{expires_at}:{agreement_id}:{roles}"
        token = hmac.new(
            self._hmac_secret, message.encode("utf-8"), hashlib.sha256
        ).hexdigest()

        url = (
            f"{self._data_api_base_url.rstrip('/')}{path}"
            f"?from={from_ts}&to={to_ts}&expiresAt={expires_at}"
            f"&agreementId={agreement_id}&roles={roles}&token={token}"
        )

        return AccessObject(url=url, token=token, expiresAt=expires_at)

    def _provision_kafka_streaming(self, transfer: TransferProcess) -> AccessObject:
        """Generate Kafka streaming access parameters per SRS §7.2.2."""
        topic = f"iot.dataset.{transfer.assetId}.tp-{transfer.id}"
        bootstrap = self._kafka_bootstrap or "kafka.provider.example:9092"
        username = f"user_{transfer.id}"
        password = secrets.token_urlsafe(24)
        expires_at = (
            datetime.now(UTC) + timedelta(seconds=self._default_ttl_seconds)
        ).isoformat()

        return AccessObject(
            bootstrap=bootstrap,
            topic=topic,
            sasl={
                "mechanism": "SCRAM-SHA-256",
                "username": username,
                "password": password,
            },
            expiresAt=expires_at,
        )
