import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {compact,type ExtensionFactory} from '@earendil-works/pi-coding-agent';
import type {AgentRunnerOptions} from './runner.js';
import {TOKEN_LIMIT_REACHED,TOKEN_USAGE_UNCERTAIN} from '../db/worker-token-budget.js';
import {requestSize} from '../agent/prompt-diagnostics.js';

export interface CompactionHealth {error?:Error; requests:number; completed:number; failed:number; cancelled?:number;}

/** Native pi owns the cut point, retained tool pairs, transcript and compaction entry. */
export function nativeCompactionExtension(opts:AgentRunnerOptions,health:CompactionHealth,remaining:()=>number=()=>Infinity):ExtensionFactory {
  return pi=>{
    pi.on('session_before_compact',async(event,ctx)=>{
      opts.modelPolicy?.setPurpose?.('compaction');
      health.error=undefined;
      const signal=AbortSignal.any([event.signal,AbortSignal.timeout(60_000),...(opts.signal?[opts.signal]:[])]);
      try{
        signal.throwIfAborted();
        const model=ctx.model??opts.model;
        const request=async(context:Parameters<typeof opts.modelRuntime.completeSimple>[1])=>{
        if(opts.summaryTargetTokens)context={...context,messages:[{role:'system',content:`摘要尽量控制在约 ${opts.summaryTargetTokens} token 内；优先保留必要依据、未完成事项和可召回引用，不复制长篇原文。`,timestamp:Date.now()},...context.messages]};
        // Native split-turn summaries do not inherit compact() customInstructions.
        // Apply retention requirements to every physical summary request as well.
        if(opts.compactionInstructions&&!JSON.stringify(context.messages).includes(opts.compactionInstructions))
          context={...context,messages:[{role:'system',content:opts.compactionInstructions,timestamp:Date.now()},...context.messages]};
        for(let attempt=0;attempt<3;attempt++){
          signal.throwIfAborted();
          if(remaining()<=0)throw new Error('模型请求预算已用尽，保留原始会话等待恢复');
          health.requests++;
          let response;
          try{
            response=await opts.modelRuntime.completeSimple(model,context,{signal,reasoning:opts.thinkingLevel==='off'?undefined:opts.thinkingLevel,cacheRetention:'none',
              onPayload:async payload=>{await opts.onRequestSize?.(requestSize(payload),'compaction');}});
          }catch{
            await opts.modelPolicy?.onResponse({stopReason:signal.aborted?'aborted':'error',errorMessage:'摘要模型请求失败'});
            signal.throwIfAborted();
            if(attempt<2&&await opts.modelPolicy?.retry(signal))continue;
            throw new Error('摘要模型请求失败');
          }
          // Each attempt, including failed summaries, is audited and counted exactly once.
          await opts.modelPolicy?.onResponse(response);
          const u=response.usage;
          if(u)await opts.onActivity?.({kind:'usage',input:u.input,output:u.output,cacheRead:u.cacheRead,cacheWrite:u.cacheWrite});
          signal.throwIfAborted();
          if(response.stopReason==='error'){
            if(response.errorMessage?.startsWith(TOKEN_LIMIT_REACHED) || response.errorMessage?.startsWith(TOKEN_USAGE_UNCERTAIN))
              throw new Error(response.errorMessage);
            if(attempt<2&&await opts.modelPolicy?.retry(signal))continue;
            throw new Error('摘要模型请求失败');
          }
          if(response.content.some(b=>b.type==='toolCall'))
            throw new Error('摘要返回了工具调用，原始会话已保留');
          if(response.stopReason!=='stop'){
            const reason=response.stopReason==='length'?'达到模型输出长度上限':response.stopReason;
            throw new Error(`摘要未完整生成（${reason}），原始会话已保留`);
          }
          const summary=response.content.filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
          if(!summary)throw new Error('摘要为空，原始会话已保留');
          return response;
        }
          throw new Error('摘要重试耗尽');
        };
        const p={...event.preparation,
          messagesToSummarize:opts.projectMessages?.(event.preparation.messagesToSummarize)??event.preparation.messagesToSummarize,
          turnPrefixMessages:opts.projectMessages?.(event.preparation.turnPrefixMessages)??event.preparation.turnPrefixMessages};
        // Reuse the SDK's exact summary format/file tracking while auditing each physical request.
        const previous=[...event.branchEntries].reverse().find(e=>e.type==='compaction');
        const details=previous?.type==='compaction'?previous.details as {policy?:string;readFiles?:string[];modifiedFiles?:string[]}|undefined:undefined;
        if(details?.policy==='native'){
          for(const file of details.readFiles??[])p.fileOps.read.add(file);
          for(const file of details.modifiedFiles??[])p.fileOps.written.add(file);
        }
        const instructions=[event.customInstructions,opts.compactionInstructions].filter(Boolean).join('\n\n')||undefined;
        const result=await compact(p,model,undefined,undefined,instructions,signal,undefined,
          async(_model,context)=>{const response=await request(context);const stream=createAssistantMessageEventStream();stream.end(response);return stream;},
          undefined,{enabled:false,maxRetries:0,baseDelayMs:0});
        return {compaction:{...result,details:{...result.details as object,policy:'native',version:opts.platform?.policy.version}}};
      }catch(error){
        // A task pause/SDK cancellation may arrive during next-turn compaction.
        // Preserve the original session and report cancellation, not a corrupt
        // summary. Network timeout and genuine summary failures still fail closed.
        if(opts.signal?.aborted || event.signal.aborted){
          health.cancelled=(health.cancelled??0)+1;
          ctx.abort();
          return {cancel:true};
        }
        health.error=error instanceof Error?error:new Error('会话压缩失败');health.failed++;
        // Extension exceptions are swallowed by pi; explicitly cancel so default compaction cannot run.
        ctx.abort();
        return {cancel:true};
      }finally{opts.modelPolicy?.setPurpose?.('conversation');}
    });
    pi.on('session_compact',()=>{health.completed++;});
  };
}
