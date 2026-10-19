// Deterministic native-pi process-crash fixture. No network or model credentials.
import pg from 'pg';import {Database} from '../src/db/index.js';
import {Engine,defaultEngineConfig} from '../src/engine/engine.js';
import {Coordinator} from '../src/engine/coordinator.js';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
const config=JSON.parse(process.env.FATE_BLACKBOARD_CRASH!),db=new Database(new pg.Pool({connectionString:process.env.SERIES_PG_DSN}));
const runtime=await ModelRuntime.create({refreshOnCreate:false}),faux=fauxProvider({provider:'blackboard-crash'});await runtime.registerNativeProvider(faux.provider);
const send=(m:unknown)=>process.send?.(m);let calls=0;
faux.setResponses(Array.from({length:5},()=>async context=>{
 calls++;send({type:'request',calls});
 const fact=(await db.query("SELECT id,payload FROM exploration_nodes WHERE kind='fact' AND payload->>'from_intent'=$1",[String(config.intent)])).rows[0];
 if(!fact)return fauxAssistantMessage([fauxToolCall('record_fact',{summary:'LOCAL crash sample',evidence:'Observed exactly once in the original process',confidence:'high'})]);
 if(config.generation===1&&config.mode==='published'){send({type:'kill_ready'});await new Promise(()=>{});}
 if(config.generation===2&&!JSON.stringify(context.messages).includes('LOCAL crash sample'))throw new Error('Published observation missing after recovery');
 return fauxAssistantMessage(`LOCAL crash observation saved as node:${fact.id}.`);
}));
if(config.generation===1&&config.mode==='finished'){
 const release=Coordinator.prototype.releaseSlot;
 Coordinator.prototype.releaseSlot=async function(...args){send({type:'kill_ready'});await new Promise(()=>{});return release.apply(this,args);};
}
const engine=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:5},async()=>({modelRuntime:runtime,model:faux.getModel() as never}),config.dir);
await engine.run(config.task);send({type:'ready'});
process.on('message',async m=>{if(m==='stop'){await engine.shutdown();await db.close();process.exit(0);}});
process.on('disconnect',()=>process.exit(2));
