"use client";
import {notifyTurnSummaries} from '@/lib/turn-summary';
import * as React from 'react';
import { openActivityStream } from '@/lib/activity-event-source';
import { api, sseUrl } from '@/lib/api';
import { preserveTranscriptPosition } from '@/lib/transcript-scroll';
import type { Activity } from '@/lib/types';
import { mergeConversationActivities, withLiveStreams, type StreamSnapshot } from '@/lib/conversation-turns';

export function useConversationActivity(id:number|null){
  const [scope,setScope]=React.useState(id);
  const [records,setRecords]=React.useState<Activity[]>([]);
  const [streams,setStreams]=React.useState<StreamSnapshot[]>([]);
  const [status,setStatus]=React.useState('idle');
  const [connected,setConnected]=React.useState(false);
  const [error,setError]=React.useState('');
  const [hasMore,setHasMore]=React.useState(false);
  const [loading,setLoading]=React.useState(false);
  const generation=React.useRef(0);
  const currentID=React.useRef(id);currentID.current=id;
  React.useEffect(()=>{
    const token=++generation.current;let alive=true;let transport:ReturnType<typeof openActivityStream>|undefined;
    setScope(id);setRecords([]);setStreams([]);setStatus('idle');setConnected(false);setError('');setHasMore(false);
    if(!id)return;
    setLoading(true);
    void api.conversationHistory(id).then(history=>{
      if(!alive)return;
      setRecords(rows=>mergeConversationActivities(history.items,rows));setHasMore(history.hasMore);
      setStatus(history.running?'running':'idle');
      let cursor=history.cursor;
      transport=openActivityStream(()=>sseUrl(`/api/conversations/${id}/messages/stream?since=${cursor}`),es=>{
      es.onmessage=e=>{if(!alive)return;try{const a=JSON.parse(e.data) as Activity;cursor=Math.max(cursor,a.seq);setRecords(rows=>mergeConversationActivities(rows,[a]));}catch{/* replay repairs malformed frames */}};
      es.addEventListener('turn_summary',e=>{if(alive){try{notifyTurnSummaries(`conversation:${id}`,JSON.parse((e as MessageEvent).data));}catch{/* history repairs */}}});
      es.addEventListener('streams',e=>{if(alive){try{setStreams(JSON.parse((e as MessageEvent).data).items);}catch{transport?.close();setError('实时消息格式错误，请重新打开会话');}}});
      es.addEventListener('run_status',e=>{if(alive){const data=JSON.parse((e as MessageEvent).data);setStatus(data.status);if(data.error)setError(data.error);}});
      es.addEventListener('access_revoked',()=>{if(alive){setRecords([]);setStreams([]);setError('会话已删除或当前授权已撤销');setStatus('idle');transport?.close();}});
      },value=>{if(alive)setConnected(value);});
    }).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive&&generation.current===token)setLoading(false);});
    return()=>{alive=false;transport?.close();};
  },[id]);
  const loadEarlier=React.useCallback(async(viewport?:HTMLElement|null)=>{
    if(!id||loading||!hasMore)return;
    const restore=preserveTranscriptPosition(viewport??null);
    const token=generation.current;setLoading(true);
    try{const r=await api.conversationHistory(id,records.find(a=>a.seq>0)?.seq??0);if(token!==generation.current)return;setRecords(rows=>mergeConversationActivities(rows,r.items));setHasMore(r.hasMore);}
    catch(e){if(token===generation.current)setError((e as Error).message);}
    finally{if(token===generation.current)setLoading(false);restore();}
  },[id,loading,hasMore,records]);
  const sameScope=scope===id;
  return {records:sameScope?records:[],items:sameScope?withLiveStreams(records,streams):[],status:sameScope?status:'idle',setStatus:(value:string)=>{if(currentID.current===id)setStatus(value);},connected:sameScope&&connected,error:sameScope?error:'',hasMore:sameScope&&hasMore,loading:!sameScope||loading,loadEarlier,
    add:(a:Activity)=>{if(currentID.current===id)setRecords(rows=>mergeConversationActivities(rows,[a]));},
    removePending:(requestID:string)=>{if(currentID.current===id)setRecords(rows=>rows.filter(a=>!(a.seq<0&&a.turn_id===requestID)));},
    reconcile:(items:Activity[])=>{if(currentID.current===id)setRecords(rows=>mergeConversationActivities(rows,items));},
    running:sameScope&&['queued','pending','running','stopping','waiting_for_executor'].includes(status)};
}
