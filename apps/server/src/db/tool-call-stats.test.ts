import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {openDatabase,type Database} from './index.js';
import {toolCallStats} from './tool-call-stats.js';
import {registerConfigRoutes} from '../http/routes/config.js';

const dsn=process.env.TEST_TOOL_CALL_STATS_DSN;
test('catalog statistics read the compact projection instead of activity history',async()=>{
 const queries:string[]=[];
 const db={query:async(sql:string)=>{queries.push(sql);return sql.startsWith('SELECT format_version')?{rows:[{format_version:1,ready:true}]}:{rows:[{tool:'read',calls:2,succeeded:1,failed:1,unknown:0}]};}} as unknown as Database;
 const stats=await toolCallStats(db,['read']);assert.equal(stats.get('read')?.calls,2);
 assert.equal(queries.some(sql=>/FROM\s+(activity|conversation_activities)\b/i.test(sql)),false);
});
test('tool statistics count retained native and legacy calls once across tasks and conversations',{skip:!dsn&&'isolated database required'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_tool_call_stats_/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 const exp=await db.createExploration('fixture','fixture');
 const conversation=Number((await db.query("INSERT INTO conversations(agent_key) VALUES('mainagent') RETURNING id")).rows[0]!.id);
 await db.query("INSERT INTO tools(key,kind,system,enabled,agents) VALUES('fixture_command','command',false,true,'[]'),('fixture_shell','shell',false,true,'[]')");
 const add=async(scope:string,tool:string,kind:string,id:string,metadata:object={},failed=false,worker='worker')=>{
  const table=scope==='task'?'activity':'conversation_activities',field=scope==='task'?'exploration_id':'conversation_id';
  return Number((await db.query(`INSERT INTO ${table}(${field},tool,kind,tool_use_id,metadata,is_error,worker) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[scope==='task'?exp:conversation,tool,kind,id,JSON.stringify(metadata),failed,worker])).rows[0]!.id);
 };
 const native=(runtime:string)=>({native_event:{runtime_id:runtime,call_key:'a'.repeat(64)},turn_id:'turn'});
 // Duplicate projection and duplicate result: one failed call, never two.
 for(let i=0;i<2;i++){
  await add('task','read','tool_use','same',native('runtime1'));
  await add('task','read','tool_result','same',native('runtime1'),true);
 }
 await add('task','read','tool_use','same',native('runtime2'));
 await add('task','read','tool_result','same',native('runtime2'));
 // A conversation is counted once even if it is bound to a task.
 await add('conversation','read','tool_use','same',native('runtime3'));
 await add('conversation','read','tool_result','same',native('runtime3'));
 for(const turn of ['one','two']){
  await add('task','fixture_command','tool_use','legacy',{turn_id:turn});
  await add('task','fixture_command','tool_use','legacy',{turn_id:turn});
  await add('task','fixture_command','tool_result','legacy',{turn_id:turn},turn==='two');
 }
 await add('task','fixture_command','tool_use','legacy',{turn_id:'one'},false,'another-worker');
 await add('task','fixture_command','tool_result','orphan',{},true);
 await add('task','fixture_command','tool_search','discovery');
 await add('task','bash','tool_use','bash-call');
 await add('task','bash','tool_result','bash-call');
 // The retired ledger has no deduplication key; do not add it to the same history.
 await db.query("INSERT INTO tool_usage(tool_key,exploration_id) VALUES('read',$1)",[exp]);
 const stats=await toolCallStats(db,['read','fixture_command','fixture_shell','bash']);
 const counts=(key:string)=>{const s=stats.get(key)!;return [s.calls,s.succeeded,s.failed,s.unknown];};
 assert.deepEqual(counts('read'),[3,2,1,0]);
 assert.deepEqual(counts('fixture_command'),[3,1,1,1]);
 assert.deepEqual(counts('bash'),[1,1,0,0]);
 assert.equal(stats.has('fixture_shell'),false,'native Bash must not be guessed as a custom shell invocation');
 const pending=await add('task','fixture_command','tool_use','to-delete',{turn_id:'delete'});
 const beforeDelete=(await toolCallStats(db,['fixture_command'])).get('fixture_command')!;
 assert.deepEqual([beforeDelete.calls,beforeDelete.unknown],[4,2]);
 await db.query('DELETE FROM activity WHERE id=$1',[pending]);
 const afterDelete=(await toolCallStats(db,['fixture_command'])).get('fixture_command')!;
 assert.deepEqual([afterDelete.calls,afterDelete.unknown],[3,1],'deleting retained activity updates the projection');
 const app=Fastify();
 app.decorate('db',{query:db.query.bind(db),platform:()=>({listAgents:async()=>[]})} as unknown as Database);
 registerConfigRoutes(app);t.after(()=>app.close());
 const response=await app.inject({method:'GET',url:'/api/tools'});assert.equal(response.statusCode,200,response.body);
 const rows=response.json().tools;
 for(const key of ['read','fixture_command'])assert.equal(rows.find((r:any)=>r.key===key).calls,3);
 assert.equal(rows.find((r:any)=>r.key==='fixture_shell').calls,0);
 assert.equal(rows.find((r:any)=>r.key==='read').failed,1);
 assert.equal(rows.find((r:any)=>r.key==='read').usage_historical_complete,false);
});
