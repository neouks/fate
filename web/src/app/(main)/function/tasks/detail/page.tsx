"use client";

import {Suspense,useEffect,useState,useRef} from "react";
import Link from "next/link";
import {useSearchParams} from "next/navigation";
import {Button} from "@/components/ui/button";
import {Field,FieldLabel} from "@/components/ui/field";
import {Textarea} from "@/components/ui/textarea";
import {Bubble,BubbleContent} from "@/components/ui/bubble";
import {Message,MessageHeader,MessageContent} from "@/components/ui/message";
import {MessageScrollerProvider,MessageScroller,MessageScrollerViewport,MessageScrollerContent,MessageScrollerButton} from "@/components/ui/message-scroller";
import {SidebarTrigger} from "@/components/ui/sidebar";
import {StatusBadge} from "@/components/status-badge";
import {SessionFactAudit} from "@/components/session-fact-audit";
import {MOCK} from "@/lib/mock/enabled";
import {http} from "@/lib/api";
import type {Task} from "@/lib/types";

type GoalResource = {kind:"mcp"|"skill"|"subagent"|"catalog";name:string;description:string;command?:string};
const resourceType = {mcp:"MCP",skill:"Skill",subagent:"Sub-agent",catalog:"系统绑定目录"};
type GoalTask = Task & {resources?:GoalResource[];runtime:"pi"|"legacy";accepted_entry?:string};
type Entry = {action?:string;tool_call_id?:string;id:string;role:string;text:string;error?:boolean;confirmed?:boolean};
type History = {messages:Entry[];next_before?:string};

function GoalDetail({id}:{id:string}) {
  const base="/tasks/"+encodeURIComponent(id);
  const [task,setTask]=useState<GoalTask>();
  const [history,setHistory]=useState<History>({messages:[]});
  const [draft,setDraft]=useState("");
  const [busy,setBusy]=useState(false);
  const [sending,setSending]=useState(false);
  const [error,setError]=useState("");
  const request=useRef<{message:string;request_id:string}|null>(null);
  async function load(signal?:AbortSignal) {
    const [t,h]=await Promise.all([http<GoalTask>(base,{signal}),http<History>(base+"/messages",{signal})]);
    if(!signal?.aborted){setTask(t);setHistory(h);}
  }
  useEffect(()=>{
    const controller=new AbortController();
    load(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[base]); // Each task has its own keyed component and draft.
  useEffect(()=>{
    if(!sending)return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    async function readMessages() {
      try {
        const current=await http<History>(base+"/messages",{signal:controller.signal});
        if(!controller.signal.aborted)setHistory(current);
      } catch { /* The final load reports any persistent read failure. */ }
      if(!controller.signal.aborted)timer=setTimeout(readMessages,1500);
    }
    timer=setTimeout(readMessages,1500);
    return ()=>{controller.abort();clearTimeout(timer);};
  },[base,sending]);
  async function perform(fn:()=>Promise<void>) {
    if(busy)return;
    setBusy(true);setError("");
    try {await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const control=(action:string,entry?:string)=>perform(async()=>{
    await http(base+"/control",{method:"POST",body:JSON.stringify({action,entry})});await load();
  });
  const send=()=>perform(async()=>{
    const message=draft.trim()?draft:task!.goal;
    if(request.current?.message!==message)request.current={message,request_id:crypto.randomUUID()};
    setSending(true);
    try {
      await http(base+"/chat",{method:"POST",body:JSON.stringify(request.current)});
    } catch(e) {
      const receipt=await http<{status:string;error?:string}>(base+"/requests/"+request.current.request_id).catch(()=>null);
      if(receipt?.status==="failed")request.current=null;
      if(receipt?.status!=="completed") {
        await load();
        throw new Error(receipt?.error || (e as Error).message);
      }
    } finally {setSending(false);}
    request.current=null;setDraft("");await load();
  });
  const open=task?.runtime==="pi" && ["created","running","paused"].includes(task.status);
  const returned=new Set(history.messages.filter(e=>e.action==="result").map(e=>e.tool_call_id));
  function entryLabel(entry:Entry) {
    const resource=task?.resources?.find(r=>r.name===entry.role);
    if(resource)return resourceType[resource.kind]+" · "+resource.name;
    if(entry.role==="user")return "你";
    return entry.role==="assistant"?"PI":entry.role;
  }
  return <main className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 p-4 md:p-6">
    <header className="flex flex-wrap items-center gap-3"><SidebarTrigger/><Link href="/function/tasks">返回任务</Link>
      {task && <StatusBadge domain="task" value={task.status}/>}
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>perform(()=>load())}>刷新</Button>
      {open && <Button size="sm" variant="outline" disabled={busy} onClick={()=>control(task.status==="paused"?"resume":"pause")}>{task.status==="paused"?"恢复":"暂停"}</Button>}
    </header>
    {error && <p role="alert">{error}</p>}
    {task ? <>
      <h1 className="text-xl font-semibold break-words">{task.name || task.goal}</h1>
      {task.name && <p className="whitespace-pre-wrap">{task.goal}</p>}
      {task.description && <details><summary>原始材料</summary><p className="max-h-48 overflow-auto whitespace-pre-wrap">{task.description}</p></details>}
      {!!task.resources?.length && <details className="shrink-0 rounded-md border p-3">
        <summary>任务资源 · {task.resources.length}</summary>
        <ul className="mt-2 grid gap-2">{task.resources.map(r=><li key={r.kind+r.name}>
          <strong>{resourceType[r.kind]}</strong> <code className="break-all">{r.name}</code>
          <p className="text-sm text-muted-foreground">{r.description}</p>
          {open && !task.paused && <Button type="button" size="sm" variant="outline" disabled={busy}
            onClick={()=>setDraft(old=>r.command?r.command+" "+old.replace(/^\/skill:\S+\s*/,""):`请使用 ${r.name}。`+old)}>
            {r.kind==="skill"?"使用此 Skill":"在消息中引用"}</Button>}
        </li>)}</ul>
      </details>}
      {task.runtime==="legacy" && <div className="flex flex-wrap items-center gap-3">
        <p>历史任务 · 只读记录</p>
        {!MOCK && <SessionFactAudit taskId={id}/>}
      </div>}
      <MessageScrollerProvider><MessageScroller className="min-h-28 flex-1"><MessageScrollerViewport preserveScrollOnPrepend><MessageScrollerContent className="gap-4">
        {history.next_before && <Button variant="outline" disabled={busy} onClick={()=>perform(async()=>{
          const h=await http<History>(base+"/messages?before="+history.next_before);
          setHistory({messages:[...h.messages,...history.messages],next_before:h.next_before});
        })}>更早的记录</Button>}
        {history.messages.map(m=><Message key={m.id} align={m.role==="user"?"end":"start"}><MessageContent>
          <MessageHeader>{entryLabel(m)}{m.action==="call"?(returned.has(m.tool_call_id)?" · 调用":" · 调用，尚无返回"):m.action==="result"?" · 返回":m.action?.startsWith("skill:")?" · Skill "+m.action.slice(6):""}{m.error?" · 失败":""}{task.accepted_entry===m.id?" · 已验收":""}</MessageHeader>
          <Bubble variant={m.error?"destructive":"secondary"}><BubbleContent className="whitespace-pre-wrap break-words">{m.text}</BubbleContent></Bubble>
          {open && m.confirmed && <Button className="self-start" size="sm" variant="outline" disabled={busy} onClick={()=>control("finish",m.id)}>以此回复验收目标</Button>}
        </MessageContent></Message>)}
      </MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton/></MessageScroller></MessageScrollerProvider>
      {open && task.status!=="paused" && <form className="flex flex-col gap-2" onSubmit={e=>{e.preventDefault();void send();}}>
        <Field><FieldLabel htmlFor="message">目标会话</FieldLabel><Textarea id="message" maxLength={64000} disabled={busy} value={draft} onChange={e=>setDraft(e.target.value)} /></Field>
        <Button disabled={busy || (!draft.trim() && history.messages.length>0)}>{busy?"处理中…":draft.trim()?"发送":"按目标开始"}</Button>
      </form>}
    </>:!error && <p role="status">读取任务中…</p>}
  </main>;
}

function Route(){const id=useSearchParams().get("id");return id?<GoalDetail key={id} id={id}/>:<p>缺少任务 ID</p>;}
export default function TaskDetailPage(){return <Suspense><Route/></Suspense>;}
