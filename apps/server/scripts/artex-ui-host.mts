// Local, isolated acceptance fixture. No paid provider or remote target.
import path from 'node:path';import {mkdirSync,writeFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';
import {openDatabase} from '../src/db/index.js';import {Engine,defaultEngineConfig} from '../src/engine/engine.js';import {buildApp} from '../src/http/app.js';import {signJWT} from '../src/http/auth.js';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';import {ModelRuntime} from '@earendil-works/pi-coding-agent';
const dir='/private/tmp/fate-artex-ui',db=await openDatabase();mkdirSync(path.join(dir,'skills'),{recursive:true});
const task=await db.tasks().createTaskWithOptions('ARTEX 验收：暂停与继续','仅测试本机合成数据',{executionMode:'manual'}),s=db.exploration(task.exploration_id);
const id=await s.addIntent({summary:'本机 PTY 夹具：保存观察，等待暂停后继续',dispatch_requested:true},5,[],'user');
const runtime=await ModelRuntime.create({refreshOnCreate:false}),worker=fauxProvider({provider:'artex-ui-worker'}),main=fauxProvider({provider:'artex-ui-main'});await runtime.registerNativeProvider(worker.provider);await runtime.registerNativeProvider(main.provider);
worker.setResponses([
 fauxAssistantMessage([fauxToolCall('record_fact',{summary:'本机观察已经写回',evidence:'LOCAL fixture; no network',confidence:'high'}),fauxToolCall('shell_open',{command:"python3 -u -c 'import time; print(\"本机终端已就绪\"); time.sleep(120)'",mode:'handsfree'})]),
 async(_ctx,options)=>{await new Promise<void>(r=>options?.signal?.addEventListener('abort',()=>r(),{once:true}));return fauxAssistantMessage('执行已暂停');},
 fauxAssistantMessage([fauxToolCall('record_fact',{summary:'人工续跑后新增观察',evidence:'LOCAL resumed once',confidence:'high'})]),
 fauxAssistantMessage('执行完成，两个独立观察均已保存。'),
]);
main.setResponses([fauxAssistantMessage('已读取当前任务记录；Worker 的事实在结束前即可查看。')]);
const engine=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:20},async(_task,role)=>({modelRuntime:runtime,model:(role==='worker'?worker:main).getModel() as never}),dir),jwt=randomUUID();
const app=buildApp({db,engine,jwtKey:jwt,dataDir:dir,skillsRoot:path.join(dir,'skills'),version:'artex-ui-fixture',startedAt:Date.now()});
await app.listen({port:18987,host:'127.0.0.1'});writeFileSync(path.join(dir,'token'),signJWT(jwt),{mode:0o600});writeFileSync(path.join(dir,'state.json'),JSON.stringify({task_id:task.id,intent_id:id,exp_id:task.exploration_id}));await engine.run(task.id);
process.on('SIGTERM',async()=>{await engine.shutdown();await app.close();await db.close();process.exit(0);});
