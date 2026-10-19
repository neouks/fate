"use client";
import * as React from "react";
import { appendEvidencePage, type EvidenceText } from "@/lib/evidence-pages";
import { Download, RefreshCw, ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import type { TrafficExchange, TrafficResp, TrafficDetail, EvidenceContentPage } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { TablePagination } from "@/components/table-pagination";
import { PageHeading, WorkspaceToolbar, WorkspaceEmpty, WorkspaceError } from "@/components/workspace";
import { toast } from "sonner";

export function TrafficTab({ taskId }: { taskId: string }) {
  const [data, setData] = React.useState<TrafficResp | null>(null),
    [error, setError] = React.useState(""),
    [q, setQ] = React.useState(""),
    [bodyQuery, setBodyQuery] = React.useState(""),
    [method, setMethod] = React.useState("all"),
    [status, setStatus] = React.useState(""),
    [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(50),
    [revision, refresh] = React.useReducer((n) => n + 1, 0);
  const [selected, setSelected] = React.useState<TrafficExchange | null>(null),
    [detail, setDetail] = React.useState<TrafficDetail | null>(null),
    [side, setSide] = React.useState<"request" | "response">("request"),
    [bodies, setBodies] = React.useState<Partial<Record<"request" | "response", EvidenceText>>>({}),
    [reading, setReading] = React.useState(false),
    [detailError, setDetailError] = React.useState("");
  const selectedRef = React.useRef<string | null>(null),
    request = React.useRef(0);
  React.useEffect(() => {
    let live = true;
    setError("");
    const timer = setTimeout(() => {
      void api
        .taskTraffic(taskId, {
          page: String(page - 1),
          size: String(size),
          q,
          body: bodyQuery,
          ...(method !== "all" ? { method } : {}),
          ...(status ? { status } : {}),
        })
        .then((r) => {
          if (live) setData(r);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [taskId, page, size, q, bodyQuery, method, status, revision]);
  async function read(row: TrafficExchange, which: "request" | "response", offset = 0) {
    const token = ++request.current;
    setReading(true);
    try {
      const result = await api.trafficBody(taskId, row.id, which, offset);
      if (selectedRef.current !== row.id || request.current !== token) return;
      setBodies((old) => ({ ...old, [which]: appendEvidencePage(offset ? old[which] : undefined, result) }));
      setDetailError("");
    } catch (e) {
      if (request.current === token) setDetailError((e as Error).message);
    } finally {
      if (request.current === token) setReading(false);
    }
  }
  function select(row: TrafficExchange) {
    selectedRef.current = row.id;
    setSelected(row);
    setSide("request");
    setBodies({});
    setDetail(null);
    setDetailError("");
    void api
      .trafficExchange(row.id, taskId)
      .then((r) => {
        if (selectedRef.current === row.id) setDetail(r);
      })
      .catch((e) => {
        if (selectedRef.current === row.id) setDetailError(e.message);
      });
    void read(row, "request");
  }
  function changeSide(value: string) {
    const next = value as "request" | "response";
    setSide(next);
    if (selected && !bodies[next]) void read(selected, next);
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        title="流量"
        description="查看本任务实际经过录制代理的 HTTP / HTTPS 请求。"
        actions={
          <Button variant="outline" onClick={refresh}>
            <RefreshCw />
            刷新
          </Button>
        }
      />
      <WorkspaceToolbar>
        <Input
          aria-label="搜索流量 URL"
          placeholder="搜索 URL 或路径"
          className="min-w-48 flex-1"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <Select
          value={method}
          onValueChange={(v) => {
            setMethod(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["all", "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].map((v) => (
              <SelectItem value={v} key={v}>
                {v === "all" ? "所有方法" : v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-28"
          aria-label="状态码"
          placeholder="状态码"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        />
        <Input
          className="w-52"
          aria-label="搜索响应正文"
          placeholder="搜索响应正文"
          value={bodyQuery}
          onChange={(e) => {
            setBodyQuery(e.target.value);
            setPage(1);
          }}
        />
      </WorkspaceToolbar>
      {error && <WorkspaceError error={error} onRetry={refresh} />}
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>方法</TableHead>
              <TableHead>请求地址</TableHead>
              <TableHead>状态码</TableHead>
              <TableHead>大小</TableHead>
              <TableHead>时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.exchanges?.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-xs">{row.method}</TableCell>
                <TableCell className="max-w-md">
                  <Button className="max-w-full justify-start" variant="ghost" onClick={() => select(row)}>
                    <span className="truncate">{row.url}</span>
                    <ArrowRight />
                  </Button>
                </TableCell>
                <TableCell>{row.status}</TableCell>
                <TableCell>{(row.resp_len / 1024).toFixed(1)} KB</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {new Date(row.ts).toLocaleTimeString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!data?.exchanges?.length && !error && (
          <WorkspaceEmpty
            title={data ? "暂无匹配流量" : "正在加载流量…"}
            description="没有录制记录时不会推测或补造网络请求。"
          />
        )}
      </div>
      {data && (
        <TablePagination
          page={page}
          pageSize={size}
          total={data.total ?? 0}
          onPageChange={setPage}
          onPageSizeChange={(v) => {
            setSize(v);
            setPage(1);
          }}
        />
      )}
      <Sheet
        open={!!selected}
        onOpenChange={(v) => {
          if (!v) {
            setSelected(null);
            selectedRef.current = null;
            request.current++;
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-4xl">
          <SheetHeader>
            <SheetTitle>请求详情</SheetTitle>
            <SheetDescription className="break-all">
              {selected?.method} {selected?.url}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            <Tabs value={side} onValueChange={changeSide}>
              <TabsList>
                <TabsTrigger value="request">请求</TabsTrigger>
                <TabsTrigger value="response">响应</TabsTrigger>
              </TabsList>
              {(["request", "response"] as const).map((which) => (
                <TabsContent value={which} key={which} className="flex flex-col gap-4">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={!selected}
                      onClick={() =>
                        selected &&
                        api.downloadTrafficBody(taskId, selected.id, which).catch((e) => toast.error(e.message))
                      }
                    >
                      <Download />
                      下载原始正文
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const url = new URL(window.location.href);
                        url.searchParams.set("tab", "findings");
                        window.history.pushState(null, "", url);
                        setSelected(null);
                      }}
                    >
                      在发现详情中绑定证据
                    </Button>
                  </div>
                  {detailError && selected && (
                    <WorkspaceError error={detailError} onRetry={() => void read(selected, which)} />
                  )}
                  <pre className="overflow-auto rounded-xl border bg-muted/40 p-4 text-xs leading-relaxed">
                    {(which === "request" ? detail?.req : detail?.resp)?.split("\r\n\r\n")[0] || "正在读取头部…"}
                  </pre>
                  <pre className="min-h-48 max-h-[55dvh] overflow-auto rounded-xl border bg-card p-4 text-xs leading-relaxed">
                    {bodies[which]?.text || (reading ? "正在读取正文…" : "空正文")}
                  </pre>
                  {bodies[which]?.page.truncated && selected && (
                    <Button
                      variant="outline"
                      disabled={reading}
                      onClick={() => void read(selected, which, bodies[which]!.page.next_offset)}
                    >
                      继续读取（{bodies[which]!.page.next_offset} / {bodies[which]!.page.total} 字节）
                    </Button>
                  )}
                </TabsContent>
              ))}
            </Tabs>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
