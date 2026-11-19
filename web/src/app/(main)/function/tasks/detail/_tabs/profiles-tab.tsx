"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import { FingerprintIcon, RefreshCwIcon, ServerIcon } from "lucide-react";

import { TablePagination } from "@/components/table-pagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { taskViewURL } from "@/lib/task-navigation";
import type { ProfileComponent, TaskAssetProfile, TaskProfilesPage } from "@/lib/types";

const observedTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });
const formatTime = (time: string) => observedTime.format(new Date(time));

type Observation = TaskAssetProfile["observations"][number];

function CategoryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-2 break-words">{children}</CardContent>
    </Card>
  );
}

function ComponentCards({ items, taskId }: { items: ProfileComponent[]; taskId: string }) {
  const categories = Map.groupBy(items, (item) => item.category);
  return Array.from(categories, ([category, components]) => (
    <CategoryCard key={category} title={category}>
      {Array.from(
        Map.groupBy(components, (c) => JSON.stringify([c.name.toLowerCase(), c.version.toLowerCase(), c.historical])),
        ([key, entries]) => (
          <details key={key}>
            <summary className="cursor-pointer">
              <strong>
                {entries[0].name} {entries[0].version}
              </strong>
              {entries[0].historical && "（历史记录）"}
            </summary>
            <ul className="flex flex-col gap-1 pt-1 text-xs">
              {entries.flatMap((c) =>
                c.sources.map((source) => (
                  <li key={JSON.stringify([c.asset_id, source.kind, source.id])}>
                    <Link
                      prefetch={false}
                      className="underline underline-offset-2"
                      href={taskViewURL(
                        "",
                        source.kind === "fact"
                          ? { id: taskId, tab: "graph", node: source.id }
                          : { id: taskId, tab: "sessions", session: source.session, activity: source.id },
                      )}
                    >
                      {c.asset_id && `资产 #${c.asset_id} · `}
                      {source.role} · {source.kind === "fact" ? "事实" : "消息"} #{source.id} ·{" "}
                      {formatTime(source.seen)}
                    </Link>
                  </li>
                )),
              )}
            </ul>
          </details>
        ),
      )}
    </CategoryCard>
  ));
}

function endpointLabel(o: Observation) {
  if (!o.url) return "";
  try {
    const url = new URL(o.url);
    return [o.method, url.pathname + url.search].filter(Boolean).join(" ");
  } catch {
    return [o.method, o.url].filter(Boolean).join(" ");
  }
}

function HostCards({
  host,
  ip,
  rows,
  components,
  taskId,
}: {
  host: string;
  ip: string;
  rows: Observation[];
  components: ProfileComponent[];
  taskId: string;
}) {
  const domains = new Set(rows.flatMap((o) => o.bound_domains).filter((d) => ![ip, host].includes(d.toLowerCase())));
  const ids = new Set(rows.map((o) => o.asset_id));
  const items = components.filter((c) => c.asset_id && ids.has(c.asset_id));
  const named = new Set(
    items
      .filter((c) => !c.historical)
      .flatMap((c) => [c.name, [c.name, c.version].filter(Boolean).join(" ")])
      .map((s) => s.toLowerCase()),
  );
  const technologies = [...new Set(rows.flatMap((o) => o.technologies))].filter((s) => !named.has(s.toLowerCase()));
  const responses = Map.groupBy(
    rows.filter((o) => o.status_code != null || o.title || o.url),
    (o) => JSON.stringify([o.url ? o.url.split("://")[0] : "", endpointLabel(o)]),
  );
  const protection = new Set(
    rows.flatMap((o) =>
      [
        o.waf && `WAF · ${o.waf.detected ? "已检出" : "未检出"} · ${formatTime(o.waf.observed_at)}`,
        o.source_ip_block &&
          `来源 IP ${o.source_ip_block.source_ip} · ${o.source_ip_block.detected ? "已封禁" : "未观察到封禁"} · ${formatTime(o.source_ip_block.observed_at)}`,
      ].filter(Boolean),
    ),
  );
  return (
    <section className="flex min-w-0 flex-col gap-2">
      {host !== ip && <h4 className="break-all font-medium font-mono">{host}</h4>}
      <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <CategoryCard title="资产信息">
          {domains.size > 0 && <p>关联域名 · {[...domains].join("、")}</p>}
          {Array.from(responses, ([key, group]) => {
            const o = group[0];
            const codes = [...new Set(group.flatMap((row) => (row.status_code == null ? [] : [row.status_code])))];
            const titles = [...new Set(group.flatMap((row) => (row.title ? [row.title] : [])))];
            return (
              <div key={key} className="flex flex-wrap items-center gap-2">
                {o.url && <span className="break-all font-mono text-xs">{endpointLabel(o)}</span>}
                {codes.length ? (
                  codes.map((code) => (
                    <Badge key={code} variant="secondary">
                      HTTP {code}
                    </Badge>
                  ))
                ) : (
                  <span className="text-muted-foreground">状态码未记录</span>
                )}
                {titles.map((title) => (
                  <span key={title}>{title}</span>
                ))}
              </div>
            );
          })}
          {!responses.size && <span className="text-muted-foreground">状态码未记录</span>}
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer">来源资产（{ids.size}）</summary>
            {Array.from(new Map(rows.map((o) => [o.asset_id, o])).values(), (o) => (
              <div key={o.asset_id} className="break-all pt-1">
                #{o.asset_id} · {[o.method, o.url || host].filter(Boolean).join(" ")}
                {o.status_code != null && ` · HTTP ${o.status_code}`} · {formatTime(o.seen)}
              </div>
            ))}
          </details>
        </CategoryCard>
        {technologies.length > 0 && <CategoryCard title="登记技术栈">{technologies.join("、")}</CategoryCard>}
        <ComponentCards items={items} taskId={taskId} />
        <CategoryCard title="防护记录">
          {protection.size ? (
            Array.from(protection, (label) => <span key={label}>{label}</span>)
          ) : (
            <span className="text-muted-foreground">WAF 与来源 IP 封禁状态未知</span>
          )}
        </CategoryCard>
      </div>
    </section>
  );
}

function ProfileRow({
  profile,
  taskId,
  components,
}: {
  profile: TaskAssetProfile;
  taskId: string;
  components: ProfileComponent[];
}) {
  const { ip, port, observations } = profile;
  const hosts = Map.groupBy(observations, (o) => o.domain?.replace(/^\[|\]$/g, "").toLowerCase() || ip);
  const services = [...new Set(observations.flatMap((o) => (o.service ? [o.service.toUpperCase()] : [])))];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ServerIcon className="size-4" />
          <span className="break-all font-mono">
            {ip.includes(":") ? `[${ip}]` : ip}:{port}
          </span>
          {services.map((s) => (
            <Badge key={s} variant="outline">
              {s}
            </Badge>
          ))}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {Array.from(hosts, ([host, rows]) => (
          <HostCards key={host} host={host} ip={ip} rows={rows} components={components} taskId={taskId} />
        ))}
      </CardContent>
    </Card>
  );
}

export function ProfilesTab({ taskId }: { taskId: string }) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; data: TaskProfilesPage } | null>(null);
  const key = [taskId, page, limit].join("/");
  const data = loaded?.key === key ? loaded.data : null;
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refresh button reloads the current page.
  useEffect(() => {
    const controller = new AbortController();
    let revision: string | undefined;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api.taskProfiles(taskId, page, limit, controller.signal, revision);
        if (controller.signal.aborted) return;
        revision = result.revision;
        if (!("unchanged" in result))
          setLoaded({
            key,
            data: {
              ...result,
              components: result.components ?? [],
              standalone_asset_ids: result.standalone_asset_ids ?? [],
            },
          });
        setError("");
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "画像加载失败");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [taskId, page, limit, key, reload]);
  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-medium">
          <FingerprintIcon className="size-5" />
          资产画像
        </h2>
        <Button size="sm" variant="outline" onClick={() => setReload((v) => v + 1)}>
          <RefreshCwIcon data-icon="inline-start" />
          刷新
        </Button>
      </header>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!data && !error && <Spinner aria-label="正在加载画像" />}
      {data && (
        <>
          {data.components.some((c) => !c.asset_id) && (
            <section className="flex flex-col gap-2 rounded-lg border p-3">
              <h3 className="font-medium text-sm">待关联资产</h3>
              <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <ComponentCards items={data.components.filter((c) => !c.asset_id)} taskId={taskId} />
              </div>
            </section>
          )}
          {data.standalone_asset_ids.map((id) => (
            <section key={id} className="flex flex-col gap-2 rounded-lg border p-3">
              <h3 className="font-medium text-sm">资产 #{id}</h3>
              <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <ComponentCards items={data.components.filter((c) => c.asset_id === id)} taskId={taskId} />
              </div>
            </section>
          ))}
          {data.items.length ? (
            <div className="flex flex-col gap-3">
              {data.items.map((p) => (
                <ProfileRow
                  key={`${p.ip}/${p.port}`}
                  profile={p}
                  taskId={taskId}
                  components={data.components.filter(
                    (c) => c.asset_id && !data.standalone_asset_ids.includes(c.asset_id),
                  )}
                />
              ))}
            </div>
          ) : (
            !data.components.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ServerIcon />
                  </EmptyMedia>
                  <EmptyTitle>暂无资产画像</EmptyTitle>
                  <EmptyDescription>任务中有明确 IP 和端口的资产会出现在这里。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
          )}
          {(data.total > limit || page > 1 || limit !== 25) && (
            <TablePagination
              page={page}
              total={data.total}
              pageSize={limit}
              pageSizeOptions={[10, 25, 50]}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPage(1);
                setLimit(size);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
