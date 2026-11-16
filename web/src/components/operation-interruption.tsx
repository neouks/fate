"use client";
import {useEffect,useState} from 'react';
import {Alert,AlertTitle,AlertDescription} from '@/components/ui/alert';
import {http} from '@/lib/api';

/** Read-only context alongside the immutable tool result; never resolves or replays an operation. */
export function OperationInterruption({taskId,operationId}:{taskId:string;operationId:number}){
 const [detail,setDetail]=useState('正在读取操作记录…');
 useEffect(()=>{
  const controller=new AbortController();setDetail('正在读取操作记录…');
  void http<{items:{id:number;interruption?:{description:string}}[]}>(`/tasks/${encodeURIComponent(taskId)}/operations?operation_id=${operationId}`,{signal:controller.signal})
   .then(value=>{if(!controller.signal.aborted)setDetail(value.items.find(item=>item.id===operationId)?.interruption?.description??'当前操作没有可用的中断详情；请以原始输出为准。');})
   .catch(error=>{if(!controller.signal.aborted)setDetail(`中断详情读取失败：${error instanceof Error?error.message:String(error)}。原始输出仍保留如下。`);});
  return()=>controller.abort();
 },[taskId,operationId]);
 return <Alert role="note" aria-label="中断原因详情">
  <AlertTitle>中断原因详情 · operation:{operationId}</AlertTitle>
  <AlertDescription className="whitespace-pre-wrap">{detail}</AlertDescription>
 </Alert>;
}
