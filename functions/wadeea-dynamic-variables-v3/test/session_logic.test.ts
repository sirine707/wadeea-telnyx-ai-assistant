import { describe, it, expect } from "vitest";
import { applyRecordCall, type CallSessionState } from "../src/actors/session_logic";

describe("CallSession logic (mentor's 4c example shape)", () => {
  it("first call: count becomes 1, not a returning caller", () => {
    const { state, result } = applyRecordCall(null, "new_booking");
    expect(state.call_count).toBe(1);
    expect(state.last_intent).toBe("new_booking");
    expect(result).toEqual({ call_count: 1, last_intent: "new_booking", returning_caller: false });
  });

  it("subsequent call: increments and reports returning caller with previous intent", () => {
    const prev: CallSessionState = { call_count: 2, last_intent: "documents" };
    const { state, result } = applyRecordCall(prev, "existing_rental");
    expect(state.call_count).toBe(3);
    expect(result.returning_caller).toBe(true);
    expect(result.last_intent).toBe("documents"); // what they wanted LAST time
    expect(state.last_intent).toBe("existing_rental"); // stored for next time
  });

  it("missing intent keeps previous last_intent", () => {
    const prev: CallSessionState = { call_count: 1, last_intent: "new_booking" };
    const { state } = applyRecordCall(prev, undefined);
    expect(state.last_intent).toBe("new_booking");
    expect(state.call_count).toBe(2);
  });
});
