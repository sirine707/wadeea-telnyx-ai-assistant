import { describe, it, expect } from "vitest";
import { isUaeNumber, normalizeUae } from "../src/shared/phone";

describe("isUaeNumber (drives the is_uae_caller dynamic variable)", () => {
  it("accepts UAE numbers in common formats", () => {
    expect(isUaeNumber("+971501234567")).toBe(true);
    expect(isUaeNumber("00971501234567")).toBe(true);
    expect(isUaeNumber("971501234567")).toBe(true);
    expect(isUaeNumber("+971 50 123 4567")).toBe(true);
    expect(isUaeNumber("+971-4-1234567")).toBe(true); // Dubai landline
  });

  it("rejects non-UAE numbers", () => {
    expect(isUaeNumber("+14155552671")).toBe(false); // US
    expect(isUaeNumber("+33612345678")).toBe(false); // FR
    expect(isUaeNumber("+9721234567")).toBe(false); // 972 = Israel, not a prefix match
  });

  it("rejects anonymous, empty, and garbage callers", () => {
    expect(isUaeNumber("")).toBe(false);
    expect(isUaeNumber("anonymous")).toBe(false);
    expect(isUaeNumber("Restricted")).toBe(false);
    expect(isUaeNumber("+971")).toBe(false); // prefix alone, no subscriber digits
  });

  it("rejects numbers that merely contain 971 elsewhere", () => {
    expect(isUaeNumber("+19715551234")).toBe(false); // US number with 971 area code
  });

  it("accepts local mobile format 05x…", () => {
    expect(isUaeNumber("0501234567")).toBe(true);
    expect(isUaeNumber("050 123 4567")).toBe(true);
  });
});

describe("normalizeUae (what gets stored on the booking)", () => {
  it("normalizes every accepted format to +971…", () => {
    expect(normalizeUae("+971501234567")).toBe("+971501234567");
    expect(normalizeUae("00971 50 123 4567")).toBe("+971501234567");
    expect(normalizeUae("971501234567")).toBe("+971501234567");
    expect(normalizeUae("050 123 4567")).toBe("+971501234567");
  });

  it("returns null for anything not UAE", () => {
    expect(normalizeUae("+14155552671")).toBeNull();
    expect(normalizeUae("anonymous")).toBeNull();
    expect(normalizeUae("")).toBeNull();
  });
});