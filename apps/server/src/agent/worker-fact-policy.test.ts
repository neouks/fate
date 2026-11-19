import assert from 'node:assert/strict';
import {test} from 'node:test';
import historical from './fixtures/historical-assignment-prompts.json' with {type:'json'};
import type {Database} from '../db/index.js';
import {WORKER_PROMPT,systemRolePrompt} from './prompts.js';
import {WORKER_FACT_GUIDANCE,migrateWorkerFactPrompt} from './worker-fact-policy.js';
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
