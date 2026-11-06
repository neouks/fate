"use client";

import * as React from "react";
import { ArrowLeft, ChevronUp, ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { Transcript } from "@/components/transcript";
import { WorkspaceEmpty, WorkspaceError } from "@/components/workspace";
import type { Activity } from "@/lib/types";
import { cn } from "@/lib/utils";

export type TranscriptPositions = Map<string, { top: number; pinned: boolean }>;

export function SessionTranscript({
  taskId, sessionKey, items, live, stopping, chat, error, loading, loadingMore,
  hasMore, onEarlier, onRetry, positions,
}: {
  taskId: string;
  sessionKey: string;
  items: Activity[];
  live: boolean;
  stopping?: boolean;
  chat?: boolean;
  error?: string;
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  onEarlier: (viewport: HTMLElement) => void;
  onRetry: () => void;
  positions: TranscriptPositions;
}) {
  const viewport = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const saved = positions.get(sessionKey);
    if (saved && !saved.pinned && viewport.current) viewport.current.scrollTop = saved.top;
  }, [positions, sessionKey]);

  return (
    <MessageScrollerProvider autoScroll={positions.get(sessionKey)?.pinned ?? true}>
      <MessageScroller>
        <MessageScrollerViewport
          ref={viewport}
          preserveScrollOnPrepend
          onScroll={(event) => {
            const node = event.currentTarget;
            if (!node.clientHeight) return;
            const top = node.scrollTop;
            positions.set(sessionKey, { top, pinned: top + node.clientHeight >= node.scrollHeight - 60 });
            if (top <= 80 && hasMore && !loading && !loadingMore) onEarlier(node);
          }}
        >
          <MessageScrollerContent className="gap-2 p-4">
            {hasMore && (
              <Button variant="ghost" size="sm" disabled={loading || loadingMore} onClick={() => viewport.current && onEarlier(viewport.current)}>
                {loadingMore ? "加载更早记录…" : "加载更早记录"}
              </Button>
            )}
            {error ? (
              <WorkspaceError error={error} onRetry={onRetry} />
            ) : items.length ? (
              <Transcript activity={items} scrollItems live={live} taskId={taskId} chat={chat}
                pendingStatus={stopping ? "stopping" : undefined} />
            ) : (
              <WorkspaceEmpty title={loading ? "正在同步记录…" : chat ? "开始任务对话" : "暂无执行记录"} />
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

export function SessionWorkspace({
  planner, list, detail, composer, open, onOpenChange, onBack, completedCount,
}: {
  planner: React.ReactNode;
  list: React.ReactNode;
  detail: React.ReactNode;
  composer: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBack: () => void;
  completedCount: number | null;
}) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const backRef = React.useRef<HTMLButtonElement>(null);
  const moveFocus = React.useRef(false);
  const [visited, setVisited] = React.useState(false);
  const showingDetail = !!detail;
  React.useEffect(() => {
    if (!open) return;
    setVisited(true);
    if (moveFocus.current) {
      moveFocus.current = false;
      panelRef.current?.focus();
    }
  }, [open]);
  React.useLayoutEffect(() => {
    const focused = document.activeElement;
    if (open && showingDetail && (focused === document.body || panelRef.current?.contains(focused))) {
      backRef.current?.focus({ preventScroll: true });
    }
  }, [open, showingDetail]);
  const toggle = (next: boolean) => {
    onOpenChange(next);
    if (!next) triggerRef.current?.focus();
  };

  return (
    <div className="task-main-conversation flex h-full min-h-0 min-w-0 flex-col">
      <section aria-label="Planner 执行记录" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {planner}
      </section>
      <div className="task-composer flex flex-col gap-2">
        <Collapsible open={open} onOpenChange={toggle} className="flex flex-col gap-2">
          <CollapsibleContent forceMount className="task-agent-tray min-h-0 overflow-hidden rounded-xl border bg-card data-[state=closed]:hidden">
            <div
              ref={panelRef}
              role="region"
              aria-label="任务会话"
              tabIndex={-1}
              className="flex h-full min-h-0 flex-col"
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.defaultPrevented) return;
                event.stopPropagation();
                toggle(false);
              }}
            >
              {detail && (
                <div className="flex shrink-0 items-center border-b px-2 py-1">
                  <Button ref={backRef} variant="ghost" size="sm" onClick={() => { onBack(); panelRef.current?.focus(); }}>
                    <ArrowLeft data-icon="inline-start" />
                    返回列表
                  </Button>
                </div>
              )}
              {(visited || open) && <div hidden={!!detail} className="min-h-0 flex-1 overflow-hidden">{list}</div>}
              {detail && <div className="min-h-0 flex-1 overflow-hidden">{detail}</div>}
            </div>
          </CollapsibleContent>
          <CollapsibleTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="secondary"
              className="h-11 w-full justify-start gap-3 rounded-xl px-4"
              onClick={() => { moveFocus.current = !open; }}
            >
              <ListTodo data-icon="inline-start" />
              <span>任务</span>
              {completedCount !== null && <span className="text-muted-foreground">{completedCount.toLocaleString()} 个 Worker 已完成</span>}
              <ChevronUp data-icon="inline-end" className={cn("ml-auto transition-transform motion-reduce:transition-none", open && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
        </Collapsible>
        {composer}
      </div>
    </div>
  );
}
