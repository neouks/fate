"use client";
import * as React from 'react';
import {api} from '@/lib/api';
import {newerSummary,type TurnSummary,type TurnSummaryBatch} from '@/lib/turn-summary';

/** Reuses the existing scope SSE; opening a popover never creates a subscription. */
export function useTurnSummaries(taskId:string|undefined,conversationId:number|undefined,ids:string[]){
 const scope=conversationId?`conversation:${conversationId}`:taskId?`task:${taskId}`:'';
 const [state,setState]=React.useState<{scope:string;items:Record<string,TurnSummary>}>({scope,items:{}});
 const key=[...new Set(ids)].sort().join(',');
 React.useEffect(()=>{
  let alive=true;
  setState(old=>old.scope===scope?old:{scope,items:{}});
  const merge=(batch:TurnSummaryBatch)=>{if(!alive)return;setState(old=>{
   const items=old.scope===scope?{...old.items}:{};
   for(const value of batch.items)if(newerSummary(items[value.turn_id],value))items[value.turn_id]=value;
   for(const id of batch.requested_ids)if(!batch.items.some(v=>v.turn_id===id))delete items[id];
   return {scope,items};
  });};
  const event=(e:Event)=>{const data=(e as CustomEvent<TurnSummaryBatch&{scope:string}>).detail;if(data.scope===scope)merge(data);};
  window.addEventListener('series:turn-summary',event);
  const all=key.split(',').filter(Boolean);
  if(scope)for(let at=0;at<all.length;at+=100){const ids=all.slice(at,at+100);void api.turnSummaries(taskId,conversationId,ids).then(r=>merge({...r,requested_ids:ids})).catch(()=>{/* Legacy servers keep their ordered transcript; unknown is never zero. */});}
  return()=>{alive=false;window.removeEventListener('series:turn-summary',event);};
 },[scope,key,taskId,conversationId]);
 return state.scope===scope?state.items:{};
}
