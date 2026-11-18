import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ContextEvent} from '@earendil-works/pi-coding-agent';
import {projectRecallHistory} from './recall-history.js';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime, type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {fauxProvider, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {AgentRunner} from './runner.js';

const body = '证据正文😀'.repeat(1000);
const assistant = (content: unknown[] = []) => ({role: 'assistant', content});
const result = (toolName: string, value: unknown, isError = false) => ({
  role: 'toolResult', toolCallId: 'call-1', toolName, isError,
  content: [{type: 'text', text: JSON.stringify(value)}],
});
const project = (messages: unknown[]) => projectRecallHistory(messages as ContextEvent['messages']) as unknown as Record<string, any>[];

test('old context excerpts retain read coordinates and do not mutate stored history', () => {
  const receipt = {ref: 'node:42', version: 3, field: '/payload/evidence', content: body,
    next_offset: 6000, next_item: {ref: 'node:42', field: '/payload/evidence', offset: 6000},
    read_receipt: {source_hash: 'hash', offset: 0}, evidence_scope: {limitations: '仅样本'}};
  const messages = [result('context_get', {items: [receipt]}), assistant(), assistant()];
  const before = JSON.stringify(messages);
  const projected = project(messages);
  const item = JSON.parse(projected[0]!.content[0].text).items[0];
  assert.equal(item.content, undefined);
  assert.equal(Array.from(item.content_history_excerpt).length, 160);
  for (const key of ['ref', 'version', 'field', 'next_offset', 'next_item', 'read_receipt', 'evidence_scope'])
    assert.deepEqual(item[key], receipt[key as keyof typeof receipt]);
  assert.equal(JSON.stringify(messages), before);
  assert.deepEqual(project(projected), projected);
  assert.deepEqual(project(JSON.parse(before)), projected);
});

test('recent results, errors, unknown formats and unrelated tools retain full content', () => {
  for (const tool of ['context_get', 'context_search']) {
    const recent = [result(tool, {content: body}), assistant()];
    assert.deepEqual(project(recent), recent);
    const failed = [result(tool, {content: body}, true), assistant(), assistant()];
    assert.deepEqual(project(failed), failed);
  }
  const other = [result('bash', {content: body}), assistant(), assistant()];
  assert.deepEqual(project(other), other);
  const malformed = result('context_get', null);
  malformed.content[0]!.text = '{invalid';
  assert.deepEqual(project([malformed, assistant(), assistant()])[0], malformed);
});

test('record_fact trims only long fields with a confirmed matching item receipt', () => {
  const fact = {summary: '结论', evidence: body, detail: body, scope: {tested: '样本'}, asset_ids: [7]};
  const call = {type: 'toolCall', id: 'call-1', name: 'record_fact', arguments: {facts: [fact, fact]}};
  const receipt = {fact_ids: [42, 0], results: [{fact_id: 42, ref: 'node:42', version: 3}, {fact_id: 0, error: '保存失败'}]};
  const messages = [assistant([call]), result('record_fact', receipt), assistant(), assistant()];
  const before = JSON.stringify(messages);
  const projected = project(messages);
  const facts = projected[0]!.content[0].arguments.facts;
  assert.match(facts[0].evidence, /node:42/);
  assert.deepEqual(facts[0].scope, fact.scope);
  assert.equal(facts[0].summary, fact.summary);
  assert.deepEqual(facts[1], fact);
  assert.deepEqual(projected[1], messages[1]);
  assert.equal(JSON.stringify(messages), before);
  const unmatched = [assistant([call]), assistant(), assistant()];
  assert.deepEqual(project(unmatched), unmatched);
  const invalid = [assistant([call]), result('record_fact', {results: [{fact_id: 42}]}), assistant(), assistant()];
  assert.deepEqual(project(invalid), invalid);
});

test('fresh rereads stay complete while old search content is shortened', () => {
  const old = result('context_search', {items: [{ref: 'session:old', content: body}], next_cursor: 'cursor'});
  const fresh = {...result('context_get', {items: [{ref: 'session:old', content: body}]}), toolCallId: 'fresh'};
  const projected = project([old, assistant(), assistant(), fresh]);
  assert.equal(JSON.parse(projected[0]!.content[0].text).next_cursor, 'cursor');
  assert.deepEqual(projected[3], fresh);
});

test('native request projection survives restore and preserves original session entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fate-recall-history-'));
  const runtime = await ModelRuntime.create({authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), refreshOnCreate: false});
  const faux = fauxProvider({provider: 'recall-fixture'});
  await runtime.registerNativeProvider(faux.provider);
  const tools: ToolDefinition[] = ['context_get', 'record_fact', 'echo'].map(name => ({
    name, label: name, description: 'Local fixture', parameters: {type: 'object', properties: {}},
    execute: async () => ({content: [{type: 'text' as const, text: JSON.stringify(name === 'context_get'
      ? {items: [{ref: 'node:42', version: 3, content: body}]}
      : name === 'record_fact' ? {fact_id: 42, ref: 'node:42', version: 3} : {ok: true})}], details: {}}),
  }));
  const options = {cwd: dir, agentDir: dir, resumeSessionPath: join(dir, 'session.jsonl'), modelRuntime: runtime,
    model: faux.getModel(), systemPrompt: 'Local fixture', toolAllowlist: tools.map(t => t.name), customTools: tools};
  let runner: AgentRunner | undefined;
  const inspect = (context: {messages: unknown[]}) => {
    const serialized = JSON.stringify(context.messages);
    assert.ok(serialized.includes('content_history_excerpt'));
    assert.ok(serialized.includes('历史调用正文已保存至 node:42'));
    assert.ok(!serialized.includes(body));
    return fauxAssistantMessage('done');
  };
  try {
    runner = await AgentRunner.create(options);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('context_get', {})]),
      fauxAssistantMessage([fauxToolCall('record_fact', {summary: '结论', evidence: body})]),
      fauxAssistantMessage([fauxToolCall('echo', {})]),
      fauxAssistantMessage([fauxToolCall('echo', {})]),
      inspect,
    ]);
    await runner.prompt('Run fixture');
    assert.ok(JSON.stringify(runner.sessionEntries).includes(body));
    await runner.dispose();
    runner = await AgentRunner.create(options);
    faux.setResponses([inspect]);
    await runner.prompt('Inspect restored fixture');
    assert.ok(JSON.stringify(runner.sessionEntries).includes(body));
  } finally {
    await runner?.dispose();
    await rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  }
});
