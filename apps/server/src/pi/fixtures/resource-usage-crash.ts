// Local-only fault injection child. Never points at the production database.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../db/index.js';
import {AgentRunner} from '../runner.js';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {projectActivity} from '../../db/activity-projection.js';
import {runnerActivityMetadata} from '../../engine/live-stream.js';
import {registerNativeActivityRun} from '../../engine/native-activity-recovery.js';
import type {NativeActivityIdentity} from '../native-activity.js';
const dsn=process.env.TEST_RESOURCE_USAGE_DSN!;assert.match(new URL(dsn).pathname,/^\/test_resource_usage_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
const dir=process.env.RESOURCE_CRASH_DIR!,db=await openDatabase(),id=randomUUID(),turn_id=randomUUID();
const exp=await db.createExploration('crash fixture','local'),task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,paused,status) VALUES('crash','local',$1,true,'paused') RETURNING id",[exp])).rows[0]!.id);
await db.query("INSERT INTO runtime_role_configs(id,task_id,role,configured,effective,expires_at) VALUES($1,$2,'worker','{}','{}',now()+interval '1 hour')",[id,task]);
const identity:NativeActivityIdentity={source:{scope:'task',scopeID:exp,taskID:task},worker:'worker',turn_id};
const runtime=await ModelRuntime.create({authPath:path.join(dir,id+'auth.json'),modelsPath:path.join(dir,id+'models.json'),refreshOnCreate:false}),faux=fauxProvider({provider:'crash-local'});runtime.registerNativeProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall('read',{path:path.join(dir,'skills/fixture/SKILL.md')})]),fauxAssistantMessage('done')]);
const runner=await AgentRunner.create({cwd:dir,agentDir:dir,resumeSessionPath:path.join(dir,id+'.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture',toolAllowlist:['read'],skillsDir:path.join(dir,'skills'),allowedSkills:['fixture'],nativeActivityRuntime:id,
 onActivity:async a=>{
  // The result remains only in native JSONL (simulated presentation DB outage).
  if(a.kind!=='tool_start')return;
  await db.transaction(tx=>projectActivity(tx,identity.source,{worker:'worker',kind:'tool_use',tool:a.toolName,tool_use_id:a.toolCallId,detail:JSON.stringify(a.args),metadata:{turn_id,...runnerActivityMetadata(a)}},true));
 }});
await registerNativeActivityRun(db,id,runner,identity);await runner.prompt('read local fixture');await runner.dispose();
await writeFile(path.join(dir,'crash-runtime.json'),JSON.stringify({id,task}));
// Simulate loss of all in-memory queues/acknowledgements, leaving the lease live.
process.kill(process.pid,'SIGKILL');
