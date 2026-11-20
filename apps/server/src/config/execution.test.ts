import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredBash,runProgram} from './execution.js';
import type {Database} from '../db/index.js';

test('configured Bash preserves environment, cwd, errors, cancellation and timeout through pi',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-configured-bash-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const db={platform:()=>({getSetting:async()=> 'bash'})} as unknown as Database;
  const tool=await configuredBash(db,dir,{FATE_EXECUTION_FIXTURE:'local-value'});
  const result=await tool.execute('environment',{command:'printf "%s\n" "$FATE_EXECUTION_FIXTURE"; pwd'},undefined,undefined,undefined as never);
  const output=JSON.stringify(result.content);
  assert.match(output,/local-value/);assert(output.includes(dir)||output.includes('/private'+dir));
  const failed=await tool.execute('exit',{command:'printf local-failure; exit 7'},undefined,undefined,undefined as never);
  assert.equal(failed.isError,true);assert.match(JSON.stringify(failed.content),/code 7/);
  await assert.rejects(tool.execute('timeout',{command:'sleep 5',timeout:0.05},undefined,undefined,undefined as never),/timed out|timeout/i);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),50);t.after(()=>clearTimeout(timer));
  await assert.rejects(tool.execute('cancel',{command:'sleep 5'},controller.signal,undefined,undefined as never),/abort|cancel/i);
});

test('program adapter still delivers stdin without shell interpolation',async()=>{
  const input='literal $(not-a-command) `not-a-command`\n';
  const result=await runProgram(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{cwd:tmpdir(),input});
  assert.equal(result.exitCode,0);assert.equal(result.output,input);
});
