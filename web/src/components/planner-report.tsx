"use client";

import * as React from "react";
import { GraphNodeReader } from "@/components/graph-node-reader";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";

type ReportItem = { intent_id: number | null; activity: string; status: string; summary?: string };
type Section = { items: ReportItem[]; total: number; partial: boolean; next_offset: number | null };
export type PlannerReportData = {
  status: string;
  dispatch: Section & { created_total: number };
  steering: Section;
  actions: {
    items: { name: string; total: number; succeeded: number; failed: number; unknown: number; activity: string }[];
    partial: boolean;
  };
};

const statusLabels: Record<string, string> = {
  created: "已提交", duplicate: "去重命中", replayed: "历史回执重放", failed: "失败",
  unknown: "无法核对", submitted: "已提交", delivered: "已交付",
  stopped: "已停止", interrupted: "已中断", exhausted: "预算耗尽", paused: "已暂停", blocked: "受阻", timeout: "超时",
};
const decimal = /^[1-9]\d*$/;
const intentAnchor = /^#planner-report-intent-([1-9]\d*)$/;
const activityURL = /^\/function\/tasks\/detail\?id=[1-9]\d*&tab=sessions&section=chat&session=plan&activity=[1-9]\d*$/;
const allowReportLink = (href: string) => intentAnchor.test(href) || activityURL.test(href);

export function plannerTableCell(text: string) {
  return text.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, "\\$&");
}

function table(headings: string[], rows: string[][]) {
  return [headings, headings.map(() => "---"), ...rows].map(row => `| ${row.join(" | ")} |`).join("\n");
}
const intent = (id: number | null) =>
  id !== null && Number.isSafeInteger(id) && id > 0 ? `[#${id}](#planner-report-intent-${id})` : "—";
const source = (task: string, activity: string) => decimal.test(activity) ?
  `[查看活动](/function/tasks/detail?${new URLSearchParams({ id: task, tab: "sessions", section: "chat", session: "plan", activity })})` : "—";

function ReportSection({ title, content, partial, next, loading, onMore, wrapSummary }: {
  title: string; content: string; partial: boolean; next?: number | null; loading?: boolean; onMore?: () => void; wrapSummary?: boolean;
}) {
  return <section className="planner-report-section flex min-w-0 flex-col gap-2" data-wrap-summary={wrapSummary || undefined}>
    <h4 className="text-sm font-semibold">{title}</h4>
    {content ? <Markdown text={content} allowLink={allowReportLink} /> : !partial && <p className="text-sm text-muted-foreground">本轮无记录</p>}
    {partial && <p className="text-sm text-muted-foreground">部分记录不足，无法核对。</p>}
    {next != null && <Button type="button" variant="outline" size="sm" className="self-start"
      aria-label={`查看更多${title}`} disabled={loading} onClick={onMore}>{loading ? "读取中…" : "查看更多"}</Button>}
  </section>;
}

export function PlannerReport({ task, turn, revision }: { task: string; turn?: string; revision?: string | number }) {
  const [data, setData] = React.useState<PlannerReportData>();
  const [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  const [more, setMore] = React.useState<"dispatch" | "steering">();
  const [nodeID, setNodeID] = React.useState<string>();
  const [visible, setVisible] = React.useState(false);
  const root = React.useRef<HTMLElement>(null);
  const paging = React.useRef<AbortController | null>(null);
  const opener = React.useRef<HTMLAnchorElement | null>(null);

  React.useEffect(() => {
    if (!turn || visible || !root.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: "160px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [turn, visible]);

  React.useEffect(() => {
    if (!turn || !visible) return;
    const controller = new AbortController();
    setError("");
    setMore(undefined);
    void api.plannerReport(task, turn, {}, controller.signal).then(report => {
      if (!controller.signal.aborted) setData(report);
    }).catch(() => {
      if (!controller.signal.aborted) setError("规划报告暂不可读取。");
    });
    return () => { controller.abort(); paging.current?.abort(); };
  }, [task, turn, revision, retry, visible]);

  async function loadMore(section: "dispatch" | "steering") {
    const offset = data?.[section].next_offset;
    if (!turn || more || offset == null) return;
    const controller = new AbortController();
    paging.current = controller;
    setMore(section);
    setError("");
    try {
      const report = await api.plannerReport(task, turn, { [section]: offset }, controller.signal);
      if (controller.signal.aborted) return;
      setData(current => {
        if (!current || current[section].next_offset !== offset) return current;
        return { ...current, [section]: { ...report[section], items: [...current[section].items, ...report[section].items] } };
      });
    } catch {
      if (!controller.signal.aborted) setError("续读失败，可再次点击查看更多。");
    } finally {
      if (!controller.signal.aborted) setMore(undefined);
    }
  }

  return <section ref={root} aria-label="本轮规划报告" className="flex w-full min-w-0 flex-col gap-4 rounded-xl border p-3 sm:p-4"
    onClick={event => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      const match = anchor && intentAnchor.exec(anchor.getAttribute("href") ?? "");
      if (match) {
        event.preventDefault();
        opener.current = anchor;
        setNodeID(match[1]);
      }
    }}>
    <h3 className="text-base font-semibold">本轮规划报告</h3>
    {!turn && <p className="text-sm text-muted-foreground">历史轮次缺少标识，无法核对。可展开原始回执查看。</p>}
    {turn && !data && !error && <p role="status" className="text-sm text-muted-foreground">正在读取规划报告…</p>}
    {error && <div role="status" className="text-sm text-muted-foreground">
      {error}{!data && <Button type="button" variant="link" onClick={() => setRetry(value => value + 1)}>重试</Button>}
    </div>}
    {data && <>
      {["failed", "stopped", "interrupted", "exhausted", "paused", "blocked", "timeout"].includes(data.status) &&
        <p className="text-sm text-muted-foreground">{statusLabels[data.status]}。以下为可核对的记录。</p>}
      {data.dispatch.total > 0 && <p className="text-sm text-muted-foreground">
        已确认新增 {data.dispatch.created_total} 条，显示 {data.dispatch.items.length} / {data.dispatch.total} 条派单记录。
      </p>}
      <ReportSection title="新增意图" partial={data.dispatch.partial} next={data.dispatch.next_offset} wrapSummary
        loading={!!more} onMore={() => void loadMore("dispatch")}
        content={data.dispatch.items.length ? table(["意图", "方向摘要", "状态", "来源"], data.dispatch.items.map(row =>
          [intent(row.intent_id), plannerTableCell(row.summary || "—"), statusLabels[row.status] ?? "无法核对", source(task, row.activity)])) : ""} />
      <ReportSection title="意图纠偏" partial={data.steering.partial} next={data.steering.next_offset}
        loading={!!more} onMore={() => void loadMore("steering")}
        content={data.steering.items.length ? table(["意图", "状态", "来源"], data.steering.items.map(row =>
          [intent(row.intent_id), statusLabels[row.status] ?? "无法核对", source(task, row.activity)])) : ""} />
      <ReportSection title="本轮做了什么" partial={data.actions.partial}
        content={data.actions.items.length ? table(["操作", "次数", "结果", "来源"], data.actions.items.map(row =>
          [plannerTableCell(row.name), String(row.total), `成功 ${row.succeeded} · 失败 ${row.failed} · 待核对 ${row.unknown}`, source(task, row.activity)])) : ""} />
    </>}
    <Dialog open={nodeID !== undefined} onOpenChange={open => { if (!open) setNodeID(undefined); }}>
      <DialogContent className="sm:max-w-2xl" onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}>
        <DialogHeader className="pr-8">
          <DialogTitle>意图 #{nodeID}</DialogTitle>
          <DialogDescription>查看已保存的意图记录。</DialogDescription>
        </DialogHeader>
        {nodeID && <GraphNodeReader taskID={task} nodeID={nodeID} kind="intent" />}
      </DialogContent>
    </Dialog>
  </section>;
}
