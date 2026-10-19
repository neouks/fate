/** Offline, actual pi/OpenAI request capture. No provider credentials or target requests. */
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import pg from 'pg';
import {openDatabase} from '../src/db/index.js';
import {buildModelSource} from '../src/pi/providerFromProfile.js';
import {runPlannerRound,runWorkerIntent,configureAgentEnv} from '../src/agent/roles.js';
import {TodoStore} from '../src/tools/context.js';

const variant=process.argv[2];
if(!['before','after'].includes(variant))throw new Error('Specify before or after');
const out=new URL('../../../docs/reviews/evidence/context-prefix-20261019/',import.meta.url);
mkdirSync(out,{recursive:true});
const name=`fate_prefix_capture_${process.pid}`,root='/tmp/fate-context-prefix-fixture';
const rows:any[]=[];let current={role:'',round:0};
const http=createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c);
 const payload=JSON.parse(Buffer.concat(chunks).toString());rows.push({...current,payload});
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 res.write(`data: ${JSON.stringify({id:'local-only',object:'chat.completion.chunk',created:0,model:'local-model',choices:[{index:0,delta:{role:'assistant',content:'LOCAL 合成资料核对完成。'},finish_reason:null}]})}\n\n`);
 res.end(`data: ${JSON.stringify({id:'local-only',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;process.env.SERIES_LOG_LEVEL='silent';
const db=await openDatabase();
try{
 rmSync(root,{recursive:true,force:true});mkdirSync(root,{recursive:true});
 const skills=root+'/skills';
 for(const n of ['z-evidence','a-recall']){
  mkdirSync(`${skills}/${n}`,{recursive:true});writeFileSync(`${skills}/${n}/SKILL.md`,`---\nname: ${n}\ndescription: Read only local synthetic evidence when needed.\n---\nLOCAL fixture, no network.\n`);
  await db.query("INSERT INTO agent_skill_visibility(agent_id,skill_name,enabled) SELECT id,$1,true FROM agents WHERE key IN ('planner','worker') ON CONFLICT DO NOTHING",[n]);
 }
 configureAgentEnv({skillsDir:skills});
 await db.query("UPDATE agents SET max_turns=0,run_seconds=0 WHERE key IN ('planner','worker')");
 const source=await buildModelSource({id:999,name:'LOCAL',model:'local-model',apiKey:'local-fixture',baseURL:`http://127.0.0.1:${(http.address() as any).port}/v1`,contextWindowK:128,maxTokens:128,streaming:true});
 const task=await db.tasks().createTaskWithOptions('LOCAL 离线资料核对','只核对本地合成记录，不访问任何测试目标。',{}),s=db.exploration(task.exploration_id);
 await s.addNode('goal',{text:task.goal},0,'open','user',[]);
 for(let i=0;i<25;i++)await s.addNode('fact',{summary:`LOCAL 已有观察 ${i}：离线样本字段及相应结论。`,detail:'不预加载的完整证据。'.repeat(100),evidence:`LOCAL evidence ${i}`},0,'confirmed','fixture',[]);
 const todos=new TodoStore(db);await todos.set(task.exploration_id,[{id:'follow-up',content:'核对已有资料；不重复执行已经完成的意图。',status:'pending'}] as never);
 for(let i=0;i<3;i++){
  current={role:'planner',round:i};
  const fact=await s.addNode('fact',{summary:`LOCAL 本轮新观察 ${i}`,evidence:`LOCAL new evidence ${i}`},0,'confirmed','fixture',[]);
  await runPlannerRound({db,taskID:task.id,expID:task.exploration_id,goal:task.goal,model:source,dataDir:root,todos,hooks:{},triggersText:`LOCAL 完成通知 ${i}`,events:[{seq:i,node_id:fact}],changes:[{ref:`node:${fact}`,source_task_id:task.id,version:1,summary:`LOCAL 本轮新观察 ${i}`}],maxTurns:4,onActivity:()=>{}});
 }
 for(let i=0;i<3;i++){
  current={role:'worker',round:i};const id=await s.addIntent({summary:`核对 LOCAL 合成字段 ${i} 是否存在，只读取本地证据，不进行网络请求。`,dispatch_requested:true},5,[],'user');
  const intent=await s.claimNextWorker('worker-fixture');if(intent?.id!==id)throw new Error('Unexpected intent');
  await runWorkerIntent({db,taskID:task.id,expID:task.exploration_id,workerName:'worker-fixture',intent,model:source,dataDir:root,hooks:{},maxTurns:4,onActivity:()=>{}});
  await s.setIntentState(id,'done');
 }
 writeFileSync(new URL(`${variant}-requests.json`,out),JSON.stringify({method:'native pi sessions through local OpenAI HTTP fixture; usage intentionally absent',target_requests:0,provider_requests:0,rows},null,2)+'\n');
 console.log(JSON.stringify({variant,requests:rows.length,bytes:rows.map(r=>({role:r.role,round:r.round,bytes:Buffer.byteLength(JSON.stringify(r.payload))}))}));
}finally{
 await db.close();await new Promise<void>(r=>http.close(()=>r()));
 const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();
 configureAgentEnv({});rmSync(root,{recursive:true,force:true});
}
