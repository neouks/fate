import assert from 'node:assert/strict';
import {test} from 'node:test';
import {terminalDiagnostic,toolOutcomeText,toolWasStopped} from './terminal-diagnostic';
import type {Activity} from './types';
test('diagnostics distinguish known errors without hiding unknown compound-command failures',()=>{
 assert.equal(terminalDiagnostic('grep value file','(no output)\n\nCommand exited with code 1')?.label,'未找到匹配');
 for(const command of ['grep a file | head','grep a file; false','grep "$PATTERN" file',undefined])assert.equal(terminalDiagnostic(command,'(no output)\n\nCommand exited with code 1')?.label,'命令非零退出');
 assert.equal(terminalDiagnostic('node fixture.js','ReferenceError: require is not defined in ES module scope\n\nCommand exited with code 1')?.label,'运行环境不兼容');
 assert.equal(terminalDiagnostic('python fixture.py','Traceback (most recent call last):\nValueError\n\nCommand exited with code 1')?.label,'脚本异常');
 assert.equal(terminalDiagnostic('fixture','partial output'),undefined);
});

test('diagnostics identify command lookup, missing paths and SDK timeouts',()=>{
 assert.equal(terminalDiagnostic(undefined,'/bin/bash: timeout: command not found\n\nCommand exited with code 1')?.label,'找不到命令');
 assert.equal(terminalDiagnostic(undefined,'Traceback (most recent call last):\nFileNotFoundError: missing\n\nCommand exited with code 1')?.label,'文件或目录缺失');
 assert.equal(terminalDiagnostic(undefined,'head: fixture.txt: No such file or directory\n\nCommand exited with code 1')?.label,'文件或目录缺失');
 assert.deepEqual(terminalDiagnostic(undefined,'Command timed out after 10 seconds'),{label:'命令超时',detail:'执行达到工具的 10 秒时限，命令已终止。'});
 assert.equal(terminalDiagnostic(undefined,'已进入收尾阶段，停止新探索。被宿主拒绝的调用未执行。')?.label,'收尾阶段已拒绝');
 assert.equal(terminalDiagnostic(undefined,'Command exited with code 127')?.code,127);
});

test('only complete result markers or persisted status identify a stopped call',()=>{
 const result:Activity={seq:2,worker:'work#1',ts:'',kind:'tool_result',tool:'bash',summary:'',is_error:true};
 assert.equal(toolWasStopped(undefined,{...result,detail:'partial output\n\nCommand aborted'}),true);
 assert.equal(toolWasStopped(undefined,{...result,summary:'Command aborted'}),true);
 assert.equal(toolWasStopped(undefined,{...result,detail:'Command aborted',is_error:false}),false);
 const truncated={...result,detail:'Command aborted',summary:'Command aborted',detail_truncated:true};
 assert.equal(toolOutcomeText(truncated),undefined);
 assert.equal(toolWasStopped(undefined,truncated),false);
 assert.equal(toolWasStopped(undefined,{...truncated,metadata:{status:'interrupted'}}),true);
 assert.equal(toolWasStopped(undefined,{...result,detail:'Command aborted\n\nCommand exited with code 1'}),false);
});
