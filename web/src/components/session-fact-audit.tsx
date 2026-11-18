"use client";

import {useEffect, useState} from "react";
import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog";
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@/components/ui/tabs";
import {http} from "@/lib/api";
import type {AuditMember, AuditSession, FactAudit, FactEvent} from "../../../apps/server/src/http/session-audit-types";

const number = (n:number|null) => n===null?"未记录":n.toLocaleString();
const ref = (id:number,version:number) => `#${id} · v${version}`;
const actions = {submit:"提交",read:"读取",search:"检索摘要"};
function readNote(e:FactEvent) {
  const c=e.comparison;
  if(c?.match==="identical")return ` · 与第 ${c.firstRound} 轮逐字相同`;
  if(c?.match==="page")return ` · 同一来源的另一片段 [${c.start}, ${c.end})`;
  return "";
}
type Detail = {current:unknown;originals:{session:string;round:number;kind:keyof typeof actions;field?:string;start?:number;end?:number;content:unknown}[]};

function useAudit<T>(url:string|null) {
  const [state,setState]=useState<{url:string;data?:T;error?:string}>();
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if(!url)return;
    const controller=new AbortController();
    setState({url});
    http<T>(url,{signal:controller.signal}).then(data=>{
      if(!controller.signal.aborted)setState({url,data});
    }).catch(error=>{if(!controller.signal.aborted)setState({url,error:String(error)});});
    return ()=>controller.abort();
  },[url,attempt]);
  return {...(url===state?.url?state:undefined),retry:()=>setAttempt(a=>a+1)};
}

function FactOriginal({url,id,version}:{url:string;id:number;version:number}) {
  const {data,error,retry}=useAudit<Detail>(url+`?node=${id}&version=${version}`);
  if(error)return <p role="alert">{error} <Button size="sm" onClick={retry}>重试</Button></p>;
  if(!data)return <p role="status">读取原文中…</p>;
  const json=(v:unknown)=><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{typeof v==="string"?v:JSON.stringify(v,null,2)}</pre>;
  return <div className="grid gap-2">
    {data.current!=null&&<div>已存节点 · {ref(id,version)}{json(data.current)}</div>}
    {data.originals.map((o,i)=><details key={i}><summary>{o.session} · 第 {o.round} 轮 · {actions[o.kind]}原文 {o.field} {o.start!=null?`[${o.start}, ${o.end})`:""}</summary>{json(o.content)}</details>)}
    {data.current==null&&<p>该历史版本仅展示日志里实际保留的提交、摘要或片段。</p>}
    {!data.current&&!data.originals.length&&<p>仅有版本引用，原文未留存。</p>}
  </div>;
}

function FactGroup({members,url}:{members:AuditMember[];url:string}) {
  const [selected,setSelected]=useState("");
  const first=members[0];
  const reads=members.reduce((n,m)=>n+m.events.filter(e=>e.kind==="read").length,0);
  return <details className="border-b py-2" onToggle={e=>{if(e.target===e.currentTarget&&!e.currentTarget.open)setSelected("");}}>
    <summary className="cursor-pointer break-words">{first.summary||ref(first.id,first.version)} <span className="text-muted-foreground"> · {members.length>1?`${members.length} 条来源`:ref(first.id,first.version)} · 读取 {reads} 次</span></summary>
    <div className="grid gap-3 py-2 pl-3">
      {members.map(m=>{
        const key=ref(m.id,m.version),e=m.events[0];
        return <div key={key} className="grid gap-1">
          <div>{key} · {m.worker} · {e?`首见于 ${e.session} 第 ${e.round} 轮`:"未找到对应轮次"} · 后续引用 {m.events.slice(1).filter(x=>x.kind!=="submit").length} 次</div>
          {!!m.events.length&&<details><summary>引用记录</summary>{m.events.map((v,i)=><div key={i}>{v.session} · 第 {v.round} 轮 · {actions[v.kind]}{readNote(v)}</div>)}</details>}
          <Button className="w-fit" variant="outline" size="sm" aria-expanded={selected===key} onClick={()=>setSelected(selected===key?"":key)}>{selected===key?"收起原文":"查看原文"}</Button>
          {selected===key&&<FactOriginal url={url} id={m.id} version={m.version}/>}
        </div>;
      })}
    </div>
  </details>;
}

function sessionLabels(session:AuditSession) {
  const seen=new Map<number,Set<number>>();
  const labels=new Map<FactEvent,string>();
  for(const round of session.rounds)for(const e of round.events){
    const versions=seen.get(e.id)??new Set<number>();
    const label=e.kind==="submit"?(versions.has(e.version)?"再次提交":"首次提交"):
      (versions.has(e.version)?"再次":"首次")+actions[e.kind]+(versions.size&&!versions.has(e.version)?"新版本":"");
    labels.set(e,label);versions.add(e.version);seen.set(e.id,versions);
  }
  return labels;
}

function Rounds({session,showFact}:{session:AuditSession;showFact:(e:FactEvent)=>void}) {
  const [expanded,setExpanded]=useState(false);
  const labels=sessionLabels(session);
  const growth=session.rounds.reduce((best,r)=>(r.delta??0)>(best?.delta??0)?r:best,undefined as AuditSession["rounds"][number]|undefined);
  return <details className="border-b py-2" onToggle={e=>{if(e.target===e.currentTarget)setExpanded(e.currentTarget.open);}}>
    <summary className="cursor-pointer">{session.name} · {session.rounds.length} 轮{growth&&` · 最大增长 +${number(growth.delta)} token（第 ${growth.number} 轮）`}</summary>
    {session.warnings.map(w=><p key={w}>{w}</p>)}
    {growth&&<p className="my-2">该轮之前新增的日志内容最多为 {growth.additions.slice(0,3).map(x=>x.label+" "+number(x.bytes)+" B").join("、")||"未记录"}。</p>}
    {expanded&&<div className="overflow-x-auto"><table className="w-full text-left text-xs tabular-nums">
      <thead><tr>{["轮次","输入","缓存读","缓存写","合计 / 增量","此前新增的日志内容","本轮事实"].map(v=><th key={v} className="p-1">{v}</th>)}</tr></thead>
      <tbody>{session.rounds.map(r=><tr key={r.number} className="border-t align-top">
        {[r.number,number(r.input),number(r.cacheRead),number(r.cacheWrite),number(r.total)+" / "+(r.delta===null?"—":number(r.delta))].map((v,i)=><td key={i} className="p-1">{v}</td>)}
        <td className="p-1"><details><summary>{r.additions[0]?.label??"无记录"} {r.additions[0]&&number(r.additions[0].bytes)+" B"}</summary>{r.additions.map(x=><div key={x.label}>{x.label} {number(x.bytes)} B</div>)}</details>{r.largeOutputs.map((item,i)=><div key={i}>大段输出 · {item.label} {number(item.bytes)} B</div>)}</td>
        <td className="p-1">{r.events.map((e,i)=><button type="button" className="block underline" key={i} onClick={()=>showFact(e)}>{labels.get(e)} {ref(e.id,e.version)}{readNote(e)}</button>)}</td>
      </tr>)}</tbody>
    </table></div>}
  </details>;
}

export function SessionFactAudit({taskId}:{taskId:string}) {
  const [open,setOpen]=useState(false);
  const [focus,setFocus]=useState<FactEvent|null>(null);
  const url="/tasks/"+encodeURIComponent(taskId)+"/session-audit";
  const {data,error,retry}=useAudit<FactAudit>(open?url:null);
  return <Dialog open={open} onOpenChange={o=>{setOpen(o);setFocus(null);}}>
    <DialogTrigger asChild><Button variant="outline" size="sm">事实与用量</Button></DialogTrigger>
    <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-5xl">
      <DialogHeader><DialogTitle>执行会话回看</DialogTitle><DialogDescription>按已保存的事实版本和模型响应核对历史记录。</DialogDescription></DialogHeader>
      {error?<p role="alert">{error} <Button onClick={retry}>重试</Button></p>:!data?<p role="status">正在读取会话记录…</p>:
        <Tabs defaultValue="facts" onValueChange={()=>setFocus(null)}>
          <TabsList><TabsTrigger value="facts">事实索引</TabsTrigger><TabsTrigger value="usage">逐轮用量</TabsTrigger></TabsList>
          <TabsContent value="facts" className="text-sm">
            <p>原始事实 {data.rawCount} 条 · 折叠后 {data.groups.length} 组（含历史版本） · 首见后的引用 {data.repeatCount} 次（含检索和分页）</p>
            {data.groups.map(g=><FactGroup key={ref(g[0].id,g[0].version)} members={g} url={url}/>)}
          </TabsContent>
          <TabsContent value="usage" className="text-sm">
            {data.reads&&<div className="mb-4 grid gap-2">
              <table className="text-left tabular-nums">
                <caption className="pb-1 text-left font-medium">同一会话内的事实读取</caption>
                <thead><tr>{["内容","读取条目","其他分页片段","逐字重复","预计可省"].map(h=><th key={h}>{h}</th>)}</tr></thead>
                <tbody>{(["read","search"] as const).map(k=>{
                  const r=data.reads[k];
                  return <tr key={k}><th>{k==="read"?"正文":"检索摘要"}</th><td>{number(r.items)}</td><td>{k==="read"?number(r.pages):"—"}</td><td>{number(r.identical)}</td><td>{number(r.netBytes)} B</td></tr>;
                })}</tbody>
              </table>
              <p>扣除来源引用后，合计约 {number(Math.round((data.reads.read.netBytes+data.reads.search.netBytes)/3))} token。按 JSON 文本每 3 个 UTF-8 字节估算，仅计一次传输，实际账单取决于模型和缓存。</p>
            </div>}
            <p>输入合计含缓存读写。新增字节按上一条响应到本轮响应之间的日志统计，参数按 JSON 序列化计量。实际发送给模型的逐项 token 无法归因。</p>
            {focus&&<section className="my-2 grid gap-2 border p-2"><div>{ref(focus.id,focus.version)} <Button size="sm" variant="ghost" onClick={()=>setFocus(null)}>关闭原文</Button></div><FactOriginal key={ref(focus.id,focus.version)} url={url} id={focus.id} version={focus.version}/></section>}
            {data.sessions.map(s=><Rounds key={s.name} session={s} showFact={setFocus}/>)}
          </TabsContent>
        </Tabs>}
    </DialogContent>
  </Dialog>;
}
