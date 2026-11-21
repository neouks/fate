"use client";

import * as React from "react";

import { ArrowLeft, Maximize2, Minimize2, X } from "lucide-react";

import { HumanInputsContext } from "@/components/human-input";
import { Transcript } from "@/components/transcript";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { WorkspaceEmpty, WorkspaceError } from "@/components/workspace";
import { humanInputSession } from "@/lib/human-input";
import type { Activity } from "@/lib/types";

export type TranscriptPositions = Map<string, { top: number; pinned: boolean }>;

export function SessionTranscript({
  taskId,
  sessionKey,
  items,
  live,
  stopping,
  chat,
  error,
  loading,
  loadingMore,
  hasMore,
  onEarlier,
  onRetry,
  positions,
  renderItems,
  emptyTitle,
}: {
  renderItems?: (items: Activity[]) => React.ReactNode;
  emptyTitle?: string;
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
  const inputs = React.useContext(HumanInputsContext);
  const waiting = inputs?.items.some((r) => r.status === "pending" && humanInputSession(r) === sessionKey);
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
              <Button
                variant="ghost"
                size="sm"
                disabled={loading === true || loadingMore === true}
                onClick={() => viewport.current && onEarlier(viewport.current)}
              >
                {loadingMore ? "加载更早记录…" : "加载更早记录"}
              </Button>
            )}
            {error ? (
              <WorkspaceError error={error} onRetry={onRetry} />
            ) : items.length ? (
              renderItems ? (
                renderItems(items)
              ) : (
                <Transcript
                  activity={items}
                  scrollItems
                  live={live}
                  taskId={taskId}
                  chat={chat}
                  pendingStatus={stopping ? "stopping" : waiting ? "human_input" : undefined}
                />
              )
            ) : (
              <WorkspaceEmpty
                title={loading ? "正在同步记录…" : (emptyTitle ?? (chat ? "开始任务对话" : "暂无执行记录"))}
              />
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

export function SessionWorkspace({
  main,
  list,
  primaryDetail,
  primaryDetailLabel,
  sessionKey,
  open,
  onOpenChange,
  onBack,
}: {
  main: React.ReactNode;
  list: React.ReactNode;
  primaryDetail?: React.ReactNode;
  primaryDetailLabel: string;
  onBack: () => void;
  sessionKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [wide, setWide] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  React.useEffect(() => {
    const media = window.matchMedia("(min-width:1280px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  React.useEffect(() => {
    void sessionKey;
    setExpanded(false);
  }, [sessionKey]);

  const panel = (
    <div className="task-process">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <span className="flex-1 font-medium text-sm">执行过程</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={expanded ? "缩小执行过程" : "放大执行过程"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="关闭执行过程" onClick={() => onOpenChange(false)}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{list}</div>
    </div>
  );
  return (
    <div className="h-full min-h-0 min-w-0">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel id="main" minSize="320px">
          <div className="relative h-full min-h-0 min-w-0">
            {!primaryDetail && <div className="h-full min-h-0">{main}</div>}
            {primaryDetail && (
              <section
                aria-label={primaryDetailLabel}
                className="task-worker-conversation absolute inset-0 flex min-h-0 min-w-0 flex-col"
              >
                {primaryDetailLabel === "执行会话" && (
                  <div className="conversation-pane-header">
                    <Button variant="ghost" size="sm" onClick={onBack}>
                      <ArrowLeft data-icon="inline-start" />
                      返回主对话
                    </Button>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-hidden">{primaryDetail}</div>
              </section>
            )}
          </div>
        </ResizablePanel>
        {wide && open && !expanded && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel id="process" defaultSize="280px" minSize="240px" maxSize="65%">
              {panel}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <Sheet open={open && (!wide || expanded)} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className={
            expanded ? "w-full p-0 data-[side=right]:sm:max-w-5xl" : "p-0 data-[side=right]:w-[min(75vw,280px)]"
          }
          showCloseButton={false}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>执行过程</SheetTitle>
            <SheetDescription>查看 Agent 列表和完整执行记录</SheetDescription>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>
    </div>
  );
}
