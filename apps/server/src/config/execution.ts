import {accessSync,constants} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createBashToolDefinition,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {Database} from '../db/index.js';

export const EXECUTION_DEFAULTS={traffic_capture:false,agent_traffic_binding:false,constraints_inject_planner:true,constraints_inject_worker:true,global_proxy:'',python_interpreter:'',shell_mode:'auto'};
export type ShellMode='auto'|'bash'|'gitbash'|'powershell'|'pwsh'|'wsl'|'cmd';
export interface ShellChoice {mode:ShellMode;path:string;args:string[];interactiveArgs:string[];interactive:boolean;}
function executable(name:string){
 const names=process.platform==='win32'&&!path.extname(name)?[name+'.exe',name+'.cmd',name]:[name];
 const candidates=path.isAbsolute(name)?[name]:(process.env.PATH??'').split(path.delimiter).flatMap(dir=>names.map(n=>path.join(dir,n)));
 return candidates.find(file=>{try{accessSync(file,constants.X_OK);return true;}catch{return false;}});
}
export function resolveShell(mode:string='auto'):ShellChoice {
 if(!['auto','bash','gitbash','powershell','pwsh','wsl','cmd'].includes(mode))throw new Error('无效 Shell 模式');
 const requested=mode as ShellMode;
 if(mode==='auto')mode=process.platform==='win32'?'powershell':'bash';
 if(['gitbash','powershell','wsl','cmd'].includes(mode)&&process.platform!=='win32')throw new Error(`${mode} 仅适用于 Windows；当前平台请使用 auto、bash 或已安装的 pwsh`);
 const known=mode==='bash'&&process.platform!=='win32'?['/bin/bash','bash']:mode==='gitbash'?[path.join(process.env.ProgramFiles??'C:\\Program Files','Git','bin','bash.exe'),'bash']:mode==='cmd'?[process.env.ComSpec??'cmd.exe']:[mode];
 const file=known.map(executable).find(Boolean);if(!file)throw new Error(`未找到 ${mode} 解释器`);
 const args=mode==='cmd'?['/d','/s','/c']:mode==='wsl'?['--exec','bash','-c']:['powershell','pwsh'].includes(mode)?['-NoLogo','-NoProfile','-NonInteractive','-Command']:['-c'];
 return {mode:mode as ShellMode,path:file,args,interactiveArgs:mode==='cmd'?['/d']:mode==='wsl'?['--exec','bash']:['powershell','pwsh'].includes(mode)?['-NoLogo','-NoProfile']:['-l'],interactive:true};
}
export function pythonInterpreter(configured=''){
 const value=configured.trim();if(value&&!path.isAbsolute(value))throw new Error('Python 解释器必须为绝对路径');
 const file=value?executable(value):executable('python3')??executable('python');
 if(!file)throw new Error(value?'Python 解释器不存在或不可执行':'未找到 Python 解释器');return file;
}
export async function executionSettings(db:Database){
 const out={...EXECUTION_DEFAULTS};for(const key of Object.keys(out) as Array<keyof typeof out>){const value=await db.platform().getSetting(key);if(value!=null)(out as Record<string,unknown>)[key]=typeof out[key]==='boolean'?value==='true':value;}
 let shell_detected:Record<string,unknown>;try{const shell=resolveShell(out.shell_mode);shell_detected={ok:true,mode:shell.mode,path:shell.path,interactive:shell.interactive};}catch(error){shell_detected={ok:false,error:(error as Error).message};}
 return {...out,shell_detected};
}
export function runProgram(file:string,args:string[],options:{cwd:string;env?:NodeJS.ProcessEnv;signal?:AbortSignal;timeoutMs?:number;input?:string;onData?:(data:Buffer)=>void}){
 options.signal?.throwIfAborted();
 return new Promise<{exitCode:number|null;output:string}>((resolve,reject)=>{
  const child=spawn(file,args,{cwd:options.cwd,env:options.env??process.env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output='',failure:Error|undefined;
  const kill=()=>{try{if(process.platform!=='win32')process.kill(-child.pid!,'SIGKILL');else child.kill('SIGKILL');}catch{}};
  const abort=()=>{failure=new Error('命令已取消');kill();};
  const timer=setTimeout(()=>{failure=new Error('命令执行超时');kill();},options.timeoutMs??300000);
  options.signal?.addEventListener('abort',abort,{once:true});
  const data=(chunk:Buffer)=>{options.onData?.(chunk);if(output.length<65536)output+=chunk.toString('utf8').slice(0,65536-output.length);};
  child.stdout.on('data',data);child.stderr.on('data',data);child.stdin.on('error',()=>{});child.stdin.end(options.input??'');
  const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);};
  child.once('error',e=>{cleanup();reject(e);});child.once('close',code=>{cleanup();if(failure)reject(failure);else resolve({exitCode:code,output});});
  if(options.signal?.aborted)abort();
 });
}
export async function configuredBash(db:Database,cwd:string,env:Record<string,string>):Promise<ToolDefinition>{
 const shell=resolveShell(await db.platform().getSetting('shell_mode')??'auto');
 // Bash-compatible interpreters use pi's native process lifecycle and output handling.
 // Keep the adapter only for interpreters with different invocation syntax.
 const tool=createBashToolDefinition(cwd,['bash','gitbash'].includes(shell.mode)?{
  shellPath:shell.path,spawnHook:context=>({...context,env:{...context.env,...env}}),
 }:{operations:{exec:async(command,directory,options)=>runProgram(shell.path,[...shell.args,command],{
  cwd:directory,env:{...options.env,...env},signal:options.signal,
  timeoutMs:options.timeout===undefined?undefined:options.timeout*1000,onData:options.onData,
 })}}) as unknown as ToolDefinition;
 tool.description+=`\n实际命令解释器：${shell.mode}。请使用该解释器的语法。`;return tool;
}
