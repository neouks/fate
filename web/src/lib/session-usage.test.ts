import assert from 'node:assert/strict';
import test from 'node:test';
import {estimateCost, estimateDraftTokens, rate, emptyRates} from './session-usage';

const usage={input_tokens:3100,uncached_input_tokens:1000,output_tokens:500,cache_read_tokens:2000,cache_write_tokens:100,input_semantics:'inclusive_cache' as const,usage_complete:true,input_complete:true};
const prices={input:'3',output:'15',cacheRead:'0.3',cacheWrite:'5'};
test('cache read and write are charged separately without charging inclusive input again',()=>{
  assert.ok(Math.abs(estimateCost(usage,prices)! - 0.0116)<1e-10);
});
test('unknown usage and prices never look free',()=>{
  assert.equal(estimateCost(usage,emptyRates),null);
  assert.equal(estimateCost({...usage,usage_complete:false},prices),null);
  assert.equal(estimateCost({...usage,input_semantics:'unknown'},prices),null);
  assert.equal(estimateCost(usage,{...prices,cacheWrite:''}),null);
  assert.equal(rate('-1'),null);assert.equal(rate('Infinity'),null);assert.equal(rate(''),null);
});
test('explicit free rates are valid, missing rates for zero usage are irrelevant',()=>{
  assert.equal(estimateCost(usage,{input:'0',output:'0',cacheRead:'0',cacheWrite:'0'}),0);
  assert.equal(estimateCost({...usage,input_tokens:1500,uncached_input_tokens:1500,cache_read_tokens:0,cache_write_tokens:0},{...prices,cacheRead:'',cacheWrite:''}),0.012);
});
test('draft heuristic handles Chinese, ASCII, and empty input',()=>{
  assert.equal(estimateDraftTokens(''),0);
  assert.equal(estimateDraftTokens('abcd'),1);
  assert.equal(estimateDraftTokens('你好'),3);
  assert.equal(estimateDraftTokens('abcd你好'),4);
});
