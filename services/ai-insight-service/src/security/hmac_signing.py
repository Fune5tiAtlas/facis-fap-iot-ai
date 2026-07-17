"""HMAC-SHA256 signed URL generation and verification for DSP HTTP Pull Profile."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from pydantic import BaseModel


class SignedUrlResponse(BaseModel):
    """Response model for DSP HTTP Pull signed URL."""

    url: str
    token: str
    expiresAt: str  # noqa: N815 — matches DSP spec casing


class HmacSigningError(Exception):
    """Raised when HMAC signing or verification fails."""


class HmacSigner:
    """
    HMAC-SHA256 signer for DSP HTTP Pull Profile.

    Generates time-windowed signed URLs with the format:
        HMAC = SHA256(secret, "{method}:{path}:{from}:{to}:{expiresAt}")

    Verifies incoming tokens against the same contract.
    """

    def __init__(self, secret: str | None = None) -> None:
        if secret is None:
            secret = secrets.token_hex(32)
        self._secret = secret.encode("utf-8")

    def _compute_hmac(
        self,
        method: str,
        path: str,
        from_ts: str,
        to_ts: str,
        expires_at: str,
        agreement_id: str = "",
        roles: str = "",
    ) -> str:
        """Compute HMAC-SHA256 over the canonical message.

        agreement_id/roles are percent-encoded with quote(value, safe="!*'()")
        before concatenation — NOT raw — for two reasons: (1) it closes a
        delimiter-ambiguity gap where an unencoded ':' inside either field
        could make two different (agreement_id, roles) pairs collide to the
        same signed message, and (2) it must byte-for-byte match the two
        signing sides that produce these tokens: dsp-connector's JS flow
        (encodeURIComponent) and its Python/legacy twin
        (urllib.parse.quote(value, safe="!*'()")). quote()'s default safe set
        differs from encodeURIComponent's (quote leaves '/' unescaped and
        escapes "!*'()"; encodeURIComponent does the opposite), so this
        specific safe= value is required to make the two byte-for-byte
        equivalent for all inputs — this is the same fix applied on the
        signing side in Tasks 4/5.
        """
        encoded_agreement_id = quote(agreement_id, safe="!*'()")
        encoded_roles = quote(roles, safe="!*'()")
        message = (
            f"{method.upper()}:{path}:{from_ts}:{to_ts}:{expires_at}"
            f":{encoded_agreement_id}:{encoded_roles}"
        )
        return hmac.new(
            self._secret, message.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def generate_signed_url(
        self,
        *,
        base_url: str,
        path: str,
        method: str = "GET",
        from_ts: str,
        to_ts: str,
        ttl_seconds: int = 3600,
        agreement_id: str = "",
        roles: str = "",
    ) -> SignedUrlResponse:
        """
        Generate a time-windowed signed URL.

        Args:
            base_url: The base URL (e.g., "https://ai-insight.facis.cloud")
            path: The resource path (e.g., "/api/v1/insights/anomaly-report")
            method: HTTP method (default GET)
            from_ts: Start of the data time window (ISO 8601)
            to_ts: End of the data time window (ISO 8601)
            ttl_seconds: URL validity period in seconds
            agreement_id: Agreement ID to bind into the signature
            roles: Comma-separated roles to bind into the signature

        Returns:
            SignedUrlResponse with url, token, and expiresAt
        """
        expires_at = (datetime.now(UTC) + timedelta(seconds=ttl_seconds)).isoformat()
        token = self._compute_hmac(
            method, path, from_ts, to_ts, expires_at, agreement_id, roles
        )

        url = (
            f"{base_url.rstrip('/')}{path}"
            f"?from={from_ts}&to={to_ts}&expiresAt={expires_at}"
            f"&agreementId={agreement_id}&roles={roles}&token={token}"
        )

        return SignedUrlResponse(url=url, token=token, expiresAt=expires_at)

    def verify_token(
        self,
        *,
        method: str,
        path: str,
        from_ts: str,
        to_ts: str,
        expires_at: str,
        token: str,
        agreement_id: str = "",
        roles: str = "",
    ) -> bool:
        """
        Verify an HMAC token.

        Checks:
            1. Token has not expired
            2. Token matches the HMAC computation (bound to agreement_id/roles)

        Returns:
            True if valid, False otherwise.
        """
        # Check expiry
        try:
            expiry = datetime.fromisoformat(expires_at)
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=UTC)
            if datetime.now(UTC) > expiry:
                return False
        except (ValueError, TypeError):
            return False

        # Check HMAC
        expected = self._compute_hmac(
            method, path, from_ts, to_ts, expires_at, agreement_id, roles
        )
        return hmac.compare_digest(expected, token)
