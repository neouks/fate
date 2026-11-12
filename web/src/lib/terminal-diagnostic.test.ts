import assert from 'node:assert/strict';
import {test} from 'node:test';
import {terminalDiagnostic} from './terminal-diagnostic';
test('diagnostics distinguish known errors without hiding unknown compound-command failures',()=>{
 assert.equal(terminalDiagnostic('grep value file','(no output)\n\nCommand exited with code 1')?.label,'未找到匹配');
 for(const command of ['grep a file | head','grep a file; false','grep "$PATTERN" file',undefined])assert.equal(terminalDiagnostic(command,'(no output)\n\nCommand exited with code 1')?.label,'命令非零退出');
 assert.equal(terminalDiagnostic('node fixture.js','ReferenceError: require is not defined in ES module scope\n\nCommand exited with code 1')?.label,'运行环境不兼容');
 assert.equal(terminalDiagnostic('python fixture.py','Traceback (most recent call last):\nValueError\n\nCommand exited with code 1')?.label,'脚本异常');
 assert.equal(terminalDiagnostic('fixture','partial output'),undefined);
});
