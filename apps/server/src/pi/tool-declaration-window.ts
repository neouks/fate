import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';
import type {ToolLoading} from '../agent/tool-loading.js';
import {loadedToolReceipt} from './platform-mcp.js';

/** Only declaration lifetime changes. Executions, arguments and results remain
 * in the native audit transcript, and discovery still enforces live bindings. */
export function toolDeclarationWindow(policy:ToolLoading|undefined,settling:()=>boolean=()=>false):ExtensionFactory|undefined {
  const idle=policy?.idleToolRequests;
  if(!idle||!policy.deferred.length)return;
  const deferred=new Set(policy.deferred);
  return api=>{
    let request=0;
    const seen=new Map<string,number>();
    api.on('tool_execution_end',event=>{
      if(deferred.has(event.toolName))seen.set(event.toolName,request);
      if(event.toolName==='tool_search'&&!event.isError){
        const details=event.result?.details;
        for(const names of [details?.loaded,details?.already_loaded])if(Array.isArray(names))
          for(const name of names)if(typeof name==='string'&&deferred.has(name))seen.set(name,request);
      }
    });
    api.on('context',event=>{
      if(request===0&&event.messages.some(message=>message.role==='assistant')){
        // A new Runner must not renew every old discovery on resume. Recover
        // recency from the last few native turns, including a search not yet used.
        for(const name of api.getActiveTools())if(deferred.has(name))seen.set(name,-idle);
        let age=0;
        for(let i=event.messages.length-1;i>=0&&age<=idle;i--){
          const message=event.messages[i]!;
          if(message.role==='toolResult'){
            const names=[message.toolName];
            const details=(message as {details?:{loaded?:unknown;already_loaded?:unknown}}).details;
            if(message.toolName==='tool_search')for(const loaded of [details?.loaded,details?.already_loaded])
              if(Array.isArray(loaded))names.push(...loaded.filter((name):name is string=>typeof name==='string'));
            for(const name of names)if(deferred.has(name))seen.set(name,Math.max(seen.get(name)??-idle,-age));
          }
          if(message.role==='assistant')age++;
        }
      }
      request++;
      if(settling())return; // The host explicitly pins writeback tools for settlement.
      const active=api.getActiveTools();
      for(const name of [...seen.keys()])if(!active.includes(name))seen.delete(name);
      const keep=active.filter(name=>{
        if(!deferred.has(name))return true;
        if(!seen.has(name))seen.set(name,request);
        if(request-seen.get(name)!<=idle)return true;
        seen.delete(name);
        return false;
      });
      if(keep.length!==active.length)api.setActiveTools(keep);
    });
    api.on('context_with_system',event=>{
      const active=new Set(api.getActiveTools());
      const retained=new Set<string>();
      // Some transports replay in-place historical declarations. Merely removing
      // an active tool would still send its old schema on those transports.
      // Project only tool metadata; never edit the persisted conversation.
      const messages=[...event.messages].reverse().map(message=>{
        if(message.role==='toolResult'&&message.toolName==='tool_search'&&!message.isError){
          const details=(message as {details?:{loaded?:unknown;discovery_version?:number}}).details;
          const loaded=details?.loaded;
          if(!details?.discovery_version&&Array.isArray(loaded)&&loaded.length&&loaded.every(name=>typeof name==='string'))
            return {...message,content:[{type:'text' as const,text:loadedToolReceipt(loaded)},...message.content.slice(1)]};
        }
        return message.role==='system'?{
        ...message,
        ...(message.toolsAdded?{toolsAdded:message.toolsAdded.filter(tool=>{
          if(!deferred.has(tool.name))return true;
          if(!active.has(tool.name)||retained.has(tool.name))return false;
          retained.add(tool.name);return true;
        })}:{}),
        ...(message.toolsRemoved?{toolsRemoved:message.toolsRemoved.filter(tool=>!deferred.has(tool.name))}:{}),
      }:message;
      }).reverse();
      return {messages};
    });
  };
}
