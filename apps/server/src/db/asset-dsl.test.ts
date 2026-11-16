import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compileAssetDSL, ASSET_DSL_HELP, AssetQueryError} from './asset-dsl.js';
import {mergedAssetSearchTool} from '../tools/asset-search-compat.js';
import {runContext} from '../tools/context.js';
import type {Database} from './index.js';
import {applyToolBindings} from '../agent/tool-bindings.js';
import {validateToolArguments} from '@earendil-works/pi-ai';

const compile = (input:string) => {
 const values:unknown[]=[];
 return {sql:compileAssetDSL(input,values),values};
};

test('screenshot call and whitespace variants compile to the existing parameterized substring query',()=>{
 const expected={sql:'a.url ILIKE $1',values:['%rcservice%']};
 for(const input of ['url contains "rcservice"','url="rcservice"','url = "rcservice"','url= rcservice','url =rcservice','URL\tCONTAINS\n"rcservice"'])
  assert.deepEqual(compile(input),expected,input);
 assert.deepEqual(compile('technology contains "sample"'),compile('technology=sample'));
 assert.deepEqual(compile('url=="rcservice"'),{sql:'a.url = $1',values:['rcservice']});
});

test('AND/OR precedence, parentheses and coverage retain their meaning',()=>{
 assert.deepEqual(compile('type == endpoint AND (url contains "sample" OR status_code >= 400)'),compile('type==endpoint AND (url=sample OR status_code>=400)'));
 const values:unknown[]=[17];
 assert.equal(compileAssetDSL('tested == false AND url contains "sample"',values,'a',tested=>tested?'covered':'uncovered'),'(uncovered) AND (a.url ILIKE $2)');
 assert.deepEqual(values,[17,'%sample%']);
 assert.deepEqual(compile('task_id == 7'),{sql:'$1=ANY(a.task_ids)',values:[7]});
});

test('quoted delimiters and escaped quotes stay in parameters, never in SQL',()=>{
 for(const value of ['hello AND (world)', 'a"b', 'a\\b', "'; DROP TABLE assets; --", '中文']){
  const result=compile('url contains '+JSON.stringify(value));
  assert.equal(result.sql,'a.url ILIKE $1');assert.deepEqual(result.values,['%'+value+'%']);
 }
 assert.deepEqual(compile('"hello AND world"').values,['%hello AND world%']);
 assert.match(compile('"hello AND world"').sql,/a\.url ILIKE \$1/);
});

test('invalid operators, IDs and malformed expressions fail closed with actionable errors',()=>{
 for(const input of ['task_id != 7','company_id > 7'])assert.throws(()=>compile(input),/仅支持 =、==/);
 for(const input of ['port contains 80','tested contains false'])assert.throws(()=>compile(input),/不支持 contains/);
 assert.throws(()=>compile('url LIKE "sample"'),/不支持运算符 LIKE/);
 assert.throws(()=>compile('url > sample'),/字符串字段 url 不支持/);
 assert.throws(()=>compile('port >= bad'),/需要整数/);
 for(const input of ['url contains','url contains "','url contains "sample" AND','(url=sample','url=sample status_code==200','missing==value'])
  assert.throws(()=>compile(input),AssetQueryError,input);
});

test('each role keeps DSL documentation in native Schema even with a custom tool description',async()=>{
 const db={query:async()=>({rows:[{key:'asset_search',agents:['worker','planner','mainagent','auto','reporter','pentest'],enabled:true,description:'Custom description'}]})} as unknown as Database;
 for(const role of ['worker','planner','mainagent','auto','reporter','pentest'] as const){
  const [tool]=await applyToolBindings(db,role,[mergedAssetSearchTool(runContext(db,1,1,role))]);assert.ok(tool);
  const properties=(tool.parameters as {properties:Record<string,{description?:string}>}).properties;
  assert.equal(properties.dsl!.description,ASSET_DSL_HELP);
  const args=validateToolArguments(tool,{type:'toolCall',id:'synthetic',name:'asset_search',arguments:{dsl:'url contains "rcservice"',limit:50}}) as {dsl:string};
  assert.deepEqual(compile(args.dsl),{sql:'a.url ILIKE $1',values:['%rcservice%']});
 }
});
