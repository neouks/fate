import type { Activity } from './types';

export function toolOutcomeText(result: Activity | undefined) {
 if (!result) return undefined;
 if (result.detail && !result.detail_truncated) return result.detail;
 if (!result.detail_truncated && !result.summary_truncated) return result.summary;
 return undefined;
}

export function toolWasStopped(use: Activity | undefined, result: Activity | undefined) {
 const status = result?.metadata?.status ?? use?.metadata?.status;
 if (result?.interrupted || use?.interrupted || ['aborted', 'cancelled', 'canceled', 'stopped', 'interrupted'].includes(status ?? '')) return true;
 if (!result?.is_error) return false;
 const text = toolOutcomeText(result)?.trim() ?? '';
 return ['Operation aborted', 'Command aborted', 'Tool execution aborted', 'aborted'].includes(text)
  || (result.tool ?? use?.tool)?.toLowerCase() === 'bash' && /\n\nCommand aborted$/.test(text);
}

/** Presentation only. Never changes success flags or causes an automatic retry. */
export function terminalDiagnostic(command:string|undefined,output:string|undefined){
 if(!output)return undefined;
 if(output.startsWith('已进入收尾阶段，停止新探索。')&&output.includes('被宿主拒绝的调用未执行'))
  return {label:'收尾阶段已拒绝',detail:'宿主在执行前拒绝了这次调用。'};
 const timeout=/(?:^|\n\n)Command timed out after (\d+) seconds\s*$/.exec(output);
 if(timeout)return {label:'命令超时',detail:`执行达到工具的 ${timeout[1]} 秒时限，命令已终止。`};
 const match=/(?:^|\n\n)Command exited with code (\d+)\s*$/.exec(output);
 if(!match)return undefined;
 const code=Number(match[1]),body=output.slice(0,match.index).trim();
 if(code===0)return undefined;
 if(/ReferenceError: require is not defined in ES module scope/.test(body))return {code,label:'运行环境不兼容',detail:'脚本的模块格式与当前 Node.js 运行方式不一致。原始错误保留如下。'};
 if(/(?:^|\n)[^\n]*\bbash: [^\n]+: command not found(?:\r?\n|$)/m.test(body))return {code,label:'找不到命令',detail:'Bash 无法在当前执行环境找到输出中标明的命令。'};
 if(/(?:^|\n)FileNotFoundError:|(?:^|\n)(?:head|wc|ls|cat|stat|find): [^\n]*No such file or directory/m.test(body))
  return {code,label:'文件或目录缺失',detail:'命令或脚本无法读取或写入输出中标明的路径。'};
 if(/Traceback \(most recent call last\):/.test(body))return {code,label:'脚本异常',detail:'脚本运行中抛出了异常，不能据此判断测试目标的状态。'};
 // Only an uncomplicated grep with empty output is identifiable as no match.
 // Pipelines, shell expansions, compound commands and truncated inputs remain unknown.
 if(code===1&&(!body||body==='(no output)')&&command&&/^grep\s+[^\n;&|`$<>]+$/.test(command))return {code,label:'未找到匹配',detail:'本次 grep 未找到匹配内容；退出码 1 不等于目标操作失败。'};
 return {code,label:'命令非零退出',detail:'仅凭退出码不能确定原因，请查看完整输出。没有自动重试。'};
}
