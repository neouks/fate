"use client";

import { useState } from "react";

import { CheckCheck, ChevronDown, Circle, CircleCheck, CircleDot, ListTodo } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { PlannerTodo } from "@/lib/planner-todos";
import { cn } from "@/lib/utils";

const statuses = {
  pending: { label: "待办", icon: Circle },
  in_progress: { label: "进行中", icon: CircleDot },
  completed: { label: "已完成", icon: CircleCheck },
};
const reviewLabels = { continue: "继续", deferred: "暂缓", closed: "已关闭" };

export function PlannerTodos({ todos, connected }: { todos: PlannerTodo[] | null; connected: boolean }) {
  const [open, setOpen] = useState(true);
  const completed = todos?.filter((todo) => todo.status === "completed").length ?? 0;
  const inProgress = todos?.filter((todo) => todo.status === "in_progress").length ?? 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card size="sm" aria-label="Planner 待办">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ListTodo className="size-4 shrink-0" aria-hidden="true" />
            Planner 待办
          </CardTitle>
          <CardDescription aria-live="polite">
            {todos === null ? "正在同步待办…" : `已完成 ${completed}/${todos.length} · 进行中 ${inProgress}`}
            {!connected && <span className="block">连接恢复后自动同步</span>}
          </CardDescription>
          <CardAction>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={open ? "收起 Planner 待办" : "展开 Planner 待办"}>
                <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
              </Button>
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <CardContent>
            {!!todos?.length && (
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll this bounded list.
              <section className="max-h-64 overflow-y-auto" aria-label="Planner 待办列表" tabIndex={0}>
                <ul className="flex flex-col gap-3">
                  {todos.map((todo, index) => {
                    const status = statuses[todo.status];
                    const Icon = status.icon;
                    return (
                      <li
                        key={`${todo.content}:${todos.slice(0, index).filter((item) => item.content === todo.content).length}`}
                        className="flex min-w-0 gap-2"
                      >
                        <Icon
                          className={cn(
                            "mt-0.5 size-4 shrink-0",
                            todo.status === "in_progress" ? "text-primary" : "text-muted-foreground",
                          )}
                          aria-hidden="true"
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                          <p
                            className={cn(
                              "whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
                              todo.status === "completed" && "text-muted-foreground line-through",
                            )}
                          >
                            {todo.content}
                          </p>
                          <div className="flex flex-wrap gap-1">
                            <Badge variant={todo.status === "in_progress" ? "default" : "secondary"}>
                              {status.label}
                            </Badge>
                            {todo.review && <Badge variant="outline">{reviewLabels[todo.review.state]}</Badge>}
                          </div>
                          {todo.review && (
                            <details className="text-muted-foreground text-xs">
                              <summary className="cursor-pointer">复核依据与恢复条件</summary>
                              <dl className="mt-2 flex flex-col gap-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                                <dt>范围</dt>
                                <dd>{todo.review.scope}</dd>
                                <dt>原因</dt>
                                <dd>{todo.review.reason}</dd>
                                {todo.review.recovery && (
                                  <>
                                    <dt>恢复条件</dt>
                                    <dd>{todo.review.recovery}</dd>
                                  </>
                                )}
                                <dt>证据</dt>
                                <dd>
                                  {todo.review.basis.map((ref) => `#${ref.node_id} · v${ref.version}`).join("、")}
                                </dd>
                              </dl>
                            </details>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {todos?.length === 0 && (
              <Empty className="p-2">
                <EmptyHeader>
                  <EmptyTitle className="flex items-center gap-2">
                    <CheckCheck className="size-4" />
                    暂无待办
                  </EmptyTitle>
                  <EmptyDescription>Planner 保存计划后会显示在这里。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
