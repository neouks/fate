"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import {
  ArrowUpRightIcon,
  BanIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ClockIcon,
  FingerprintIcon,
  GlobeIcon,
  LayersIcon,
  ListChecksIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldIcon,
} from "lucide-react";

import { TablePagination } from "@/components/table-pagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { statusMeta } from "@/lib/status";
import { taskViewURL } from "@/lib/task-navigation";
import type { ProtectionObservation, TaskAssetProfile, TaskProfilesPage } from "@/lib/types";

const observedTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });
const formatTime = (time: string) => observedTime.format(new Date(time));

function protectionLabel(values: (ProtectionObservation | null)[]) {
  const known = new Set(values.flatMap((v) => (v ? [v.detected] : [])));
  if (known.size === 0) return "未知";
  if (known.size > 1) return "记录不一";
  return known.has(true) ? "有检出记录" : "有未检出记录";
}

const progressIcons: Record<string, typeof ClockIcon> = { done: CheckIcon, running: CircleDotIcon };

function ProfileRow({ profile, taskId }: { profile: TaskAssetProfile; taskId: string }) {
  const { ip, port, observations, checks } = profile;
  const address = ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
  const services = [...new Set(observations.map((o) => o.service?.toUpperCase()).filter(Boolean))];
  const stack = [...new Set(observations.flatMap((o) => o.technologies))];
  const seen = observations[0].seen;
  return (
    <details className="group border-b last:border-b-0">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 rounded-sm px-3 py-3 text-sm hover:bg-muted/50 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground group-open:rotate-90" />
          <ServerIcon className="size-4 shrink-0" />
          <strong className="break-all font-medium font-mono">{address}</strong>
        </span>
        <span className="hidden max-w-64 truncate text-muted-foreground text-xs sm:block">
          {[...services, ...stack].join(" · ")}
        </span>
        <span className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 pl-6 text-xs sm:w-auto sm:pl-0">
          <span className="inline-flex items-center gap-1">
            <ShieldIcon className="size-3.5" />
            WAF {protectionLabel(observations.map((o) => o.waf))}
          </span>
          <span className="inline-flex items-center gap-1">
            <BanIcon className="size-3.5" />
            来源 IP 封禁 {protectionLabel(observations.map((o) => o.source_ip_block))}
          </span>
        </span>
        <time className="hidden text-muted-foreground text-xs xl:inline" dateTime={seen}>
          {formatTime(seen)}
        </time>
      </summary>
      <div className="flex flex-col gap-4 bg-muted/20 px-4 py-4 text-sm sm:pl-10">
        <div className="flex flex-col gap-2">
          {observations.map((o) => (
            <div key={`${o.asset_id}/${o.service}`} className="flex flex-col gap-1 break-words border-l-2 pl-3">
              <div className="flex flex-wrap items-center gap-x-2">
                <GlobeIcon className="size-3.5" />
                <span className="break-all font-medium">{o.domain || ip}</span>
                {o.service && <span>{o.service}</span>}
                <span className="text-muted-foreground text-xs">
                  资产 #{o.asset_id} · {formatTime(o.seen)}
                </span>
              </div>
              {o.title && <span>{o.title}</span>}
              {o.bound_domains.length > 0 && <span>IP 关联域名 · {o.bound_domains.join("、")}</span>}
              {o.technologies.length > 0 && (
                <span className="flex items-center gap-2">
                  <LayersIcon className="size-3.5 shrink-0" />
                  技术栈 · {o.technologies.join("、")}
                </span>
              )}
              {o.fingerprint && (
                <span className="flex items-center gap-2">
                  <FingerprintIcon className="size-3.5 shrink-0" />
                  favicon MMH3 · {o.fingerprint}
                </span>
              )}
              {o.waf && (
                <span>
                  WAF · {o.waf.detected ? "已检出" : "未检出"} · {formatTime(o.waf.observed_at)}
                </span>
              )}
              {o.source_ip_block && (
                <span>
                  来源 IP {o.source_ip_block.source_ip} · {o.source_ip_block.detected ? "已封禁" : "未观察到封禁"} ·{" "}
                  {formatTime(o.source_ip_block.observed_at)}
                </span>
              )}
            </div>
          ))}
        </div>
        <div>
          <h3 className="mb-2 flex items-center gap-2 font-medium">
            <ListChecksIcon className="size-4" />
            核查进度
          </h3>
          {checks.length === 0 ? (
            <p className="text-muted-foreground text-xs">暂无关联核查记录</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {checks.map((check) => {
                const Icon = progressIcons[check.state] ?? ClockIcon;
                return (
                  <li key={check.intent_id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="inline-flex items-center gap-1 text-xs">
                      <Icon className="size-3.5" />
                      {statusMeta("intent", check.state).label}
                    </span>
                    <span className="min-w-0 break-all">{check.summary || `核查事项 #${check.intent_id}`}</span>
                    {check.activity && (
                      <Link
                        prefetch={false}
                        className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
                        href={taskViewURL("", {
                          id: taskId,
                          tab: "sessions",
                          section: "chat",
                          session: `intent:${check.intent_id}`,
                          activity: check.activity,
                        })}
                      >
                        Worker 最近记录
                        <ArrowUpRightIcon className="size-3" />
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}

export function ProfilesTab({ taskId }: { taskId: string }) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<TaskProfilesPage | null>(null);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refresh button reloads the current page.
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setData(null);
    api
      .taskProfiles(taskId, page, limit, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message || "画像加载失败");
      });
    return () => controller.abort();
  }, [taskId, page, limit, reload]);
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
          {data.items.length ? (
            <div className="overflow-hidden rounded-lg border bg-card">
              {data.items.map((p) => (
                <ProfileRow key={`${p.ip}/${p.port}`} profile={p} taskId={taskId} />
              ))}
            </div>
          ) : (
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
