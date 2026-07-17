"""FastAPI dependency for HMAC token validation on DSP pull requests."""

from __future__ import annotations

from fastapi import HTTPException, Query, Request, status

from src.security.hmac_signing import HmacSigner


class HmacTokenValidator:
    """
    FastAPI dependency that validates HMAC-signed pull requests.

    Usage in route:
        validator = HmacTokenValidator(signer)

        @router.get("/api/data/{asset_id}")
        async def pull(request: Request, ctx: AccessContext = Depends(validator)):
            ...
    """

    def __init__(self, signer: HmacSigner, enabled: bool = True) -> None:
        self._signer = signer
        self._enabled = enabled

    async def __call__(
        self,
        request: Request,
        token: str = Query(..., description="HMAC-SHA256 token"),
        expires_at: str = Query(
            ...,
            alias="expiresAt",
            description="Token expiry (ISO 8601)",
        ),
        from_ts: str = Query(
            ..., alias="from", description="Data window start (ISO 8601)"
        ),
        to_ts: str = Query(..., alias="to", description="Data window end (ISO 8601)"),
        agreement_id: str = Query(
            "", alias="agreementId", description="Agreement ID bound into the signature"
        ),
        roles: str = Query(
            "", description="Comma-separated roles bound into the signature"
        ),
    ) -> dict[str, str]:
        """Validate the HMAC token and return the verified parameters."""
        if not self._enabled:
            return {
                "from": from_ts,
                "to": to_ts,
                "agreementId": agreement_id,
                "roles": roles,
            }

        path = request.url.path
        method = request.method

        if not self._signer.verify_token(
            method=method,
            path=path,
            from_ts=from_ts,
            to_ts=to_ts,
            expires_at=expires_at,
            token=token,
            agreement_id=agreement_id,
            roles=roles,
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Invalid or expired HMAC token",
            )

        return {
            "from": from_ts,
            "to": to_ts,
            "expiresAt": expires_at,
            "agreementId": agreement_id,
            "roles": roles,
        }
