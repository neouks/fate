import {it,expect} from 'vitest';
import {projectTurn} from './turn-summary.js';
const row=(id:number,kind:string,metadata:Record<string,unknown>={},extra:Record<string,unknown>={})=>({id,kind,summary:'',created_at:new Date(1700000000000+id*1000),worker:'main',metadata:{turn_id:'t',...metadata},...extra});
const start=row(1,'status',{event_type:'turn_start',started_at:'2023-11-14T22:13:21Z',role:'mainagent',mode:'manual'});
const response=(id:number,stream:string,tools=false)=>row(id,tools?'status':'text',{stream_id:stream,channel:'text',response:{stop_reason:tools?'toolUse':'stop',has_tools:tools,model:'local',provider:'faux',usage:{input:10,output:2}}},{summary:tools?'':'答复'});
const end=row(8,'result',{event_type:'lifecycle',status:'completed'});
it('counts native tool-only responses once and pairs duplicated parallel calls without page dependence',()=>{
 const rows=[start,response(2,'s1',true),row(3,'tool_use',{}, {tool_use_id:'a'}),row(4,'tool_use',{}, {tool_use_id:'a'}),row(5,'tool_result',{}, {tool_use_id:'a',is_error:true}),response(6,'s2'),end];
 const s=projectTurn(rows,[]);expect(s).toMatchObject({steps:2,tool_calls:1,failed_tool_calls:1,status:'completed',usage:{total:24}});expect(s.final_activity?.seq).toBe(6);
});
it('a text response before more tools is not promoted, even after host completion',()=>{
 const s=projectTurn([start,response(2,'text'),response(3,'tools',true),end],[]);expect(s.final_activity).toBeNull();
});
it('stopped and failed native partial messages never become final answers',()=>{
 for(const status of ['failed','stopped','exhausted'])expect(projectTurn([start,response(2,'s'),row(3,'result',{event_type:'lifecycle',status})],[]).final_activity).toBeNull();
});
it('host acceptance receipts remain final, including partial outcomes',()=>{
 const s=projectTurn([start,response(2,'s',true),row(3,'result',{event_type:'outcome',status:'exhausted'},{summary:'已保存部分事实'})],[]);
 expect(s.final_activity?.summary).toBe('已保存部分事实');expect(s.status).toBe('exhausted');
});
it('old records do not invent steps, duration or exact usage',()=>{
 const s=projectTurn([row(1,'text',{}, {summary:'旧内容'}),end],[]);expect(s.steps).toBeNull();expect(s.started_at).toBeNull();expect(s.usage).toBeNull();expect(s.final_activity).toBeNull();
});
it('audit includes fallback and compaction exactly once without adding visible steps',()=>{
 const s=projectTurn([start,response(2,'s'),end],[{model:'first',purpose:'conversation',status:'failed',usage:{input:2,output:0}},{model:'second',purpose:'conversation',status:'completed',usage:{input:10,output:5}},{model:'second',purpose:'compaction',status:'completed',usage:{input:20,output:3}}]);
 expect(s.models).toEqual(['first','second']);expect(s.steps).toBe(1);expect(s.usage).toMatchObject({total:40,compaction_requests:1,compaction_tokens:23,failed_requests:1,failed_request_tokens:2});
});
it('an expired executor is interrupted, never completed, without extending its elapsed time forever',()=>{
 const s=projectTurn([start,response(2,'s')],[],{expires_at:'2023-11-14T22:13:25Z'});expect(s.status).toBe('interrupted');expect(s.finished_at).toBe('2023-11-14T22:13:25.000Z');expect(s.final_activity).toBeNull();
});

it('budget terminal metadata cannot be presented as a successful ordinary reply',()=>{
 const s=projectTurn([start,response(2,'s'),row(3,'status',{event_type:'runner_settled',stop_reason:'budget'}),end],[]);expect(s.status).toBe('exhausted');expect(s.final_activity).toBeNull();
});

it('normal runner disposal waits for host confirmation rather than flashing interrupted',()=>{
 const s=projectTurn([start,response(2,'s')],[],{expires_at:new Date().toISOString(),finished_at:new Date().toISOString()});expect(s.status).toBe('awaiting_confirmation');expect(s.final_activity).toBeNull();
});

it('a crash after runner disposal cannot leave a turn generating forever',()=>{
 const s=projectTurn([start,response(2,'s')],[],{expires_at:'2023-11-14T22:13:25Z',finished_at:'2023-11-14T22:13:25Z'});expect(s.status).toBe('interrupted');expect(s.final_activity).toBeNull();
});
