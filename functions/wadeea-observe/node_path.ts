// Turns a conversation's messages (Telnyx conversations API, newest first)
// into a compact node-execution trace like:
//   greeting_identify_intent → human_handoff (transfer ✗) → take_message
// Uses only node ids, tool names and ok/fail — never caller utterance text
// (that stays in Telnyx's access-controlled Conversation History).

interface ApiMessage {
  role?: string;
  text?: string;
  tool_call_id?: string;
  tool_calls?: { id?: string; function?: { name?: string } }[];
  metadata?: { flow_node_id?: string };
}

function toolFailed(resultText: string): boolean {
  const t = resultText.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t) as Record<string, unknown>;
      if (parsed.ok === false || parsed.error !== undefined) return true;
      const status = Number(parsed.http_status ?? 0);
      return status >= 400;
    } catch {
      return true;
    }
  }
  // Plain-text tool results are error explanations in practice.
  return true;
}

export function buildNodePath(messages: ApiMessage[]): string {
  const oldestFirst = [...messages].reverse();

  // Map each tool call id to its outcome from the matching tool-result message.
  const outcomes = new Map<string, boolean>();
  for (const m of oldestFirst) {
    if (m.role === "tool" && m.tool_call_id) outcomes.set(m.tool_call_id, !toolFailed(m.text ?? ""));
  }

  const steps: { node: string; tools: string[] }[] = [];
  for (const m of oldestFirst) {
    const node = m.metadata?.flow_node_id;
    if (!node) continue;
    let step = steps[steps.length - 1];
    if (!step || step.node !== node) {
      step = { node, tools: [] };
      steps.push(step);
    }
    for (const tc of m.tool_calls ?? []) {
      const name = tc.function?.name;
      if (!name) continue;
      const ok = tc.id !== undefined ? outcomes.get(tc.id) : undefined;
      step.tools.push(`${name} ${ok === false ? "✗" : ok === true ? "✓" : ""}`.trim());
    }
  }

  return steps
    .map((s) => (s.tools.length ? `${s.node} (${s.tools.join(", ")})` : s.node))
    .join(" → ");
}
