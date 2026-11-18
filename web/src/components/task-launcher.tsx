"use client";

import {useEffect,useState,type FormEvent} from "react";
import {useRouter} from "next/navigation";
import {Button} from "@/components/ui/button";
import {Field,FieldGroup,FieldLabel} from "@/components/ui/field";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import {api} from "@/lib/api";
import type {LLMProfile} from "@/lib/types";

export function TaskLauncher() {
  const router = useRouter();
  const [models,setModels] = useState<LLMProfile[]>([]);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  useEffect(()=>{api.llmProfiles().then(setModels).catch(e=>setError(e.message));},[]);
  async function create(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const model = data.get("model");
    setBusy(true); setError("");
    try {
      const task = await api.createTask({
        name:String(data.get("name")??""),goal:String(data.get("goal")??""),description:String(data.get("description")??""),llmProfileIds:model?[Number(model)]:[],
      });
      router.push("/function/tasks/detail?id="+task.id);
    } catch(e) {setError((e as Error).message);setBusy(false);}
  }
  return <main className="mx-auto flex w-full max-w-2xl flex-col gap-6">
    <h1 className="text-2xl font-semibold">新建目标任务</h1>
    <form onSubmit={create}><FieldGroup>
      <Field><FieldLabel htmlFor="goal">任务目标</FieldLabel><Textarea required maxLength={64000} id="goal" name="goal" autoFocus /></Field>
      <Field><FieldLabel htmlFor="description">原始材料（可选）</FieldLabel><Textarea id="description" name="description" rows={6}/></Field>
      <Field><FieldLabel htmlFor="name">任务名称（可选）</FieldLabel><Input id="name" name="name"/></Field>
      <Field><FieldLabel htmlFor="model">模型</FieldLabel><select className="rounded-md border bg-background p-2" id="model" name="model">
        <option value="">平台默认</option>{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={busy}>{busy?"创建中…":"创建目标会话"}</Button>
    </FieldGroup></form>
  </main>;
}
