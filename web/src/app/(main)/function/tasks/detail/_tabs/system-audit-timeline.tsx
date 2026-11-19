"use client";
import * as React from 'react';
import Link from 'next/link';
import {Flag,OctagonPause,Lightbulb,History,ChevronDown,ArrowUpRight} from 'lucide-react';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {ToggleGroup,ToggleGroupItem} from '@/components/ui/toggle-group';
import {Collapsible,CollapsibleContent,CollapsibleTrigger} from '@/components/ui/collapsible';
import {ActivityBody,ActivityContentProvider} from '@/components/activity-body';
import {auditFilters,auditSource,auditStatus,auditSourceHref,type AuditFilter} from '@/lib/system-audit';
import type {Activity} from '@/lib/types';
import {SessionTranscript} from './session-workspace';

function AuditItem({step,taskId}:{step:Activity;taskId:string}){
 const [open,setOpen]=React.useState(false),event=step.audit_event;
 if(!event)return null;
 const Icon={correction:Flag,control:OctagonPause,important_fact:Lightbulb,system:History}[event.type];
 const date=new Date(step.ts),href=auditSourceHref(taskId,step);
 return <li data-audit-id={step.seq} className="relative min-w-0 border-l pb-6 pl-7 last:pb-1">
  <span className="absolute -left-3 flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground"><Icon className="size-3.5"/></span>
  <article className="flex min-w-0 flex-col gap-2" aria-label={event.title}>
   <div className="flex flex-wrap items-center gap-2">
    <strong className="text-sm">{event.title}</strong><Badge variant="outline">{auditSource(event.source)}</Badge>
    <Badge variant="secondary">{auditStatus(event.status)}</Badge>
    {event.intent_id&&<span className="text-xs text-muted-foreground">Worker · 意图 #{event.intent_id}</span>}
   </div>
   <time dateTime={Number.isNaN(date.getTime())?undefined:date.toISOString()} className="text-xs text-muted-foreground" suppressHydrationWarning>{Number.isNaN(date.getTime())?'时间未记录':date.toLocaleString('zh-CN',{hour12:false})}</time>
   <Collapsible open={open} onOpenChange={setOpen}>
    <div className="flex min-w-0 flex-col gap-2">
     {!open&&<p className="line-clamp-3 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{step.summary||event.reason||event.title}</p>}
     {event.reason&&event.reason!==step.summary&&!open&&<p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{event.type==='important_fact'?'重要原因：':'原因：'}{event.reason}</p>}
     <CollapsibleContent>{open&&<div className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">{event.type==='important_fact'?<p className="whitespace-pre-wrap">{step.summary}{'\n\n重要原因：'}{event.reason}</p>:<ActivityBody step={step}/>}</div>}</CollapsibleContent>
     <div className="flex flex-wrap items-center gap-2">
      {<CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start"/>{open?'收起详情':'展开详情'}</Button></CollapsibleTrigger>}
      {href&&<Button variant="ghost" size="sm" asChild><Link href={href}><ArrowUpRight data-icon="inline-start"/>{event.fact_id?`查看事实 #${event.fact_id}`:'定位原会话'}</Link></Button>}
     </div>
    </div>
   </Collapsible>
  </article>
 </li>;
}
export function SystemAuditTimeline({filter,onFilter,...props}:Omit<React.ComponentProps<typeof SessionTranscript>,'renderItems'|'emptyTitle'>&{filter:AuditFilter;onFilter:(value:AuditFilter)=>void}){
 return <div className="flex min-h-0 flex-1 flex-col" aria-label="系统事件时间线">
  <div className="shrink-0 border-b p-3">
   <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={value=>{if(value in auditFilters)onFilter(value as AuditFilter);}} className="flex-wrap" aria-label="系统事件分类">
    {Object.entries(auditFilters).map(([value,label])=><ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>)}
   </ToggleGroup>
  </div>
  <SessionTranscript {...props} emptyTitle="暂无系统事件" renderItems={items=><ActivityContentProvider taskId={props.taskId}><ol className="ml-3 min-w-0" aria-label="重要事件时间线">{items.map(step=><AuditItem key={step.seq} step={step} taskId={props.taskId}/>)}</ol></ActivityContentProvider>}/>
 </div>;
}
