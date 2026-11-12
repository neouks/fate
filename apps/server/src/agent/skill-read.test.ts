import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fauxAssistantMessage, fauxProvider, fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import type {Database} from '../db/index.js';
import {AgentRunner, type RunnerActivity} from '../pi/runner.js';
import {skillReadAccess} from './resources.js';
import {workerIntentToolRestriction} from './roles.js';

test('pi read can load bound Skill documents without opening other files in a limited intent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fate-skill-read-'));
  try {
    const skillsDir = join(dir, 'skills');
    const skillDir = join(skillsDir, 'api-recon');
    await mkdir(skillDir, {recursive:true});
    const skill = join(skillDir, 'SKILL.md');
    const reference = join(skillDir, 'reference.md');
    const other = join(dir, 'other.md');
    const script = join(skillDir, 'script.sh');
    const link = join(skillDir, 'linked.md');
    await Promise.all([
      writeFile(skill, '---\nname: api-recon\ndescription: Fixture skill.\n---\nSkill instructions'),
      writeFile(reference, 'Skill reference'), writeFile(other, 'Unrelated file'), writeFile(script, 'Script contents'),
    ]);
    await symlink(other, link, 'file');
    const resources = {cwd:dir, skillsDir, allowedSkills:['api-recon']};
    let bound = true;
    const db = {
      query: async (_sql: string, args: unknown[]) => ({rowCount:bound && args[0] === '1' && args[1] === 'api-recon' ? 1 : 0}),
    } as unknown as Database;
    const runtime = await ModelRuntime.create({authPath:join(dir, 'auth.json'), modelsPath:join(dir, 'models.json'), refreshOnCreate:false});
    const faux = fauxProvider({provider:'skill-documents'});
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([skill, reference, other, script, link].map(path => fauxToolCall('read', {path}))),
      fauxAssistantMessage('读取检查完毕'),
    ]);
    const activities: RunnerActivity[] = [];
    const runner = await AgentRunner.create({
      ...resources, agentDir:dir, inMemory:true, modelRuntime:runtime, model:faux.getModel(),
      systemPrompt:'本地 Skill 读取权限回归。', toolAllowlist:['read'],
      guard: async g => {
        const access = await skillReadAccess(db, '1', resources, String(g.args.path));
        if (access === 'disabled') return {block:true, reason:'Skill 已禁用或解除角色绑定'};
        return workerIntentToolRestriction(['http_request'], {...g, skillDocument:access === 'document'});
      },
      onActivity: activity => {activities.push(activity);},
    });
    try {
      await runner.prompt('检查文档读取');
      const results = activities.filter(a => a.kind === 'tool_end');
      assert.equal(results.length, 5);
      assert.equal(results.filter(a => !a.isError).length, 2);
      assert.ok(results.some(a => !a.isError && a.text?.includes('Skill instructions')));
      assert.ok(results.some(a => !a.isError && a.text === 'Skill reference'));
      assert.equal(results.filter(a => a.isError && a.text?.includes('allowed_tools')).length, 2);
      assert.ok(results.some(a => a.isError && a.text?.includes('Skill 已禁用')));
      assert.equal(await skillReadAccess(db, '1', {...resources, allowedSkills:[]}, skill), undefined);
      bound = false;
      assert.equal(await skillReadAccess(db, '1', resources, skill), 'disabled');
    } finally {
      await runner.dispose();
    }
  } finally {
    await rm(dir, {recursive:true, force:true});
  }
});
