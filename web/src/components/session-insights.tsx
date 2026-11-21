"use client";

import * as React from "react";

import { ArrowDown, ArrowUp, Calculator, Gauge, RefreshCw, X } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { SessionControls } from "@/components/session-controls";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useVisiblePoll } from "@/hooks/use-visible-poll";
import { api } from "@/lib/api";
import {
  compactNumber,
  emptyRates,
  estimateCost,
  estimateDraftTokens,
  formatUSD,
  type ModelRates,
  rate,
  type SessionUsage,
  sessionRequestError,
} from "@/lib/session-usage";
import { tokenBreakdown } from "@/lib/token-usage";
import type { LLMProfile } from "@/lib/types";

export function useSessionInsights(
  id: number | string | null,
  profile: LLMProfile | undefined,
  draft: string,
  running: boolean,
  taskId?: string,
  catalog: LLMProfile[] = [],
) {
  const scopeKey = taskId ? `task:${taskId}:${id}` : `conversation:${id}`;
  const [snapshot, setSnapshot] = React.useState<{ id: string; data: SessionUsage } | null>(null);
  const [failure, setFailure] = React.useState<{ id: string; message: string } | null>(null);
  const [rates, setRates] = React.useState<Record<string, ModelRates>>({});
  const [outputBudget, setOutputBudget] = React.useState("1024");
  const [revision, refresh] = React.useReducer((n) => n + 1, 0);
  const [storageError, setStorageError] = React.useState("");
  React.useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("series:model-rates:v1") ?? "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        const valid = Object.fromEntries(
          Object.entries(saved).filter(
            ([, v]) => v && typeof v === "object" && Object.keys(emptyRates).every((k) => typeof v[k] === "string"),
          ),
        );
        setRates(valid);
      }
    } catch {
      setStorageError("单价配置读取失败，请重新填写。");
    }
  }, []);
  const read = React.useCallback(
    async (signal: AbortSignal) => {
      if (id === null) return;
      void revision;
      try {
        const data = taskId
          ? await api.taskSessionUsage(taskId, id, signal)
          : await api.conversationUsage(Number(id), signal);
        if (!data?.total || !Array.isArray(data.models) || !data.context)
          throw new Error("服务未返回完整用量，请确认后端已更新");
        if (!signal.aborted) {
          setSnapshot({ id: scopeKey, data });
          setFailure(null);
        }
      } catch (e) {
        if (!signal.aborted) setFailure({ id: scopeKey, message: sessionRequestError(e, "会话用量") });
      }
    },
    [id, revision, taskId, scopeKey],
  );
  useVisiblePoll(read, running ? 5000 : 30000);
  const data = snapshot?.id === scopeKey ? snapshot.data : null;
  const error = failure?.id === scopeKey ? failure.message : "";
  const usable = error ? null : data;
  const metrics = tokenBreakdown(usable?.total);
  const costs = usable?.models.map((m) => estimateCost(m, rates[m.model]));
  const cost =
    usable?.total.usage_complete !== false && costs?.every((c) => c !== null)
      ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0)
      : null;
  const draftTokens = estimateDraftTokens(draft);
  const contextTokens = usable?.context.tokens ?? null;
  const sameModel = profile?.model === usable?.context.model;
  const contextProfile =
    catalog.find((p) => String(p.id) === String(usable?.context.profile_id)) ?? (sameModel ? profile : undefined);
  const configuredCapacity = contextProfile?.context_window_k ?? 0;
  const recordedCapacity = usable?.context.capacity;
  const configuredFallback = contextProfile ? (configuredCapacity > 0 ? configuredCapacity : 128) * 1000 : null;
  const capacityRecorded =
    typeof recordedCapacity === "number" && Number.isSafeInteger(recordedCapacity) && recordedCapacity > 0;
  const capacity = capacityRecorded ? recordedCapacity : configuredFallback;
  let contextNote = "尚无完整请求记录。";
  if (usable?.context.state === "compacted")
    contextNote = "压缩请求后等待下一次对话请求校准；摘要请求的用量仅计入累计消耗。";
  if (usable?.context.state === "pending") contextNote = "请求进行中，完成后更新上下文占用。";
  if (usable?.context.state === "unavailable") contextNote = "最近请求未成功返回可核定的用量，上下文占用未知。";
  const contextPercent = contextTokens !== null && capacity ? (contextTokens / capacity) * 100 : null;
  const inputRate = profile ? rate(rates[profile.model]?.input ?? "") : null;
  const outputRate = profile ? rate(rates[profile.model]?.output ?? "") : null;
  const output = rate(outputBudget);
  const nextCost =
    sameModel &&
    draft.trim() &&
    contextTokens !== null &&
    inputRate !== null &&
    outputRate !== null &&
    output !== null &&
    Number.isInteger(output)
      ? ((contextTokens + draftTokens) * inputRate + output * outputRate) / 1_000_000
      : null;
  const saveRates = (model: string, value: ModelRates) => {
    const next = { ...rates, [model]: value };
    setRates(next);
    try {
      localStorage.setItem("series:model-rates:v1", JSON.stringify(next));
      setStorageError("");
    } catch {
      setStorageError("本次单价仅在当前页面生效，浏览器未允许保存。");
    }
  };
  return {
    data: usable,
    loading: id !== null && snapshot?.id !== scopeKey && failure?.id !== scopeKey,
    error,
    metrics,
    cost,
    draftTokens,
    contextTokens,
    contextNote,
    capacity,
    capacityRecorded,
    contextPercent,
    nextCost,
    rates,
    saveRates,
    outputBudget,
    setOutputBudget,
    storageError,
    refresh,
    profile,
    running,
  };
}
type Insights = ReturnType<typeof useSessionInsights>;
export function SessionUsageButton({ value, onClick }: { value: Insights; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="session-usage-button"
      aria-label="会话信息：上下文与消费预估"
      onClick={onClick}
    >
      <span title="非缓存输入">
        <ArrowUp />
        {compactNumber(value.metrics.uncached)}
      </span>
      <span title="输出">
        <ArrowDown />
        {compactNumber(value.metrics.output)}
      </span>
      <span title="缓存读取">
        <RefreshCw />
        {compactNumber(value.metrics.cacheRead)}
      </span>
      <strong>{formatUSD(value.cost)}</strong>
      <span title="最近请求上下文快照">
        <Calculator />
        {value.contextPercent === null ? "—" : `${value.contextPercent.toFixed(1)}%`} / {compactNumber(value.capacity)}
      </span>
    </Button>
  );
}
export function SessionInsights({ value, onClose }: { value: Insights; onClose: () => void }) {
  const models = [
    ...new Set([...(value.data?.models.map((m) => m.model) ?? []), ...(value.profile ? [value.profile.model] : [])]),
  ];
  const [selected, setSelected] = React.useState("");
  const model = models.includes(selected) ? selected : models[0];
  const prices = value.rates[model] ?? emptyRates;
  return (
    <>
      <header className="pi-web-inspector-head">
        <div>
          <h2 className="font-semibold text-sm">会话信息</h2>
          <p className="text-muted-foreground text-xs">上下文与消费预估</p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭会话信息" onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {value.error && (
          <p role="alert" className="mb-3 text-destructive text-xs">
            用量读取失败：{value.error}
          </p>
        )}
        <section className="pi-web-info-card">
          <p className="pi-web-card-label">最近请求上下文 · 快照</p>
          <p className="mt-2 font-semibold text-xl tabular-nums">
            {value.contextTokens?.toLocaleString("zh-CN") ?? "—"}{" "}
            <span className="text-muted-foreground text-sm">/ {value.capacity?.toLocaleString("zh-CN") ?? "—"}</span>
          </p>
          {value.contextPercent !== null && (
            <Progress aria-label="上下文占用" value={Math.min(100, value.contextPercent)} className="my-3 h-2" />
          )}
          <p className="mt-2 text-muted-foreground text-xs">
            {value.contextPercent === null
              ? value.contextNote
              : `${value.contextPercent.toFixed(1)}% · 最近一次输入（含缓存）+ 输出`}
          </p>
          {value.contextPercent !== null && value.contextPercent >= 80 && (
            <p className="mt-2 text-destructive text-xs">上下文接近容量，请留意后续压缩。</p>
          )}
          <p className="mt-2 text-muted-foreground text-xs">
            草稿约 {compactNumber(value.draftTokens)} tokens；按中英文字符估算，不含附件。快照不代表压缩后的实时上下文。
            {!value.capacityRecorded && value.capacity !== null && " 历史请求未记录窗口容量，分母暂按模型配置估算。"}
          </p>
          {value.data?.context.at && (
            <time className="mt-2 block text-muted-foreground text-xs">
              采样：{new Date(value.data.context.at).toLocaleString("zh-CN")}
            </time>
          )}
          <Button type="button" variant="outline" size="sm" className="mt-3 w-full" onClick={value.refresh}>
            <RefreshCw data-icon="inline-start" />
            刷新用量
          </Button>
        </section>
        <section className="pi-web-info-card">
          <p className="pi-web-card-label">整段会话用量</p>
          <dl className="pi-web-stat-list">
            {(
              [
                ["非缓存输入", value.metrics.uncached],
                ["输出", value.metrics.output],
                ["缓存读取", value.metrics.cacheRead],
                ["缓存写入", value.metrics.cacheWrite],
              ] as const
            ).map(([label, n]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{n?.toLocaleString("zh-CN") ?? "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-muted-foreground text-xs">
            {value.data?.total.usage_complete === false
              ? "存在未核定请求，费用暂不估算。"
              : "按请求账本统计，缓存不重复计入。"}
          </p>
        </section>
        <section className="pi-web-info-card pi-web-cost-card">
          <p className="pi-web-card-label">累计费用估算 · USD</p>
          <p className="mt-2 font-semibold text-2xl">{formatUSD(value.cost)}</p>
          <p className="mt-2 text-muted-foreground text-xs">按下方自定义单价计算；不包含草稿。供应商实际账单为准。</p>
          <div className="mt-4 flex justify-between text-sm">
            <span>下一次请求预算</span>
            <strong>{formatUSD(value.nextCost)}</strong>
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            沿用最近上下文，假设输入不命中缓存；模型切换、附件及工具调用不在此预算内。
          </p>
        </section>
        <section className="pi-web-info-card">
          <p className="pi-web-card-label mb-3">估算单价 · USD / 百万 tokens</p>
          {!model ? (
            <p className="text-muted-foreground text-xs">配置模型或产生请求后可设置单价。</p>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="pricing-model">模型</FieldLabel>
                <Select value={model} onValueChange={setSelected}>
                  <SelectTrigger id="pricing-model" className="w-full min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectGroup>
                      {models.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {(
                [
                  ["input", "非缓存输入"],
                  ["output", "输出"],
                  ["cacheRead", "缓存读取"],
                  ["cacheWrite", "缓存写入"],
                ] as const
              ).map(([key, label]) => (
                <Field key={key}>
                  <FieldLabel htmlFor={`price-${key}`}>{label}</FieldLabel>
                  <Input
                    id={`price-${key}`}
                    type="number"
                    min="0"
                    step="any"
                    placeholder="未设置"
                    value={prices[key]}
                    onChange={(e) => value.saveRates(model, { ...prices, [key]: e.target.value })}
                  />
                </Field>
              ))}
              <Field>
                <FieldLabel htmlFor="output-budget">预计输出 tokens</FieldLabel>
                <Input
                  id="output-budget"
                  type="number"
                  min="0"
                  step="1"
                  value={value.outputBudget}
                  onChange={(e) => value.setOutputBudget(e.target.value)}
                />
              </Field>
            </FieldGroup>
          )}
          <p className="mt-3 text-muted-foreground text-xs">单价仅保存在此浏览器。空值表示未知，0 表示免费。</p>
          {value.storageError && (
            <p role="alert" className="text-destructive text-xs">
              {value.storageError}
            </p>
          )}
        </section>
      </div>
    </>
  );
}

/** Compact footer readout; details distinguish the latest context from cumulative usage. */
export function ContextUsage({ value }: { value: Insights }) {
  const cacheHit =
    value.metrics.input && value.metrics.cacheRead !== null && value.metrics.knownInput
      ? (value.metrics.cacheRead / value.metrics.input) * 100
      : null;
  let contextLabel = "上下文未记录";
  if (value.contextPercent !== null)
    contextLabel = `${value.contextPercent.toFixed(1)}% / ${compactNumber(value.capacity)}`;
  if (value.data?.context.state === "compacted") contextLabel = "压缩后待校准";
  if (value.data?.context.state === "pending") contextLabel = "请求中…";
  if (value.data?.context.state === "unavailable") contextLabel = "上下文未知";
  if (value.loading) contextLabel = "读取用量…";
  if (value.error) contextLabel = "用量暂不可用";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="context-usage-trigger"
          aria-label="当前上下文使用情况"
        >
          <Gauge data-icon="inline-start" />
          {contextLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="context-usage-popover">
        <h3 className="font-semibold">Token</h3>
        <dl>
          {(
            [
              ["非缓存输入", value.metrics.uncached],
              ["输出", value.metrics.output],
              ["缓存读取", value.metrics.cacheRead],
              ["缓存写入", value.metrics.cacheWrite],
              [value.metrics.incomplete ? "总计（已记录）" : "总计", value.metrics.total],
            ] as const
          ).map(([label, n]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{n === null ? "—" : n.toLocaleString("zh-CN")}</dd>
            </div>
          ))}
          <div>
            <dt>上下文</dt>
            <dd>
              {value.contextTokens === null ? "—" : value.contextTokens.toLocaleString("zh-CN")} /{" "}
              {value.capacity === null ? "—" : value.capacity.toLocaleString("zh-CN")}
            </dd>
          </div>
          <div>
            <dt>缓存命中率</dt>
            <dd>{cacheHit === null ? "—" : `${cacheHit.toFixed(1)}%`}</dd>
          </div>
        </dl>
        {value.contextTokens === null && <p className="text-muted-foreground text-xs">{value.contextNote}</p>}
        <p className="text-muted-foreground text-xs">
          上下文为最近完整请求快照；累计输入、输出和缓存分别统计。草稿 ≈ {value.draftTokens} tokens。
          {!value.capacityRecorded && value.capacity !== null && " 历史请求未记录窗口容量，分母暂按模型配置估算。"}
        </p>
        {value.error && (
          <Alert variant="destructive">
            <AlertTitle>用量暂不可用</AlertTitle>
            <AlertDescription>{value.error}</AlertDescription>
            <Button type="button" variant="outline" size="sm" onClick={value.refresh}>
              重试用量
            </Button>
          </Alert>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function TaskSessionFooter({
  taskId,
  session,
  draft,
  running,
  readOnly = false,
}: {
  taskId: string;
  session: string;
  draft: string;
  running: boolean;
  readOnly?: boolean;
}) {
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  const [selection, setSelection] = React.useState<{
    key: string;
    profileId: number | null;
    resolvedId?: number;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [revision, retry] = React.useReducer((n) => n + 1, 0);
  const key = `${taskId}:${session}`;
  const load = React.useCallback(
    async (signal: AbortSignal) => {
      void revision;
      setLoading(true);
      const [rows, model] = await Promise.allSettled([
        api.llmProfiles(),
        api.taskSessionModel(taskId, session, signal),
      ]);
      if (signal.aborted) return false;
      setLoading(false);
      if (rows.status === "fulfilled") setProfiles(rows.value);
      if (model.status === "fulfilled") {
        setSelection({ key, profileId: model.value.profile_id, resolvedId: model.value.resolution.profile_id });
      }
      const modelFailure = model.status === "rejected" ? model.reason : null;
      const failure = rows.status === "rejected" ? rows.reason : modelFailure;
      setError(failure ? sessionRequestError(failure, "会话模型") : "");
      return !failure;
    },
    [taskId, session, key, revision],
  );
  useVisiblePoll(load, running ? 5000 : 30000);
  const current = selection?.key === key ? selection : null;
  const pendingLabel = loading ? "读取模型…" : undefined;
  const profile = profiles.find((p) => String(p.id) === String(current?.resolvedId));
  const insights = useSessionInsights(session, profile, draft, running, taskId, profiles);
  const [details, setDetails] = React.useState(false);
  async function change(value: string) {
    if (busy || readOnly) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.setTaskSessionModel(taskId, session, value === "default" ? null : Number(value));
      const refreshed = await load(new AbortController().signal);
      insights.refresh();
      if (refreshed) setNotice("已保存，仅此会话的下次执行使用新模型。");
    } catch (e) {
      setError(sessionRequestError(e, "会话模型"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ModelPicker
        profiles={profiles}
        value={String(current?.profileId ?? "default")}
        resolved={profile}
        placeholder={error ? "模型暂不可用" : pendingLabel}
        disabled={busy || readOnly || !current || Boolean(error)}
        onChange={(v) => void change(v)}
      />
      <SessionControls
        target={{ taskId, session }}
        running={running}
        disabled={readOnly}
        onCompacted={insights.refresh}
      />
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="会话信息：上下文与消费预估"
          onClick={() => setDetails(true)}
        >
          <Calculator />
        </Button>
        <ContextUsage value={insights} />
      </div>
      {error && (
        <Alert variant="destructive" className="basis-full">
          <AlertTitle>会话模型暂不可用</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={[loading, busy].some(Boolean)}
            onClick={() => retry()}
          >
            {loading ? "正在重试…" : "重试模型"}
          </Button>
        </Alert>
      )}
      {!error && notice && (
        <p className="basis-full text-muted-foreground text-xs" role="status">
          {notice}
        </p>
      )}
      <Sheet open={details} onOpenChange={setDetails}>
        <SheetContent className="gap-0 p-0" showCloseButton={false}>
          <SheetHeader className="sr-only">
            <SheetTitle>会话用量</SheetTitle>
            <SheetDescription>当前会话的上下文与费用</SheetDescription>
          </SheetHeader>
          <SessionInsights value={insights} onClose={() => setDetails(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
