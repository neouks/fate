"use client";
import * as React from "react";
import {toast} from "sonner";
import {http,api} from "@/lib/api";
import type {Finding,FindingReproduction,FindingReproductionDetail,FindingStepImage} from "@/lib/types";
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from "@/components/ui/card";
import {Button} from "@/components/ui/button";
import {Badge} from "@/components/ui/badge";
import {Alert,AlertDescription} from "@/components/ui/alert";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import {Field,FieldGroup,FieldLabel} from "@/components/ui/field";
import {Markdown} from "@/components/markdown";

export function FindingReproductionPanel({finding,contextTask,readOnly,onChanged,workspaceEvidence}:{finding:Finding;contextTask?:string;readOnly:boolean;onChanged:()=>void;workspaceEvidence?:React.ReactNode}){
 const base=`/exploration/findings/${finding.finding_id}`,q=contextTask?`?context_task=${encodeURIComponent(contextTask)}`:"";
 const [data,setData]=React.useState<FindingReproductionDetail>(),[error,setError]=React.useState("");
 const [busy,setBusy]=React.useState(false),[editing,setEditing]=React.useState(false);
 const [draft,setDraft]=React.useState<FindingReproduction>(),[description,setDescription]=React.useState(""),[impact,setImpact]=React.useState(""),[remediation,setRemediation]=React.useState("");
 const load=React.useCallback(async()=>{const value=await http<FindingReproductionDetail>(base+"/reproduction"+q);setData(value);return value;},[base,q]);
 React.useEffect(()=>{let active=true;http<FindingReproductionDetail>(base+"/reproduction"+q).then(v=>{if(active)setData(v);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[base,q,finding.report_evidence_version,finding.evidence_version]);
 const running=data?.job?.status==="running"||data?.job?.status==="queued";
 React.useEffect(()=>{if(!running)return;let active=true;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const v=await http<FindingReproductionDetail>(base+"/reproduction"+q);if(active){setData(v);if(v.job?.status==="running"||v.job?.status==="queued")timer=setTimeout(poll,1500);else onChanged();}}catch(e){if(active)setError((e as Error).message);}};timer=setTimeout(poll,1500);return()=>{active=false;clearTimeout(timer);};},[running,base,q,onChanged]);
 async function act(fn:()=>Promise<unknown>){setBusy(true);try{await fn();await load();setError("");onChanged();}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}
 async function downloadBody(trafficID:string,side:"request"|"response"){
  setBusy(true);try{
   const evidence=await api.findingTraffic(finding.finding_id!,contextTask);
   const binding=evidence.bindings.find(item=>item.snapshot_id===trafficID);
   if(!binding)throw new Error("流量证据未绑定或不可访问");
   await api.downloadFindingTrafficBody(finding.finding_id!,binding.id,side,contextTask);
  }catch(e){toast.error((e as Error).message);}finally{setBusy(false);}
 }
 const [source,setSource]=React.useState<{id:string;content:string;next_offset:number;total:number}>();
 async function readSource(id:string,append=false){await act(async()=>{const value=await http<{content:string;next_offset:number;total:number}>(base+`/steps/${encodeURIComponent(id)}/source${q}${q?"&":"?"}offset=${append?source?.next_offset??0:0}`);setSource({id,...value,content:(append?source?.content??"":"")+value.content});});}
 const repro=data?.reproduction??finding.reproduction;
 const jobStatus=data?.job?.status;
 const sections=data?.report_sections??finding.report_sections;
 const descriptionText=sections?.description||finding.summary||"暂无描述。";
 const discovery=([["vulnerability","漏洞发现思路"],["asset","资产发现思路"]] as const).map(([key,label])=>{
  const value=sections?.discovery?.[key];
  return value?.trim()?<section className="task-finding-section" key={key}><h2>{label}</h2><p>{value}</p></section>:null;
 });
 const openEditor=()=>{setDraft(structuredClone(repro??{entry_point:"",prerequisites:[],steps:[],provenance:""}));setDescription(sections?.description??finding.summary);setImpact(sections?.impact.join("\n")??"");setRemediation(sections?.remediation.join("\n")??"");setEditing(true);};
 const actions=!readOnly&&<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy||running} onClick={()=>void act(()=>http(base+"/analyze"+q,{method:"POST"}))}>{finding.report?.trim() || sections ? "重新生成报告" : "生成完整报告"}</Button><Button variant="outline" disabled={busy||running||!data} onClick={openEditor}>编辑过程与说明</Button></div>;
 const sectionList=(values: string[]) => <ul className="list-inside list-disc">{values.map((value,i)=><li key={i}>{value}</li>)}</ul>;
 const contents=<>

 {error&&<Alert><AlertDescription>{error}<Button variant="ghost" onClick={()=>void act(load)}>重试</Button></AlertDescription></Alert>}
 {data?.job&&<Alert><AlertDescription>{({queued:"排队等待 Reporter",running:"Reporter 正在读取证据、整理报告并保存",completed:"本次整理已结束",failed:"报告整理失败，原报告仍保留",stopped:"报告整理已停止"} as Record<string,string>)[jobStatus??""]??"正在准备报告"}{data.job.error&&`：${data.job.error}`}</AlertDescription></Alert>}
 {editing&&draft&&<FieldGroup><Field><FieldLabel>漏洞说明</FieldLabel><Textarea value={description} onChange={e=>setDescription(e.target.value)}/></Field><Field><FieldLabel>入口</FieldLabel><Input value={draft.entry_point} onChange={e=>setDraft({...draft,entry_point:e.target.value})}/></Field><Field><FieldLabel>前置条件（每行一项）</FieldLabel><Textarea value={draft.prerequisites.join("\n")} onChange={e=>setDraft({...draft,prerequisites:e.target.value.split("\n")})}/></Field>
 {draft.steps.map((step,i)=><FieldGroup key={step.id}><Badge variant="secondary">步骤 {i+1}</Badge>{([['action','做了什么'],['expected','实际结果说明'],['proves','证明什么'],['traffic_id','关联真实流量 ID']] as const).map(([key,label])=><Field key={key}><FieldLabel>{label}</FieldLabel><Textarea value={step[key]??""} onChange={e=>setDraft({...draft,steps:draft.steps.map(s=>s.id===step.id?{...s,[key]:e.target.value}:s)})}/></Field>)}<div className="flex gap-2"><Button variant="outline" disabled={i===0} onClick={()=>{const steps=[...draft.steps];[steps[i-1],steps[i]]=[steps[i]!,steps[i-1]!];setDraft({...draft,steps});}}>上移步骤</Button><Button variant="outline" onClick={()=>setDraft({...draft,steps:draft.steps.filter(s=>s.id!==step.id)})}>删除步骤</Button></div></FieldGroup>)}
 <Field><FieldLabel>具体影响（每行一项）</FieldLabel><Textarea value={impact} onChange={e=>setImpact(e.target.value)}/></Field><Field><FieldLabel>修复建议（每行一项）</FieldLabel><Textarea value={remediation} onChange={e=>setRemediation(e.target.value)}/></Field><div className="flex gap-2"><Button disabled={busy} onClick={()=>void act(async()=>{await http(base+"/reproduction"+q,{method:"PATCH",body:JSON.stringify({report_revision:data!.report_revision,evidence_version:data!.evidence_version,reproduction:draft,report_sections:{description,impact:impact.split("\n").filter(Boolean),remediation:remediation.split("\n").filter(Boolean)}})});setEditing(false);})}>保存</Button><Button variant="ghost" onClick={()=>setEditing(false)}>取消</Button></div></FieldGroup>}
 {!workspaceEvidence&&<><Markdown text={descriptionText}/>{discovery}</>}
 {repro?<><p>入口：{repro.entry_point||"未记录"}</p>{repro.prerequisites.length>0&&<ul className="list-inside list-disc">{repro.prerequisites.map((p,i)=><li key={i}>{p}</li>)}</ul>}
 {repro.steps.map((step,i)=><React.Fragment key={step.id}><p>{i+1}. {step.action||"验证"}</p>{step.expected&&<p>{step.expected}</p>}{step.proves&&<p>{step.proves}</p>}
 {!step.packet_note?.startsWith('原始证据未包含完整 HTTP 请求与响应')&&(step.packet_note||step.truncated)&&<Alert><AlertDescription>{step.packet_note||"当前为证据片段，完整内容请查看证据来源。"}</AlertDescription></Alert>}
 <Packet label="请求 / 命令" value={step.request}/><Packet label="响应 / 输出" value={step.response}/>
 {step.traffic_id&&<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={()=>void downloadBody(step.traffic_id!,"request")}>下载请求 Body</Button><Button variant="outline" disabled={busy} onClick={()=>void downloadBody(step.traffic_id!,"response")}>下载响应 Body</Button></div>}
 {(step.source||step.source_ref)&&<Button variant="outline" onClick={()=>void readSource(step.id)}>查看完整证据来源</Button>}
 {source?.id===step.id&&<div><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{source.content}</pre>{source.next_offset<source.total&&<Button variant="outline" onClick={()=>void readSource(step.id,true)}>继续读取</Button>}</div>}
 <Images images={data?.images.filter(im=>im.step_id===step.id)??[]} base={base} q={q} disabled={busy||readOnly} mutate={fn=>act(fn)}/>
 </React.Fragment>)}{!sections?.discovery&&repro.provenance&&<p>发现来源：{repro.provenance}</p>}</>:<Alert><AlertDescription>尚未整理复现过程。{readOnly ? "可查看已保存的证据。" : "可按需调用 Reporter 整理已保存的证据。"}</AlertDescription></Alert>}
 <Images images={data?.images.filter(im=>!im.step_id||!repro?.steps.some(s=>s.id===im.step_id))??[]} base={base} q={q} disabled={busy||readOnly} mutate={fn=>act(fn)}/>
 {!workspaceEvidence&&sections?.impact.length ? <><h3>具体影响</h3>{sectionList(sections.impact)}</> : null}
 {!workspaceEvidence&&sections?.remediation.length ? <><h3>修复建议</h3>{sectionList(sections.remediation)}</> : null}
 {data?.versions.length? <details><summary>历史报告版本</summary>{data.versions.map(v=><Button key={v.revision} variant="link" onClick={()=>void act(async()=>{const value=await http<{report:string}>(base+`/report-versions/${v.revision}`+q);await navigator.clipboard.writeText(value.report);toast.success("历史版本已复制");})}>版本 {v.revision} · 证据 {v.evidence_version} · 复制原文</Button>)}</details>:null}
 </>;
 if (workspaceEvidence) return <>
   <section className="task-finding-section"><h2>漏洞描述</h2><Markdown text={descriptionText}/></section>
   {discovery}
   {Boolean(sections?.impact.length)&&<section className="task-finding-section"><h2>影响</h2>{sectionList(sections!.impact)}</section>}
   <section className="task-finding-section"><h2>复现步骤</h2>{actions}<div className="flex min-w-0 flex-col gap-4">{contents}</div></section>
   {workspaceEvidence}
   {Boolean(sections?.remediation.length)&&<section className="task-finding-section"><h2>修复建议</h2>{sectionList(sections!.remediation)}</section>}
 </>;
 return <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>漏洞报告</CardTitle>{actions}</div><CardDescription>按操作顺序说明复现过程，HTTP 报文保留请求行、状态行、Header 和 Body。</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-4">{contents}</CardContent></Card>;
}
function Packet({label,value}:{label:string;value:string}){return <><p>{label}{!value&&"（原始证据缺失）"}</p>{value&&<pre className="min-w-0 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{value}</pre>}</>;}
function Images({images,base,q,disabled,mutate}:{images:FindingStepImage[];base:string;q:string;disabled:boolean;mutate:(fn:()=>Promise<unknown>)=>Promise<void>}){
 if (!images.length) return null;
 return <div className="flex flex-col gap-2">
 {images.map(image=><figure className="flex flex-col gap-2" key={image.id}><EvidenceImage src={`/api${base}/images/${image.id}${q}`} caption={image.caption}/><Input aria-label="证据图注" disabled={disabled} defaultValue={image.caption} onBlur={e=>{if(e.target.value!==image.caption)void mutate(()=>http(base+`/images/${image.id}`+q,{method:"PATCH",body:JSON.stringify({caption:e.target.value})}));}}/>{!disabled&&<div className="flex gap-2"><Button variant="ghost" onClick={()=>void mutate(()=>http(base+`/images/${image.id}`+q,{method:"DELETE"}))}>删除截图</Button><Button variant="ghost" onClick={()=>void mutate(()=>http(base+`/images/${image.id}`+q,{method:"PATCH",body:JSON.stringify({position:Math.max(0,image.position-1)})}))}>前移截图</Button></div>}</figure>)}
 </div>;
}
function EvidenceImage({src,caption}:{src:string;caption:string}){
 const [url,setURL]=React.useState("");React.useEffect(()=>{const controller=new AbortController();let object="";fetch(src,{headers:{"X-Series-Token":localStorage.getItem("series_token")??""},signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error("图片不可用");return r.blob();}).then(blob=>{if(controller.signal.aborted)return;object=URL.createObjectURL(blob);setURL(object);}).catch(()=>{});return()=>{controller.abort();if(object)URL.revokeObjectURL(object);};},[src]);
 return url?<img className="max-h-96 max-w-full self-start object-contain" src={url} alt={caption||"漏洞证据截图"}/>:<p>截图加载中或不可用</p>;
}
