// Pure logic for the CallSession actor (the assignment's 4c example shape).
// The actor stores one small state object per caller via ctx.storage get/put;
// its single-threaded execution makes the read-modify-write atomic.

export interface CallSessionState {
  call_count: number;
  last_intent: string | null;
}

export interface RecordCallResult {
  call_count: number;
  last_intent: string | null; // the PREVIOUS call's intent (for personalization)
  returning_caller: boolean;
}

export function applyRecordCall(
  prev: CallSessionState | null,
  intent: string | undefined,
): { state: CallSessionState; result: RecordCallResult } {
  const previousIntent = prev?.last_intent ?? null;
  const state: CallSessionState = {
    call_count: (prev?.call_count ?? 0) + 1,
    last_intent: intent ?? previousIntent,
  };
  return {
    state,
    result: {
      call_count: state.call_count,
      last_intent: previousIntent ?? intent ?? null,
      returning_caller: (prev?.call_count ?? 0) > 0,
    },
  };
}
