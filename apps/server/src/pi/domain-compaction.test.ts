import {describe,it,expect,afterEach} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {AgentRunner,type AgentRunnerOptions} from './runner.js';
import {PLATFORM_ROLES} from './platform-policy.js';

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
async function fixture(role='worker',extra:Partial<AgentRunnerOptions>={}){
  const cwd=mkdtempSync(path.join(tmpdir(),'fate-domain-'));dirs.push(cwd);
  const faux=fauxProvider({provider:`domain-${path.basename(cwd)}`}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});
  await modelRuntime.registerNativeProvider(faux.provider);
  const responses:unknown[]=[],activities:unknown[]=[],purposes:string[]=[],sizes:string[]=[];
  const options:AgentRunnerOptions={cwd,agentDir:path.join(cwd,'agent'),resumeSessionPath:path.join(cwd,'session.jsonl'),
    modelRuntime,model:faux.getModel() as never,toolAllowlist:[],systemPrompt:`${role}: LOCAL synthetic only`,
    platform:{role,taskID:1,policy:{version:'domain-v1',compaction:'domain',mcpLoading:'deferred'}},
    compactionSettings:{keepRecentTokens:32,reserveTokens:1024},
    loadDomainState:async()=>({intent_ref:'node:7',version:3,status:'running',pending:['写回已有观察并总结'],evidence:[{ref:'node:9',version:2}]}),
    onActivity:a=>activities.push(a),onRequestSize:(_s,p)=>{sizes.push(p??'conversation');},
    modelPolicy:{onResponse:async r=>{responses.push(r);},retry:async()=>false,setPurpose:p=>{purposes.push(p);}},...extra};
  const runner=await AgentRunner.create(options);
  faux.setResponses([fauxAssistantMessage('已记录阶段进展。'.repeat(150)),fauxAssistantMessage('当前阻塞仍待解决。')]);
  await runner.prompt('本地合成历史，执行验收条件 A；线索 B 尚未验证。'.repeat(100));
  await runner.prompt('继续当前意图，证据 node:9 version 2。');
  return {cwd,faux,runner,options,responses,activities,purposes,sizes};
}
describe('native domain compaction',()=>{
  it.each(PLATFORM_ROLES)('%s retains checkpoint, native entry and summary usage',async role=>{
    const f=await fixture(role);
    f.faux.setResponses([context=>{
      const text=JSON.stringify(context.messages);expect(text).toContain('node:7');expect(text).toContain('未验证');
      expect(text).not.toContain('Preserve exact file paths');
      return fauxAssistantMessage('已尝试 A，node:9 v2；B 为线索，阻塞待恢复，尚未 写回已有观察并总结。');
    }]);
    try{
      await f.runner.compact();
      const entries=readFileSync(f.runner.sessionFile!,'utf8').trim().split('\n').map(s=>JSON.parse(s));
      const summary=entries.find(e=>e.type==='compaction');
      expect(summary.details).toMatchObject({version:'domain-v1',role,checkpoint:{intent_ref:'node:7',version:3}});
      expect(summary.summary).toContain('不是新的事实或授权');expect(summary.firstKeptEntryId).toBeTruthy();
      expect(f.responses).toHaveLength(3);expect(f.activities.filter((a:any)=>a.kind==='usage')).toHaveLength(3);
      expect(f.runner.compactionDiagnostics).toEqual({requests:1,completed:1,failed:0});
      expect(f.purposes).toEqual(['compaction','conversation']);
    }finally{await f.runner.dispose();}
  });
  it('resumes and compacts twice with updated host state and no duplicate summary usage',async()=>{
    const f=await fixture();f.faux.setResponses([fauxAssistantMessage('首次摘要，node:9 v2')]);
    await f.runner.compact();await f.runner.dispose();
    const runner=await AgentRunner.create({...f.options,loadDomainState:async()=>({intent_ref:'node:7',version:4,status:'blocked',pending:['写回已有观察并总结']})});
    f.faux.setResponses([context=>{expect(JSON.stringify(context.messages)).toContain('首次摘要');return fauxAssistantMessage('恢复后只查看已授权引用。'.repeat(80));},fauxAssistantMessage('更新摘要，禁止重试旧地址')]);
    try{await runner.prompt('授权已撤销，保存阻塞位置');await runner.compact();
      const entries=readFileSync(runner.sessionFile!,'utf8').trim().split('\n').map(s=>JSON.parse(s));
      const summaries=entries.filter(e=>e.type==='compaction');expect(summaries).toHaveLength(2);
      expect(summaries[1].details.checkpoint).toMatchObject({version:4,status:'blocked'});
      expect(f.activities.filter((a:any)=>a.kind==='usage')).toHaveLength(5);
    }finally{await runner.dispose();}
  });
  it.each(['empty','error','length'])('cancels %s summary without default fallback or transcript truncation',async kind=>{
    const f=await fixture();const before=readFileSync(f.runner.sessionFile!,'utf8');
    f.faux.setResponses([fauxAssistantMessage(kind==='empty'?'':'partial',{...(kind==='error'?{stopReason:'error' as const,errorMessage:'local failure'}:{}),...(kind==='length'?{stopReason:'length' as const}:{})})]);
    try{await expect(f.runner.compact()).rejects.toThrow();expect(readFileSync(f.runner.sessionFile!,'utf8')).toBe(before);
      expect(f.faux.state.callCount).toBe(3);expect(f.runner.compactionDiagnostics.failed).toBe(1);
    }finally{await f.runner.dispose();}
  });
  it('bounds summary retries and retries the request without executing tools',async()=>{
    let retried=0;const f=await fixture('worker',{modelPolicy:{onResponse:async()=>{},retry:async()=>{retried++;return true;}}});
    f.faux.setResponses(Array.from({length:3},()=>fauxAssistantMessage('',{stopReason:'error',errorMessage:'local 429'})));
    try{await expect(f.runner.compact()).rejects.toThrow();expect(retried).toBe(2);expect(f.runner.compactionDiagnostics.requests).toBe(3);}
    finally{await f.runner.dispose();}
  });
  it('does not start a summary after exhausting the shared model request budget',async()=>{
    const f=await fixture('worker',{maxTurns:2});
    try{await expect(f.runner.compact()).rejects.toThrow('预算');expect(f.faux.state.callCount).toBe(2);}
    finally{await f.runner.dispose();}
  });
  it('honors cancellation before summarizing without changing the transcript',async()=>{
    const controller=new AbortController(),f=await fixture('worker',{signal:controller.signal});
    const before=readFileSync(f.runner.sessionFile!,'utf8');controller.abort();
    try{await expect(f.runner.compact()).rejects.toThrow();expect(f.faux.state.callCount).toBe(2);expect(readFileSync(f.runner.sessionFile!,'utf8')).toBe(before);}
    finally{await f.runner.dispose();}
  });
  it.each([false,true])('automatic compaction on resume preserves success/failure semantics (fail=%s)',async fail=>{
    const f=await fixture();await f.runner.dispose();
    const small=fauxProvider({provider:f.options.model.provider,models:[{id:f.options.model.id,contextWindow:2000,maxTokens:512}]});
    await f.options.modelRuntime.registerNativeProvider(small.provider);
    const runner=await AgentRunner.create({...f.options,model:small.getModel() as never,compactionSettings:{keepRecentTokens:32,reserveTokens:512}});
    small.setResponses(Array.from({length:4},()=>context=>JSON.stringify(context.messages).includes('压缩安全测试平台会话')?fauxAssistantMessage(fail?'':'LOCAL compacted, intent node:7'):fauxAssistantMessage('LOCAL resumed '.repeat(600))));
    try{
      if(fail){await expect(runner.prompt('LOCAL resume')).rejects.toThrow('压缩');expect(runner.compactionDiagnostics.failed).toBe(1);expect(small.state.callCount).toBeLessThanOrEqual(2);}
      else {await runner.prompt('LOCAL resume');expect(runner.compactionDiagnostics.completed).toBeGreaterThan(0);}
    }finally{await runner.dispose();}
  });
  it('uses native summary generation in rollback mode and accounts for each summary request',async()=>{
    const f=await fixture('mainagent',{platform:{role:'mainagent',taskID:1,policy:{version:'domain-v1',compaction:'native',mcpLoading:'direct'}}});
    f.faux.setResponses([fauxAssistantMessage('LOCAL native summary'),fauxAssistantMessage('LOCAL native turn prefix')]);
    try{await f.runner.compact();const entries=readFileSync(f.runner.sessionFile!,'utf8').trim().split('\n').map(s=>JSON.parse(s));
      expect(entries.find(e=>e.type==='compaction').details).toMatchObject({policy:'native',readFiles:[],modifiedFiles:[]});
      expect(f.activities.filter((a:any)=>a.kind==='usage')).toHaveLength(2+f.runner.compactionDiagnostics.requests);
      expect(f.runner.compactionDiagnostics.requests).toBeGreaterThan(0);
    }finally{await f.runner.dispose();}
  });
  it('does not send a subsequent conversational request after a summary consumes the last allowance',async()=>{
    const f=await fixture('worker',{maxTurns:3});f.faux.setResponses([fauxAssistantMessage('LOCAL compacted'),fauxAssistantMessage('must not be requested')]);
    try{await f.runner.compact();const result=await f.runner.prompt('continue');expect(result.aborted).toBe(true);expect(result.stopReason).toBe('budget');expect(f.faux.state.callCount).toBe(3);}
    finally{await f.runner.dispose();}
  });
});
