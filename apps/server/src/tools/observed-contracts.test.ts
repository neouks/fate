import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateToolArguments} from '@earendil-works/pi-ai';
import {trafficSearchTool} from './traffic-search.js';
import {reportFindingTool} from './findings.js';
import {runContext} from './context.js';
import type {Database} from '../db/index.js';
import {effectiveToolDescription} from '../agent/tool-descriptions.js';
import {PREVIOUS_TRAFFIC_SEARCH_DESCRIPTION} from '../agent/tool-description-policy.js';

test('obsolete traffic filters fail before querying; current filters run once',async()=>{
 let queries=0;const db={query:async()=>{queries++;return {rows:[]}}} as unknown as Database;
 const tool=trafficSearchTool(runContext(db,1,1,'worker'));
 for(const args of [{host:'example.test'},{page:2},{body_contains:'fixture'},{limit:21},{query:[]}]){
  assert.throws(()=>validateToolArguments(tool,{type:'toolCall',id:'fixture',name:tool.name,arguments:args}));
  const result=await tool.execute('fixture',args as never,undefined,undefined,{} as never);assert.equal(result.isError,true);
 }
 assert.equal(queries,0);
 const result=await tool.execute('once',{query:'fixture',limit:10},undefined,undefined,{} as never);assert.notEqual(result.isError,true);assert.equal(queries,1);
 const resolved=effectiveToolDescription(tool.name,tool.description,PREVIOUS_TRAFFIC_SEARCH_DESCRIPTION);
 assert.equal(resolved.source,'builtin');assert.doesNotMatch(resolved.description,/host|page|body_contains|traffic_get/);
 assert.equal(effectiveToolDescription(tool.name,tool.description,'custom instruction').description,'custom instruction');
});

test('finding reproduction documents and enforces the observed object boundary',()=>{
 const tool=reportFindingTool(runContext({} as Database,1,1,'worker'));
 const step={action:'read local fixture',request:'fixture input',response:'fixture output',proves:'local structure only'};
 const base={vulnclass:'fixture',severity:'low',summary:'fixture',evidence:'local fixture'};
 const validate=(args:Record<string,unknown>)=>validateToolArguments(tool,{type:'toolCall',id:'fixture',name:tool.name,arguments:args});
 assert.throws(()=>validate({...base,reproduction:[],steps:[step]}),/reproduction|steps/);
 assert.doesNotThrow(()=>validate({...base,reproduction:{steps:[step]}}));
 assert.match((tool.parameters as any).properties.reproduction.description,/steps 只能放在 reproduction 内/);
});
