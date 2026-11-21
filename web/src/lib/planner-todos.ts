export interface PlannerTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  review?: {
    state: "continue" | "deferred" | "closed";
    basis: { node_id: number; version: number }[];
    scope: string;
    reason: string;
    recovery?: string;
  };
}
