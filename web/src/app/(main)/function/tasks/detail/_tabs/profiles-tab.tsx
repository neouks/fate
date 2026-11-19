"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import {
  BanIcon,
  BlocksIcon,
  ChevronDownIcon,
  DatabaseIcon,
  FingerprintIcon,
  GlobeIcon,
  LayersIcon,
  RefreshCwIcon,
  ServerCogIcon,
  ServerIcon,
  ShieldIcon,
} from "lucide-react";

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

const componentStyles = {
  数据库: { icon: DatabaseIcon, variant: "info" },
  中间件: { icon: ServerCogIcon, variant: "warning" },
  "Web 服务器": { icon: ServerIcon, variant: "warning" },
  框架: { icon: BlocksIcon, variant: "success" },
} as const;

function TechnologyStack({
  items,
  technologies = [],
  taskId,
}: {
  items: ProfileComponent[];
  technologies?: string[];
  taskId: string;
}) {
  const named = new Set(
    items
      .filter((c) => !c.historical)
      .flatMap((c) => [c.name, [c.name, c.version].filter(Boolean).join(" ")])
      .map((s) => s.toLowerCase()),
  );
  const registered = [
    ...new Map(
      technologies.filter((s) => s.trim() && !named.has(s.toLowerCase())).map((s) => [s.toLowerCase(), s]),
    ).values(),
  ];
  const groups = Map.groupBy(items, (c) =>
    JSON.stringify([c.category, c.name.toLowerCase(), c.version.toLowerCase(), c.historical]),
  );
  return (
    <section aria-label="登记技术栈" className="flex min-w-0 flex-col gap-1.5">
      <h4 className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <LayersIcon className="size-3.5" aria-hidden="true" />
        登记技术栈
      </h4>
      <div className="flex min-w-0 flex-wrap items-start gap-1.5">
        {registered.map((name) => (
          <Badge key={name} variant="secondary" className="max-w-full" title={name}>
            <LayersIcon data-icon="inline-start" />
            <span className="truncate">{name}</span>
          </Badge>
        ))}
        {Array.from(groups, ([key, entries]) => {
          const component = entries[0];
          const { icon: Icon, variant } = componentStyles[component.category as keyof typeof componentStyles] ?? {
            icon: LayersIcon,
            variant: "info" as const,
          };
          const label = [component.name, component.version].filter(Boolean).join(" ");
          return (
            <details key={key} className="group/technology min-w-0 max-w-full open:basis-full">
              <summary
                aria-label={`${component.category} ${label}${component.historical ? "（历史）" : ""}，查看来源`}
                className="w-fit max-w-full cursor-pointer list-none rounded-full focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
              >
                <Badge
                  variant={component.historical ? "outline" : variant}
                  className="max-w-full"
                  title={component.category}
                >
                  <Icon data-icon="inline-start" />
                  <span className="truncate">
                    {label}
                    {component.historical && " · 历史"}
                  </span>
                  <ChevronDownIcon
                    data-icon="inline-end"
                    className="transition-transform group-open/technology:rotate-180"
                  />
                </Badge>
              </summary>
              <ul className="flex flex-col gap-1 py-2 text-muted-foreground text-xs">
                {entries.flatMap((c) =>
                  c.sources.map((source) => (
                    <li key={JSON.stringify([c.asset_id, source.kind, source.id])}>
                      <Link
                        prefetch={false}
                        className="break-words underline underline-offset-2"
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
          );
        })}
        {!registered.length && !items.length && <span className="text-muted-foreground text-xs">暂未登记</span>}
      </div>
    </section>
  );
}

function StatusBadge({ code }: { code: number }) {
  const variants = ["secondary", "secondary", "success", "info", "warning", "destructive"] as const;
  return <Badge variant={variants[Math.floor(code / 100)] ?? "secondary"}>{code}</Badge>;
}

function HostDetails({
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
  const ids = new Set(rows.map((o) => o.asset_id));
  const responses = Map.groupBy(
    rows.filter((o) => o.title || o.status_code != null),
    (o) => JSON.stringify([o.title || "", o.status_code]),
  );
  const protections = new Map(
    rows
      .flatMap((o) => [
        ...(o.waf ? [{ label: `WAF ${o.waf.detected ? "已检出" : "未检出"}`, value: o.waf, icon: ShieldIcon }] : []),
        ...(o.source_ip_block
          ? [
              {
                label: `来源 IP ${o.source_ip_block.detected ? "已封禁" : "未封禁"}`,
                value: o.source_ip_block,
                icon: BanIcon,
              },
            ]
          : []),
      ])
      .map((p) => [JSON.stringify([p.label, p.value.source_ip]), p]),
  );
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      {host !== ip && (
        <h3 className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <GlobeIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate" title={host}>
            {host}
          </span>
        </h3>
      )}
      <section aria-label="资产信息" className="flex min-w-0 flex-col gap-1.5">
        {responses.size ? (
          Array.from(responses, ([key, group]) => (
            <div key={key} className="flex min-w-0 items-center gap-2">
              <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate" title={group[0].title || undefined}>
                {group[0].title || "未记录标题"}
              </span>
              {group[0].status_code != null ? (
                <StatusBadge code={group[0].status_code} />
              ) : (
                <Badge variant="outline">状态码未知</Badge>
              )}
            </div>
          ))
        ) : (
          <span className="text-muted-foreground text-xs">标题与状态码未记录</span>
        )}
      </section>
      <TechnologyStack
        items={components.filter((c) => c.asset_id && ids.has(c.asset_id))}
        technologies={rows.flatMap((o) => o.technologies)}
        taskId={taskId}
      />
      <section aria-label="防护记录" className="flex flex-wrap gap-1.5">
        {protections.size ? (
          Array.from(protections, ([key, { label, value, icon: Icon }]) => (
            <Badge
              key={key}
              variant={value.detected ? "warning" : "outline"}
              title={[value.source_ip, formatTime(value.observed_at)].filter(Boolean).join(" · ")}
            >
              <Icon data-icon="inline-start" />
              {label}
            </Badge>
          ))
        ) : (
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <ShieldIcon className="size-3.5" aria-hidden="true" />
            防护状态未知
          </span>
        )}
      </section>
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
    <Card size="sm" className="min-w-0" data-profile-card>
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <ServerIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono" title={`${ip}:${port}`}>
            {ip.includes(":") ? `[${ip}]` : ip}:{port}
          </span>
          {services.map((service) => (
            <Badge key={service} variant="outline">
              {service}
            </Badge>
          ))}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {Array.from(hosts, ([host, rows]) => (
          <HostDetails key={host} host={host} ip={ip} rows={rows} components={components} taskId={taskId} />
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
          <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.components.some((c) => !c.asset_id) && (
              <Card size="sm" className="min-w-0">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <LayersIcon className="size-4" />
                    待关联资产
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <TechnologyStack items={data.components.filter((c) => !c.asset_id)} taskId={taskId} />
                </CardContent>
              </Card>
            )}
            {data.standalone_asset_ids.map((id) => (
              <Card key={id} size="sm" className="min-w-0">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ServerIcon className="size-4" />
                    资产 #{id}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <TechnologyStack items={data.components.filter((c) => c.asset_id === id)} taskId={taskId} />
                </CardContent>
              </Card>
            ))}
            {data.items.map((profile) => (
              <ProfileRow
                key={`${profile.ip}/${profile.port}`}
                profile={profile}
                taskId={taskId}
                components={data.components.filter(
                  (c) => c.asset_id && !data.standalone_asset_ids.includes(c.asset_id),
                )}
              />
            ))}
          </div>
          {!data.items.length && !data.components.length && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ServerIcon />
                </EmptyMedia>
                <EmptyTitle>暂无资产画像</EmptyTitle>
                <EmptyDescription>任务中有明确 IP 和端口的资产会出现在这里。</EmptyDescription>
              </EmptyHeader>
            </Empty>
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
