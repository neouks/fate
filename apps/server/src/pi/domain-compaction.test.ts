import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fauxAssistantMessage, fauxProvider} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {AgentRunner} from './runner.js';

for (const [stopReason, expected] of [
  ['length', /达到模型输出长度上限.*原始会话已保留/],
  ['pending', /摘要模型请求失败/],
] as const) test(`an unfinished Planner summary (${stopReason}) leaves the native session intact`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fate-compaction-fixture-'));
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), refreshOnCreate: false,
    });
    const faux = fauxProvider({provider: 'local-compaction-fixture'});
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage('合成清单第一段。'.repeat(400)),
      fauxAssistantMessage('合成清单第二段。'.repeat(400)),
      fauxAssistantMessage('未完成的摘要', {stopReason}),
    ]);
    const runner = await AgentRunner.create({
      cwd: dir, agentDir: dir, inMemory: true, modelRuntime, model: faux.getModel(),
      systemPrompt: '只读取合成清单。', toolAllowlist: [],
      platform: {role: 'planner', taskID: 1, policy: {version: 'domain-v1', compaction: 'native', mcpLoading: 'direct'}},
      compactionSettings: {keepRecentTokens: 128, reserveTokens: 512},
    });
    try {
      await runner.prompt('第一段');
      await runner.prompt('第二段');
      const before = runner.sessionEntries.filter(entry => entry.type === 'message').map(entry => entry.id);
      await assert.rejects(runner.compact(), expected);
      assert.deepEqual(runner.sessionEntries.filter(entry => entry.type === 'message').map(entry => entry.id), before);
      assert.equal(runner.sessionEntries.some(entry => entry.type === 'compaction'), false);
      assert.equal(faux.state.callCount, 3);
      assert.deepEqual(runner.compactionDiagnostics, {requests: 1, completed: 0, failed: 1, cancelled: 0});
    } finally {
      await runner.dispose();
    }
  } finally {
    await rm(dir, {recursive: true, force: true, maxRetries: 3});
  }
});
