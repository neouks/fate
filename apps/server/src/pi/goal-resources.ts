import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {createMcpToolName} from '@earendil-works/pi-mcp';
import {loadBoundSkills} from '../agent/skill-files.js';
import type {Database} from '../db/index.js';
import {roleResources} from '../agent/resources.js';
import quote from './goal-resources/quote.json' with {type:'json'};

const root=fileURLToPath(new URL('./goal-resources/',import.meta.url));
const skillsDir=path.join(root,'skills');
const skillName='material-review';
const server='materials';
const mcpName=createMcpToolName(server,quote.name);
const serverFile=path.join(root,'materials.mjs');

export const reviewTool = {
  name:'review_material', label:'材料复核', description:'让独立 PI 会话复核本任务的原始材料，指出与目标相关的缺项。',
  parameters:{type:'object', properties:{}, additionalProperties:false},
} as const;

const bindingSearch = {
  name:'find_resource_bindings', label:'查询系统绑定',
  description:'按名称查询目标会话已启用的系统 MCP 和 Skill 绑定。结果是配置记录，仅供查询。',
  parameters:{type:'object',properties:{query:{type:'string',maxLength:128,description:'资源名称片段，省略时列出绑定'}},additionalProperties:false},
};

export async function findGoalBindings(db:Database, query:string) {
  const {mcpEntries,allowedSkills}=await roleResources(db,'mainagent');
  const needle=query.trim().toLowerCase();
  const matches=[
    ...(mcpEntries??[]).map(server=>({kind:'mcp',name:server.name})),
    ...(allowedSkills??[]).map(name=>({kind:'skill',name})),
  ].filter(resource=>resource.name.toLowerCase().includes(needle));
  return {total:matches.length,bindings:matches.slice(0,50)};
}

function reviewSkill(){
  const skill=loadBoundSkills(skillsDir,[skillName]).skills[0];
  if(!skill)throw new Error('材料核对 Skill 未正确安装');
  return skill;
}

export function goalResourceCatalog() {
  const skill=reviewSkill();
  return [
    {kind:'mcp',name:mcpName,description:quote.description},
    {kind:'skill',name:skill.name,description:skill.description,command:'/skill:'+skill.name},
    {kind:'subagent',name:reviewTool.name,description:reviewTool.description},
    {kind:'catalog',name:bindingSearch.name,description:bindingSearch.description},
  ];
}

const skillFile=path.join(skillsDir,skillName,'SKILL.md');
const readTool = {
  name:'read', label:'读取 Skill',description:'读取材料核对 Skill 的 SKILL.md。',
  parameters:{type:'object',properties:{path:{type:'string',enum:[skillFile]}},required:['path'],additionalProperties:false},
};

export const goalTools = [reviewTool,readTool,bindingSearch,{name:mcpName,description:quote.description,parameters:quote.inputSchema}];

export function goalResources(lookup:(query:string)=>ReturnType<typeof findGoalBindings>) {
  const skill=reviewSkill();
  const read:ToolDefinition={...readTool, async execute(_id,input){
    if((input as {path:string}).path!==skill.filePath)throw new Error('read 仅可读取本任务的 Skill 说明');
    return {content:[{type:'text',text:readFileSync(skill.filePath,'utf8')}],details:{}};
  }};
  const search:ToolDefinition={...bindingSearch,async execute(_id,input){
    const {query=''}=input as {query?:string};
    const result=await lookup(query);
    return {content:[{type:'text',text:JSON.stringify(result)}],details:{}};
  }};
  const names=goalTools.map(t=>t.name);
  return {skillsDir,allowedSkills:[skill.name],liveAllowedSkills:async()=>[skill.name],customTools:[read,search],
    toolAllowlist:names,toolLoading:{version:'goal-resources-v1',initialActive:names,deferred:[],compatibility:[]},
    mcpEntries:[{name:server,config:{transport:'stdio',command:process.execPath,args:[serverFile],exposure:'direct'}}]};
}
