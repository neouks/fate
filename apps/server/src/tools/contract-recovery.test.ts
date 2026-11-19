import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall,validateToolArguments} from '@earendil-works/pi-ai';
import {ModelRuntime,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {effectiveToolDescription,TOOL_DESCRIPTIONS} from '../agent/tool-descriptions.js';
import {mandatoryToolContract,PREVIOUS_REQUIRED_TOOL_CONTRACTS} from '../agent/tool-description-policy.js';
import {compactToolSchema,toolLoadout} from '../agent/tool-loading.js';
import {applyToolBindings} from '../agent/tool-bindings.js';
import {previewRoleTools} from '../agent/tool-catalog.js';
import {AgentRunner,type RunnerActivity} from '../pi/runner.js';
import {recordExchange} from '../evidence/store.js';
import {runContext} from './context.js';
import {contextGetTool} from './context-read.js';
import {addIntentTool} from './intents.js';
import {CONTEXT_ITEM_LIMIT_GUIDANCE,INTENT_RETRY_GUIDANCE} from './input-contracts.js';

const ctx=(role:'worker'|'planner')=>runContext({} as Database,1,1,role);
const validate=(tool:ToolDefinition,args:Record<string,unknown>,prepare=true)=>validateToolArguments(tool,{
  type:'toolCall',id:'fixture',name:tool.name,arguments:prepare&&tool.prepareArguments?tool.prepareArguments(args):args,
});
async function invoke(tool:ToolDefinition,args:Record<string,unknown>){
  const result=await tool.execute('fixture',validate(tool,args),undefined,undefined,{} as never);
  return {error:result.isError===true,body:JSON.parse((result.content[0] as {text:string}).text)};
}

test('custom descriptions retain mandatory contracts exactly once',()=>{
  for(const [name,contract] of [['context_get',CONTEXT_ITEM_LIMIT_GUIDANCE],['add_intent',INTENT_RETRY_GUIDANCE]]){
    const custom='管理员自定义业务说明';
    const resolved=effectiveToolDescription(name!,'unused',custom);
    assert.equal(resolved.source,'custom');assert(resolved.description.startsWith(custom));
    assert(resolved.description.includes(contract!));
    assert.equal(mandatoryToolContract(name!,resolved.description),resolved.description);
    assert.equal(effectiveToolDescription(name!,'unused',resolved.description).description,resolved.description);
    const historical=effectiveToolDescription(name!,'unused',TOOL_DESCRIPTIONS[name!]+PREVIOUS_REQUIRED_TOOL_CONTRACTS[name!]);
    assert.equal(historical.source,'builtin');assert(historical.description.includes(contract!));
    const oldCustom=custom+PREVIOUS_REQUIRED_TOOL_CONTRACTS[name!];
    assert.equal(effectiveToolDescription(name!,'unused',oldCustom).description,oldCustom+' '+contract);

  }
});

test('native paging rejects the precise item before generic schema validation, without mutation',()=>{
  for(const role of ['planner','worker'] as const){
    const original=contextGetTool(ctx(role));
    for(const tool of [original,...toolLoadout(role,{customTools:[original],toolAllowlist:['context_get']}).customTools]){
      for(const ref of ['traffic:fixture','output:fixture','attachment:fixture'])for(const view of ['detail','summary','output']){
        const args={items:[{ref:'node:1'},{ref,view,max_chars:3000}]},before=structuredClone(args);
        assert.throws(()=>validate(tool,args),/CONTEXT_NATIVE_PAGING: items\[1\]\.max_chars/);
        assert.throws(()=>validate(tool,args,false)); // The schema constraint remains in place.
        assert.deepEqual(args,before);
      }
      assert.doesNotThrow(()=>validate(tool,{items:[{ref:'traffic:fixture'}],max_chars:3000}));
      assert.doesNotThrow(()=>validate(tool,{items:[{ref:'node:1',max_chars:3000}]}));
    }
  }
});

test('retry schema, preparation and direct execution reject incomplete retry arguments',async()=>{
  for(const tool of [addIntentTool(ctx('planner')),compactToolSchema(addIntentTool(ctx('planner')))]){
    const retry={summary:'synthetic',retry_of:1,retry_kind:'transient_failure',retry_reason:'恢复条件已满足'};
    for(const missing of ['retry_of','retry_kind','retry_reason']){
      const item:Record<string,unknown>={...retry};delete item[missing];
      const args={intents:[item]};
      assert.throws(()=>validate(tool,args),new RegExp('intents\\[0\\]\\.'+missing));
      assert.throws(()=>validate(tool,args,false));
      const result=await tool.execute('fixture',args,undefined,undefined,{} as never);
      assert.equal(result.isError,true);assert.match(JSON.stringify(result),new RegExp(missing));
    }
    for(const item of [{...retry,retry_reason:' '},{...retry,retry_kind:'unknown'},{...retry,retry_of:0},{...retry,replaces_intent_id:2}]){
      assert.throws(()=>validate(tool,{intents:[item]}));assert.throws(()=>validate(tool,{intents:[item]},false));
    }
    const work={resource:'fixture',question_key:'compare',method_class:'local',identity:'A'};
    for(const field of Object.keys(work)){
      assert.throws(()=>validate(tool,{intents:[{summary:'synthetic',contract:{work:{...work,[field]:' '}}}]}));
    }
    assert.doesNotThrow(()=>validate(tool,{intents:[retry]}));
    assert.doesNotThrow(()=>validate(tool,{intents:[{summary:'synthetic'}]}));
  }
});

test('native AgentRunner returns the actionable pre-validation error to the model',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-contract-recovery-'));
  t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'contract-recovery-local'});runtime.registerNativeProvider(faux.provider);
  for(const role of ['worker','planner'] as const){
    const tool=contextGetTool(ctx(role)),activities:RunnerActivity[]=[];
    faux.setResponses([
      ()=>fauxAssistantMessage([fauxToolCall(tool.name,{items:[{ref:'traffic:00000000-0000-0000-0000-000000000000:request',max_chars:3000}]})]),
      context=>{
        const results=JSON.stringify(context.messages.filter((m:any)=>m.role==='toolResult'));
        assert.match(results,/CONTEXT_NATIVE_PAGING: items\[0\]\.max_chars/);
        assert.doesNotMatch(results,/must not match the schema in not/);
        return fauxAssistantMessage('Parameter error understood.');
      },
    ]);
    const runner=await AgentRunner.create({cwd:dir,agentDir:dir,sessionDir:join(dir,role),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Synthetic local contract test.',customTools:[tool],toolAllowlist:[tool.name],onActivity:a=>{activities.push(a);}});
    try{await runner.prompt('Read the synthetic reference once.');}finally{await runner.dispose();}
    const results=activities.filter((a):a is Extract<RunnerActivity,{kind:'tool_end'}>=>a.kind==='tool_end');
    assert.equal(results.length,1);assert.equal(results[0]!.isError,true);
    assert.match(results[0]!.text!,/items\[0\]\.max_chars/);
  }
});

const dsn=process.env.TEST_TOOL_CONTRACTS_DSN;
test('retry and paging recovery use isolated records with no model or target requests',{skip:!dsn&&'requires isolated PostgreSQL'},async t=>{
  assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase();t.after(()=>db.close());
  const exp=await db.createExploration('fixture','local fixture');
  const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id) VALUES('fixture','fixture',$1) RETURNING id",[exp])).rows[0]!.id);
  const graph=db.exploration(exp),planner=runContext(db,task,exp,'planner'),tool=addIntentTool(planner);
  const add=(item:Record<string,unknown>)=>invoke(tool,{intents:[item]});
  const count=async()=>Number((await db.query("SELECT count(*) FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent'",[exp])).rows[0]!.count);
  const retry=(id:number)=>({retry_of:id,retry_kind:'transient_failure',retry_reason:'synthetic recovery'});
  const work={resource:'fixture:local',question_key:'comparison',method_class:'local',identity:'A'};

  await t.test('custom catalog and runtime bindings include the same contracts without editing configuration',async()=>{
    for(const name of ['add_intent','context_get'])await db.query('UPDATE tools SET description=$2 WHERE key=$1',[name,'custom '+name]);
    for(const role of ['planner','worker'] as const){
      const c=runContext(db,task,exp,role),tools=[contextGetTool(c),...(role==='planner'?[addIntentTool(c)]:[])];
      const preview=await previewRoleTools(db,role),bound=await applyToolBindings(db,role,tools);
      for(const loaded of toolLoadout(role,{customTools:bound,toolAllowlist:bound.map(t=>t.name)}).customTools){
        assert.equal(loaded.description,preview.descriptions[loaded.name]);
        assert.deepEqual(loaded.parameters,preview.schemas[loaded.name]);
        assert(loaded.description.includes(loaded.name==='add_intent'?INTENT_RETRY_GUIDANCE:CONTEXT_ITEM_LIMIT_GUIDANCE));
      }
    }
    assert.equal((await db.query("SELECT description FROM tools WHERE key='add_intent'")).rows[0]!.description,'custom add_intent');
  });

  await t.test('task 4899 shape distinguishes missing references from changed legacy work and rolls back batches',async()=>{
    const original=(await add({summary:'legacy local work'})).body.ids[0];await graph.setIntentState(original,'blocked');
    const before=await count();
    const changed=await add({summary:'rewritten local work',contract:{work},...retry(original)});
    assert.equal(changed.error,true);assert.match(changed.body.error,/INTENT_RETRY_WORK_MISMATCH.*没有 contract.work/);
    assert.match(changed.body.error,new RegExp('node:'+original));
    const foreignExp=await db.createExploration('foreign','fixture');
    const foreign=await db.exploration(foreignExp).addNode('intent',{summary:'legacy local work'},0,'blocked','fixture',[]);
    for(const id of [foreign,2147483647]){
      const missing=await add({summary:'legacy local work',...retry(id)});
      assert.equal(missing.error,true);assert.match(missing.body.error,/INTENT_RETRY_NOT_FOUND/);
    }
    const batch=await invoke(tool,{intents:[{summary:'must roll back'},{summary:'changed',...retry(original)}]});
    assert.equal(batch.error,true);assert.equal(await count(),before);
    const recovered=await add({summary:'legacy local work',...retry(original)});
    assert.equal(recovered.error,false);assert.equal(recovered.body.submitted,1);
    const duplicate=await add({summary:'legacy local work',...retry(original)});
    assert.equal(duplicate.error,false);assert.equal(duplicate.body.submitted,0);assert.deepEqual(duplicate.body.ids,recovered.body.ids);
  });

  await t.test('structured identity, completed state, changed basis and user cancellation remain enforced',async()=>{
    const original=(await add({summary:'structured work',contract:{work}})).body.ids[0];await graph.setIntentState(original,'blocked');
    const mismatch=await add({summary:'structured work',contract:{work:{...work,identity:'B'}},...retry(original)});
    assert.equal(mismatch.error,true);assert.match(mismatch.body.error,/INTENT_RETRY_WORK_MISMATCH.*双方都有/);
    const accepted=await add({summary:'same identity with new wording',contract:{work},...retry(original)});
    assert.equal(accepted.error,false);assert.equal(accepted.body.submitted,1);
    const current=accepted.body.ids[0];await graph.setIntentState(current,'done');
    const state=await add({summary:'structured work',contract:{work},...retry(current)});
    assert.equal(state.error,true);assert.match(state.body.error,/INTENT_RETRY_STATE.*state=done/);
    const unchanged=await add({summary:'structured work',contract:{work},...retry(current),retry_kind:'new_evidence'});
    assert.equal(unchanged.error,true);assert.match(unchanged.body.error,/INTENT_RETRY_BASIS_UNCHANGED/);
    const fact=await graph.addNode('fact',{summary:'synthetic new evidence'},0,'confirmed','fixture',[]);
    const fresh=await add({summary:'structured work',contract:{work,basis:[{node_id:fact,version:0}]},...retry(current),retry_kind:'new_evidence'});
    assert.equal(fresh.error,false);assert.equal(fresh.body.submitted,1);
    const cancelled=fresh.body.ids[0];await graph.setIntentState(cancelled,'stopped');
    await db.query("UPDATE exploration_nodes SET payload=payload||'{\"cancelled_by_user\":true}'::jsonb WHERE id=$1",[cancelled]);
    const denied=await add({summary:'structured work',contract:{work},...retry(cancelled)});
    assert.equal(denied.error,true);assert.match(denied.body.error,/用户已取消/);
  });

  await t.test('removing only the unsupported limit reads synthetic traffic and preserves native continuation',async()=>{
    await db.query("INSERT INTO task_scope(task_id,kind,domain) VALUES ($1,'subdomain','fixture.example.test')",[task]);
    const body=Buffer.from('synthetic traffic '.repeat(80));
    const id=await recordExchange(db,{taskID:task,url:'https://fixture.example.test/local',method:'GET',status:200,reqHead:'synthetic',respHead:'synthetic',request:body,response:body});
    for(const role of ['worker','planner'] as const){
      const read=contextGetTool(runContext(db,task,exp,role)),ref='traffic:'+id+':request';
      assert.throws(()=>validate(read,{items:[{ref,max_chars:3000}]}),/items\[0\]\.max_chars/);
      const first=await invoke(read,{items:[{ref}]});
      if(role==='planner'){
        assert.equal(first.error,true);assert.match(first.body.items[0].error,/无 traffic_body 读取或执行权限/);
        continue; // Parameter recovery must not grant a disabled sub-capability.
      }
      assert.equal(first.error,false,JSON.stringify(first.body));
      const page=first.body.items[0];assert.equal(page.offset_unit,'byte');assert.equal(page.content,body.subarray(0,400).toString());
      assert.equal(page.next_item.max_chars,undefined);
      const next=await invoke(read,{items:[page.next_item]});assert.equal(next.error,false,JSON.stringify(next.body));
      assert.equal(next.body.items[0].offset,400);assert.equal(next.body.items[0].content,body.subarray(400,800).toString());
    }
  });
});
