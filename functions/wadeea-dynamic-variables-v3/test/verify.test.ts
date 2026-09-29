import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { verifyTelnyxSignature } from "../src/verify";

// Telnyx signs `${timestamp}|${rawBody}` with Ed25519; signature and public
// key travel base64-encoded (key as 32 raw bytes).
function makeSigned(body: string, timestamp: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const message = Buffer.from(`${timestamp}|${body}`);
  const signature = edSign(null, message, privateKey).toString("base64");
  const rawPub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  return { publicKeyB64: rawPub.toString("base64"), signature };
}

describe("verifyTelnyxSignature (node:crypto Ed25519, zero deps)", () => {
  const body = JSON.stringify({ data: { event_type: "assistant.initialization" } });
  const ts = String(Math.floor(Date.now() / 1000));

  it("accepts a valid signature", () => {
    const { publicKeyB64, signature } = makeSigned(body, ts);
    expect(verifyTelnyxSignature(body, signature, ts, publicKeyB64)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { publicKeyB64, signature } = makeSigned(body, ts);
    expect(verifyTelnyxSignature(body + "x", signature, ts, publicKeyB64)).toBe(false);
  });

  it("rejects a wrong timestamp", () => {
    const { publicKeyB64, signature } = makeSigned(body, ts);
    expect(verifyTelnyxSignature(body, signature, String(Number(ts) + 5), publicKeyB64)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const { signature } = makeSigned(body, ts);
    const other = makeSigned(body, ts);
    expect(verifyTelnyxSignature(body, signature, ts, other.publicKeyB64)).toBe(false);
  });

  it("returns false (not throw) on malformed inputs", () => {
    expect(verifyTelnyxSignature(body, "not-base64!!!", ts, "also-bad")).toBe(false);
  });
});
