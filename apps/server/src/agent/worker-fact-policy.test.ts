import assert from 'node:assert/strict';
import {test} from 'node:test';
import historical from './fixtures/historical-assignment-prompts.json' with {type:'json'};
import type {Database} from '../db/index.js';
import {WORKER_PROMPT,systemRolePrompt} from './prompts.js';
import {WORKER_FACT_GUIDANCE,WORKER_COMPLETION_GUIDANCE,normalizeWorkerInstructions,migrateWorkerFactPrompt,migrateWorkerInstructionCleanup} from './worker-fact-policy.js';
import {effectiveToolDescription} from './tool-descriptions.js';
import {describeToolContract} from './tool-description-policy.js';

const old = historical.worker.replace(historical.worker.split('\n')[0]!, '你是 Worker，执行当前意图给定的工作，遵守用户要求和授权范围，然后停止。受阻时如实说明原因，不扩展任务。')
  .replace('发现的新资产可直接继续探索','新发现资产及时登记，执行仍遵守当前意图和授权');

function fixture(template: string) {
  const settings = new Map<string,string>();
  const versions: string[] = [];
  const tx = {
    platform: () => ({getSetting: async (key:string) => settings.get(key), setSetting: async (key:string,value:string) => settings.set(key,value)}),
    query: async (sql:string,args:unknown[] = []) => {
      if (sql.startsWith('SELECT a.id')) return {rows:[{id:'worker',template_text:template}]};
      if (sql.startsWith('INSERT INTO agent_prompts')) {
        versions.push(String(args[1]));
        return {rows:[{id:versions.length}]};
      }
      return {rows:[]};
    },
  };
  return {versions, db:{...tx,transaction:async (run:(tx:unknown)=>unknown) => run(tx)} as unknown as Database};
}

test('existing Worker default upgrades once and custom templates retain their history',async () => {
  const shipped = fixture(old);
  await migrateWorkerFactPrompt(shipped.db,WORKER_PROMPT);
  await migrateWorkerFactPrompt(shipped.db,WORKER_PROMPT);
  assert.deepEqual(shipped.versions,[WORKER_PROMPT]);
  const custom = fixture(old+'\n用户补充要求');
  await migrateWorkerFactPrompt(custom.db,WORKER_PROMPT);
  assert.deepEqual(custom.versions,[]);
});

test('custom Worker prompts and closing overrides receive the fact summary contract',async () => {
  const db = {platform:() => ({getAgentByKey:async () => ({id:'worker'}),currentPrompt:async () => old+'\n用户补充要求'})} as unknown as Database;
  for (const override of [undefined,'仅收尾']) {
    const prompt = await systemRolePrompt(db,'worker',{},false,override);
    assert.ok(prompt.includes('用户补充要求'));
    assert.ok(prompt.includes(WORKER_FACT_GUIDANCE));
    assert.equal(prompt.split(WORKER_FACT_GUIDANCE).length,2);
  }
});

test('persisted fact tool descriptions upgrade raw and schema-expanded defaults',() => {
  const previous = '保存新增事实，相关观察合并为同一结论。单条传 summary 等顶层字段；批量只传 facts 数组，不混用。asset_ids 仅列实际涉及资产，缺省不继承意图范围；scope 描述实际验证范围。核对逐项回执。';
  for (const stored of [previous,describeToolContract('record_fact',previous)]) {
    const resolved = effectiveToolDescription('record_fact','unused',stored);
    assert.equal(resolved.source,'builtin');
    assert.match(resolved.description,/一条 fact 一次写回/);
  }
  assert.equal(effectiveToolDescription('record_fact','unused','用户自定义工具说明').source,'custom');
});

const oldHeading='**边发现边写回**（写进图才算数，脑子/文字里的不算；每得一个结果立刻写，别攒到最后被步数耗尽丢掉）。三种写回，别串图：';
const oldFact='同一结论的相关观察合并保存；独立结论分别写回，不规定一意图通常只能写一条事实。';
test('selected custom/old prompts lose only shipped conflicts; current completion policy occurs once',async()=>{
 const custom='用户要求：关键结论必须独立复核两次；原始证据逐字保留。';
 for(const template of [oldHeading+'\n'+oldFact+'\n'+custom,WORKER_PROMPT,WORKER_PROMPT+'\n'+WORKER_COMPLETION_GUIDANCE]){
  const db={platform:()=>({getAgentByKey:async()=>({id:'worker'}),currentPrompt:async()=>template})} as unknown as Database;
  for(const override of [undefined,oldHeading+'\n仅保存已有结果']){
   const prompt=await systemRolePrompt(db,'worker',{},false,override);
   assert.ok(!prompt.includes('每得一个结果立刻写'));assert.ok(!prompt.includes('不规定一意图通常只能写一条事实'));
   assert.equal(prompt.split(WORKER_FACT_GUIDANCE).length,2);assert.equal(prompt.split(WORKER_COMPLETION_GUIDANCE).length,2);
   assert.match(prompt,/用户明确要求复核、原证据失败或相互矛盾/);
   assert.match(prompt,/可选字段为空/);
   if(template.includes(custom))assert.ok(prompt.includes(custom));
  }
 }
 assert.equal(normalizeWorkerInstructions(custom),custom);
 assert.equal(normalizeWorkerInstructions(normalizeWorkerInstructions(oldHeading)),normalizeWorkerInstructions(oldHeading));
});

test('cleanup appends one selected version after the old migration, preserving unrelated custom text',async()=>{
 const original=oldHeading+'\n'+oldFact+'\n用户自定义授权范围';
 const f=fixture(original);
 await migrateWorkerFactPrompt(f.db,WORKER_PROMPT);assert.equal(f.versions.length,0);
 await migrateWorkerInstructionCleanup(f.db);await migrateWorkerInstructionCleanup(f.db);
 assert.deepEqual(f.versions,[normalizeWorkerInstructions(original)]);
 assert.ok(f.versions[0]!.includes('用户自定义授权范围'));
 const clean=fixture('用户要求每项复核两次');await migrateWorkerInstructionCleanup(clean.db);assert.deepEqual(clean.versions,[]);
});
