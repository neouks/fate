// Isolated synthetic UI acceptance; deliberately has no model or target access.
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {postgresDSN} from '../src/config/index.js';
import {openDatabase} from '../src/db/index.js';
import {Engine,defaultEngineConfig} from '../src/engine/engine.js';
import {buildApp} from '../src/http/app.js';
import {signJWT} from '../src/http/auth.js';
import {LiveStreamWriter} from '../src/engine/live-stream.js';
const url=new URL(postgresDSN().dsn);url.pathname='/fate_neo_turn_ui_20261019';process.env.SERIES_PG_DSN=url.toString();
const dir='/tmp/fate-neo-turn-ui';mkdirSync(dir,{recursive:true});const db=await openDatabase();
const task=await db.tasks().createTaskWithOptions('本地合成验收 · Neo 对话','只验证显示，不运行目标操作',{executionMode:'manual'}),store=db.exploration(task.exploration_id);
const engine=new Engine(db,defaultEngineConfig(),async()=>{throw new Error('UI fixture forbids model access');},dir);
const jwt=randomUUID(),app=buildApp({db,engine,jwtKey:jwt,dataDir:dir,skillsRoot:dir,version:'neo-turn-isolated',startedAt:Date.now()});
const response=(stream:string,tools=false)=>({stream_id:stream,channel:'text',response:{stop_reason:tools?'toolUse':'stop',has_tools:tools,model:'LOCAL deterministic',provider:'faux',usage:{input:100,output:30,cacheRead:5,cacheWrite:0}}});
const add=(worker:string,turn:string,kind:string,text:string,extra:Record<string,unknown>={})=>store.appendActivity({worker,main_seg:worker==='main'?0:undefined,kind,summary:text,detail:text,...extra,metadata:{turn_id:turn,...extra.metadata as object}} as never);
async function seed(worker:string,role:string,turn:string,node?:number){
 const extra=node?{node_id:node}:{};
 await add(worker,turn,'status','',{...extra,metadata:{event_type:'turn_start',role,mode:'manual',started_at:new Date(Date.now()-179000).toISOString()}});
 await add(worker,turn,'thinking','核对合成资料的来源和证据引用。',{...extra,metadata:{stream_id:turn+'1',channel:'thinking'}});
 await add(worker,turn,'text','我先核对本地样本，再整理本轮结论。',{...extra,metadata:response(turn+'1',true)});
 for(let i=0;i<2;i++){
  await add(worker,turn,'tool_use','读取本地合成资料',{...extra,tool:'context_get',tool_use_id:turn+i,detail:JSON.stringify({ref:'LOCAL:sample',view:i?'evidence':'summary'})});
  await add(worker,turn,'tool_result',i?'LOCAL evidence verified':'LOCAL sample found',{...extra,tool:'context_get',tool_use_id:turn+i});
 }
 const body=`### 本轮检查完成\n\n已核对 **2 份本地合成资料**，原始记录可从执行过程展开查看。\n\n| 项目 | 结果 |\n| --- | --- |\n| 来源与版本 | 已核对 |\n| 请求范围 | 仅本地夹具 |\n\n\`\`\`json\n{"source":"LOCAL","verified":true}\n\`\`\``;
 await add(worker,turn,'text',body,{...extra,metadata:response(turn+'2')});
 await add(worker,turn,'result',role==='worker'?body:'回复完成',{...extra,metadata:{event_type:role==='worker'?'outcome':'lifecycle',status:'completed'}});
}
await add('main','main-example','user','请汇总这轮本地验证结果。');await seed('main','mainagent','main-example');
await seed('planner','planner','planner-example');await seed('goals','goals','goals-example');
const intent=await store.addIntent({summary:'核对本地合成资料并保存最终结论'},1,[],'user');await seed('work#1','worker','worker-example',intent);await store.setIntentState(intent,'done');
const conversations:Record<string,number>={};
for(const role of ['auto','pentest','reporter','retester']){
 const c=(await db.query('INSERT INTO conversations(agent_key,title,task_id) VALUES($1,$2,$3) RETURNING id',[role,`LOCAL ${role}`,task.id])).rows[0];conversations[role]=Number(c.id);
 const events=[['status','',{event_type:'turn_start',role,mode:'conversation',started_at:new Date(Date.now()-6000).toISOString()}],['thinking','核对本地资料。',{stream_id:role+'1',channel:'thinking'}],['assistant',`${role}：本地合成资料已处理。`,response(role+'1')],['result','回复完成',{event_type:'lifecycle',status:'completed'}]];
 for(const [kind,text,meta] of events)await db.query('INSERT INTO conversation_activities(conversation_id,worker,kind,summary,detail,metadata) VALUES($1,$2,$3,$4,$4,$5::jsonb)',[c.id,role,kind,text,JSON.stringify({turn_id:role,...meta as object})]);
}
let active=false;
app.post('/__fixture/stream',async()=>{
 if(active)return {running:true};active=true;const turn=randomUUID(),stream=randomUUID();const writer=new LiveStreamWriter(db,'task',task.exploration_id,{worker:'main',main_seg:0,turn_id:turn});let text='';
 const metrics:{part:string;at:number}[]=[];
 await add('main',turn,'status','',{metadata:{event_type:'turn_start',role:'mainagent',mode:'manual',started_at:new Date().toISOString()}});
 await add('main',turn,'thinking','检查流式与折叠状态。',{metadata:{stream_id:stream,channel:'thinking'}});
 void(async()=>{try{
  for(let i=1;i<=12;i++){await new Promise(r=>setTimeout(r,600));const part=`实时第${i}段。`;text+=part;metrics.push({part,at:Date.now()});writer.push({kind:'assistant_delta',streamID:stream,text:part});}
  await add('main',turn,'text',text,{metadata:response(stream)});await writer.committed(stream,'text');
  await add('main',turn,'result','回复完成',{metadata:{event_type:'lifecycle',status:'completed'}});
 }finally{await writer.close();active=false;writeFileSync(dir+'/stream.json',JSON.stringify({turn,stream,metrics,finished:Date.now()}));}})();return {turn,stream};
});
await app.listen({port:18889,host:'127.0.0.1'});writeFileSync(dir+'/state.json',JSON.stringify({task_id:task.id,intent_id:intent,conversations}));writeFileSync(dir+'/token',signJWT(jwt),{mode:0o600});
process.on('SIGTERM',async()=>{await app.close();await engine.shutdown();await db.close();process.exit(0);});
