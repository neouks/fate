/** Replay native, synthetic request captures for usage measurement, never execute model tool calls. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';import {Database} from '../src/db/index.js';

if(process.env.FATE_PREFIX_LIVE!=='1'||!process.env.FATE_PREFIX_PROFILE_DSN)throw new Error('Explicit opt-in and profile DSN required');
const out=new URL('../../../docs/reviews/evidence/context-prefix-20261019/',import.meta.url);
const ledger=new URL(process.env.FATE_PREFIX_LEDGER||'deepseek-comparison.json',out);
if(existsSync(ledger))throw new Error('Use a fresh ledger; never overwrite real request accounting');
const db=new Database(new pg.Pool({connectionString:process.env.FATE_PREFIX_PROFILE_DSN}));
const profile=await db.platform().profileByID(Number(process.env.FATE_PREFIX_PROFILE_ID));await db.close();
if(!profile?.apiKey||profile.model!=='deepseek-flash'||new URL(profile.baseURL).hostname!=='api.deepseek.com')throw new Error('Approved profile unavailable');
const captures=Object.fromEntries(['before','after'].map(v=>[v,JSON.parse(readFileSync(new URL(`${v}-requests.json`,out),'utf8')).rows]));
const report:any={run_id:randomUUID(),authorization:'2026-10-19 user removed DeepSeek testing cap; bounded 12-request measurement batch',previous_ledger:'../terminal-acceptance-20261018/request-ledger.json',method:'Native pi request captures replayed with full tool schemas and tool_choice=auto; tool calls are never executed, one response per sample; paired dynamic revisions, separate cache arm markers, actual provider usage. Not an end-to-end behavior test.',target_requests:0,request_count:0,rows:[]};
const save=()=>writeFileSync(ledger,JSON.stringify(report,null,2)+'\n');
for(let round=0;round<3;round++)for(const role of ['planner','worker'])for(const variant of (round%2?['after','before']:['before','after'])){
 const payload=structuredClone(captures[variant].find((r:any)=>r.role===role&&r.round===round).payload);
 payload.model=profile.model;payload.stream=false;delete payload.stream_options;delete payload.store;delete payload.max_completion_tokens;
 payload.max_tokens=128;payload.temperature=0;payload.thinking={type:'disabled'};payload.tool_choice='auto';
 payload.messages[0].content=`LOCAL offline comparison ${report.run_id} ${variant==='before'?'A':'B'} ${role}\n`+payload.messages[0].content;
 payload.messages.push({role:'user',content:'这是本地合成输入的成本对照，不是真实任务执行。请只用一句话确认当前资料是否充足；不要访问任何地址或调用工具。'});
 const row:any={role,variant,round,status:'started',started_at:new Date().toISOString(),request_sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),request_bytes:Buffer.byteLength(JSON.stringify(payload))};
 report.rows.push(row);report.request_count++;save();
 try{
  const url=new URL(profile.baseURL);url.pathname=url.pathname.replace(/\/$/,'')+'/chat/completions';
  const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${profile.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(90_000)});
  row.http_status=response.status;
  if(!response.ok)throw new Error(`provider HTTP ${response.status}`);
  const data=await response.json() as any;
  row.status='completed';row.usage=data.usage;row.actual_model=data.model;row.finish_reason=data.choices?.[0]?.finish_reason;
  row.reply=data.choices?.[0]?.message?.content;row.tool_calls=data.choices?.[0]?.message?.tool_calls?.length??0;
 }catch(error){row.status='error';row.error=String(error).replace(/sk-[\w-]+/g,'[redacted]');}
 row.finished_at=new Date().toISOString();save();console.log(JSON.stringify({role,variant,round,status:row.status,usage:row.usage}));
 await new Promise(r=>setTimeout(r,2500));
}
if(report.rows.some((r:any)=>r.status!=='completed'))process.exitCode=1;
