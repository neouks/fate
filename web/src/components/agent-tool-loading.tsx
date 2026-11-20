"use client";

import * as React from "react";
import { PinIcon, RotateCcwIcon, SaveIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { AgentToolLoading, Tool } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const trafficTools = new Set(["traffic_search", "traffic_get"]);
const modes = { resident: "常驻", deferred: "按需检索" };
const sorted = (value: AgentToolLoading["overrides"]) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

export function AgentToolLoadingEditor({ agentKey, tools, captureOn, onToggle, onSaved }: {
  agentKey: string; tools: Tool[]; captureOn: boolean;
  onToggle: (tool: Tool) => Promise<void>; onSaved?: () => void;
}) {
  const [settings, setSettings] = React.useState<AgentToolLoading | null>(null);
  const [draft, setDraft] = React.useState<AgentToolLoading["overrides"]>({});
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    let current = true;
    setSettings(null); setError("");
    api.agentToolLoading(agentKey).then(value => {
      if (current) { setSettings(value); setDraft(value.overrides); }
    }).catch(e => { if (current) setError((e as Error).message); });
    return () => { current = false; };
  }, [agentKey, retry]);
  const dirty = !!settings && sorted(settings.overrides) !== sorted(draft);
  async function toggleBinding(tool: Tool) {
    setBusy(true); setError("");
    try {
      await onToggle(tool);
      // Refresh discovery availability without discarding unsaved loading choices.
      setSettings(await api.agentToolLoading(agentKey));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError("");
    try {
      const value = await api.saveAgentToolLoading(agentKey, draft);
      setSettings(value); setDraft(value.overrides);
      toast.success("工具加载配置已保存，下次执行或恢复会话时生效");
      onSaved?.();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const visible = tools.filter(t => (!["web_search", "web_read"].includes(t.key) || ["planner", "worker", "mainagent"].includes(agentKey)) &&
    `${t.key} ${t.description}`.toLowerCase().includes(query.toLowerCase()));
  return <FieldGroup>
    <Field>
      <FieldLabel>工具授权与加载方式</FieldLabel>
      <FieldDescription>勾选绑定工具；默认沿用平台规则，常驻工具持续可调用，按需工具通过 tool_search 加载，闲置两轮后退出声明。加载配置保存后从下次执行或恢复会话生效。</FieldDescription>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}><SaveIcon data-icon="inline-start" />{busy ? "正在保存…" : "保存加载配置"}</Button>
        <Button size="sm" variant="outline" disabled={!settings || busy || Object.keys(draft).length === 0} onClick={() => setDraft({})}><RotateCcwIcon data-icon="inline-start" />恢复默认</Button>
        {dirty && <Badge variant="secondary">有未保存的修改</Badge>}
      </div>
      {error && <p role="alert" className="text-destructive text-sm">{error} {!settings && <Button size="sm" variant="outline" onClick={() => setRetry(n => n + 1)}>重新加载</Button>}</p>}
      {!settings && !error && <p role="status" className="text-muted-foreground text-sm">正在读取加载配置…</p>}
      {settings?.fallback && <FieldDescription>{settings.fallback}。启用并绑定 tool_search 后才能使用按需检索。</FieldDescription>}
    </Field>
    <Field>
      <FieldLabel htmlFor={`tool-filter-${agentKey}`} className="sr-only">筛选工具</FieldLabel>
      <Input id={`tool-filter-${agentKey}`} placeholder="按名称或说明筛选工具" value={query} onChange={e => setQuery(e.target.value)} />
    </Field>
    <FieldGroup className="gap-2">
      {visible.map(tool => {
        const bound = tool.agents.includes(agentKey);
        const gated = trafficTools.has(tool.key) && !captureOn;
        const fixed = tool.key === "tool_search" || tool.implementation_status === "compatibility";
        const unavailable = ["retired", "unsupported"].includes(tool.implementation_status ?? "");
        const selected = Object.hasOwn(draft, tool.key) ? draft[tool.key] : "default";
        const defaultMode = settings?.default_mode === "resident" || settings?.default_resident.includes(tool.key) ? "resident" : "deferred";
        const effective = tool.effective?.[agentKey];
        const mode = selected === "default" ? defaultMode : selected;
        return <Field key={tool.key} orientation="responsive" className="rounded-md border p-2" data-tool-loading={tool.key}>
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <Checkbox id={`tool-binding-${agentKey}-${tool.key}`} checked={bound} disabled={gated || busy} onCheckedChange={() => void toggleBinding(tool)} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldLabel htmlFor={`tool-binding-${agentKey}-${tool.key}`} className="break-all font-mono text-xs">{tool.key}</FieldLabel>
              <FieldDescription className="line-clamp-2 break-words">{tool.description}</FieldDescription>
              <div className="flex flex-wrap gap-1">
                {!bound ? <Badge variant="outline">未绑定</Badge> : !tool.enabled ? <Badge variant="outline">已停用</Badge> : gated ? <Badge variant="outline">需开启流量捕获</Badge> :
                  effective?.status === "unavailable" ? <Badge variant="outline">{effective.reason ?? "当前不可用"}</Badge> : <Badge variant="secondary">{fixed ? "常驻" : modes[settings?.fallback ? "resident" : mode]}{dirty ? " · 待保存" : ""}</Badge>}
              </div>
            </div>
          </div>
          {fixed ? <span className="text-muted-foreground shrink-0 text-xs">{tool.key === "tool_search" ? "发现入口 · 固定常驻" : "兼容入口 · 沿用默认"}</span> :
            <ToggleGroup type="single" size="sm" variant="outline" spacing={0} aria-label={`${tool.key} 加载方式`} value={selected}
              disabled={!settings || !settings.editable_tools.includes(tool.key) || busy || unavailable || !bound || !tool.enabled}
              onValueChange={value => {
                if (!value) return;
                setDraft(previous => { const next = { ...previous }; if (value === "default") delete next[tool.key]; else next[tool.key] = value as "resident" | "deferred"; return next; });
              }}>
              <ToggleGroupItem value="default" aria-label={`${tool.key} 默认加载`} title={`默认：${modes[defaultMode]}`}><RotateCcwIcon data-icon="inline-start" />默认</ToggleGroupItem>
              <ToggleGroupItem value="resident" aria-label={`${tool.key} 常驻`}><PinIcon data-icon="inline-start" />常驻</ToggleGroupItem>
              <ToggleGroupItem value="deferred" aria-label={`${tool.key} 按需检索`} disabled={!!settings?.fallback}><SearchIcon data-icon="inline-start" />按需</ToggleGroupItem>
            </ToggleGroup>}
        </Field>;
      })}
      {!visible.length && <FieldDescription>没有匹配的工具。</FieldDescription>}
    </FieldGroup>
  </FieldGroup>;
}
