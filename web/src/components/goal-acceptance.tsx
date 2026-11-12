"use client";
import * as React from 'react';
import {api} from '@/lib/api';
import {GraphNodeReader} from '@/components/graph-node-reader';
import {Button} from '@/components/ui/button';
import {Alert,AlertDescription} from '@/components/ui/alert';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogTrigger,DialogFooter} from '@/components/ui/dialog';

export type GoalAcceptance={id:string;goal_hash:string;evidence_hash:string;goal_text:string;evidence_id:string;evidence_kind:'fact'|'finding';evidence_summary:string;note:string;status:string;state:string;fresh:boolean;valid:boolean;method:string};
export function GoalAcceptanceReview({task,goal,onReviewed}:{task:string;goal:string;onReviewed:()=>void}){
 const [open,setOpen]=React.useState(false),[loaded,setLoaded]=React.useState(false),[proof,setProof]=React.useState<GoalAcceptance|null>(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
 const generation=React.useRef(0);
 const read=React.useCallback(async()=>{const request=++generation.current;setLoaded(false);setError('');setProof(null);try{const r=await api.goalAcceptance(task,goal);if(request===generation.current)setProof(r.acceptance);}catch{if(request===generation.current)setError('无法读取验收记录，请重试');}finally{if(request===generation.current)setLoaded(true);}},[task,goal]);
 React.useEffect(()=>{if(open)void read();return()=>{generation.current++;};},[open,read]);
 async function review(action:'approve'|'reject'){
  if(!proof||busy)return;setBusy(true);setError('');
  try{await api.reviewGoalAcceptance(task,goal,{action,acceptance_id:proof.id,goal_hash:proof.goal_hash,evidence_hash:proof.evidence_hash});await read();onReviewed();}
  catch(e){setError(e instanceof Error?e.message:'保存失败，请重新读取');}
  finally{setBusy(false);}
 }
 return <Dialog open={open} onOpenChange={value=>{if(!busy)setOpen(value);}}><DialogTrigger asChild><Button variant="outline" size="sm">核验目标</Button></DialogTrigger>
  <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>目标验收</DialogTitle><DialogDescription>请核对目标原文与实际证据。确认只保存验收结果，不启动任务。</DialogDescription></DialogHeader>
   {error&&<Alert variant="destructive"><AlertDescription>{error}<Button variant="outline" size="sm" onClick={()=>void read()}>重新读取</Button></AlertDescription></Alert>}
   {!loaded?<p role="status">读取中…</p>:proof?<div className="flex min-w-0 flex-col gap-4">
    <p className="whitespace-pre-wrap break-words">{proof.goal_text}</p>
    <p className="text-sm text-muted-foreground">{proof.valid?'当前证明已核验':!proof.fresh?'目标或证据已变化，原申请不可确认':proof.status==='rejected'?'已退回':proof.method==='coverage'?'由平台按实时覆盖记录核验':'等待人工核验'}</p>
    {proof.note&&<p className="whitespace-pre-wrap break-words">申请说明：{proof.note}</p>}
    <GraphNodeReader taskID={task} nodeID={proof.evidence_id} kind={proof.evidence_kind}/>
   </div>:!error&&<p>尚无可核对的验收申请；历史达成标记不等于有效证明。</p>}
   {proof?.method==='manual'&&proof.status==='pending'&&proof.fresh&&<DialogFooter>
    <Button variant="outline" disabled={busy} onClick={()=>void review('reject')}>证据不足，退回</Button>
    <Button variant="outline" disabled={busy} onClick={()=>void review('approve')}>确认此目标已达成</Button>
   </DialogFooter>}
  </DialogContent></Dialog>;
}
