"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeftIcon, DownloadIcon, EllipsisIcon, ListFilterIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";

import { FindingDeleteDialog } from "@/components/finding-delete-dialog";
import { FindingDetailContent } from "@/components/finding-detail-content";
import { TablePagination } from "@/components/table-pagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspaceState } from "@/hooks/use-workspace-state";
import { api } from "@/lib/api";
import { FINDING_STATUSES, SEVERITIES, findingRowKey } from "@/lib/findings";
import { useStoredSortPreference } from "@/lib/sort-preference";
import { statusMeta } from "@/lib/status";
import { taskViewURL } from "@/lib/task-navigation";
import type { Finding, FindingStatus, FindingsPage, Severity } from "@/lib/types";

const SORT_FIELDS = ["time"] as const;
const OWNERSHIP = [
  ["all", "全部发现"],
  ["current", "当前任务"],
  ["inherited", "来源任务"],
] as const;
type Ownership = (typeof OWNERSHIP)[number][0];
const STATUS_OPTIONS = FINDING_STATUSES.map((value) => [value, statusMeta("finding", value).label] as const);
const SEVERITY_OPTIONS = SEVERITIES.map((value) => [value, statusMeta("severity", value).label] as const);
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
const relativeFormat = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

function reference(finding: Finding) {
  return finding.finding_id ? `record:${finding.finding_id}` : `node:${finding.id}`;
}

function findingTime(ts: string) {
  const time = new Date(ts);
  if (!Number.isFinite(time.getTime())) return null;
  const days = Math.round((time.getTime() - Date.now()) / 86400000);
  const absolute = dateFormat.format(time);
  return (
    <time dateTime={ts} title={absolute}>
      {Math.abs(days) < 30 ? relativeFormat.format(days, "day") : absolute}
    </time>
  );
}

async function copyLink(href: string) {
  try {
    await navigator.clipboard.writeText(new URL(href, window.location.origin).href);
    toast.success("已复制漏洞链接");
  } catch {
    toast.error("复制失败，请重试");
  }
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(selected) => {
        const option = options.find(([key]) => key === selected);
        if (option) onChange(option[0]);
      }}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

interface TaskFindingsProps {
  taskId: string;
  findingRef: string | null;
  active: boolean;
  search: string;
}

export function FindingsTab(props: TaskFindingsProps) {
  return <TaskFindings key={props.taskId} {...props} />;
}

function TaskFindings({ taskId, findingRef, active, search }: TaskFindingsProps) {
  const [sort, setSort] = useStoredSortPreference("series_task_findings_sort", SORT_FIELDS, "time", "desc");
  const [query, setQuery] = useWorkspaceState(`task:${taskId}`, "finding-query", "");
  const [severity, setSeverity] = useWorkspaceState<Severity | "all">(`task:${taskId}`, "finding-severity", "all");
  const [status, setStatus] = useWorkspaceState<FindingStatus | "all">(`task:${taskId}`, "finding-status", "all");
  const [ownership, setOwnership] = useWorkspaceState<Ownership>(`task:${taskId}`, "finding-ownership", "all");
  const [vulnclass, setVulnclass] = useWorkspaceState(`task:${taskId}`, "finding-class", "");
  const [page, setPage] = useWorkspaceState(`task:${taskId}`, "finding-page", 1);
  const [pageSize, setPageSize] = useWorkspaceState(`task:${taskId}`, "finding-page-size", 50);
  const [savedReturnPoint, setSavedReturnPoint] = useWorkspaceState<{
    scroll: number;
    key: string;
    finding: string;
  } | null>(`task:${taskId}`, "finding-return", null);
  const [result, setResult] = React.useState<{ key: string; data: FindingsPage }>();
  const [failure, setFailure] = React.useState<{ key: string; error: string }>();
  const [checked, setChecked] = React.useState<Set<string>>(() => new Set());
  const [deleteTarget, setDeleteTarget] = React.useState<Finding | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  const list = React.useRef<HTMLDivElement>(null);
  const listTitle = React.useRef<HTMLHeadingElement>(null);
  const detailTitle = React.useRef<HTMLDivElement>(null);
  const returnPoint = React.useRef<{ scroll: number; key: string; finding: string } | null>(null);
  const previousFinding = React.useRef<string | null>(null);
  const searchText = query.trim();
  const classText = vulnclass.trim();
  const key = JSON.stringify([page, pageSize, sort.direction, searchText, severity, status, ownership, classText]);
  const data = result?.key === key ? result.data : undefined;
  const error = failure?.key === key ? failure.error : "";

  React.useEffect(() => {
    if (!active || findingRef !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const value = await api.taskFindingsPage(taskId, page, pageSize, sort.direction, {
          q: searchText,
          severity,
          status,
          ownership,
          vulnclass: classText,
        });
        if (cancelled) return;
        const lastPage = Math.max(1, Math.ceil(value.total / pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          setChecked(new Set());
          return;
        }
        setResult({ key, data: value });
        setFailure(undefined);
      } catch (e) {
        if (!cancelled) setFailure({ key, error: (e as Error).message });
      } finally {
        if (!cancelled) timer = setTimeout(load, 3000);
      }
    }
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    active,
    findingRef,
    taskId,
    page,
    pageSize,
    sort.direction,
    revision,
    searchText,
    severity,
    status,
    ownership,
    classText,
    key,
    setPage,
  ]);

  React.useLayoutEffect(() => {
    if (!active || previousFinding.current === findingRef) return;
    const panel = list.current?.parentElement;
    if (findingRef !== null) {
      if (panel) panel.scrollTop = 0;
      detailTitle.current?.focus({ preventScroll: true });
    } else {
      const point = savedReturnPoint?.finding === previousFinding.current ? savedReturnPoint : null;
      if (point && !data && !error) return;
      if (panel) panel.scrollTop = point?.scroll ?? 0;
      const row = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-finding-key]") ?? []).find(
        (element) => element.dataset.findingKey === point?.key,
      );
      (row ?? listTitle.current)?.focus({ preventScroll: true });
    }
    previousFinding.current = findingRef;
  }, [active, findingRef, savedReturnPoint, data, error]);

  function resetPage(next = 1) {
    setPage(next);
    setChecked(new Set());
  }

  function hrefFor(finding: Finding) {
    return taskViewURL(search, { id: taskId, tab: "findings", panel: null, finding: reference(finding) });
  }

  function remember(finding: Finding) {
    const point = {
      scroll: list.current?.parentElement?.scrollTop ?? 0,
      key: findingRowKey(finding),
      finding: reference(finding),
    };
    returnPoint.current = point;
    setSavedReturnPoint(point);
  }

  function backToList() {
    if (returnPoint.current?.finding === findingRef) window.history.back();
    else window.history.replaceState(null, "", taskViewURL(window.location.search, { finding: null }));
  }

  const ids = (data?.items ?? []).flatMap((item) =>
    item.finding_id && checked.has(item.finding_id) ? [item.finding_id] : [],
  );
  const filtered = Boolean(searchText || classText || severity !== "all" || status !== "all" || ownership !== "all");

  async function exportResults(format: "csv" | "json" | "md-single") {
    setExporting(true);
    try {
      await api.exportFindings({
        format,
        scope: ids.length ? "selected" : "filtered",
        ids,
        contextTask: taskId,
        ownership,
        filters: { query: searchText, severity, status, vulnclass: classText },
      });
    } catch (e) {
      toast.error(`导出失败：${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

  async function deleteFinding(finding: Finding, reason: string) {
    if (!finding.finding_id || finding.inherited) return;
    await api.deleteFinding(finding.finding_id, reason, taskId);
    setResult((current) => {
      if (!current?.data.items.some((item) => item.finding_id === finding.finding_id)) return current;
      return {
        ...current,
        data: {
          ...current.data,
          items: current.data.items.filter((item) => item.finding_id !== finding.finding_id),
          total: current.data.total - 1,
        },
      };
    });
    setChecked((current) => {
      const next = new Set(current);
      next.delete(finding.finding_id!);
      return next;
    });
    if (findingRef === reference(finding)) backToList();
    refresh();
  }

  return (
    <>
      <div ref={list} hidden={findingRef !== null} className="task-findings">
        <div className="task-findings-body">
          <header className="task-findings-heading">
            <h1 ref={listTitle} tabIndex={-1}>
              {OWNERSHIP.find(([value]) => value === ownership)?.[1] ?? "全部发现"}
            </h1>
            {data && <span>{data.total} 项发现</span>}
          </header>
          <div className="findings-search">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="搜索发现"
                placeholder="搜索发现"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  resetPage();
                }}
              />
            </InputGroup>
            <FilterSelect
              label="发现排序"
              value={sort.direction}
              options={[
                ["desc", "最新发现"],
                ["asc", "最早发现"],
              ]}
              onChange={(value) => {
                setSort({ field: "time", direction: value as "asc" | "desc" });
                resetPage();
              }}
            />
          </div>
          <div className="findings-filters">
            <FilterSelect
              label="发现范围"
              value={ownership}
              options={OWNERSHIP}
              onChange={(value) => {
                setOwnership(value as Ownership);
                resetPage();
              }}
            />
            <FilterSelect
              label="发现状态"
              value={status}
              options={[["all", "状态"], ...STATUS_OPTIONS]}
              onChange={(value) => {
                setStatus(value);
                resetPage();
              }}
            />
            <FilterSelect
              label="发现严重性"
              value={severity}
              options={[["all", "严重性"], ...SEVERITY_OPTIONS]}
              onChange={(value) => {
                setSeverity(value);
                resetPage();
              }}
            />
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">
                  <ListFilterIcon data-icon="inline-start" />
                  筛选
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="flex flex-col gap-3">
                <Field>
                  <FieldLabel htmlFor="task-finding-class">漏洞类型</FieldLabel>
                  <Input
                    id="task-finding-class"
                    placeholder="输入完整类型，例如 IDOR"
                    value={vulnclass}
                    onChange={(event) => {
                      setVulnclass(event.target.value);
                      resetPage();
                    }}
                  />
                </Field>
                <p className="break-words text-sm text-muted-foreground">
                  {[
                    searchText,
                    ownership !== "all" && OWNERSHIP.find(([value]) => value === ownership)?.[1],
                    status !== "all" && statusMeta("finding", status).label,
                    severity !== "all" && statusMeta("severity", severity).label,
                    classText,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "未设置筛选条件"}
                </p>
                <Button
                  variant="outline"
                  disabled={!filtered}
                  onClick={() => {
                    setQuery("");
                    setStatus("all");
                    setSeverity("all");
                    setOwnership("all");
                    setVulnclass("");
                    resetPage();
                  }}
                >
                  清除筛选
                </Button>
              </PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="导出发现"
                  title="导出发现"
                  disabled={!data?.total || exporting}
                >
                  {exporting ? <Spinner /> : <DownloadIcon />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => void exportResults("csv")}>
                    导出 {ids.length ? `已选 ${ids.length} 条` : "筛选结果"}为 CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportResults("json")}>导出为 JSON</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportResults("md-single")}>导出为 Markdown</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {error && (
            <Alert>
              <AlertDescription>
                加载失败：{error}
                <Button variant="outline" size="sm" onClick={refresh}>
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!data && !error && (
            <div className="flex justify-center p-8" role="status" aria-label="加载发现">
              <Spinner />
            </div>
          )}
          {data?.items.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>暂无发现</EmptyTitle>
                <EmptyDescription>
                  {filtered ? "试试调整搜索或筛选条件。" : "此任务目前没有可查看的漏洞发现。"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {!!data?.items.length && (
            <ul className="finding-list">
              {data.items.map((item) => {
                const title = item.name || item.vulnclass || "未分类";
                const href = hrefFor(item);
                const rowKey = findingRowKey(item);
                const id = item.finding_id;
                const time = findingTime(item.ts);
                return (
                  <li className="task-finding-row" key={rowKey}>
                    <Checkbox
                      aria-label={`选择 ${title}`}
                      disabled={!id}
                      checked={!!id && checked.has(id)}
                      onCheckedChange={(value) => {
                        if (!id) return;
                        setChecked((current) => {
                          const next = new Set(current);
                          if (value === true) next.add(id);
                          else next.delete(id);
                          return next;
                        });
                      }}
                    />
                    <Link
                      href={href}
                      scroll={false}
                      onNavigate={() => remember(item)}
                      className="finding-list-copy task-finding-link"
                      data-finding-key={rowKey}
                    >
                      <span className="finding-list-title" title={title}>
                        {title}
                      </span>
                      <span className="finding-list-meta">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="finding-severity-dot" data-severity={item.severity} aria-hidden="true" />
                          {statusMeta("severity", item.severity).label}
                        </span>
                        <span>{statusMeta("finding", item.status).label}</span>
                        {time && <span>{time}</span>}
                        {item.assets?.[0] && (
                          <span title={item.assets.map((asset) => asset.label).join("、")}>
                            {item.assets[0].label}
                            {item.assets.length > 1 ? ` +${item.assets.length - 1}` : ""}
                          </span>
                        )}
                        <span>{id ? `#${id}` : `节点 #${item.id}`}</span>
                        {item.inherited && <span>来源任务 · 只读</span>}
                      </span>
                    </Link>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${title} 的更多操作`}>
                          <EllipsisIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuGroup>
                          <DropdownMenuItem asChild>
                            <Link href={href} scroll={false} onNavigate={() => remember(item)}>
                              查看详情
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void copyLink(href)}>复制链接</DropdownMenuItem>
                          {id && !item.inherited && (
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget(item)}>
                              删除
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {data && (
          <footer className="task-findings-footer">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={data.total}
              onPageChange={resetPage}
              onPageSizeChange={(value) => {
                setPageSize(value);
                resetPage();
              }}
            />
          </footer>
        )}
      </div>
      {active && findingRef !== null && (
        <div ref={detailTitle} tabIndex={-1} role="region" aria-label="漏洞详情" className="task-finding-detail">
          <TaskFindingDetail
            key={findingRef}
            taskId={taskId}
            findingRef={findingRef}
            onBack={backToList}
            onDelete={deleteFinding}
          />
        </div>
      )}
      {deleteTarget && (
        <FindingDeleteDialog
          finding={deleteTarget}
          onDelete={deleteFinding}
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      )}
    </>
  );
}

function TaskFindingDetail({
  taskId,
  findingRef,
  onBack,
  onDelete,
}: {
  taskId: string;
  findingRef: string;
  onBack: () => void;
  onDelete: (finding: Finding, reason: string) => Promise<void>;
}) {
  const [finding, setFinding] = React.useState<Finding>();
  const [error, setError] = React.useState("");
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const [, kind, id] = /^(record|node):([A-Za-z0-9_-]+)$/.exec(findingRef) ?? [];
    if (!id) {
      setError("漏洞链接无效。");
      return;
    }
    let active = true;
    const request = kind === "record" ? api.getFinding(id, taskId) : api.taskLegacyFinding(taskId, id);
    request
      .then((value) => {
        if (active) {
          setFinding(value);
          setError("");
        }
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [taskId, findingRef, revision]);
  if (finding && !error)
    return (
      <FindingDetailContent
        finding={finding}
        contextTask={taskId}
        onRefresh={refresh}
        onDelete={onDelete}
        onBack={onBack}
        onCopyLink={() => void copyLink(window.location.href)}
      />
    );
  return (
    <div className="flex flex-col items-start gap-5">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeftIcon data-icon="inline-start" />
        返回发现
      </Button>
      {error ? (
        <Alert>
          <AlertDescription>
            无法查看漏洞：{error}
            <Button variant="outline" size="sm" onClick={refresh}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex items-center gap-2" role="status">
          <Spinner />
          加载漏洞详情…
        </div>
      )}
    </div>
  );
}
