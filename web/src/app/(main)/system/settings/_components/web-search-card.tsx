"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { WebSearchSettings, WebSearchTest, WebSearchSelection, WebSearchSource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

const labels: Record<WebSearchSelection, string> = {auto:"自动", deepseek:"DeepSeek", baidu:"百度", bing:"Bing", github:"GitHub", cnblogs:"博客园", csdn:"CSDN", wechat:"微信公众号"};
const available = Object.keys(labels).filter((key): key is WebSearchSource => key !== "auto");
const sourceLabel = (source: string) => Object.hasOwn(labels, source) ? labels[source as WebSearchSelection] : source;

const SEARCH_AGENTS = [
  ["worker", "Worker"], ["planner", "Planner"], ["mainagent", "主 Agent"],
] as const;

export function WebSearchCard() {
  const [settings, setSettings] = useState<WebSearchSettings | null>(null);
  const [key, setKey] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [sources, setSources] = useState<WebSearchSource[]>(["deepseek"]);
  const [preferred, setPreferred] = useState<WebSearchSelection>("deepseek");
  const [testSource, setTestSource] = useState<WebSearchSelection>("deepseek");
  const [query, setQuery] = useState("Apache Tomcat 9 维护周期");
  const community = sources.some(s => ["cnblogs", "csdn", "wechat"].includes(s));
  const invalid = !sources.length ? "至少选择一个来源" : community && !sources.includes("bing") && !sources.includes("baidu") ? "社区检索需要同时启用 Bing 或百度" : "";
  function toggleSource(source: WebSearchSource, on: boolean) {
    const next = on ? [...sources, source] : sources.filter(s => s !== source);
    setSources(next);
    if (preferred === source && !on) setPreferred(next[0] ?? "auto");
    if (testSource === source && !on) setTestSource(next[0] ?? "auto");
    setResult(null);
  }
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [result, setResult] = useState<WebSearchTest | null>(null);
  const load = useCallback(async () => {
    setLoadError("");
    try {
      const value = await api.webSearchSettings();
      setSettings(value);
      setSources(value.sources ?? ["deepseek"]);
      setPreferred(value.default_source ?? "deepseek");
      setTestSource(value.default_source ?? "deepseek");
      setRoles(value.agent_roles.filter(role => SEARCH_AGENTS.some(([key]) => key === role)));
    }
    catch (error) { setLoadError((error as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function save(enabled: boolean, clearKey = false) {
    setBusy(true);
    setResult(null);
    try {
      const value = await api.saveWebSearchSettings({ web_search_enabled: enabled, api_key: key, clear_key: clearKey, agent_roles: roles, sources, default_source: preferred });
      setSettings(value);
      setRoles(value.agent_roles);
      setKey("");
      toast.success("网络搜索配置已保存");
    } catch (error) { toast.error(`保存失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    setResult(null);
    try { setResult(await api.testWebSearch({ query, api_key: key, source: testSource, sources, default_source: preferred })); }
    catch (error) { setResult({ ok: false, error: (error as Error).message }); }
    finally { setBusy(false); }
  }
  const disabled = !settings || busy || !!loadError;
  return <Card className="mb-4 break-inside-avoid md:mb-6">
    <CardHeader>
      <CardTitle>网络搜索</CardTitle>
      <CardDescription>Planner、Worker 和主 Agent 可搜索公开技术文档，并按需读取正文。已读正文在模型请求中去重。</CardDescription>
    </CardHeader>
    <CardContent>
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="deepseek-search-enabled">启用网络搜索</FieldLabel>
          <Switch id="deepseek-search-enabled" checked={settings?.web_search_enabled ?? false} disabled={disabled || !!invalid} onCheckedChange={value => void save(value)} />
        </Field>
        <Field>
          <FieldLabel>公开资料来源</FieldLabel>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            {available.map(source => <label key={source} className="flex items-center gap-2 text-sm">
              <Checkbox disabled={disabled} checked={sources.includes(source)} onCheckedChange={on => toggleSource(source, on === true)} />{labels[source]}
            </label>)}
          </div>
          <FieldDescription>GitHub 检索公开仓库。博客园、CSDN、微信公众号仅检索网页引擎已收录的文章。</FieldDescription>
          {invalid && <FieldError>{invalid}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="default-reference-source">默认检索来源</FieldLabel>
          <NativeSelect id="default-reference-source" disabled={disabled} value={preferred} onChange={e => setPreferred(e.target.value as WebSearchSelection)}>
            {(["auto", ...sources] as WebSearchSelection[]).map(s => <NativeSelectOption key={s} value={s}>{labels[s]}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel>使用网络搜索的 Agent</FieldLabel>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            {SEARCH_AGENTS.map(([role, label]) => <label key={role} className="flex items-center gap-2 text-sm">
              <Checkbox disabled={disabled} checked={roles.includes(role)} onCheckedChange={checked => setRoles(current => checked ? [...new Set([...current, role])] : current.filter(item => item !== role))} />
              {label}
            </label>)}
          </div>
          <FieldDescription>保存后按所选角色及已有工具授权生效。</FieldDescription>
          {settings && <FieldDescription role="status">{!settings.web_search_enabled ? "总开关已关闭" : !settings.ready ? "搜索凭证未就绪" : settings.effective_agent_roles.length ? `已生效：${SEARCH_AGENTS.filter(([role]) => settings.effective_agent_roles.includes(role)).map(([,label]) => label).join("、")}` : "尚无可调用的 Agent，请选择上方角色并保存"}</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel htmlFor="deepseek-search-key">DeepSeek API Key</FieldLabel>
          <Input id="deepseek-search-key" type="password" autoComplete="new-password" value={key} disabled={disabled}
            placeholder={settings?.deepseek_key_set ? "已保存，留空保留" : "填写官方 API Key，或复用已有官方模型配置"}
            onChange={event => { setKey(event.target.value); setResult(null); }} />
          <FieldDescription>{settings?.credential_source || "尚未配置官方搜索凭证"}。专用 Key 直连官方接口；复用模型配置时沿用该配置的代理。</FieldDescription>
          <FieldDescription>搜索按 DeepSeek 官方规则计费。测试使用当前输入值，可在开启总开关前执行。</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="test-reference-source">测试来源</FieldLabel>
          <NativeSelect id="test-reference-source" disabled={disabled} value={testSource} onChange={e => {setTestSource(e.target.value as WebSearchSelection); setResult(null);}}>
            {(["auto", ...sources] as WebSearchSelection[]).map(s => <NativeSelectOption key={s} value={s}>{labels[s]}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="deepseek-search-query">测试搜索词</FieldLabel>
          <Input id="deepseek-search-query" value={query} disabled={disabled} onChange={event => { setQuery(event.target.value); setResult(null); }} />
        </Field>
        {loadError && <FieldError>{loadError}</FieldError>}
        {result && <FieldDescription role="status">{result.ok ? `搜索成功，返回 ${result.count ?? 0} 条结果，耗时 ${result.latency_ms ?? 0} ms${result.count === 0 ? "，可尝试调整搜索词" : ""}` : `搜索失败：${result.error}`}</FieldDescription>}
        {result?.failures?.map(f => <FieldDescription key={f.source}>{labels[f.source]} · {f.reason}</FieldDescription>)}
        {result?.results?.map((item, index) => <Field key={`${item.url}-${index}`}>
          <FieldDescription>{sourceLabel(item.engine)} · {sourceLabel(item.source)}</FieldDescription>
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-sm underline">{item.title || item.url}</a>
          <FieldDescription>{item.snippet || item.summary}</FieldDescription>
        </Field>)}
      </FieldGroup>
    </CardContent>
    <CardFooter className="mt-4 flex flex-wrap gap-2">
      {loadError ? <Button variant="outline" onClick={() => void load()}>重新加载</Button> : <>
        <Button disabled={disabled || !!invalid} onClick={() => void save(settings!.web_search_enabled)}>保存搜索配置</Button>
        <Button variant="outline" disabled={disabled || !!invalid || !query.trim() || [...query.trim()].length > 128} onClick={() => void test()}>{busy ? "处理中…" : "测试搜索"}</Button>
        {settings?.deepseek_key_set && <Button variant="ghost" disabled={disabled || !!invalid} onClick={() => void save(settings.web_search_enabled, true)}>清除专用 Key</Button>}
      </>}
    </CardFooter>
  </Card>;
}
