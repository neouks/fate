import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {systemAuditEvent,AUDIT_TYPE_SQL} from './system-audit.js';
import {activityDTO} from './live-stream.js';
import {openDatabase} from '../db/index.js';
import {registerCompatRoutes} from '../http/routes/compat.js';
import {readActivityPage} from '../db/activity-content.js';
import {recordFactTool} from '../tools/graph.js';
import {runContext} from '../tools/context.js';
const fixtures:Record<string,unknown>[]=[
 ...['user','planner','mainagent',''].map(source=>({worker:'w1',kind:'status',tool:'steer_work',metadata:{event_type:'steering',steering:{source,status:'submitted'}}})),
 {worker:'planner',kind:'tool_use',tool:'steer_work',metadata:{}},
 {worker:'planner',kind:'status',tool:'kill_work',metadata:{event_type:'lifecycle',status:'stopped',execution_stop:{reason:'planner_terminated'}}},
 {worker:'w1',kind:'result',metadata:{event_type:'outcome',status:'stopped',execution_stop:{reason:'main_terminated'}}},
 {worker:'w1',kind:'result',metadata:{event_type:'outcome',status:'done',execution_stop:{reason:'completed'}}},
 {worker:'system',kind:'status',metadata:{event_type:'lifecycle',status:'stop_requested',execution_stop:{reason:'intent_paused'}}},
 ...['resume_requested','resume_started'].map(status=>({worker:'system',kind:'status',metadata:{event_type:'lifecycle',status,source:'user'}})),
 {worker:'system',kind:'status',metadata:{event_type:'important_fact',source:'worker',important_fact:{fact_id:2,reason:'影响目标判断'}}},
 {worker:'system',kind:'llm_switch',metadata:{}},{worker:'planner',kind:'llm_failover',metadata:{}},{worker:'system',kind:'status',metadata:{}},
 {worker:'system',kind:'status',metadata:{event_type:'major_finding'}},
 {worker:'system',kind:'tool_result',tool:'report_finding',metadata:{}},
 {worker:'w1',kind:'text',summary:'kill_work 成功 / major finding / 重要事实',metadata:{}},
];
test('only explicit audit receipts qualify; no findings, calls, inferred effects or ordinary completions',()=>{
 const events=fixtures.map(systemAuditEvent);
 assert.deepEqual(events.map(e=>e?.type),['correction','correction','correction','correction',undefined,'control','control',undefined,'control','control','control','important_fact','system','system','system',undefined,undefined,undefined]);
 assert.equal(events[0]?.status,'submitted');assert.equal(events[3]?.source,'');assert.equal(events[8]?.status,'stop_requested');assert.equal(events[6]?.source,'mainagent');
});
const dsn=process.env.TEST_SYSTEM_AUDIT_DSN;
test('audit pagination, stream DTO, task authorization and atomic important-fact writes',{skip:!dsn},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase(),app=Fastify();app.decorate('db',db);registerCompatRoutes(app);t.after(async()=>{await app.close();await db.close();});
 const exp=await db.createExploration('fixture','fixture'),other=await db.createExploration('other','other');
 const task=Number((await db.query("INSERT INTO tasks(exploration_id,description,goal,status,paused) VALUES($1,'fixture','fixture','running',true) RETURNING id",[exp])).rows[0]!.id);
 await db.query("INSERT INTO tasks(exploration_id,description,goal) VALUES($1,'other','other')",[other]);
 const graph=db.exploration(exp),intent=await graph.addNode('intent',{summary:'fixture'},0,'running','fixture',[]);
 await db.query("UPDATE exploration_nodes SET owner='w1' WHERE id=$1",[intent]);
 const foreign=await db.exploration(other).addNode('intent',{summary:'private'},0,'running','fixture',[]);
 const tool=recordFactTool(runContext(db,task,exp,'worker',{intentID:intent,workerName:'w1'}));
 const invoke=async(args:object,id:string)=>{const r=await tool.execute(id,args,undefined,undefined,{} as never);return {failed:!!r.isError,...JSON.parse((r.content[0] as {text:string}).text)};};
 const proof='unaltered original evidence — '.repeat(500),input={summary:'关键事实',evidence:proof,important_reason:'改变后续决策'};
 const first=await invoke(input,'one');assert.ok(!first.failed);assert.equal((await invoke(input,'one')).fact_id,first.fact_id);assert.equal((await graph.getNode(first.fact_id))!.payload.evidence,proof);
 const batch=await invoke({facts:[{summary:'重要项',evidence:'original',important_reason:'关键阻碍'},{summary:'普通项',evidence:'original'},{summary:'失败项',evidence:'original',important_reason:' '}]},'batch');
 assert.equal(batch.results.filter((x:any)=>x.fact_id).length,2);
 const marked=(await db.query("SELECT * FROM activity WHERE exploration_id=$1 AND metadata->>'event_type'='important_fact' ORDER BY id",[exp])).rows;
 assert.equal(marked.length,2);assert.equal(marked[0]!.node_id,String(first.fact_id));assert.equal(marked[0]!.input_tokens,null);assert.ok(!JSON.stringify(marked).includes(proof));
 assert.equal((await invoke({...input,important_reason:'长'.repeat(501)},'long')).failed,true);
 await db.query(`CREATE FUNCTION reject_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.summary='rollback audit' THEN RAISE EXCEPTION 'audit failed'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_audit_fixture BEFORE INSERT ON activity FOR EACH ROW EXECUTE FUNCTION reject_audit_fixture()`);
 assert.equal((await invoke({...input,summary:'rollback audit'},'rollback')).failed,true);assert.equal((await db.query("SELECT count(*) FROM exploration_nodes WHERE tool_call_id='rollback'")).rows[0]!.count,'0');
 await db.query('DROP TRIGGER reject_audit_fixture ON activity; DROP FUNCTION reject_audit_fixture()');
 for(const row of fixtures)await graph.appendActivity({...row,node_id:intent,summary:'fixture event'} as never);
 await graph.appendActivity({node_id:foreign,worker:'system',kind:'status',summary:'must not leak'});
 await db.query("INSERT INTO activity(exploration_id,node_id,worker,kind,summary) SELECT $1,$2,'w1','text','ordinary' FROM generate_series(1,2500)",[exp,intent]);
 const large=await graph.appendActivity({node_id:intent,worker:'w1',kind:'result',summary:'large receipt',metadata:{event_type:'outcome',status:'stopped',unrelated:'x'.repeat(9000),execution_stop:{reason:'planner_terminated',summary:'停止原因',fact_refs:Array(500).fill({node_id:1})}}});
 assert.equal(activityDTO((await readActivityPage(db,'task','id=$1',[large],'ASC',1)).rows[0]!).audit_event?.type,'control');
 const rows=(await db.query(`SELECT *,(${AUDIT_TYPE_SQL}) audit_type FROM activity WHERE exploration_id=$1`,[exp])).rows;
 for(const row of rows)assert.equal(systemAuditEvent(row)?.type,row.audit_type??undefined,`SQL/DTO drift: ${row.id}`);
 const expected=rows.filter(r=>r.audit_type&&r.node_id!==String(foreign)).map(r=>Number(r.id)).sort((a,b)=>a-b);
 const read=async(q:string)=>{const r=await app.inject(`/api/exploration/activity/history?task=${task}&session=system&${q}`);assert.equal(r.statusCode,200,r.body);return r.json();};
 const latest=await read('limit=3');assert.equal(latest.has_more,true);assert.deepEqual(latest.items.map((r:any)=>r.seq),expected.slice(-3));
 let page=latest,all=[...page.items];while(page.has_more){page=await read('limit=3&before='+page.earliest_cursor);all=[...page.items,...all];}assert.deepEqual(all.map((r:any)=>r.seq),expected);
 for(const type of ['correction','control','important_fact','system']){const p=await read('audit_type='+type);assert.ok(p.items.length);assert.ok(p.items.every((r:any)=>r.audit_event.type===type));}
 const correction=(await read('audit_type=correction')).items[0];
 const original=await app.inject(`/api/exploration/activity/history?task=${task}&session=intent:${intent}&around=${correction.seq}&limit=1`);assert.equal(original.json().items[0].seq,correction.seq);
 const search=await app.inject(`/api/exploration/activity/search?task=${task}&session=system&audit_type=correction&q=fixture`);assert.ok(search.json().items.length);assert.ok(search.json().items.every((r:any)=>r.audit_event.type==='correction'));
 assert.equal((await app.inject(`/api/exploration/activity/history?task=${task}&session=system&audit_type=invalid`)).statusCode,400);
 const next=await graph.appendActivity({worker:'system',kind:'llm_switch',summary:'new model'}),tail=await read('after='+latest.snapshot_cursor);assert.deepEqual(tail.items.map((r:any)=>r.seq),[next]);
 assert.deepEqual(JSON.parse(JSON.stringify(activityDTO((await db.query('SELECT * FROM activity WHERE id=$1',[next])).rows[0]!).audit_event)),tail.items[0].audit_event);
 assert.equal((await db.query('SELECT paused FROM tasks WHERE id=$1',[task])).rows[0]!.paused,true);assert.equal((await db.query('SELECT count(*) FROM llm_request_attempts')).rows[0]!.count,'0');
 await db.query('UPDATE tasks SET deleted_at=now() WHERE id=$1',[task]);assert.equal((await app.inject(`/api/exploration/activity/history?task=${task}&session=system`)).statusCode,404);
});
