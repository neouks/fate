// Opt-in real-model integration. Creates isolated chats; never changes user tasks.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';import {randomUUID} from 'node:crypto';
import pg from 'pg';import {postgresDSN} from '../src/config/index.js';import {signJWT} from '../src/http/auth.js';
assert.equal(process.env.FATE_REAL_MODEL_TEST,'1','Real model requests must be explicitly enabled');
const origin=process.env.FATE_TEST_ORIGIN||'http://127.0.0.1:8787',profile=Number(process.env.FATE_PROFILE_ID||453);
const token=signJWT((await readFile('jwt.key','utf8')).trim());
const pool=new pg.Pool({connectionString:postgresDSN().dsn});
const evidence:any={stages:[]};
const output=process.env.FATE_CONTROL_EVIDENCE||'/tmp/fate-session-controls-live.json';
async function api(url:string,body?:unknown,method=body?'POST':'GET'){
 const r=await fetch(origin+'/api'+url,{method,headers:{'X-Series-Token':token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const data=await r.json();assert.ok(r.ok,JSON.stringify({url,status:r.status,data}));return data as any;
}
try{
 const original=(await pool.query('SELECT thinking_type,reasoning_effort FROM llm_profiles WHERE id=$1',[profile])).rows[0];
 const chat=process.env.FATE_CONTROL_CONVERSATION?{id:Number(process.env.FATE_CONTROL_CONVERSATION)}:await api('/conversations',{agent_key:'auto',title:'Pi 配置真实模型回归',llm_profile_id:profile});evidence.conversationID=chat.id;
 const baseline=(await api(`/conversations/${chat.id}/usage`)).total.calls;
 for(const [index,thinking] of ['off','xhigh'].entries()){
  const settings=await api(`/conversations/${chat.id}/controls`,{thinking_level:thinking,tool_preset:'none'},'PATCH');
  assert.equal(settings.thinking_level,thinking);assert.equal(settings.tool_preset,'none');
  await api(`/conversations/${chat.id}/messages`,{message:'这是界面配置回归测试。不要调用工具或访问任何网站。请只回复 OK。',request_id:randomUUID()});
  let settled=false;
  for(let i=0;i<120;i++){
   const usage=await api(`/conversations/${chat.id}/usage`);
   if(usage.total.calls>=baseline+index+1&&!usage.total.pending_calls){
    const runs=(await pool.query('SELECT status,error FROM conversation_runs WHERE conversation_id=$1 ORDER BY id DESC LIMIT 1',[chat.id])).rows;
    if(runs[0]?.status==='failed')throw new Error(runs[0].error);
    if(runs[0]?.status==='completed'){
     const runtime=(await pool.query('SELECT effective FROM runtime_role_configs WHERE conversation_id=$1 ORDER BY started_at DESC LIMIT 1',[chat.id])).rows[0];
     assert.deepEqual(runtime.effective.tools,[]);assert.deepEqual(runtime.effective.active_tools,[]);
     const native=(await pool.query("SELECT usage FROM llm_usage_ledger WHERE conversation_id=$1 AND source='native_response' ORDER BY created_at DESC LIMIT 1",[chat.id])).rows[0].usage;
     if(thinking==='off')assert.equal(native.reasoning??0,0);else assert.ok(native.reasoning>0,'Provider returned real reasoning tokens');
     evidence.stages.push({thinking,usage,nativeUsage:native,tools:runtime.effective.tools});settled=true;break;
    }
   }
   await new Promise(r=>setTimeout(r,1000));
  }
  assert.ok(settled,'Real request completed');console.log('PASS actual model settings',thinking);
 }
 assert.deepEqual((await pool.query('SELECT thinking_type,reasoning_effort FROM llm_profiles WHERE id=$1',[profile])).rows[0],original);
 // Exercise native manual compaction with an explicitly synthetic historical fixture.
 // Only its summary and continuation invoke the provider; zero fake billable usage is inserted.
 const compactChat=await api('/conversations',{agent_key:'auto',title:'Pi 压缩端点回归（合成历史）',llm_profile_id:profile});evidence.compactionConversationID=compactChat.id;
 await api(`/conversations/${compactChat.id}/controls`,{thinking_level:'off',tool_preset:'none'},'PATCH');
 const cwd=path.resolve('data/conversations',String(compactChat.id)),file=path.join(cwd,'session.jsonl');await mkdir(cwd,{recursive:true});
 const entries:any[]=[{type:'session',version:3,id:randomUUID(),timestamp:new Date().toISOString(),cwd}];let parent:string|null=null;
 for(let turn=0;turn<5;turn++){
  for(const message of [
   {role:'user',content:`Synthetic historical block ${turn}. All numbered rows are inert test data.\n`+Array.from({length:500},(_,i)=>`Archived synthetic row ${i}: blue square alpha beta gamma delta epsilon.`).join('\n'),timestamp:Date.now()},
   {role:'assistant',content:[{type:'text',text:'ACK. This is synthetic fixture history, not a real model response.'}],api:'openai-completions',provider:`series-p${profile}`,model:'deepseek-flash',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()},
  ]){const id=randomUUID().slice(0,8);entries.push({type:'message',id,parentId:parent,timestamp:new Date().toISOString(),message});parent=id;}
 }
 await writeFile(file,entries.map(e=>JSON.stringify(e)).join('\n')+'\n',{flag:'wx'});
 await pool.query('UPDATE conversations SET session_file=$2 WHERE id=$1',[compactChat.id,file]);
 const result=await api(`/conversations/${compactChat.id}/controls/compact`,{});assert.equal(result.status,'compacted');
 const after=await api(`/conversations/${compactChat.id}/usage`);assert.equal(after.context.tokens,null);assert.equal(after.context.state,'compacted');assert.equal(after.total.compaction_calls,1);assert.equal(after.total.usage_complete,true);
 assert.ok((await readFile(file,'utf8')).split('\n').some(s=>s&&JSON.parse(s).type==='compaction'));
 evidence.compaction={result,usage:after,syntheticHistory:true};console.log('PASS real Pi manual compaction',JSON.stringify(after.total));
 await api(`/conversations/${compactChat.id}/messages`,{message:'根据摘要继续，不使用工具，只回复 OK。',request_id:randomUUID()});
 let continued=false;
 for(let i=0;i<120;i++){
  const usage=await api(`/conversations/${compactChat.id}/usage`);
  if(usage.total.calls>=2&&!usage.total.pending_calls&&usage.context.state==='recorded'){
   assert.equal(usage.total.compaction_calls,1);evidence.continuation=usage;continued=true;break;
  }
  await new Promise(r=>setTimeout(r,1000));
 }
 assert.ok(continued,'Continuation calibrates context after manual compaction');console.log('PASS continuation after compact');
}finally{await writeFile(output,JSON.stringify(evidence,null,2));await pool.end();console.log('Evidence:',output);}
