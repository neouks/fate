import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ContextEvent} from '@earendil-works/pi-coding-agent';
import {projectRecallHistory, RETRIEVAL_BODY_CHARS, RETRIEVAL_INDEX_CHARS} from './recall-history.js';
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
  for (const tool of ['bash', 'read', 'write', 'edit', 'mcp__fixture__query']) {
    const other = [result(tool, {content: body}), assistant(), assistant()];
    assert.deepEqual(project(other), other);
    assert.strictEqual(project(other)[0], other[0]);
  }
  const malformed = result('context_get', null);
  malformed.content[0]!.text = '{invalid';
  assert.deepEqual(project([malformed, assistant(), assistant()])[0], malformed);
});

test('record_fact arguments and receipts remain exact, including batches and reused call IDs', () => {
  const fact = {summary: '结论', evidence: body, detail: body, scope: {tested: '样本'}, asset_ids: [7]};
  const call = {type: 'toolCall', id: 'call-1', name: 'record_fact', arguments: {facts: [fact, fact]}};
  const receipt = {fact_ids: [42, 0], results: [{fact_id: 42, ref: 'node:42', version: 3}, {fact_id: 0, error: '保存失败'}]};
  const messages = [assistant([call]), result('record_fact', receipt), assistant(), assistant()];
  const before = JSON.stringify(messages);
  const projected = project(messages);
  const facts = projected[0]!.content[0].arguments.facts;
  assert.equal(facts[0].evidence, body);
  assert.deepEqual(facts[0].scope, fact.scope);
  assert.equal(facts[0].summary, fact.summary);
  assert.deepEqual(facts[1], fact);
  assert.deepEqual(projected[1], messages[1]);
  assert.equal(JSON.stringify(messages), before);
  assert.deepEqual(projected, messages);
  assert.strictEqual(projected[0], messages[0]);
  const single = {type: 'toolCall', id: 'call-1', name: 'record_fact', arguments: fact};
  const reused = [assistant([single]), result('record_fact', {fact_id: 42, ref: 'node:42', version: 0}),
    assistant([single]), result('record_fact', {fact_id: 99, ref: 'node:99', version: 0}), assistant(), assistant()];
  assert.deepEqual(project(reused), reused);
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

test('all platform reads share a newest-first body/index budget across calls and restored sessions', () => {
  const names = ['context_get', 'context_search', 'asset_get', 'asset_search', 'traffic_search', 'graph_overview',
    'read_tool_output', 'traffic_body', 'list_assets', 'list_untested_assets', 'list_findings', 'get_finding',
    'node_detail', 'search_worker_traces', 'get_worker_trace', 'expand_index', 'expand_digest'];
  // Many individually small, distinct records defeat per-field truncation.
  const messages = Array.from({length: 120}, (_, i) => ({...result(names[i % names.length]!,
    {items: Array.from({length: 15}, (_, j) => ({ref: `node:${i * 15 + j}`, version: i,
      field: '/payload/evidence', summary: `样本${i}-${j}😀`.repeat(5)})), next_cursor: `page-${i}`}), toolCallId: `call-${i}`}));
  const before = JSON.stringify(messages), projected = project(messages);
  let bodies = 0, indices = 0, omitted = 0;
  for (const message of projected) {
    const text = message.content[0].text, value = JSON.parse(text);
    if (!value.history_omitted) bodies += Array.from(text).length;
    else if (value.items) indices += Array.from(text).length;
    else omitted++;
  }
  assert.ok(bodies > 0 && bodies <= RETRIEVAL_BODY_CHARS);
  assert.ok(indices > 0 && indices <= RETRIEVAL_INDEX_CHARS);
  assert.ok(omitted > 0);
  assert.strictEqual(projected.at(-1), messages.at(-1), 'newest result stays complete');
  assert.equal(JSON.stringify(messages), before, 'original evidence stays in the transcript');
  assert.deepEqual(project(projected), projected, 'request projection is idempotent');
  assert.deepEqual(project(JSON.parse(before)), projected, 'restore uses the same budget');
  const indexed = projected.map(m => JSON.parse(m.content[0].text)).find(v => v.history_omitted && v.items);
  assert.equal(indexed.items[0].field, '/payload/evidence');
  assert.equal(typeof indexed.items[0].version, 'number');
  assert.ok(indexed.next_cursor.startsWith('page-'));
});

test('oversized fresh results become valid indices; errors, images, writes and native history are never budgeted', () => {
  const huge = result('context_get', {items: [{ref: 'node:42', version: 7, field: '/payload/evidence', content: body.repeat(10)}]});
  const protectedMessages = [
    result('context_get', {items: [{error: 'denied', detail: body.repeat(10)}]}),
    result('asset_search', {error: body}),
    ...['bash', 'read', 'write', 'edit', 'mcp__fixture__query', 'record_fact', 'report_finding'].map(name => result(name, {content: body.repeat(10)})),
    {...result('context_get', {}), content: [{type: 'image', data: body, mimeType: 'image/png'}]},
  ];
  const projected = project([huge, ...protectedMessages]);
  const index = JSON.parse(projected[0]!.content[0].text);
  assert.equal(index.history_omitted, true);
  assert.deepEqual(index.items, [{ref: 'node:42', version: 7, field: '/payload/evidence'}]);
  protectedMessages.forEach((message, i) => assert.strictEqual(projected[i + 1], message));
  assert.deepEqual(project(projected), projected);
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
    assert.ok(!serialized.includes('历史调用正文已保存至'));
    assert.ok(serialized.includes(body), 'original write arguments remain available to PI');
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
