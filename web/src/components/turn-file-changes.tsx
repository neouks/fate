"use client";

import { useEffect, useRef, useState } from "react";
import { FilePenLine, FilePlus2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { TurnFileChange } from "@/lib/turn-summary";

const unavailable = {
  binary: "二进制文件",
  too_large: "改动超出预览限制",
  uncertain: "无法核实差异",
};

function DiffLines({ patch }: { patch: string }) {
  let inHunk = false;
  return <pre tabIndex={0} aria-label="文件差异"
    className="max-h-[65dvh] min-w-0 overflow-auto rounded-lg border bg-muted/30 py-2 font-mono text-xs leading-5">
    {patch.trimEnd() === "" ? null : patch.replace(/\n$/, "").split("\n").map((line, index) => {
      if (line.startsWith("@@ ")) inHunk = true;
      const change = inHunk ? line[0] : "";
      const color = change === "+" ? "bg-emerald-500/10 text-[var(--status-success)]"
        : change === "-" ? "bg-destructive/10 text-destructive"
        : change === " " ? "" : "text-muted-foreground";
      return <span key={index} className={`block w-max min-w-full px-3 ${color}`}>{line || "\u00a0"}</span>;
    })}
  </pre>;
}

function FileCard({ file, scope, turn }: { file: TurnFileChange; scope: string; turn: string }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ patch: string | null; error?: string }>();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api.turnFileChange(scope, turn, file.id, controller.signal)
      .then(result => { if (!controller.signal.aborted) setDetail(result); })
      .catch(() => {
        if (!controller.signal.aborted) setDetail({ patch: null, error: "无法加载文件差异，请重新打开后再试。" });
      });
    return () => controller.abort();
  }, [file.id, open, scope, turn]);
  const name = file.path.split("/").at(-1);
  const Icon = file.kind === "added" ? FilePlus2 : FilePenLine;

  return <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-background px-3 py-2.5">
    <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
      <Icon className="size-4" aria-hidden="true"/>
    </div>
    <div className="min-w-0 flex-1 basis-32">
      <p className="text-sm font-medium break-all">{file.kind === "added" ? "新增" : "修改"} {name}</p>
      {file.path !== name && <p className="text-xs break-all text-muted-foreground">{file.path}</p>}
      {file.status === "text" ? <p className="flex gap-2 text-xs tabular-nums">
        <span className="text-[var(--status-success)]" aria-label={`新增 ${file.additions} 行`}>+{file.additions}</span>
        <span className="text-destructive" aria-label={`删除 ${file.deletions} 行`}>−{file.deletions}</span>
      </p> : <p className="text-xs text-muted-foreground">{unavailable[file.status]}</p>}
    </div>
    {file.status === "text" && <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setDetail(undefined); }}>
      <DialogTrigger asChild><Button className="ml-auto shrink-0" variant="outline" size="sm">查看改动</Button></DialogTrigger>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-3xl">
        <DialogHeader className="pr-8">
          <DialogTitle>文件改动</DialogTitle>
          <DialogDescription className="break-all">{file.path} · 本轮写入时保存的差异</DialogDescription>
        </DialogHeader>
        {!detail ? <p role="status" className="text-muted-foreground">正在加载差异…</p>
          : detail.patch !== null ? <DiffLines patch={detail.patch}/>
          : <p role="status" className="text-muted-foreground">{detail.error ?? "此文件的差异不可查看。"}</p>}
      </DialogContent>
    </Dialog>}
  </li>;
}

export function TurnFileChanges({ summary, turn, taskId, conversationId }: {
  summary: { total: number; items: TurnFileChange[] }; turn: string; taskId?: string; conversationId?: number;
}) {
  const scope = conversationId ? `conversations/${conversationId}` : taskId ? `tasks/${taskId}` : "";
  const [extra, setExtra] = useState<{ items: TurnFileChange[]; next_cursor: string | null }>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController>(null);
  useEffect(() => () => request.current?.abort(), []);
  const items = [...new Map([...summary.items, ...(extra?.items ?? [])].map(item => [item.id, item])).values()];
  const cursor = extra ? extra.next_cursor : summary.items.at(-1)?.id;
  if (!scope || !summary.items.length) return null;

  async function loadMore() {
    if (!cursor || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(false);
    try {
      const page = await api.turnFileChanges(scope, turn, cursor, controller.signal);
      if (!controller.signal.aborted) setExtra(old => ({ items: [...(old?.items ?? []), ...page.items], next_cursor: page.next_cursor }));
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <section aria-label="本轮文件改动" className="mt-2 min-w-0 space-y-2">
    <ul className="space-y-2">{items.map(file => <FileCard key={file.id} file={file} scope={scope} turn={turn}/>)}</ul>
    {cursor && (extra || summary.total > items.length) && <Button variant="ghost" size="sm" disabled={loading} onClick={() => void loadMore()}>
      {loading ? "加载中…" : error ? "重试" : extra ? "加载更多" : `查看全部 ${summary.total} 个文件`}
    </Button>}
    {error && <p role="status" className="text-xs text-muted-foreground">无法加载更多文件。</p>}
  </section>;
}
