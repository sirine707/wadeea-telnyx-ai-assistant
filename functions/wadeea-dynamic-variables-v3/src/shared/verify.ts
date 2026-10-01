import { createPublicKey, verify as edVerify } from "node:crypto";

// SPKI DER prefix for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Verifies Telnyx's webhook signature (Ed25519 over `${timestamp}|${rawBody}`)
// using only node:crypto — keeps the bundle single-dependency so the actor
// host can load it (ADR 0002). Returns false on any malformed input.
export function verifyTelnyxSignature(
  rawBody: string,
  signatureB64: string,
  timestamp: string,
  publicKeyB64: string,
): boolean {
  try {
    const raw = Buffer.from(publicKeyB64, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    const signature = Buffer.from(signatureB64, "base64");
    const message = Buffer.from(`${timestamp}|${rawBody}`);
    return edVerify(null, message, key, signature);
  } catch {
    return false;
  }
}
