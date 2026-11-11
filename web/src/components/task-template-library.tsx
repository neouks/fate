"use client";

import * as React from "react";
import { CopyIcon, LibraryIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { TaskTemplate } from "@/lib/types";

type Draft = Pick<TaskTemplate, "name" | "description" | "goal"> & { id?: number };
const emptyDraft: Draft = { name: "", description: "", goal: "" };
const textFields = [["description", "任务说明"], ["goal", "验收目标"]] as const;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const searchText = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
const latestFirst = (a: TaskTemplate, b: TaskTemplate) =>
  Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id;

export function TaskTemplateLibrary() {
  const [open, setOpen] = React.useState(false);
  const [templates, setTemplates] = React.useState<TaskTemplate[]>([]);
  const [selectedID, setSelectedID] = React.useState<number>();
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [deleting, setDeleting] = React.useState<TaskTemplate | null>(null);
  const [working, setWorking] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const [loadError, setLoadError] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const fieldID = React.useId();
  const selected = templates.find((template) => template.id === selectedID);
  const visibleTemplates = templates.filter((template) => searchText(template.name).includes(searchText(query)));

  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void api.taskTemplates(controller.signal).then((rows) => {
      if (controller.signal.aborted) return;
      const sorted = [...rows].sort(latestFirst);
      setTemplates(sorted);
      setSelectedID((id) => sorted.some((row) => row.id === id) ? id : sorted[0]?.id);
    }).catch((error) => {
      if (!controller.signal.aborted) setLoadError(message(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [open, reload]);

  function changeOpen(next: boolean) {
    if (working) return;
    setOpen(next);
    if (!next) {
      setDraft(null);
      setQuery("");
      setActionError("");
    }
  }

  function edit(next: Draft) {
    setDraft(next);
    setActionError("");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || working) return;
    const { id, ...input } = draft;
    setWorking(true);
    setActionError("");
    try {
      const row = id === undefined ? await api.createTaskTemplate(input) : await api.updateTaskTemplate(id, input);
      setTemplates((current) => [row, ...current.filter((entry) => entry.id !== row.id)].sort(latestFirst));
      setSelectedID(row.id);
      setQuery("");
      setDraft(null);
      toast.success("模板已保存");
    } catch (error) {
      setActionError(message(error));
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    if (!deleting || working) return;
    setWorking(true);
    setActionError("");
    try {
      await api.deleteTaskTemplate(deleting.id);
      const remaining = templates.filter((row) => row.id !== deleting.id);
      setTemplates(remaining);
      setSelectedID(remaining.find((row) => searchText(row.name).includes(searchText(query)))?.id);
      setDeleting(null);
      toast.success("模板已删除");
    } catch (error) {
      setActionError(message(error));
    } finally {
      setWorking(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label}已复制`);
    } catch {
      toast.error("复制失败，请选中文本后手动复制");
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm"><LibraryIcon data-icon="inline-start" />任务模板</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader className="pr-8">
          <DialogTitle>任务模板</DialogTitle>
          <DialogDescription>管理和复制常用的任务说明与验收目标。</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input aria-label="搜索模板名称" placeholder="按名称搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
              <Button type="button" variant="outline" size="icon" aria-label="新建模板" title="新建模板"
                disabled={!!draft || working || loading} onClick={() => edit(emptyDraft)}><PlusIcon /></Button>
            </div>
            {loading && <p role="status" className="text-muted-foreground">正在加载模板…</p>}
            {loadError && <Alert variant="destructive"><AlertDescription>
              {loadError}
              <Button type="button" variant="link" onClick={() => setReload((current) => current + 1)}>重试</Button>
            </AlertDescription></Alert>}
            {!loading && !loadError && !visibleTemplates.length &&
              <p className="text-muted-foreground">{query.trim() ? "没有匹配的模板" : "暂无模板"}</p>}
            <ul aria-label="模板列表" className="flex max-h-36 flex-col gap-1 overflow-auto sm:max-h-[56dvh]">
              {visibleTemplates.map((template) => <li key={template.id}>
                <Button type="button" variant={selectedID === template.id ? "secondary" : "ghost"}
                  className="w-full justify-start" title={template.name} aria-pressed={selectedID === template.id}
                  disabled={!!draft || working} onClick={() => setSelectedID(template.id)}>
                  <span className="truncate">{template.name}</span>
                </Button>
              </li>)}
            </ul>
          </div>
          <div className="min-w-0">
            {draft ? (
              <form className="flex flex-col gap-4" onSubmit={save} aria-label={draft.id ? "编辑模板" : "新建模板"}>
                <h3 className="font-medium">{draft.id ? "编辑模板" : "新建模板"}</h3>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={`${fieldID}-name`}>模板名称</FieldLabel>
                    <Input id={`${fieldID}-name`} value={draft.name} required disabled={working}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </Field>
                  {textFields.map(([key, label]) => <Field key={key}>
                    <FieldLabel htmlFor={`${fieldID}-${key}`}>{label}</FieldLabel>
                    <Textarea id={`${fieldID}-${key}`} value={draft[key]} required disabled={working}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
                  </Field>)}
                </FieldGroup>
                {actionError && <Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" disabled={working} onClick={() => setDraft(null)}>取消</Button>
                  <Button type="submit" disabled={working}>{working ? "正在保存…" : "保存模板"}</Button>
                </div>
              </form>
            ) : selected ? (
              <div className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 break-all font-medium">{selected.name}</h3>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={working || loading}
                      onClick={() => edit({ id: selected.id, name: selected.name, description: selected.description, goal: selected.goal })}>编辑</Button>
                    <Button type="button" variant="outline" size="sm" disabled={working || loading}
                      onClick={() => { setActionError(""); setDeleting(selected); }}>删除</Button>
                  </div>
                </div>
                {textFields.map(([key, label]) => <section key={key} aria-label={label} className="flex min-w-0 flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-medium">{label}</h4>
                    <Button type="button" variant="ghost" size="sm" aria-label={`复制${label}`}
                      onClick={() => void copy(selected[key], label)}><CopyIcon data-icon="inline-start" />复制</Button>
                  </div>
                  <p tabIndex={0} className="max-h-40 overflow-auto break-words whitespace-pre-wrap rounded-lg border p-3">{selected[key]}</p>
                </section>)}
              </div>
            ) : null}
          </div>
        </div>
        <AlertDialog open={!!deleting} onOpenChange={(next) => { if (!next && !working) setDeleting(null); }}>
          <AlertDialogContent className="max-w-[calc(100%-2rem)]">
            <AlertDialogHeader>
              <AlertDialogTitle>删除模板？</AlertDialogTitle>
              <AlertDialogDescription className="break-all">确定删除「{deleting?.name}」？</AlertDialogDescription>
            </AlertDialogHeader>
            {actionError && <Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={working}>取消</AlertDialogCancel>
              <Button type="button" variant="destructive" disabled={working} onClick={() => void remove()}>
                {working ? "正在删除…" : "确认删除"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
