"use client";
import {useEffect,useState} from 'react';
import {Alert,AlertTitle,AlertDescription} from '@/components/ui/alert';
import {http} from '@/lib/api';

type OperationRecord = {id:number; intent_id:number; tool_name:string; status:string; interruption?:{description:string}};

/** The text contains a reference. Only the matching journal entry can supply its status. */
export function OperationInterruption({taskId,intentId,tool,operationId}:{
  taskId:string; intentId:string; tool:string; operationId:number;
}){
  const [detail,setDetail]=useState("");
  useEffect(()=>{
    const controller=new AbortController();
    setDetail("");
    const query=new URLSearchParams({intent_id:intentId,operation_id:String(operationId)});
    void http<{items:OperationRecord[]}>(`/tasks/${encodeURIComponent(taskId)}/operations?${query}`,{signal:controller.signal})
      .then(({items})=>{
        const record=items.find(r=>r.id===operationId && String(r.intent_id)===intentId && r.tool_name===tool && r.status==='uncertain');
        if(!controller.signal.aborted)setDetail(record?.interruption?.description??"");
      }).catch(()=>{}); // Optional context; the original tool receipt remains visible.
    return()=>controller.abort();
  },[taskId,intentId,tool,operationId]);
  if(!detail)return null;
  return <Alert role="note" aria-label="关联操作记录">
    <AlertTitle>关联操作记录 · operation:{operationId}</AlertTitle>
    <AlertDescription className="whitespace-pre-wrap">{detail}</AlertDescription>
  </Alert>;
}
