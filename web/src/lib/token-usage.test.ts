import assert from 'node:assert/strict';
import {test} from 'node:test';
import {tokenBreakdown, tokenChartParts, tokenMetrics, tokenUsageDetails} from './token-usage';
import {modelTokenTotals} from './model-token-stats';
import type {TokenTotal, ModelTokenStat} from './types';

const usage: TokenTotal = {input_tokens: 18556675, uncached_input_tokens: 844931, cache_read_tokens: 17711744,
  cache_write_tokens: 0, output_tokens: 296379, input_semantics: 'inclusive_cache', input_complete: true, usage_complete: true};

test('cached input is separated without adding it to total twice', () => {
  const tokens = tokenBreakdown(usage);
  assert.equal(tokens.uncached, 844931);
  assert.equal(tokens.total, 18853054);
  assert.deepEqual(tokenMetrics(usage).map(m=>m.label), ['非缓存输入','缓存读取','缓存写入','输出','总量']);
  assert.equal(Object.values(tokenChartParts(usage)).reduce((a,b)=>a+b,0), tokens.total);
  assert.match(tokenUsageDetails(usage), /非缓存输入 844,931.*缓存读取 17,711,744.*输出 296,379.*总量 18,853,054/);
});

test('cache writes have their own category, including old inclusive APIs without an explicit uncached field', () => {
  const value: TokenTotal = {...usage,input_tokens: 100,uncached_input_tokens: undefined,cache_read_tokens: 60,cache_write_tokens: 25,output_tokens: 5};
  assert.equal(tokenBreakdown(value).uncached,15);
  assert.equal(tokenBreakdown(value).total,105);
  assert.deepEqual(tokenChartParts(value),{input:15,cacheRead:60,cacheWrite:25,output:5,unknownInput:0});
  const totals = modelTokenTotals([{...value,model:'fixture',calls:1,source:'usage_ledger'} as ModelTokenStat]);
  assert.equal(totals.uncached,15);
});

test('unknown legacy input is not labeled as uncached, zero or a guessed chart segment', () => {
  for (const value of [{...usage,input_semantics:'unknown' as const}, {...usage,input_complete:false}]) {
    assert.equal(tokenBreakdown(value).uncached,null);
    assert.equal(tokenBreakdown(value).cacheRead,usage.cache_read_tokens);
    assert.equal(tokenMetrics(value).at(-1)!.label,'总量（已记录）');
    assert.deepEqual(tokenChartParts(value),{input:0,output:usage.output_tokens,cacheRead:0,cacheWrite:0,unknownInput:usage.input_tokens});
    assert.match(tokenUsageDetails(value),/非缓存输入 未知/);
  }
});

test('zero, missing and incomplete usage remain distinguishable', () => {
  assert.ok(tokenMetrics(null).every(m=>m.value===null));
  const zero = {...usage,input_tokens:0,uncached_input_tokens:0,cache_read_tokens:0,output_tokens:0};
  assert.ok(tokenMetrics(zero).every(m=>m.value===0));
  const partial = {...usage,usage_complete:false};
  assert.equal(tokenBreakdown(partial).uncached,usage.uncached_input_tokens);
  assert.equal(tokenMetrics(partial).at(-1)!.label,'总量（已记录）');
});
