import type { Activity } from "./types";

const stoppedStates = new Set(["aborted", "cancelled", "canceled", "stopped", "interrupted"]);

export function toolCallState(use: Activity | undefined, result: Activity | undefined) {
  const receipt = result ?? use;
  if (receipt?.interrupted || stoppedStates.has(receipt?.metadata?.status ?? "")) return "stopped";
  if (result) return result.is_error ? "failed" : "completed";
  return use?.metadata?.status === "running" ? "running" : "unknown";
}
