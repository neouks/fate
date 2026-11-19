import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {buildSkillDocument,parseSkillDocument,loadBoundSkills,skillFilePath} from './skill-files.js';
import {registerConfigRoutes} from '../http/routes/config.js';
import {registerSkillMgmtRoutes} from '../http/routes/skills-mgmt.js';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {AgentRunner,type RunnerActivity} from '../pi/runner.js';
import {registerAgentManagementRoutes} from '../http/routes/agents-management.js';

test('MCP capability is consistent in settings; unsupported roles reject grants but allow cleanup',async()=>{
 const roles=['worker','planner','mainagent','pentest','auto','goals','reporter','custom'];
 const agents=roles.map((key,i)=>({id:i+1,key,name:key,enabled:true}));let writes=0;
 const query=async(sql:string)=>{
  if(/INSERT|DELETE|UPDATE/.test(sql)){writes++;return {rows:[],rowCount:1};}
  if(sql.includes('SELECT a.key,')||sql.includes('SELECT a.key FROM'))return {rows:roles.map(key=>({key,mcp_count:1})),rowCount:roles.length};
  if(sql.includes('SELECT id FROM agents'))return {rows:[{id:1}],rowCount:1};
  if(sql.includes('agent_visibility'))return {rows:[{resource_id:1}],rowCount:1};
  return {rows:[],rowCount:0};
 };
 const app=Fastify();app.decorate('db',{query,pool:{connect:async()=>({query,release(){}})},platform:()=>({listAgents:async()=>agents,getAgentByKey:async(key:string)=>agents.find(a=>a.key===key)})});
 registerSkillMgmtRoutes(app);registerAgentManagementRoutes(app);
 try{
  const list=(await app.inject('/api/agents')).json().agents;
  for(const key of roles){
   const supported=!['goals','reporter','custom'].includes(key),agent=list.find((a:any)=>a.key===key);
   assert.equal(agent.mcp_supported,supported);assert.equal(agent.mcp_count,supported?1:0);
   const visible=(await app.inject(`/api/agents/${key}/visibility`)).json();assert.deepEqual(visible.mcp,supported?[1]:[]);
   for(const request of [
    {method:'POST' as const,url:'/api/visibility/toggle',payload:{agent_id:key,kind:'mcp',resource_id:1,visible:true}},
    {method:'PUT' as const,url:`/api/agents/${key}/visibility`,payload:{mcp:[1],skill:['fixture']}},
   ]){const before=writes,response=await app.inject(request);assert.equal(response.statusCode,supported?200:400,response.body);if(!supported)assert.equal(writes,before,'rejected request must not alter either resource binding');}
   assert.equal((await app.inject({method:'POST',url:'/api/visibility/toggle',payload:{agent_id:key,kind:'mcp',resource_id:1,visible:false}})).statusCode,200);
   assert.equal((await app.inject({method:'PUT',url:`/api/agents/${key}/visibility`,payload:{mcp:[],skill:['fixture']}})).statusCode,200);
  }
  assert.deepEqual((await app.inject('/api/visibility/mcp/1')).json().agents,roles.slice(0,5));
 }finally{await app.close();}
});

test('Skill metadata round trip preserves multiline text, colon, hash, booleans and MCP list',()=>{
 const fm={name:'fixture',description:'Use: local data # full text\nSecond line',mcps:['local'],metadata:{nested:'kept'},'disable-model-invocation':false};
 const parsed=parseSkillDocument(buildSkillDocument(fm,'body'));
 assert.deepEqual(parsed.fm,fm);assert.equal(parsed.body,'body');
});
test('directory bindings, YAML diagnostics, alias collision and symlink isolation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fate-skill-config-'));
 try{
  for(const [dir,name,desc] of [['first','alias','First'],['second','alias','Second'],['broken','broken','']]){
   await mkdir(join(root,dir!));await writeFile(join(root,dir!,'SKILL.md'),buildSkillDocument({name,description:desc},'body'));
  }
  await symlink(join(root,'second'),join(root,'linked'),'dir');
  assert.deepEqual(loadBoundSkills(root,['first']).skills.map(s=>s.name),['first']);
  assert.deepEqual(loadBoundSkills(root,['first','second']).skills.map(s=>s.name),['first','second']);
  assert.equal(loadBoundSkills(root).skills.length,0);
  for(const name of ['broken','missing','linked','../outside']){const r=loadBoundSkills(root,[name]);assert.equal(r.skills.length,0);assert.ok(r.diagnostics.length);}
  assert.throws(()=>skillFilePath(root,'first','../second/SKILL.md'));
 }finally{await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
test('management create/update/list uses native metadata and returns loading diagnostics',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fate-skill-http-'));
 const app=Fastify();app.decorate('skillsRoot',root);app.decorate('db',{platform:()=>({}),query:async()=>({rows:[]})});registerConfigRoutes(app);registerSkillMgmtRoutes(app);
 try{
  let r=await app.inject({method:'POST',url:'/api/skills',payload:{name:'fixture',description:'Parse: local # synthetic\nSecond line',instructions:'Local only',mcps:['server-a']}});assert.equal(r.statusCode,201,r.body);
  r=await app.inject('/api/skills');let skill=r.json().skills[0];assert.equal(skill.loadable,true);assert.deepEqual(skill.mcps,['server-a']);assert.match(skill.description,/Second line/);
  const file=join(root,'fixture/SKILL.md');await writeFile(file,'---\nname: alias\ndescription: |\n  Full multiline\n  description retained\nmetadata:\n  author: fixture\ndisable-model-invocation: true\n---\nInstructions');
  r=await app.inject({method:'PUT',url:'/api/skills/fixture/meta',payload:{mcps:['server-b']}});assert.equal(r.statusCode,200,r.body);
  const parsed=parseSkillDocument(await readFile(file,'utf8'));assert.match(String(parsed.fm.description),/description retained/);assert.deepEqual(parsed.fm.metadata,{author:'fixture'});assert.equal(parsed.fm['disable-model-invocation'],true);
  r=await app.inject('/api/skills');skill=r.json().skills[0];assert.equal(skill.loadable,true);assert.equal(skill.model_visible,false);assert.deepEqual(skill.mcps,['server-b']);assert.ok(skill.diagnostics.length);
  await writeFile(file,'---\nname: fixture\ndescription: invalid: yaml\n---\nbody');
  r=await app.inject('/api/skills');assert.equal(r.json().skills[0].loadable,false);
  await symlink(join(root,'fixture'),join(root,'linked'),'dir');
  for(const request of [{method:'POST' as const,url:'/api/skills/file',payload:{name:'linked',file:'SKILL.md'}},{method:'GET' as const,url:'/api/skills/linked/files/SKILL.md'},{method:'PUT' as const,url:'/api/skills/linked/files/SKILL.md',payload:{content:'overwrite'}}])assert.equal((await app.inject(request)).statusCode,400);
 }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
for(const prefix of ['', '@'])test(`native pi reads and meters directory-bound alias Skill: ${prefix||'absolute'}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'fate-skill-native-'));const skills=join(root,'skills'),file=join(skills,'bound/SKILL.md');
 await mkdir(join(skills,'bound'),{recursive:true});await writeFile(file,buildSkillDocument({name:'different-name',description:'Read local synthetic instructions'},'fixture-skill-body'));
 const runtime=await ModelRuntime.create({authPath:join(root,'auth.json'),modelsPath:join(root,'models.json'),refreshOnCreate:false});const faux=fauxProvider({provider:'skill-local'});runtime.registerNativeProvider(faux.provider);const activities:RunnerActivity[]=[];
 faux.setResponses([ctx=>{assert.match(JSON.stringify(ctx.messages.filter(m=>m.role==='system')),/name>bound/);assert.ok(!(JSON.stringify(ctx.messages.filter(m=>m.role==='system'))).includes('name>different-name'));return fauxAssistantMessage([fauxToolCall('read',{path:prefix+file})]);},fauxAssistantMessage('done')]);
 const runner=await AgentRunner.create({cwd:root,agentDir:root,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture.',toolAllowlist:['read'],skillsDir:skills,allowedSkills:['bound'],onActivity:a=>{activities.push(a);}});
 try{await runner.prompt('读取已绑定 Skill');assert.ok(activities.some(a=>a.kind==='tool_end'&&!a.isError&&a.text?.includes('fixture-skill-body')));assert.deepEqual(activities.find(a=>a.kind==='tool_start')?.resource_call,{kind:'skill',name:'bound',operation:'read'});}finally{await runner.dispose();await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('seven roles respect explicit resources, per-tool disable and direct-mode fallback',async()=>{
 const {roleResources}=await import('./resources.js');
 let searchEnabled=true;
 const db={platform:()=>({getSetting:async()=>'',listMCP:async()=>[{id:1,name:'enabled',enabled:true,transport:'stdio',command:'node',args:[],env:{}},{id:2,name:'disabled',enabled:false,transport:'stdio',command:'node',args:[],env:{}}]}),query:async(sql:string,args:unknown[])=>{
  if(sql.includes('agent_skill_visibility'))return{rows:[{skill_name:'bound'}]};
  if(sql.includes('agent_visibility'))return{rows:[{resource_id:'1',mcp_tool_name:'',enabled:true},{resource_id:'1',mcp_tool_name:'forbidden',enabled:false},{resource_id:'2',mcp_tool_name:'',enabled:true}]};
  if(sql.includes('WHERE key=$1'))return{rows:[{enabled:searchEnabled,agents:['goals','planner','mainagent','worker','auto','pentest','reporter']}]};
  return{rows:[]};
 }} as unknown as Parameters<typeof roleResources>[0];
 for(const role of ['goals','planner','mainagent','worker','auto','pentest','reporter']){
  const resources=await roleResources(db,role,'/local/skills');assert.deepEqual(resources.allowedSkills,['bound']);
  if(['goals','reporter'].includes(role)){assert.equal(resources.mcpEntries,undefined);continue;}
  assert.deepEqual(resources.mcpEntries?.map(e=>e.name),['enabled']);assert.equal(resources.mcpEntries?.[0]?.config.exposure,'deferred');assert.equal((resources.mcpEntries?.[0]?.config.toolExposure as Record<string,string>).forbidden,'hidden');
 }
 searchEnabled=false;assert.equal((await roleResources(db,'worker')).mcpEntries?.[0]?.config.exposure,'direct');
});
test('MCP save and probe reject invalid configurations instead of silently coercing',async()=>{
 const app=Fastify();let writes=0;app.decorate('db',{platform:()=>({saveMCP:async()=>{writes++;return 1;}})});
 registerConfigRoutes(app);const {registerMcpMgmtRoutes}=await import('../http/routes/mcp-mgmt.js');registerMcpMgmtRoutes(app);
 try{for(const payload of [{name:'bad',transport:'http',url:'file:///tmp'}, {name:'bad',transport:'stdio',command:'node',args:[1]}, {name:'bad',transport:'http',url:'http://localhost',env:{Authorization:123}}]){
  assert.equal((await app.inject({method:'POST',url:'/api/mcp',payload})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/mcp/test',payload})).json().ok,false);
 }assert.equal(writes,0);}finally{await app.close();}
});
