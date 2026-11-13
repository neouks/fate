import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import type {Database} from '../../db/index.js';
import {catalogSchema} from '../../agent/tool-catalog.js';
import {effectiveToolDescription} from '../../agent/tool-descriptions.js';
import {registerConfigRoutes} from './config.js';

test('catalog preserves role-specific nested constraints without inventing a shared schema',()=>{
 const base={type:'object',properties:{items:{type:'array',items:{type:'object',properties:{value:{type:'integer',maximum:24}},required:['value']}}},required:['items']};
 const other=structuredClone(base);other.properties.items.items.properties.value.maximum=12;
 const roles=[{schemas:{fixture:base}},{schemas:{fixture:other}}];
 assert.deepEqual(catalogSchema('fixture',roles),{schema:{},schema_source:'role_specific'});
 assert.deepEqual(catalogSchema('fixture',[roles[0]!,roles[0]!]),{schema:base,schema_source:'role'});
 assert.deepEqual(catalogSchema('disabled',roles,base),{schema:base,schema_source:'unavailable'});
 assert.equal(roles[1]!.schemas.fixture.properties.items.items.properties.value.maximum,12);
});

test('tool settings reset only the description and reject invalid requests without writes',async t=>{
 const rows=new Map([
  ['context_get',{kind:'builtin',description:'custom fixture',enabled:false,agents:['auto'],schema:{type:'object'}}],
  ['fixture_custom',{kind:'command',description:'custom',enabled:false,agents:[],schema:{type:'object'}}],
  ['complete_intent',{kind:'builtin',description:'historical',enabled:false,agents:[],schema:{type:'object'}}],
 ]);
 const writes:string[]=[];
 const db={query:async(sql:string,params:unknown[])=>{
  const key=String(params.at(-1)),row=rows.get(key);
  if(sql.startsWith('SELECT kind'))return {rows:row?[{kind:row.kind}]:[]};
  writes.push(sql);
  if(sql==="UPDATE tools SET description='' WHERE key=$1 AND kind='builtin'"&&row?.kind==='builtin')row.description='';
  return {rowCount:row?1:0,rows:[]};
 }} as unknown as Database;
 const app=Fastify();app.decorate('db',db);registerConfigRoutes(app);t.after(()=>app.close());
 const reset=(key:string)=>app.inject({method:'POST',url:`/api/tools/${key}/reset`});
 const before=structuredClone(rows.get('context_get')!);
 const response=await reset('context_get');assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(rows.get('context_get'),{...before,description:''});
 assert.equal(effectiveToolDescription('context_get','default',rows.get('context_get')!.description).source,'builtin');
 assert.equal((await reset('missing')).statusCode,404);
 assert.equal((await reset('fixture_custom')).statusCode,400);
 assert.equal((await reset('complete_intent')).statusCode,410);
 for(const payload of [{schema:{},enabled:true},{description:1},{enabled:'true'},{agents:['auto',1]},{},[]]){
  const r=await app.inject({method:'PUT',url:'/api/tools/context_get',payload});
  assert.equal(r.statusCode,400,r.body);
 }
 assert.equal((await app.inject({method:'PUT',url:'/api/tools/missing',payload:{description:'test'}})).statusCode,404);
 assert.equal(writes.length,1);
});
