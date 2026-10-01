import { describe, it, expect } from "vitest";
import { buildNodePath } from "../node_path.js";

// Shapes as the conversations API returns them (newest first).
const msg = (node: string | undefined, role: string, over: Record<string, unknown> = {}) => ({
  role,
  text: "some utterance that must never leak",
  metadata: node ? { flow_node_id: node } : {},
  ...over,
});

describe("buildNodePath (conversation messages → compact node trace, no utterance text)", () => {
  it("compresses consecutive same-node messages into one step, oldest first", () => {
    const messages = [
      msg("take_message", "assistant"),
      msg("human_handoff", "assistant"),
      msg("human_handoff", "user"),
      msg("greeting_identify_intent", "user"),
      msg("greeting_identify_intent", "assistant"),
    ]; // newest first, as the API returns
    expect(buildNodePath(messages)).toBe("greeting_identify_intent → human_handoff → take_message");
  });

  it("annotates tool calls with name and ok/fail from the following tool result", () => {
    const messages = [
      msg("human_handoff", "tool", { text: "The transfer destination is not ready", tool_call_id: "functions.transfer:1" }),
      msg("human_handoff", "assistant", { tool_calls: [{ id: "functions.transfer:1", function: { name: "transfer", arguments: "{}" } }] }),
      msg("greeting_identify_intent", "user"),
    ];
    expect(buildNodePath(messages)).toBe("greeting_identify_intent → human_handoff (transfer ✗)");
  });

  it("marks a tool ok when its result is not an error", () => {
    const messages = [
      msg("create_booking", "tool", { text: '{"ok":true,"booking_id":"W1"}', tool_call_id: "functions.create_booking:1" }),
      msg("create_booking", "assistant", { tool_calls: [{ id: "functions.create_booking:1", function: { name: "create_booking", arguments: "{}" } }] }),
    ];
    expect(buildNodePath(messages)).toBe("create_booking (create_booking ✓)");
  });

  it("never includes utterance text and survives missing metadata", () => {
    const out = buildNodePath([msg(undefined, "system"), msg("wrap_up", "assistant")]);
    expect(out).toBe("wrap_up");
    expect(out).not.toContain("utterance");
  });
});
