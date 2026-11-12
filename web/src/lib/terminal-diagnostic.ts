/** Presentation only. Never changes success flags or causes an automatic retry. */
export function terminalDiagnostic(command:string|undefined,output:string|undefined){
 if(!output)return undefined;
 const match=/\n\nCommand exited with code (\d+)\s*$/.exec(output);
 if(!match)return undefined;
 const code=Number(match[1]),body=output.slice(0,match.index).trim();
 if(code===0)return undefined;
 if(/ReferenceError: require is not defined in ES module scope/.test(body))return {code,label:'运行环境不兼容',detail:'脚本的模块格式与当前 Node.js 运行方式不一致。原始错误保留如下。'};
 if(/Traceback \(most recent call last\):/.test(body))return {code,label:'脚本异常',detail:'脚本运行中抛出了异常，不能据此判断测试目标的状态。'};
 // Only an uncomplicated grep with empty output is identifiable as no match.
 // Pipelines, shell expansions, compound commands and truncated inputs remain unknown.
 if(code===1&&(!body||body==='(no output)')&&command&&/^grep\s+[^\n;&|`$<>]+$/.test(command))return {code,label:'未找到匹配',detail:'本次 grep 未找到匹配内容；退出码 1 不等于目标操作失败。'};
 return {code,label:'命令非零退出',detail:'仅凭退出码不能确定原因，请查看完整输出。没有自动重试。'};
}
