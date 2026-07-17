"""Tests for HMAC-SHA256 signed URL generation and verification."""

from datetime import UTC, datetime, timedelta

import pytest

from src.security.hmac_signing import HmacSigner


@pytest.fixture
def signer() -> HmacSigner:
    return HmacSigner(secret="test-secret-key-for-hmac-signing")


class TestGenerateSignedUrl:
    def test_returns_signed_url_response(self, signer: HmacSigner) -> None:
        result = signer.generate_signed_url(
            base_url="https://example.com",
            path="/api/v1/insights/anomaly-report",
            from_ts="2026-04-07T00:00:00Z",
            to_ts="2026-04-07T23:59:59Z",
        )
        assert result.url.startswith(
            "https://example.com/api/v1/insights/anomaly-report"
        )
        assert "token=" in result.url
        assert "expiresAt=" in result.url
        assert "from=" in result.url
        assert "to=" in result.url
        assert len(result.token) == 64  # SHA256 hex digest

    def test_custom_ttl(self, signer: HmacSigner) -> None:
        result = signer.generate_signed_url(
            base_url="https://example.com",
            path="/test",
            from_ts="2026-01-01T00:00:00Z",
            to_ts="2026-01-02T00:00:00Z",
            ttl_seconds=60,
        )
        expires = datetime.fromisoformat(result.expiresAt)
        assert expires > datetime.now(UTC)
        assert expires < datetime.now(UTC) + timedelta(seconds=120)


class TestVerifyToken:
    def test_valid_token(self, signer: HmacSigner) -> None:
        result = signer.generate_signed_url(
            base_url="https://example.com",
            path="/api/v1/data",
            from_ts="2026-04-07T00:00:00Z",
            to_ts="2026-04-07T23:59:59Z",
            ttl_seconds=3600,
        )
        assert signer.verify_token(
            method="GET",
            path="/api/v1/data",
            from_ts="2026-04-07T00:00:00Z",
            to_ts="2026-04-07T23:59:59Z",
            expires_at=result.expiresAt,
            token=result.token,
        )

    def test_tampered_token(self, signer: HmacSigner) -> None:
        result = signer.generate_signed_url(
            base_url="https://example.com",
            path="/api/v1/data",
            from_ts="2026-04-07T00:00:00Z",
            to_ts="2026-04-07T23:59:59Z",
        )
        assert not signer.verify_token(
            method="GET",
            path="/api/v1/data",
            from_ts="2026-04-07T00:00:00Z",
            to_ts="2026-04-07T23:59:59Z",
            expires_at=result.expiresAt,
            token="tampered" + result.token[8:],
        )

    def test_expired_token(self, signer: HmacSigner) -> None:
        expired_at = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        token = signer._compute_hmac(
            "GET", "/test", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", expired_at
        )
        assert not signer.verify_token(
            method="GET",
            path="/test",
            from_ts="2026-01-01T00:00:00Z",
            to_ts="2026-01-02T00:00:00Z",
            expires_at=expired_at,
            token=token,
        )

    def test_wrong_path(self, signer: HmacSigner) -> None:
        result = signer.generate_signed_url(
            base_url="https://example.com",
            path="/api/v1/data",
            from_ts="2026-04-07T00:00:00Z",
            to_ts="2026-04-07T23:59:59Z",
        )
        assert not signer.verify_token(
            method="GET",
            path="/api/v1/OTHER",
            from_ts="2026-04-07T00:00:00Z",
            to_ts="2026-04-07T23:59:59Z",
            expires_at=result.expiresAt,
            token=result.token,
        )

    def test_different_secret_rejects(self) -> None:
        signer1 = HmacSigner(secret="secret-A")
        signer2 = HmacSigner(secret="secret-B")
        result = signer1.generate_signed_url(
            base_url="https://example.com",
            path="/test",
            from_ts="2026-01-01T00:00:00Z",
            to_ts="2026-01-02T00:00:00Z",
        )
        assert not signer2.verify_token(
            method="GET",
            path="/test",
            from_ts="2026-01-01T00:00:00Z",
            to_ts="2026-01-02T00:00:00Z",
            expires_at=result.expiresAt,
            token=result.token,
        )

    def test_agreement_id_binding_rejects_tamper(self, signer: HmacSigner) -> None:
        result = signer.generate_signed_url(
            base_url="https://data.example",
            path="/api/data/dataset-1",
            from_ts="2026-01-01T00:00:00",
            to_ts="2026-01-02T00:00:00",
            agreement_id="agr-abc",
            roles="consumer",
        )
        # Verifying with a DIFFERENT agreement_id than what was signed must fail —
        # proves agreement_id is bound into the signature, not a decorative param.
        assert not signer.verify_token(
            method="GET",
            path="/api/data/dataset-1",
            from_ts="2026-01-01T00:00:00",
            to_ts="2026-01-02T00:00:00",
            expires_at=result.expiresAt,
            token=result.token,
            agreement_id="agr-DIFFERENT",
            roles="consumer",
        )

    def test_roles_binding_rejects_tamper(self, signer: HmacSigner) -> None:
        result = signer.generate_signed_url(
            base_url="https://data.example",
            path="/api/data/dataset-1",
            from_ts="2026-01-01T00:00:00",
            to_ts="2026-01-02T00:00:00",
            agreement_id="agr-abc",
            roles="consumer",
        )
        assert not signer.verify_token(
            method="GET",
            path="/api/data/dataset-1",
            from_ts="2026-01-01T00:00:00",
            to_ts="2026-01-02T00:00:00",
            expires_at=result.expiresAt,
            token=result.token,
            agreement_id="agr-abc",
            roles="admin",
        )

    def test_matching_agreement_id_and_roles_verify(self, signer: HmacSigner) -> None:
        result = signer.generate_signed_url(
            base_url="https://data.example",
            path="/api/data/dataset-1",
            from_ts="2026-01-01T00:00:00",
            to_ts="2026-01-02T00:00:00",
            agreement_id="agr-abc",
            roles="consumer",
        )
        assert signer.verify_token(
            method="GET",
            path="/api/data/dataset-1",
            from_ts="2026-01-01T00:00:00",
            to_ts="2026-01-02T00:00:00",
            expires_at=result.expiresAt,
            token=result.token,
            agreement_id="agr-abc",
            roles="consumer",
        )

    def test_empty_agreement_id_and_roles_still_verify(self, signer: HmacSigner) -> None:
        # Legacy/off-mode parity: fields present but empty must still round-trip.
        result = signer.generate_signed_url(
            base_url="https://data.example",
            path="/api/data/dataset-1",
            from_ts="2026-01-01T00:00:00",
            to_ts="2026-01-02T00:00:00",
        )
        assert signer.verify_token(
            method="GET",
            path="/api/data/dataset-1",
            from_ts="2026-01-01T00:00:00",
            to_ts="2026-01-02T00:00:00",
            expires_at=result.expiresAt,
            token=result.token,
        )

    def test_compute_hmac_percent_encodes_agreement_id_and_roles(
        self, signer: HmacSigner
    ) -> None:
        """_compute_hmac must apply quote(value, safe="!*'()") to agreement_id/roles
        before concatenating — the exact encoding dsp-connector's JS
        (encodeURIComponent) and Python (urllib.parse.quote(..., safe="!*'()"))
        signing sides use. This is not just "some" encoding: it independently
        reconstructs the expected message with that specific transform and
        compares digests, so it fails if the implementation used raw values, a
        different safe-set, or any other encoding.
        """
        import hashlib
        import hmac as hmac_module
        from urllib.parse import quote

        agreement_id = "agr:abc/def(x)!y'z*"
        roles = "role:a,role/b"
        method, path = "GET", "/api/data/dataset-1"
        from_ts, to_ts = "2026-01-01T00:00:00", "2026-01-02T00:00:00"
        expires_at = "2026-01-02T01:00:00"

        encoded_agreement_id = quote(agreement_id, safe="!*'()")
        encoded_roles = quote(roles, safe="!*'()")
        expected_message = (
            f"{method}:{path}:{from_ts}:{to_ts}:{expires_at}"
            f":{encoded_agreement_id}:{encoded_roles}"
        )
        expected_token = hmac_module.new(
            signer._secret, expected_message.encode("utf-8"), hashlib.sha256
        ).hexdigest()

        actual_token = signer._compute_hmac(
            method, path, from_ts, to_ts, expires_at, agreement_id, roles
        )
        assert actual_token == expected_token

    def test_agreement_id_and_roles_with_delimiter_chars_round_trip(
        self, signer: HmacSigner
    ) -> None:
        """Realistic inputs containing ':' '/' '!' '*' ''' '(' ')' must still
        sign+verify successfully — proves the percent-encoding is applied
        consistently on both the generate and verify paths.
        """
        result = signer.generate_signed_url(
            base_url="https://data.example",
            path="/api/data/dataset-1",
            from_ts="2026-01-01T00:00:00",
            to_ts="2026-01-02T00:00:00",
            agreement_id="agr:abc/def(x)!y'z*",
            roles="role:a,role/b",
        )
        assert signer.verify_token(
            method="GET",
            path="/api/data/dataset-1",
            from_ts="2026-01-01T00:00:00",
            to_ts="2026-01-02T00:00:00",
            expires_at=result.expiresAt,
            token=result.token,
            agreement_id="agr:abc/def(x)!y'z*",
            roles="role:a,role/b",
        )
