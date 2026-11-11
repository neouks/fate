"use client";

import * as React from "react";
import { ArrowLeft, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
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
  main, list, primaryDetail, primaryDetailLabel, sessionKey, open, onOpenChange, onBack,
}: {
  main: React.ReactNode;
  list: React.ReactNode;
  primaryDetail?: React.ReactNode;
  primaryDetailLabel: string;
  sessionKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBack: () => void;
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
  React.useEffect(() => setExpanded(false), [sessionKey]);

  const panel = (
    <div className="task-process">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <span className="flex-1 text-sm font-medium">执行过程</span>
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
        {wide && open && !expanded && (
          <>
            <ResizablePanel id="process" defaultSize="280px" minSize="240px" maxSize="65%">
              {panel}
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        )}
        <ResizablePanel id="main" minSize="320px">
          <div className="relative h-full min-h-0 min-w-0">
            <div className={cn("h-full min-h-0", primaryDetail && "invisible pointer-events-none")} inert={!!primaryDetail}>
              {main}
            </div>
            {primaryDetail && (
              <section aria-label={primaryDetailLabel} className="task-worker-conversation absolute inset-0 flex min-h-0 min-w-0 flex-col">
                <div className="flex h-12 shrink-0 items-center border-b px-3">
                  <Button variant="ghost" size="sm" onClick={onBack}>
                    <ArrowLeft data-icon="inline-start" />
                    返回主对话
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">{primaryDetail}</div>
              </section>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <Sheet open={open && (!wide || expanded)} onOpenChange={onOpenChange}>
        <SheetContent side="left" className={expanded ? "w-full p-0 data-[side=left]:sm:max-w-5xl" : "p-0 data-[side=left]:w-[min(75vw,280px)]"} showCloseButton={false}>
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
