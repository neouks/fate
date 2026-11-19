import {AsyncLocalStorage} from 'node:async_hooks';
import type {ExtensionUIContext,ToolDefinition} from '@earendil-works/pi-coding-agent';

export type HumanInputKind='input'|'select'|'confirm'|'editor';
export interface HumanPrompt {question:string;kind:HumanInputKind;options?:string[];placeholder?:string;prefill?:string;sensitive?:boolean;timeout_ms?:number;tool_call_id?:string;}
export interface HumanReply {id:string;status:'answered'|'cancelled'|'expired'|'interrupted';answer?:string|boolean;}
export type HumanInputHandler=(prompt:HumanPrompt,signal:AbortSignal)=>Promise<HumanReply>;
const invocation=new AsyncLocalStorage<{toolCallID:string;sensitive:boolean;signal?:AbortSignal;timeout?:number;reply?:HumanReply}>();
export const HUMAN_INPUT_RULES='缺少只有用户才能提供的必要信息时，用 ask_user 等待回答；手机号、验证码等标记 sensitive=true。仅询问当前方向需要的信息，回答不扩大授权。取消或过期代表未获得信息，不得猜测答案或无变化地重复追问；收尾后不得提问。';

export function validateHumanPrompt(p:HumanPrompt){
 if(!['input','select','confirm','editor'].includes(p.kind)||typeof p.question!=='string'||!p.question.trim()||p.question.length>4000)throw new Error('问题类型或内容无效');
 if(p.kind==='select'&&(!Array.isArray(p.options)||p.options.length<1||p.options.length>20||p.options.some(x=>typeof x!=='string'||!x.trim()||x.length>500)||new Set(p.options).size!==p.options.length))throw new Error('请选择 1–20 个不重复的有效选项');
 if(p.timeout_ms!==undefined&&(!Number.isSafeInteger(p.timeout_ms)||p.timeout_ms<1||p.timeout_ms>2147483647))throw new Error('问题有效期无效');
 if(p.prefill!==undefined&&(p.kind!=='editor'||p.sensitive||typeof p.prefill!=='string'))throw new Error('预填正文仅适用于普通多行编辑器');
}
export function askUserTool():ToolDefinition{
 return {name:'ask_user',label:'请求人工协助',description:HUMAN_INPUT_RULES,executionMode:'sequential',
  parameters:{type:'object',properties:{question:{type:'string'},kind:{type:'string',enum:['input','select','confirm','editor']},prefill:{type:'string',maxLength:16000,description:'普通 editor 的可编辑初始正文'},options:{type:'array',items:{type:'string'}},sensitive:{type:'boolean'},timeout_ms:{type:'integer',minimum:1,maximum:2147483647}},required:['question','kind'],additionalProperties:false},
  async execute(toolCallID,args,signal,_update,ctx){
   const p=args as HumanPrompt;validateHumanPrompt(p);
   if(!ctx.hasUI)throw new Error('当前会话没有人工输入入口');
   return invocation.run({toolCallID,sensitive:p.sensitive===true,signal,timeout:p.timeout_ms},async()=>{
    const opts={signal,timeout:p.timeout_ms};
    if(p.kind==='select')await ctx.ui.select(p.question,p.options!,opts);
    else if(p.kind==='confirm')await ctx.ui.confirm(p.question,'请明确选择是否继续。',opts);
    else if(p.kind==='editor')await ctx.ui.editor(p.question,p.prefill);
    else await ctx.ui.input(p.question,undefined,opts);
    const reply=invocation.getStore()!.reply;
    if(!reply)throw new Error('未收到人工输入回执');
    return {content:[{type:'text',text:JSON.stringify(reply)}],details:{human_input:{...reply,sensitive:p.sensitive===true}}};
   });
  }};
}

/** The web host implements PI's public UI contract; PI still owns the pending tool. */
export function humanInputUI(base:ExtensionUIContext,handler:HumanInputHandler,signal:AbortSignal,waiting:(value:boolean)=>void,accept:()=>void,interrupt:()=>void):ExtensionUIContext{
 let pending=false;
 const request=async(p:HumanPrompt,extra?:AbortSignal)=>{
  accept();signal.throwIfAborted();if(pending)throw new Error('本执行已有待回答问题');
  validateHumanPrompt(p);pending=true;waiting(true);
  const state=invocation.getStore();
  extra??=state?.signal; // ui.editor has no signal option in PI's public API.
  const combined=extra?AbortSignal.any([signal,extra]):signal;
  try{
   const reply=await handler({...p,tool_call_id:state?.toolCallID,sensitive:state?.sensitive??false,timeout_ms:p.timeout_ms??state?.timeout},combined);
   combined.throwIfAborted();accept();if(state)state.reply=reply;
   if(reply.status==='interrupted')throw new Error('人工输入所属执行已中断');
   return reply.status==='answered'?reply.answer:undefined;
  }catch(error){interrupt();throw error;}finally{pending=false;waiting(false);}
 };
 return {...base,
  input:async(question,placeholder,opts)=>await request({question,kind:'input',placeholder,timeout_ms:opts?.timeout},opts?.signal) as string|undefined,
  select:async(question,options,opts)=>await request({question,kind:'select',options,timeout_ms:opts?.timeout},opts?.signal) as string|undefined,
  confirm:async(question,message,opts)=>(await request({question:message?question+'\n'+message:question,kind:'confirm',timeout_ms:opts?.timeout},opts?.signal))===true,
  editor:async(question,prefill)=>await request({question,kind:'editor',prefill}) as string|undefined,
  custom:async()=>{throw new Error('网页人工输入不支持自定义终端组件，请使用 input/select/confirm/editor');},
 };
}

/** Presentation only. Original answers remain in native PI history and model context. */
export function maskedHumanResult(result:unknown):string|undefined{
 const h=(result as {details?:{human_input?:HumanReply&{sensitive?:boolean}}}|null)?.details?.human_input;
 return h?.sensitive?JSON.stringify({id:h.id,status:h.status,...(h.status==='answered'?{answer:'[敏感回答已隐藏]'}:{})}):undefined;
}
