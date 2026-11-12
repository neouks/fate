import path from 'node:path';
import {homedir} from 'node:os';
/** Host-derived identity, without arguments, file bodies or credentials. */
export type ResourceCall = {kind:'skill';name:string;operation:'read'} | {kind:'mcp';name:string;server_id?:number;operation:string};
export type McpOwner = {server:string;tool:string};
export function classifyResourceCall(tool:string,args:unknown,options:{cwd:string;skillsDir?:string},owners:ReadonlyMap<string,McpOwner>,servers:ReadonlyMap<string,number>):ResourceCall|undefined {
 const owner=owners.get(tool);
 if(owner)return {kind:'mcp',name:owner.server,server_id:servers.get(owner.server),operation:owner.tool};
 if(tool!=='read'||!options.skillsDir||!args||typeof args!=='object')return;
 const requested=(args as {path?:unknown}).path;if(typeof requested!=='string')return;
 const file=path.resolve(options.cwd,requested.startsWith('~/')?path.join(homedir(),requested.slice(2)):requested);
 const relative=path.relative(path.resolve(options.skillsDir),file).split(path.sep);
 // Count entry-document read attempts, not index loading/supporting files.
 if(relative.length===2&&relative[0]&&relative[0]!=='.'&&relative[0]!=='..'&&relative[1]==='SKILL.md')return {kind:'skill',name:relative[0],operation:'read'};
}
