import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime, createBashToolDefinition} from '@earendil-works/pi-coding-agent';
import {fauxProvider, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {executionTools} from './roles.js';
import type {ToolRunContext} from '../tools/context.js';
import {AgentRunner} from '../pi/runner.js';

test('role execution uses PI native Bash without platform overrides or execution wrapping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fate-native-bash-'));
  const runtime = await ModelRuntime.create({authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), refreshOnCreate: false});
  const faux = fauxProvider({provider: 'native-bash-fixture'});
  await runtime.registerNativeProvider(faux.provider);
  const platform = {
    listTools: async () => [],
    getAgentByKey: async () => ({interactiveShell: false}),
    getSetting: async (key: string) => {
      assert.notEqual(key, 'shell_mode');
      return key === 'global_proxy' ? 'http://127.0.0.1:1' : null;
    },
  };
  try {
    for (const role of ['worker', 'mainagent', 'pentest']) {
      const ctx = {role, taskID: 1, intentID: 1, db: {platform: () => platform}} as unknown as ToolRunContext;
      const execution = await executionTools(ctx, dir, {});
      assert.ok(!execution.tools.some(tool => tool.name === 'bash'));
      const wrapped: string[] = [];
      const runner = await AgentRunner.create({cwd: dir, agentDir: dir, inMemory: true,
        modelRuntime: runtime, model: faux.getModel(), systemPrompt: 'Local fixture',
        toolAllowlist: ['bash'], customTools: execution.tools,
        wrapExecutionTool: tool => {wrapped.push(tool.name); return tool;},
      });
      try {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('bash', {command: "if [ \"$HTTP_PROXY\" = 'http://127.0.0.1:1' ]; then printf platform-proxy; else printf native-bash-ok; fi"})]),
          context => {
            const result = context.messages.find(message => message.role === 'toolResult');
            assert.ok(result && result.role === 'toolResult');
            assert.deepEqual(result.content, [{type: 'text', text: 'native-bash-ok'}]);
            return fauxAssistantMessage('done');
          },
        ]);
        assert.equal((await runner.prompt('Run local Bash fixture')).stopReason, 'completed');
        const bash = runner.session.getAllTools().find(tool => tool.name === 'bash');
        assert.equal(bash?.description, createBashToolDefinition(dir).description);
        assert.ok(!wrapped.includes('bash'));
      } finally {
        await runner.dispose();
      }
    }
  } finally {
    await rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  }
});
