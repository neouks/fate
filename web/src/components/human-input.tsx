"use client";

import * as React from 'react';
import {CircleHelpIcon,SendIcon,XIcon,ChevronDownIcon,ArrowUpRightIcon,EyeIcon,EyeOffIcon,LockKeyholeIcon} from 'lucide-react';
import {api} from '@/lib/api';
import {type HumanInputRequest,type HumanInputUpdate,humanInputSource,mergeHumanInputs} from '@/lib/human-input';
import {Alert,AlertTitle,AlertDescription} from '@/components/ui/alert';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Field,FieldGroup,FieldLabel,FieldDescription} from '@/components/ui/field';
import {InputGroup,InputGroupInput,InputGroupTextarea,InputGroupAddon} from '@/components/ui/input-group';
import {ToggleGroup,ToggleGroupItem} from '@/components/ui/toggle-group';
import {Collapsible,CollapsibleTrigger,CollapsibleContent} from '@/components/ui/collapsible';

export function useHumanInputs(taskId:string){
 const [items,setItems]=React.useState<HumanInputRequest[]>([]),[error,setError]=React.useState('');
 const [drafts,setDrafts]=React.useState<Record<string,string>>({});
 const setDraft=React.useCallback((id:string,value:string)=>setDrafts(old=>old[id]===value?old:{...old,[id]:value}),[]);
 const active=React.useRef(taskId);active.current=taskId;
 const snapshotGeneration=React.useRef(0);
 const receive=React.useCallback((next:HumanInputRequest[],source:HumanInputUpdate='detail')=>{
  if(active.current!==taskId||!Array.isArray(next)||next.some(r=>r.task_id!==taskId))return;
  if(source==='snapshot')snapshotGeneration.current++;
  setError('');
  setItems(old=>mergeHumanInputs(old,next,taskId,source));
  setDrafts(old=>{
   const statuses=new Map(next.map(r=>[r.id,r.status]));
   const ended=Object.keys(old).filter(id=>(source==='snapshot'||statuses.has(id))&&statuses.get(id)!=='pending');
   if(!ended.length)return old;
   const copy={...old};
   for(const id of ended)delete copy[id];
   return copy;
  });
 },[taskId]);
 const refresh=React.useCallback(async()=>{
  const generation=++snapshotGeneration.current;
  try{
   const result=await api.inputRequests(taskId);
   if(generation===snapshotGeneration.current)receive(result.items,'snapshot');
  }catch{
   if(active.current===taskId&&generation===snapshotGeneration.current)setError('人工问答暂时无法同步');
  }
 },[taskId,receive]);
 React.useEffect(()=>{setItems([]);setDrafts({});setError('');void refresh();},[refresh]);
 return {taskId,items,receive,refresh,error,drafts,setDraft};
}
export const HumanInputsContext=React.createContext<ReturnType<typeof useHumanInputs>|null>(null);
const labels={pending:'等待回答',answered:'已回答',cancelled:'已取消',expired:'已过期',interrupted:'已中断'};

export function HumanInputInbox({onLocate}:{onLocate:(r:HumanInputRequest)=>void}){
 const ctx=React.useContext(HumanInputsContext);if(!ctx)return null;
 const pending=ctx.items.filter(r=>r.status==='pending');
 if(!pending.length&&!ctx.error)return null;
 return <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-2" aria-live="polite">
  <Badge variant="outline"><CircleHelpIcon/>Need input · {pending.length}</Badge>
  {pending.map(r=><Button key={r.id} size="sm" variant="outline" onClick={()=>onLocate(r)} title={r.question}><ArrowUpRightIcon data-icon="inline-start"/>{humanInputSource(r)}</Button>)}
  {ctx.error&&<Button size="sm" variant="ghost" onClick={()=>void ctx.refresh()}>{ctx.error} · 重试</Button>}
 </div>;
}

export function HumanInputCard({id,question,readOnly=false,activityId,focused,onLocated}:{id:string;question?:string;readOnly?:boolean;activityId?:number;focused?:boolean;onLocated?:(el:HTMLElement)=>void}){
 const ctx=React.useContext(HumanInputsContext),r=ctx?.items.find(item=>item.id===id);
 const isPlainEditor=r?.kind==='editor'&&!r.sensitive;
 const value=ctx?.drafts[id]??(isPlainEditor?r.prefill??r.placeholder??'':'');
 const setValue=(value:string)=>ctx?.setDraft(id,value);
 const [busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[show,setShow]=React.useState(false),[expanded,setExpanded]=React.useState(false);
 const root=React.useRef<HTMLDivElement>(null);
 React.useEffect(()=>{if(focused&&r&&root.current)onLocated?.(root.current);},[focused,!!r,onLocated]);
 const pending=r?.status==='pending'&&!readOnly;
 const taskId=ctx?.taskId,receive=ctx?.receive;
 React.useEffect(()=>{if(!taskId||r||readOnly)return;let alive=true;
  void api.inputRequests(taskId,id).then(result=>{if(alive){if(result.items.length)receive?.(result.items);else setError('问题已不可用');}}).catch(()=>{if(alive)setError('问题加载失败，请重新连接');});
  return()=>{alive=false;};
 },[taskId,id,!!r,readOnly,receive]);
 React.useEffect(()=>{if(!pending)setShow(false);},[pending]);
 const respond=async(action:'answer'|'cancel')=>{
  if(!ctx||!r||busy||!pending)return;setBusy(true);setError('');
  try{const answer=r.kind==='confirm'?value==='yes':value;const result=await api.respondInput(ctx.taskId,id,{action,...(action==='answer'?{answer}:{})});ctx.receive([result]);setExpanded(false);}
  catch(e){setError((e as Error).message||'提交失败');await ctx.refresh();}finally{setBusy(false);}
 };
 return <Alert ref={root} variant="notice" data-human-input-id={id} data-search-activity={activityId} className="my-2 min-w-0" role="region" aria-label="人工协助问题">
  <AlertTitle className="flex flex-wrap items-center gap-2"><CircleHelpIcon/><span>Need input · 需要协助</span><Badge variant="outline">{r?labels[r.status]:'问题记录'}</Badge>{r&&<span>{humanInputSource(r)}</span>}{r?.sensitive&&<LockKeyholeIcon aria-label="敏感回答"/>}</AlertTitle>
  <AlertDescription className="min-w-0">
   <Collapsible open={!!pending||expanded} onOpenChange={setExpanded}>
    {!pending&&<CollapsibleTrigger asChild><Button size="sm" variant="ghost"><ChevronDownIcon data-icon="inline-start"/>查看问题与回答</Button></CollapsibleTrigger>}
    <CollapsibleContent>
     <form onSubmit={e=>{e.preventDefault();void respond('answer');}}>
      <FieldGroup><Field data-invalid={!!error} data-disabled={!pending||busy}>
       <FieldLabel htmlFor={`human-${id}`} className="whitespace-pre-wrap break-words">{r?.question??question}</FieldLabel>
       {pending&&r&&(r.kind==='select'||r.kind==='confirm'?<ToggleGroup type="single" variant="outline" className="flex-wrap justify-start" value={value} onValueChange={setValue} disabled={busy} aria-label={r.question}>
        {(r.kind==='confirm'?['yes','no']:r.options??[]).map(option=><ToggleGroupItem key={option} value={option}>{r.kind==='confirm'?(option==='yes'?'是':'否'):option}</ToggleGroupItem>)}
       </ToggleGroup>:<InputGroup>
        {r.sensitive?<InputGroupInput id={`human-${id}`} type={show?'text':'password'} value={value} onChange={e=>setValue(e.target.value)} disabled={busy} autoComplete="off" maxLength={16000} aria-invalid={!!error} placeholder={r.placeholder??'请输入回答'}/>:<InputGroupTextarea id={`human-${id}`} value={value} onChange={e=>setValue(e.target.value)} disabled={busy} maxLength={16000} aria-invalid={!!error} placeholder={isPlainEditor?'请输入回答':r.placeholder??'请输入回答'}/>}
        {r.sensitive&&<InputGroupAddon><Button size="icon-sm" variant="ghost" type="button" aria-label={show?'隐藏回答':'显示回答'} onClick={()=>setShow(!show)}>{show?<EyeOffIcon/>:<EyeIcon/>}</Button></InputGroupAddon>}
       </InputGroup>)}
       {!pending&&r?.status==='answered'&&<p className="whitespace-pre-wrap break-words">{r.sensitive?'敏感回答已隐藏':typeof r.answer==='boolean'?(r.answer?'是':'否'):r.answer}</p>}
       {pending&&r?.sensitive&&<FieldDescription>回答将提供给当前 Agent，并保留在会话历史中。</FieldDescription>}
       {r?.expires_at&&<FieldDescription>有效期至 {new Date(r.expires_at).toLocaleString('zh-CN')}</FieldDescription>}
       {r?.status==='interrupted'&&<FieldDescription>原执行已中断。恢复后若仍需协助，将重新提问。</FieldDescription>}
       {pending&&<div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={busy||(!isPlainEditor&&!value.trim())}><SendIcon data-icon="inline-start"/>{busy?'提交中…':'回答并继续'}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>void respond('cancel')}><XIcon data-icon="inline-start"/>取消回答</Button></div>}
      </Field></FieldGroup>
     </form>
    </CollapsibleContent>
   </Collapsible>
   {error&&<p role="alert">{error}</p>}
  </AlertDescription>
 </Alert>;
}
