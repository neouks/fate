"use client";

import * as React from "react";
import { LibraryIcon, PlusIcon, SaveIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { TaskTemplate } from "@/lib/types";

type Draft = Pick<TaskTemplate, "name" | "description" | "goal"> & { id?: number };
const emptyDraft: Draft = { name: "", description: "", goal: "" };
function toDraft({ id, name, description, goal }: TaskTemplate): Draft {
  return { id, name, description, goal };
}
const textFields = [["description", "任务说明"], ["goal", "验收目标"]] as const;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const searchText = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
const latestFirst = (a: TaskTemplate, b: TaskTemplate) =>
  Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id;

const templateRowClass = "h-auto min-h-16 w-full justify-start gap-3 rounded-none px-4 py-3 text-left sm:px-5 focus-visible:ring-inset";

export function TaskTemplateLibrary({ draftDescription, draftGoal, onApply, disabled = false }: {
  draftDescription: string;
  draftGoal: string;
  onApply: (value: Pick<TaskTemplate, "description" | "goal">) => void;
  disabled?: boolean;
}) {
  const [mode, setMode] = React.useState<"manage" | null>(null);
  const [templates, setTemplates] = React.useState<TaskTemplate[]>([]);
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [deleting, setDeleting] = React.useState<TaskTemplate | null>(null);
  const [working, setWorking] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [reload, setReload] = React.useState(0);
  const [loadError, setLoadError] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const fieldID = React.useId();
  const opener = React.useRef<HTMLButtonElement>(null);
  const manageButton = React.useRef<HTMLButtonElement>(null);
  const newTemplateButton = React.useRef<HTMLButtonElement>(null);
  const deleteButton = React.useRef<HTMLButtonElement>(null);

  const visibleTemplates = templates.filter((template) => searchText(template.name).includes(searchText(query)));

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void api.taskTemplates(controller.signal).then((rows) => {
      if (controller.signal.aborted) return;
      setTemplates([...rows].sort(latestFirst));
    }).catch((error) => {
      if (!controller.signal.aborted) setLoadError(message(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [reload]);

  function changeOpen(next: boolean) {
    if (working || next) return;
    setMode(null);
    setDraft(null);
    setQuery("");
    setActionError("");
  }

  function edit(next: Draft) {
    setDraft(next);
    setActionError("");
  }

  function openManager(button: HTMLButtonElement, seed?: Draft) {
    opener.current = button;
    edit(seed ?? (templates[0] ? toDraft(templates[0]) : emptyDraft));
    setMode("manage");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || working || loading) return;
    const { id, ...input } = draft;
    setWorking(true);
    setActionError("");
    try {
      const row = id === undefined ? await api.createTaskTemplate(input) : await api.updateTaskTemplate(id, input);
      setTemplates((current) => [row, ...current.filter((entry) => entry.id !== row.id)].sort(latestFirst));
      setQuery("");
      setDraft(toDraft(row));
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
      const next = remaining.find((row) => searchText(row.name).includes(searchText(query)));
      setDraft(next ? toDraft(next) : emptyDraft);
      setDeleting(null);
      toast.success("模板已删除");
    } catch (error) {
      setActionError(message(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open={mode !== null} onOpenChange={changeOpen}>
      <section aria-labelledby={`${fieldID}-heading`} className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h2 id={`${fieldID}-heading`} className="text-base font-semibold">任务模板</h2>
          <div className="flex flex-wrap items-center gap-1 sm:gap-2">
            <Button ref={manageButton} type="button" variant="ghost" size="sm" aria-haspopup="dialog"
              disabled={loading || disabled} onClick={(event) => openManager(event.currentTarget)}>
              <SlidersHorizontalIcon data-icon="inline-start" />管理模板
            </Button>
            <Button type="button" variant="ghost" size="sm" aria-haspopup="dialog"
              disabled={loading || disabled || !draftDescription.trim() || !draftGoal.trim()}
              onClick={(event) => openManager(event.currentTarget, { name: "", description: draftDescription, goal: draftGoal })}>
              <SaveIcon data-icon="inline-start" />另存为模板
            </Button>
          </div>
        </div>
        {loadError && <Alert variant="destructive"><AlertDescription>
          {loadError}
          <Button type="button" variant="link" onClick={() => setReload((current) => current + 1)}>重试</Button>
        </AlertDescription></Alert>}
        {loading ? (
          <div role="status" aria-label="正在加载模板" className="flex flex-col gap-4 rounded-2xl border p-5">
            <Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-3/4" />
          </div>
        ) : templates.length > 0 ? (
          <ul aria-label="任务模板列表" className="divide-y overflow-hidden rounded-2xl border bg-card">
            {templates.map((template) => <li key={template.id}>
              <Button type="button" variant="ghost" aria-label={`使用模板：${template.name}`}
                disabled={disabled} className={templateRowClass}
                onClick={() => {
                  onApply({ description: template.description, goal: template.goal });
                }}>
                <LibraryIcon data-icon="inline-start" />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-base font-medium" title={template.name}>{template.name}</span>
                  <span className="truncate text-sm font-normal text-muted-foreground">{template.description.replace(/\s+/gu, " ")}</span>
                </span>
              </Button>
            </li>)}
          </ul>
        ) : !loadError && (
          <Empty className="border border-solid bg-card">
            <EmptyHeader><EmptyTitle>暂无任务模板</EmptyTitle>
              <EmptyDescription>在管理模板中创建，或将当前草稿另存为模板。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <p className="text-sm text-muted-foreground">点击模板直接填入任务说明和目标；草稿可独立编辑，不与模板保持关联。</p>
      </section>
      <DialogContent className="h-[min(44rem,calc(100dvh-2rem))] max-h-none grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const button = opener.current;
          (button?.isConnected && !button.disabled ? button : manageButton.current)?.focus();
        }}>
        {mode === "manage" && draft ? (
          <form className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]" onSubmit={save}
            aria-label={draft.id === undefined ? "新建模板" : "编辑模板"}>
            <DialogHeader className="border-b px-4 py-4 pr-10 text-left sm:px-6 sm:pr-10">
              <DialogTitle>任务模板管理</DialogTitle>
              <DialogDescription>新建模板，或选择已有模板编辑任务说明和验收目标。</DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 flex-col overflow-y-auto sm:grid sm:grid-cols-[14rem_minmax(0,1fr)] sm:grid-rows-1 sm:overflow-hidden">
              <div className="flex min-h-0 min-w-0 shrink-0 flex-col gap-2 border-b p-3 sm:border-r sm:border-b-0">
                <Button ref={newTemplateButton} type="button" variant="outline" className="w-full"
                  disabled={working || loading} onClick={() => edit(emptyDraft)}>
                  <PlusIcon data-icon="inline-start" />新建模板
                </Button>
                <Input type="search" aria-label="搜索模板名称" placeholder="按名称搜索" value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                  }} />
                {loading && <p role="status" className="px-2 py-3 text-sm text-muted-foreground">正在加载模板…</p>}
                {loadError && <Alert variant="destructive"><AlertDescription>
                  {loadError}
                  <Button type="button" variant="link" disabled={working} onClick={() => setReload((current) => current + 1)}>重试</Button>
                </AlertDescription></Alert>}
                {!loading && !loadError && !visibleTemplates.length &&
                  <p className="px-2 py-3 text-sm text-muted-foreground">{query.trim() ? "没有匹配的模板" : "暂无模板"}</p>}
                <ul aria-label="模板列表" className="flex max-h-32 min-h-0 flex-col gap-1 overflow-y-auto sm:max-h-none">
                  {visibleTemplates.map((template) => <li key={template.id}>
                    <Button type="button" variant={draft.id === template.id ? "secondary" : "ghost"}
                      className="h-auto w-full justify-start px-2.5 py-2 text-left"
                      title={template.name} aria-label={template.name} aria-pressed={draft.id === template.id}
                      disabled={working} onClick={() => edit(toDraft(template))}>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate">{template.name}</span>
                        <span className="truncate text-xs font-normal text-muted-foreground">{template.description}</span>
                      </span>
                    </Button>
                  </li>)}
                </ul>
              </div>
              <div className="min-w-0 shrink-0 p-4 sm:min-h-0 sm:overflow-y-auto sm:p-6">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={`${fieldID}-name`}>模板名称</FieldLabel>
                    <Input id={`${fieldID}-name`} value={draft.name} required maxLength={120} disabled={working} autoFocus={draft.id === undefined}
                      placeholder="输入模板名称" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                  </Field>
                  {textFields.map(([key, label]) => <Field key={key}>
                    <FieldLabel htmlFor={`${fieldID}-${key}`}>{label}</FieldLabel>
                    <Textarea id={`${fieldID}-${key}`} value={draft[key]} required maxLength={16000} disabled={working}
                      className="min-h-28" placeholder={key === "description" ? "描述对象与背景" : "说明期望达成的结果"}
                      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
                  </Field>)}
                </FieldGroup>
                {actionError && !deleting && <Alert variant="destructive" className="mt-4"><AlertDescription>{actionError}</AlertDescription></Alert>}
              </div>
            </div>
            <DialogFooter className="m-0 flex-row flex-wrap items-center rounded-none bg-popover px-4 py-3 sm:px-6">
              {draft.id !== undefined && <Button ref={deleteButton} type="button" variant="destructive" className="mr-auto"
                disabled={working || loading} onClick={() => {
                  const record = templates.find((row) => row.id === draft.id);
                  if (record) {
                    setActionError("");
                    setDeleting(record);
                  }
                }}>
                <Trash2Icon data-icon="inline-start" />删除模板
              </Button>}
              <div className="ml-auto flex gap-2">
                <Button type="button" variant="outline" disabled={working} onClick={() => changeOpen(false)}>关闭</Button>
                <Button type="submit" disabled={working || loading}>
                  {working ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
                  {working ? "正在保存…" : draft.id === undefined ? "保存模板" : "保存修改"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        ) : null}
        <AlertDialog open={!!deleting} onOpenChange={(next) => { if (!next && !working) setDeleting(null); }}>
          <AlertDialogContent className="max-w-[calc(100%-2rem)]" onCloseAutoFocus={(event) => {
            event.preventDefault();
            (deleteButton.current ?? newTemplateButton.current)?.focus();
          }}>
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
