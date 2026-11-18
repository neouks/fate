import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Database} from '../db/index.js';
import {systemRolePrompt,resolveRolePrompt} from './prompts.js';
import {effectiveToolDescription} from './tool-descriptions.js';
import {normalizeGoalProofInstructions,GOAL_PROOF_PROTOCOL} from './goal-proof-policy.js';

const legacy='用仍获授权的 confirmed 事实或漏洞提交目标验收；量化覆盖或数量仅在用户目标明确要求时核对。多个事实可共同支持判断，note 说明引用关系，不为合并报告重新探测。awaiting_confirmation 表示已提交并等待人工确认，本目标无新增反证或具体缺口时结束本轮，不重复提交或另派复核。';

test('stored retired goal instructions resolve to direct proof without rewriting custom text',async()=>{
  const stored='用户保留的业务规则\n'+legacy;
  const db={platform:()=>({getAgentByKey:async()=>({id:1}),currentPrompt:async()=>stored})} as unknown as Database;
  const resolved=await resolveRolePrompt(db,'planner');
  assert.ok(resolved.template.startsWith('用户保留的业务规则\n'));
  assert.doesNotMatch(resolved.template,/awaiting_confirmation|等待人工确认/);
  assert.match(resolved.template,/直接标记 met/);
  assert.equal(normalizeGoalProofInstructions(resolved.template),resolved.template);
  for(const role of ['planner','mainagent']){
    const prompt=await systemRolePrompt(db,role,{},true,'仅收尾');
    assert.ok(prompt.includes(GOAL_PROOF_PROTOCOL));
    assert.doesNotMatch(prompt,/awaiting_confirmation/);
  }
});

test('native tool contract and stored descriptions agree on direct evidence acceptance',()=>{
  for(const stored of [undefined,legacy]){
    const result=effectiveToolDescription('prove_goal','unused',stored);
    assert.match(result.description,/直接标记 met/);
    assert.doesNotMatch(result.description,/awaiting_confirmation|等待人工确认/);
  }
  assert.equal(normalizeGoalProofInstructions('保留独立业务规则'),'保留独立业务规则');
});
