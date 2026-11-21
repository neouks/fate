import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {registerConversationRoutes} from './conversations.js';
import {resolveModelProfiles} from '../../pi/modelResolver.js';

async function fixture(){
  const selected=new Map<string,number>();
  const calls:{sql:string;params:unknown[]}[]=[];
  const profiles=[1,2].map(id=>({id,name:`Profile ${id}`,model:`model-${id}`,format:'openai'}));
  const db:any={tasks:()=>({getTask:async(id:number)=>id===10?{id,exploration_id:100}:null}),
    platform:()=>({profileByID:async(id:number)=>profiles.find(p=>p.id===id),activeProfile:async()=>profiles[0],getBool:async()=>false}),
    query:async(sql:string,params:unknown[]=[])=>{
      calls.push({sql,params});const key=`${params[0]}:${params[1]}`;
      if(sql.startsWith('INSERT INTO task_session_profiles')){selected.set(key,Number(params[2]));return {rows:[],rowCount:1};}
      if(sql.startsWith('DELETE FROM task_session_profiles')){selected.delete(key);return {rows:[],rowCount:1};}
      if(sql.startsWith('SELECT profile_id FROM task_session_profiles'))return {rows:selected.has(key)?[{profile_id:selected.get(key)}]:[]};
      if(sql.startsWith('SELECT id FROM exploration_nodes'))return {rows:[],rowCount:params[0]===99&&params[1]===100?1:0};
      if(sql.startsWith('WITH ledger'))return {rows:[{input_tokens:100,output_tokens:5,cache_read_tokens:0,cache_write_tokens:0,input_complete:true,usage_complete:true}]};
      if(sql.includes('FROM llm_usage_ledger'))return {rows:[]};
      if(sql.includes('FROM agents'))return {rows:[{enabled:true}]};
      return {rows:[]};
    }};
  const app=Fastify();app.decorate('db',db);app.decorate('engine',{} as never);registerConversationRoutes(app);await app.ready();
  return {app,db,selected,calls};
}
test('model selection is isolated by task conversation and resolves on the next run',async()=>{
  const {app,db}=await fixture();
  try {
    for(const session of ['main:0','plan','intent:99']){
      const r=await app.inject({method:'PATCH',url:'/api/tasks/10/session-model',payload:{session,profile_id:2}});
      assert.equal(r.statusCode,200);assert.equal(r.json().effective,'next_run');
      const role=session==='plan'?'planner':session.startsWith('main')?'mainagent':'worker';
      assert.equal((await resolveModelProfiles(db,10,role,{sessionKey:session})).profiles[0].id,2);
    }
    assert.equal((await resolveModelProfiles(db,10,'mainagent',{sessionKey:'main:1'})).profiles[0].id,1);
    assert.equal((await resolveModelProfiles(db,10,'worker',{sessionKey:'intent:100'})).profiles[0].id,1);
    await app.inject({method:'PATCH',url:'/api/tasks/10/session-model',payload:{session:'main:0',profile_id:null}});
    const r=await app.inject('/api/tasks/10/session-model?session=main:0');
    assert.equal(r.json().profile_id,null);assert.equal(r.json().resolution.profile_id,1);
  }finally{await app.close();}
});
test('rejects foreign workers, missing tasks, invalid models and malformed sessions',async()=>{
  const {app,selected}=await fixture();
  try{
    for(const [task,session,profile,status] of [[10,'intent:101',2,404],[11,'plan',2,404],[10,'main:0',22,404],[10,'main:-1',2,400],[10,'plan',-1,400],[10,'system',2,400]] as const){
      const r=await app.inject({method:'PATCH',url:`/api/tasks/${task}/session-model`,payload:{session,profile_id:profile}});
      assert.equal(r.statusCode,status);
    }
    assert.equal(selected.size,0);
  }finally{await app.close();}
});
test('planner and worker usage never aggregate the whole task',async()=>{
  const {app,calls}=await fixture();
  try{
    assert.equal((await app.inject('/api/tasks/10/session-usage?session=plan')).statusCode,200);
    const planner=calls.filter(c=>c.sql.startsWith('WITH ledger'));
    assert.ok(planner.every(c=>c.sql.includes('role=ANY')&&c.sql.includes('conversation_id IS NULL')));
    calls.length=0;
    assert.equal((await app.inject('/api/tasks/10/session-usage?session=intent:99')).statusCode,200);
    const worker=calls.filter(c=>c.sql.startsWith('WITH ledger'));
    assert.ok(worker.every(c=>c.sql.includes('intent_id=$2')&&c.params[1]===99));
  }finally{await app.close();}
});
