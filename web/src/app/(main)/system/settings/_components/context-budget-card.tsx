"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { CONTEXT_BUDGET_KEYS, contextBudgetFromK, readContextBudgets, type ContextBudgetKey } from "@/lib/context-budget";

const labels = { planner_context_budget_tokens: "Planner 上下文（K Token）", worker_context_budget_tokens: "Worker 上下文（K Token）" };
type Draft = Record<ContextBudgetKey, string>;

export function ContextBudgetCard() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [workerLimit, setWorkerLimit] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const settings = await api.settings();
      const values = readContextBudgets(settings);
      if (!Number.isSafeInteger(settings.worker_total_token_limit) || settings.worker_total_token_limit! < 0)
        throw new Error("服务未返回有效的 Worker 累计额度，请核对后端版本。");
      setWorkerLimit(String(settings.worker_total_token_limit));
      setDraft({ planner_context_budget_tokens: String(values.planner_context_budget_tokens / 1000), worker_context_budget_tokens: String(values.worker_context_budget_tokens / 1000) });
    } catch (error) {
      setLoadError((error as Error).message);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const limitInvalid = !/^\d+$/.test(workerLimit) || !Number.isSafeInteger(Number(workerLimit));
  const invalid = limitInvalid || (draft !== null && CONTEXT_BUDGET_KEYS.some(key => contextBudgetFromK(draft[key]) === null));
  async function save() {
    if (!draft || invalid || loading || loadError) return;
    const patch = { worker_total_token_limit: Number(workerLimit), planner_context_budget_tokens: contextBudgetFromK(draft.planner_context_budget_tokens)!, worker_context_budget_tokens: contextBudgetFromK(draft.worker_context_budget_tokens)! };
    setSaving(true);
    setSaved(false);
    try {
      const settings = await api.setSettings(patch);
      const confirmed = readContextBudgets(settings);
      if (settings.worker_total_token_limit !== patch.worker_total_token_limit || CONTEXT_BUDGET_KEYS.some(key => confirmed[key] !== patch[key])) throw new Error("服务端未确认保存值，请刷新后核对。");
      setSaved(true);
      toast.success("预算设置已保存");
    } catch (error) { toast.error(`保存失败：${(error as Error).message}`); }
    finally { setSaving(false); }
  }

  return <Card className="mb-4 break-inside-avoid md:mb-6">
    <CardHeader>
      <CardTitle>Agent 上下文与用量</CardTitle>
      <CardDescription>
        上下文压缩阈值以 K Token 填写，1K 等于 1,000 token。
      </CardDescription>
    </CardHeader>
    <CardContent>
      <FieldGroup>
        {CONTEXT_BUDGET_KEYS.map(key => {
          const error = draft !== null && contextBudgetFromK(draft[key]) === null;
          return <Field key={key} data-invalid={error} data-disabled={loading || saving || !!loadError}>
            <FieldLabel htmlFor={key}>{labels[key]}</FieldLabel>
            <Input id={key} inputMode="decimal" value={draft?.[key] ?? ""} placeholder={loading ? "加载中…" : "如 48、64 或 0"}
              disabled={loading || saving || !!loadError} aria-invalid={error} aria-describedby={`${key}-help${error ? ` ${key}-error` : ""}`}
              onChange={event => { setDraft(previous => previous && { ...previous, [key]: event.target.value }); setSaved(false); }} />
            <FieldDescription id={`${key}-help`}>{key.startsWith("planner") ? "默认 48K。" : "默认 0，沿用 pi 自动策略。"} 填 0 使用 pi 自动策略；自定义范围 8.192–1000K。</FieldDescription>
            {error && <FieldError id={`${key}-error`}>请输入 0 或 8.192–1000，最多三位小数；不能为空。</FieldError>}
          </Field>;
        })}
        <FieldDescription>
          较小阈值可减少输入，但会更频繁地生成摘要。超出所选模型容量时自动收紧并预留空间；模型容量仍在 LLM 配置中设置。
          保存后不打断当前执行，下一轮 Planner、下一次 Worker 执行或恢复时生效。原始会话和证据保留。
        </FieldDescription>
        <Field data-invalid={draft !== null && limitInvalid} data-disabled={loading || saving || !!loadError}>
          <FieldLabel htmlFor="worker-total-token-limit">每个 Worker 意图的累计额度（token）</FieldLabel>
          <Input id="worker-total-token-limit" inputMode="numeric" value={workerLimit} placeholder="10000000"
            disabled={loading || saving || !!loadError} aria-invalid={draft !== null && limitInvalid}
            aria-describedby="worker-total-token-help"
            onChange={event => { setWorkerLimit(event.target.value); setSaved(false); }} />
          <FieldDescription id="worker-total-token-help">默认 1,000 万 token，按含缓存的输入与输出之和累计。填 0 表示不限。保存后从下一次模型请求起检查，同一意图恢复后继续累计。达到额度时保留已提交的记录。</FieldDescription>
          {draft !== null && limitInvalid && <FieldError>请输入非负安全整数。</FieldError>}
        </Field>
        {loadError && <FieldError>{loadError}</FieldError>}
        {saved && <FieldDescription role="status">预算设置已保存</FieldDescription>}
      </FieldGroup>
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      {loadError ? <Button variant="outline" disabled={loading} onClick={() => void load()}>重新加载</Button> : <>
        <Button disabled={loading || saving || invalid || !draft} onClick={() => void save()}>
          {saving && <Loader2Icon data-icon="inline-start" className="animate-spin" />}保存预算设置
        </Button>
        <Button variant="outline" disabled={loading || saving || !draft} onClick={() => { setWorkerLimit("10000000"); setDraft({ planner_context_budget_tokens: "48", worker_context_budget_tokens: "0" }); setSaved(false); }}>填入默认值</Button>
      </>}
    </CardFooter>
  </Card>;
}
