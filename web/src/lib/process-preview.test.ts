import assert from 'node:assert/strict';
import {test} from 'node:test';
import {processPreview} from './process-preview';
test('reasoning preview prefers loaded reasoning over prose and historical summaries',()=>{
 assert.equal(processPreview([{kind:'text',summary:'对话正文'},{kind:'thinking',summary:'思考过程',detail:'先核对\n已有记录，再读取结果。'}]),'先核对 已有记录，再读取结果。');
 assert.equal(processPreview([{kind:'thinking',summary:'历史推理摘要'}]),'历史推理摘要');
 assert.equal(processPreview([{kind:'thinking',detail:'  ',summary:'已有摘要'}]),'已有摘要');
});
test('missing reasoning stays unknown and streaming preview updates without altering content',()=>{
 assert.equal(processPreview([{kind:'thinking',summary:''}]),'未记录推理内容');
 for(const detail of ['先核','先核对记录','先核对记录。'])assert.equal(processPreview([{kind:'thinking',summary:'',detail}]),detail);
 const step={kind:'thinking' as const,summary:'',detail:'测'.repeat(20000)};
 assert.equal(processPreview([step]).length,500);assert.equal(step.detail.length,20000);
});
