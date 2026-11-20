import {pendingPlannerContext} from '../db/planner-context.js';
import {contextGetTool} from '../tools/context-read.js';
import {todoWriteTool} from '../tools/intents.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hasDirectionEvidenceRead,normalizeFollowUp,directionFollowUps,validateDirectionReviews} from './direction-review.js';
import type {ReadCoverage} from './planner-grounding.js';
import {systemRolePrompt,ROLE_PROMPTS} from './prompts.js';
import {DIRECTION_REASONING_GUIDANCE} from './direction-reasoning.js';
import {Database,openDatabase} from '../db/index.js';
import {runContext} from '../tools/context.js';
import {migrateDirectionReasoning,DIRECTION_MIGRATION} from './direction-reasoning-migration.js';
import previous from './fixtures/pre-direction-review.json' with {type:'json'};

test('closure requires current complete detail, not partial or stale reads',()=>{
 const read=(field:string,version=2,fully_delivered=true)=>({ref:'node:1',view:'detail',field,version,fully_delivered}) as ReadCoverage;
 const ref={node_id:1,version:2};
 assert(!hasDirectionEvidenceRead([read('/payload/evidence')],ref));
 assert(!hasDirectionEvidenceRead([read('/payload/evidence'),read('/payload/scope',2,false)],ref));
 assert(!hasDirectionEvidenceRead([read('',1)],ref));
 assert(hasDirectionEvidenceRead([read('/payload/evidence'),read('/payload/scope')],ref));
 assert(hasDirectionEvidenceRead([read('')],ref));
 assert.throws(()=>normalizeFollowUp({positive:' ',question:'q',blocker:'method'}));
});
test('current, old and custom role prompts get one evidence policy',async()=>{
 for(const role of ['planner','worker','mainagent'] as const)for(const selected of [ROLE_PROMPTS[role],previous[role],'自定义格式']){
  const db={platform:()=>({getAgentByKey:async()=>({id:1}),currentPrompt:async()=>selected})} as unknown as Database;
  const prompt=await systemRolePrompt(db,role);
  assert.equal(prompt.split(DIRECTION_REASONING_GUIDANCE).length-1,1);
  assert(!prompt.includes('证据不足的否定方向最多复核一次'));
  assert(!(await systemRolePrompt(db,role,{},true)).includes(DIRECTION_REASONING_GUIDANCE));
 }
});
const dsn=process.env.TEST_DIRECTION_REVIEW_DSN;
test('durable clue, unread closure, defer recovery and exact migration',{skip:!dsn&&'isolated PostgreSQL required'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 const exp=await db.createExploration('direction fixture','retrieve sample');
 const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status) VALUES('fixture','retrieve sample',$1,'running') RETURNING id",[exp])).rows[0]!.id);
 const id=await db.exploration(exp).addNode('fact',{summary:'positive',evidence:'bytes exist',scope:{tested:'preview',not_tested:'archive'},follow_up:{positive:'bytes exist',question:'read archive',blocker:'method'}},0,'confirmed','fixture',[]);
 const ctx=runContext(db,task,exp,'planner');assert.equal((await directionFollowUps(ctx)).items.length,1);
 const pending=await pendingPlannerContext(db,task,exp);
 assert(pending.changes.some(c=>c.ref===`node:${id}`&&!!c.follow_up),'Incremental Planner delivery keeps structured clue');
 await assert.rejects(validateDirectionReviews(ctx,[{content:'closed',status:'completed',review:{state:'closed',basis:[{node_id:id,version:0}],scope:'preview',reason:'unavailable'}}]),/context_get/);
 await assert.rejects(validateDirectionReviews(ctx,[{content:'wait',status:'pending',review:{state:'deferred',basis:[{node_id:id,version:0}],scope:'preview',reason:'missing input'}}]),/recovery/);
 const receipt=await contextGetTool(ctx).execute('read',{items:[{ref:`node:${id}`,view:'detail',field:''}]});
 assert(!receipt.isError);
 ctx.sessionEntries=()=>[{type:'message',message:{role:'toolResult',toolName:'context_get',content:receipt.content,isError:false}}] as never;
 const closed={content:'preview rejected in measured scope',status:'completed' as const,review:{state:'closed' as const,basis:[{node_id:id,version:0}],scope:'preview only',reason:'preview format unsupported'}};
 const saved=await todoWriteTool(ctx).execute('close',{todos:[closed]});assert(!saved.isError,JSON.stringify(saved));
 assert.equal((await directionFollowUps(ctx)).items[0]!.review.state,'closed');
 assert.equal((await directionFollowUps(ctx)).items.length,1,'Scoped closure cannot erase positive observations');
 ctx.sessionEntries=()=>[];
 assert(!(await todoWriteTool(ctx).execute('preserve',{todos:[closed,{content:'another task',status:'pending'}]})).isError,'Unchanged checked reviews need no repeat read');
 await db.query("UPDATE exploration_nodes SET payload=payload||'{\"detail\":\"changed evidence\"}'::jsonb WHERE id=$1",[id]);
 assert.equal((await directionFollowUps(ctx)).items[0]!.review,null,'Changed evidence invalidates review');
 for(const role of ['planner','worker','mainagent'] as const){
  const a=(await db.platform().getAgentByKey(role))!;
  const select=async(text:string)=>{
   const p=(await db.query("INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by) SELECT $1,COALESCE(max(version),0)+1,$2,'fixture','test' FROM agent_prompts WHERE agent_id=$1 RETURNING id",[a.id,text])).rows[0]!;
   await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[a.id,p.id]);return p.id;
  };
  const old=await select(previous[role]);await db.query('DELETE FROM settings WHERE key=$1',[DIRECTION_MIGRATION]);await migrateDirectionReasoning(db);
  assert.equal(await db.platform().currentPrompt(a.id),ROLE_PROMPTS[role]);
  assert.equal((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[old])).rows[0]!.template_text,previous[role]);
  await select(previous[role]);await migrateDirectionReasoning(db);assert.equal(await db.platform().currentPrompt(a.id),previous[role]);
  await select('custom');await db.query('DELETE FROM settings WHERE key=$1',[DIRECTION_MIGRATION]);await migrateDirectionReasoning(db);assert.equal(await db.platform().currentPrompt(a.id),'custom');
 }
});
