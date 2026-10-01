import { StatefulActor } from "@telnyx/edge-runtime";
import { applyRecordCall, type CallSessionState, type RecordCallResult } from "./session_logic";

// One actor instance per caller (idFromName(phone)) — the assignment's 4c
// example shape: no constructor, lazy get/put storage, single-threaded
// read-modify-write.
export class CallSession extends StatefulActor {
  async recordCall(intent?: string): Promise<RecordCallResult> {
    const prev = (await this.ctx.storage.get<CallSessionState>("session")) ?? null;
    const { state, result } = applyRecordCall(prev, intent);
    await this.ctx.storage.put("session", state);
    return result;
  }
}
