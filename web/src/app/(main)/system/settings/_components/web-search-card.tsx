"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { WebSearchSettings, WebSearchSettingsPatch, WebSearchTest, WebSearchSelection, WebSearchSource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function WebSearchCard() {
  const [settings, setSettings] = useState<WebSearchSettings | null>(null);
  const [agents, setAgents] = useState<Array<[string, string]>>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [sources, setSources] = useState<WebSearchSource[]>([]);
  const [preferred, setPreferred] = useState<WebSearchSelection>("auto");
  const [keys, setKeys] = useState<Partial<Record<WebSearchSource, string>>>({});
  const [clearKeys, setClearKeys] = useState<WebSearchSource[]>([]);
  const [searxngURL, setSearxngURL] = useState("");
  const [domains, setDomains] = useState("");
  const [proxy, setProxy] = useState("");
  const [clearProxy, setClearProxy] = useState(false);
  const [query, setQuery] = useState("Apache Tomcat 9 维护周期");
  const [testSource, setTestSource] = useState<WebSearchSelection>("auto");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [result, setResult] = useState<WebSearchTest | null>(null);
  const label = (source: string) => source === "auto" ? "自动（按顺序回退）" : settings?.providers.find(p => p.id === source)?.label ?? source;
  function apply(value: WebSearchSettings) {
    setSettings(value); setSources(value.sources); setPreferred(value.default_source); setTestSource(value.default_source);
    setDomains((value.domain_filter ?? []).join(", "));
    setRoles(value.agent_roles); setSearxngURL(value.searxng_url); setKeys({}); setClearKeys([]); setProxy(""); setClearProxy(false);
  }
  const load = useCallback(async () => {
    setLoadError("");
    try { const [value, list] = await Promise.all([api.webSearchSettings(), api.agents()]); apply(value); setAgents(list.map(a => [a.key, a.name])); }
    catch (error) { setLoadError((error as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  function patch(enabled: boolean): WebSearchSettingsPatch {
    return { web_search_enabled: enabled, sources, default_source: preferred, agent_roles: roles,
      api_keys: keys, clear_keys: clearKeys, searxng_url: searxngURL, domain_filter: domains.split(/[,，\s]+/u).filter(Boolean), proxy, clear_proxy: clearProxy };
  }
  async function save(enabled: boolean) {
    setBusy(true); setResult(null);
    try { apply(await api.saveWebSearchSettings(patch(enabled))); toast.success("搜索配置已保存，下次调用生效"); }
    catch (error) { toast.error(`保存失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setResult(null);
    try { setResult(await api.testWebSearch({ ...patch(settings?.web_search_enabled ?? false), query, source: testSource })); }
    catch (error) { setResult({ ok: false, error: (error as Error).message }); }
    finally { setBusy(false); }
  }
  function toggle(source: WebSearchSource, on: boolean) {
    const next = on ? [...sources, source] : sources.filter(s => s !== source);
    setSources(next); setResult(null);
    if (!on && preferred === source) setPreferred("auto");
    if (!on && testSource === source) setTestSource("auto");
  }
  function move(index: number, direction: number) {
    const next = [...sources]; [next[index], next[index + direction]] = [next[index + direction], next[index]];
    setSources(next); setResult(null);
  }
  function applyPreset(preset: string) {
    setResult(null);
    if (preset === "bing") {
      setSources(current => current.includes("searxng") ? current : [...current, "searxng"]);
      setPreferred("searxng"); setTestSource("searxng"); setDomains("");
    } else if (preset === "cnblogs" || preset === "csdn") {
      setDomains(preset === "cnblogs" ? "cnblogs.com" : "csdn.net");
    }
  }
  const disabled = busy || !settings || !!loadError;
  const invalid = !sources.length ? "至少启用一个搜索供应商" : sources.includes("searxng") && !searxngURL.trim() ? "请填写 SearXNG 服务地址" : "";
  return <Card className="mb-4 break-inside-avoid md:mb-6">
    <CardHeader>
      <CardTitle>网络搜索</CardTitle>
      <CardDescription>使用 pi-web-access 搜索、抓取网页和续读正文。配置保存后从下一次调用生效，正在执行的请求使用开始时的配置。</CardDescription>
    </CardHeader>
    <CardContent><FieldGroup>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="web-access-enabled">启用网络搜索</FieldLabel>
        <Switch id="web-access-enabled" checked={settings?.web_search_enabled ?? false} disabled={disabled || !!invalid} onCheckedChange={value => void save(value)} />
      </Field>
      {settings?.migration_notice && <FieldDescription>{settings.migration_notice}</FieldDescription>}
      <Field>
        <FieldLabel htmlFor="web-access-preset">搜索预设</FieldLabel>
        <Select value="" disabled={disabled} onValueChange={applyPreset}>
          <SelectTrigger id="web-access-preset" className="w-full"><SelectValue placeholder="选择预设，填入下方配置" /></SelectTrigger>
          <SelectContent position="popper"><SelectGroup>
            <SelectItem value="bing">Bing（通过 SearXNG）</SelectItem>
            <SelectItem value="cnblogs">博客园</SelectItem>
            <SelectItem value="csdn">CSDN</SelectItem>
          </SelectGroup></SelectContent>
        </Select>
        <FieldDescription>博客园、CSDN 填入站点范围，沿用当前供应商。Bing 切换至 SearXNG 并清空站点范围；需填写已启用 Bing 的实例地址，实际引擎由实例配置决定。选择后点击「保存搜索配置」生效，也可先测试。</FieldDescription>
      </Field>
      <FieldSet>
        <FieldLegend>搜索供应商</FieldLegend>
        <FieldDescription>只允许已启用的供应商。自动模式按下方顺序尝试；Exa 可不填 Key，DuckDuckGo 无需 Key，可用性以测试结果为准。</FieldDescription>
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          {settings?.providers.map(provider => <FieldLabel key={provider.id} htmlFor={`web-provider-${provider.id}`}>
            <Checkbox id={`web-provider-${provider.id}`} disabled={disabled} checked={sources.includes(provider.id)} onCheckedChange={on => toggle(provider.id, on === true)} />{provider.label}
          </FieldLabel>)}
        </div>
        <div className="flex flex-col gap-2">
          {sources.map((source, index) => <div key={source} className="flex items-center gap-2">
            <span className="flex-1 text-sm">{index + 1}. {label(source)}</span>
            <Button variant="ghost" size="sm" disabled={disabled || index === 0} aria-label={`上移 ${label(source)}`} onClick={() => move(index, -1)}>上移</Button>
            <Button variant="ghost" size="sm" disabled={disabled || index === sources.length - 1} aria-label={`下移 ${label(source)}`} onClick={() => move(index, 1)}>下移</Button>
          </div>)}
        </div>
        {invalid && <FieldError>{invalid}</FieldError>}
      </FieldSet>
      <Field>
        <FieldLabel htmlFor="web-access-default">默认供应商</FieldLabel>
        <Select disabled={disabled} value={preferred} onValueChange={value => setPreferred(value as WebSearchSelection)}>
          <SelectTrigger id="web-access-default" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent position="popper"><SelectGroup>
            {["auto", ...sources].map(source => <SelectItem key={source} value={source}>{label(source)}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
        <FieldDescription>指定供应商时只使用该来源；自动模式允许失败后切换到后续来源。使用 Bing 等引擎时，选择 SearXNG 并在自己的实例中启用对应引擎。</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="web-access-domains">默认搜索站点</FieldLabel>
        <Input id="web-access-domains" value={domains} disabled={disabled} placeholder="例如 cnblogs.com, csdn.net" onChange={event => { setDomains(event.target.value); setResult(null); }} />
        <FieldDescription>留空搜索全网。博客园填 cnblogs.com，CSDN 填 csdn.net，多个域名用逗号分隔，前缀 - 表示排除。模型可按次覆盖站点；此设置不是访问权限限制。测试搜索也使用此范围。</FieldDescription>
      </Field>
      {sources.filter(source => settings?.providers.find(p => p.id === source)?.supports_key).map(source => <Field key={source}>
        <FieldLabel htmlFor={`search-key-${source}`}>{label(source)} API Key</FieldLabel>
        <Input id={`search-key-${source}`} type="password" autoComplete="new-password" disabled={disabled || clearKeys.includes(source)} value={keys[source] ?? ""}
          placeholder={settings?.keys_set[source] ? "已配置，留空保留" : source === "exa" ? "可选，留空使用免 Key 搜索" : "填写 API Key"}
          onChange={event => setKeys(current => ({ ...current, [source]: event.target.value }))} />
        {settings?.keys_set[source] && <FieldLabel htmlFor={`clear-search-key-${source}`}>
          <Checkbox id={`clear-search-key-${source}`} disabled={disabled} checked={clearKeys.includes(source)} onCheckedChange={on => setClearKeys(current => on === true ? [...current, source] : current.filter(s => s !== source))} />清除已配置密钥
        </FieldLabel>}
        {source === "deepseek" && <FieldDescription>未设置专用 Key 时，可复用平台已有的 DeepSeek 官方模型配置。清除后会停止复用。</FieldDescription>}
      </Field>)}
      {sources.includes("searxng") && <Field>
        <FieldLabel htmlFor="searxng-url">SearXNG 服务地址</FieldLabel>
        <Input id="searxng-url" value={searxngURL} disabled={disabled} placeholder="https://search.example.com" onChange={event => setSearxngURL(event.target.value)} />
        <FieldDescription>服务需要允许 JSON 格式搜索结果。Bing 等引擎在 SearXNG 的 settings.yml 中启用；此处只填写实例根地址，不附加 engines 等查询参数。</FieldDescription>
      </Field>}
      <Field>
        <FieldLabel htmlFor="web-access-proxy">搜索与抓取代理</FieldLabel>
        <Input id="web-access-proxy" type="password" autoComplete="new-password" value={proxy} disabled={disabled || clearProxy} placeholder={settings?.proxy_set ? "已配置，留空保留" : "可选：http(s):// 或 socks5h://"} onChange={event => setProxy(event.target.value)} />
        <FieldLabel htmlFor="web-access-clear-proxy"><Checkbox id="web-access-clear-proxy" checked={clearProxy} disabled={disabled} onCheckedChange={on => setClearProxy(on === true)} />清除专用代理</FieldLabel>
      </Field>
      <FieldSet>
        <FieldLegend>使用网络搜索的 Agent</FieldLegend>
        <div className="flex flex-wrap gap-x-5 gap-y-3">{agents.map(([role, name]) => <FieldLabel key={role} htmlFor={`web-agent-${role}`}>
          <Checkbox id={`web-agent-${role}`} disabled={disabled} checked={roles.includes(role)} onCheckedChange={on => setRoles(current => on === true ? [...new Set([...current, role])] : current.filter(value => value !== role))} />{name}
        </FieldLabel>)}</div>
        <FieldDescription>同时遵守工具页已有的启用状态和 Agent 绑定。工具为 web_search、fetch_content、get_search_content。</FieldDescription>
        {settings && <FieldDescription role="status">{!settings.web_search_enabled ? "总开关已关闭" : !settings.ready ? "默认来源所需凭证或地址未配置" : settings.effective_agent_roles.length ? `已生效：${agents.filter(([role]) => settings.effective_agent_roles.includes(role)).map(([,name]) => name).join("、")}` : "没有可调用的 Agent，请检查角色和工具绑定"}</FieldDescription>}
      </FieldSet>
      <Field>
        <FieldLabel htmlFor="web-access-test-source">测试供应商</FieldLabel>
        <Select value={testSource} disabled={disabled} onValueChange={value => { setTestSource(value as WebSearchSelection); setResult(null); }}>
          <SelectTrigger id="web-access-test-source" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent position="popper"><SelectGroup>
            {["auto", ...sources].map(source => <SelectItem key={source} value={source}>{label(source)}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="web-access-query">测试搜索词</FieldLabel>
        <Input id="web-access-query" value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} />
        <FieldDescription>测试使用当前表单值，不会保存配置；供应商可能按其规则收费。</FieldDescription>
      </Field>
      {loadError && <FieldError>{loadError}</FieldError>}
      {result && <FieldDescription role="status">{result.ok ? `搜索成功：${result.count ?? 0} 条结果，${result.latency_ms ?? 0} ms` : `搜索失败：${result.error}`}</FieldDescription>}
      {result?.results?.map((item, index) => <Field key={`${item.url}-${index}`}>
        <FieldDescription>{label(item.engine)}</FieldDescription>
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-sm underline">{item.title || item.url}</a>
        <FieldDescription>{item.snippet || item.summary}</FieldDescription>
      </Field>)}
    </FieldGroup></CardContent>
    <CardFooter className="mt-4 flex flex-wrap gap-2">
      {loadError ? <Button variant="outline" onClick={() => void load()}>重新加载</Button> : <>
        <Button disabled={disabled || !!invalid} onClick={() => void save(settings!.web_search_enabled)}>保存搜索配置</Button>
        <Button variant="outline" disabled={disabled || !!invalid || !query.trim()} onClick={() => void test()}>{busy ? "处理中…" : "测试搜索"}</Button>
      </>}
    </CardFooter>
  </Card>;
}
