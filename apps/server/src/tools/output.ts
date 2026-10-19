import {domainTool} from './define.js';
import type {ToolRunContext} from './context.js';
import {loadToolOutput,outputPage} from '../evidence/tool-outputs.js';
export function toolOutputTool(ctx:ToolRunContext){return domainTool<{output_ref:string;offset?:number}>({
 name:'read_tool_output',description:'按字符偏移续读本会话工具的完整 JSON 原文；使用上次结果的 output_ref 与 next_offset。',readOnly:true,
 parameters:{type:'object',properties:{output_ref:{type:'string'},offset:{type:'integer',minimum:0}},required:['output_ref']},
 async run(args,c){return outputPage(args.output_ref,await loadToolOutput(c.db,args.output_ref,{taskID:c.taskID,conversationID:c.conversationID,worker:c.role==='worker',agent:true,intentID:c.intentID}),args.offset);}
},ctx);}
