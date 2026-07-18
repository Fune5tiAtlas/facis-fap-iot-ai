#!/usr/bin/env node
// generate-fixtures.js — one-off script, run manually, output committed to
// keys.json / vectors.json. Re-run only if the verifier's claim shape
// changes; the whole point of golden vectors is that they DON'T change
// silently between runs.
const fs = require('fs');
const path = require('path');

async function main() {
    const jose = await import('jose');

    async function keypair() {
        const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
        return {
            publicJwk: await jose.exportJWK(publicKey),
            privateJwk: await jose.exportJWK(privateKey),
            privateKey
        };
    }

    const holder = await keypair();
    const issuer = await keypair();
    const untrustedIssuer = await keypair();

    const now = Math.floor(Date.now() / 1000);

    async function sign(payload, privateKey, kid) {
        return new jose.SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid }).sign(privateKey);
    }

    const validVc = await sign({
        iss: 'did:web:issuer.example',
        vc: { credentialSubject: { id: 'did:web:holder.example', roles: ['participant'] } }
    }, issuer.privateKey, 'did:web:issuer.example#key-1');

    const untrustedVc = await sign({
        iss: 'did:web:untrusted.example',
        vc: { credentialSubject: { id: 'did:web:holder.example', roles: [] } }
    }, untrustedIssuer.privateKey, 'did:web:untrusted.example#key-1');

    const mismatchedVc = await sign({
        iss: 'did:web:issuer.example',
        vc: { credentialSubject: { id: 'did:web:someone-else.example', roles: [] } }
    }, issuer.privateKey, 'did:web:issuer.example#key-1');

    // Tampered-inner-VC vector: same valid VC as `validVc`, but with one
    // base64url char flipped in its own signature segment, then wrapped in
    // an otherwise-validly-signed VP. Proves the VC signature is checked
    // independently of the VP wrapper.
    const validVcSegs = validVc.split('.');
    const validVcSigChars = validVcSegs[2].split('');
    validVcSigChars[0] = validVcSigChars[0] === 'A' ? 'B' : 'A';
    const tamperedVc = validVcSegs[0] + '.' + validVcSegs[1] + '.' + validVcSigChars.join('');

    async function signVp(payload) {
        return sign(payload, holder.privateKey, 'did:web:holder.example#key-1');
    }

    const vectors = {
        anchorNowEpochSeconds: now,
        valid: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:connector.example', jti: 'golden-valid', exp: now + 300,
            vp: { verifiableCredential: [validVc] }
        }),
        expired: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:connector.example', jti: 'golden-expired', exp: now - 10,
            vp: { verifiableCredential: [validVc] }
        }),
        wrongAudience: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:wrong.example', jti: 'golden-wrong-aud', exp: now + 300,
            vp: { verifiableCredential: [validVc] }
        }),
        untrustedIssuer: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:connector.example', jti: 'golden-untrusted', exp: now + 300,
            vp: { verifiableCredential: [untrustedVc] }
        }),
        holderMismatch: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:connector.example', jti: 'golden-mismatch', exp: now + 300,
            vp: { verifiableCredential: [mismatchedVc] }
        }),
        tamperedVc: await signVp({
            iss: 'did:web:holder.example', sub: 'did:web:holder.example',
            aud: 'did:web:connector.example', jti: 'golden-tampered-vc', exp: now + 300,
            vp: { verifiableCredential: [tamperedVc] }
        })
    };
    // Tampered-signature vector: flip one base64url char in the valid VP's signature segment.
    const segs = vectors.valid.split('.');
    const sigChars = segs[2].split('');
    sigChars[0] = sigChars[0] === 'A' ? 'B' : 'A';
    vectors.tamperedSignature = segs[0] + '.' + segs[1] + '.' + sigChars.join('');

    fs.writeFileSync(path.join(__dirname, 'keys.json'), JSON.stringify({
        holder: { publicJwk: holder.publicJwk, privateJwk: holder.privateJwk },
        issuer: { publicJwk: issuer.publicJwk, privateJwk: issuer.privateJwk },
        untrustedIssuer: { publicJwk: untrustedIssuer.publicJwk, privateJwk: untrustedIssuer.privateJwk }
    }, null, 2));
    fs.writeFileSync(path.join(__dirname, 'vectors.json'), JSON.stringify(vectors, null, 2));
    console.log('Wrote keys.json and vectors.json');
}

main();
