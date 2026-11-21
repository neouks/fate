export type ThinkingLevel = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ToolPreset = "configured" | "none" | "read-only" | "default" | "full";
export type SessionControlPatch = { thinking_level?: ThinkingLevel; tool_preset?: ToolPreset };
export type SessionControlTarget = { taskId: string; session: string } | { conversationId: number };
export type SessionControlSettings = {
  thinking_level: ThinkingLevel;
  tool_preset: ToolPreset;
  thinking_options: { value: ThinkingLevel; label: string; original: string | null }[];
  compacting: boolean;
  can_compact: boolean;
  effective: "next_run";
};
export function sessionControlURL(target: SessionControlTarget, action = "") {
  return "taskId" in target
    ? `/tasks/${target.taskId}/session-controls${action}?${new URLSearchParams({ session: target.session })}`
    : `/conversations/${target.conversationId}/controls${action}`;
}
