"use client";

import * as React from "react";
import { Download, Eye, FileText, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { FileContentPage, TaskFileCategory, TaskFileCleanupPreview, TaskFileCleanupResult, TaskFileEntry } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WorkspaceEmpty, WorkspaceError } from "@/components/workspace";

const categories = { all: "全部", work: "工作文件", temporary: "临时文件", attachment: "上传附件" };
const source = (file: TaskFileEntry) => file.origin === "attachment" ? "上传附件" : file.intent_id ? `意图 #${file.intent_id}` : "任务工作区";
function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function DownloadFile({ taskId, file, compact = false }: { taskId: string; file: TaskFileEntry; compact?: boolean }) {
  return <Button variant={compact ? "ghost" : "outline"} size={compact ? "icon-sm" : "sm"} asChild>
    <a href={api.taskFileDownloadURL(taskId, file.ref)} download={file.name} title="下载原文件" aria-label={`下载 ${file.name}`}>
      <Download data-icon="inline-start"/>{!compact && "下载原文件"}
    </a>
  </Button>;
}

function FilePreview({ taskId, file, close }: { taskId: string; file: TaskFileEntry; close: () => void }) {
  const [content, setContent] = React.useState<FileContentPage | null>(null);
  const [error, setError] = React.useState("");
  const [image, setImage] = React.useState("");
  const [reading, setReading] = React.useState(false);
  const request = React.useRef<AbortController>(null);
  const url = React.useRef("");
  const read = React.useCallback(async (offset = 0, version = "") => {
    request.current?.abort();
    if (url.current) { URL.revokeObjectURL(url.current); url.current = ""; }
    const controller = new AbortController();
    request.current = controller;
    setReading(true);
    setError("");
    setImage("");
    if (!offset) setContent(null);
    try {
      const page = await api.taskFileContent(taskId, file.ref, offset, version, controller.signal);
      if (controller.signal.aborted) return;
      setContent(old => ({ ...page, content: offset && page.preview !== "binary" ? (old?.content ?? "") + page.content : page.content }));
      if (page.preview === "image") {
        const blob = await api.taskFileImage(taskId, file.ref, page.version, controller.signal);
        if (!controller.signal.aborted) { url.current = URL.createObjectURL(blob); setImage(url.current); }
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setReading(false);
    }
  }, [file.ref, taskId]);
  React.useEffect(() => {
    void read(0, file.version);
    return () => { request.current?.abort(); if (url.current) URL.revokeObjectURL(url.current); url.current = ""; };
  }, [file.version, read]);
  return <Sheet open onOpenChange={open => { if (!open) close(); }}>
    <SheetContent className="w-full sm:max-w-3xl">
      <SheetHeader>
        <SheetTitle className="break-all">{file.name}</SheetTitle>
        <SheetDescription className="break-all">{file.relative_path} · {source(file)} · {size(file.size)}</SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-y-auto px-4 pb-4">
        <DownloadFile taskId={taskId} file={file}/>
        {error && <WorkspaceError error={error} onRetry={() => void read()}/>}
        {reading && !image && !content && <p role="status" className="text-sm text-muted-foreground">正在读取…</p>}
        {image && <img src={image} alt={file.name} className="max-h-[65dvh] max-w-full self-center object-contain"/>}
        {content?.preview === "too_large" && <p className="text-sm text-muted-foreground">文件超出在线预览限制，请下载查看。</p>}
        {content?.preview !== "image" && content?.preview !== "too_large" && content?.binary && <p className="text-sm text-muted-foreground">二进制文件，请下载查看。</p>}
        {content && !content.binary && <pre tabIndex={0} aria-label="文件内容" className="min-h-28 max-h-[65dvh] w-full shrink-0 overflow-auto rounded-xl border bg-muted/40 p-3 text-xs leading-relaxed">{content.content || "空文件"}</pre>}
        {content?.has_more && !error && <Button variant="outline" disabled={reading} onClick={() => void read(content.next_offset, content.version)}>继续读取（{content.next_offset} / {content.total} 字节）</Button>}
      </div>
    </SheetContent>
  </Sheet>;
}

export function FilesTab({ taskId }: { taskId: string }) {
  const [items, setItems] = React.useState<TaskFileEntry[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [category, setCategory] = React.useState<"all" | TaskFileCategory>("all");
  const [query, setQuery] = React.useState("");
  const [intent, setIntent] = React.useState("");
  const [filters, setFilters] = React.useState({ q: "", intent: "" });
  const [selected, setSelected] = React.useState<TaskFileEntry | null>(null);
  const [deleteFile, setDeleteFile] = React.useState<TaskFileEntry | null>(null);
  const [cleanupOpen, setCleanupOpen] = React.useState(false);
  const [cleanup, setCleanup] = React.useState<TaskFileCleanupPreview | null>(null);
  const [result, setResult] = React.useState<TaskFileCleanupResult | null>(null);
  const [operationError, setOperationError] = React.useState("");
  const [working, setWorking] = React.useState(false);
  const request = React.useRef<AbortController>(null);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setFilters({ q: query.trim(), intent: intent.trim() }), 250);
    return () => window.clearTimeout(timer);
  }, [query, intent]);
  const load = React.useCallback(async (after = "") => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const page = await api.taskFiles(taskId, { category, ...filters, intent: category === "attachment" ? "" : filters.intent, cursor: after }, controller.signal);
      if (controller.signal.aborted) return;
      setItems(old => after ? [...new Map([...old, ...page.items].map(file => [file.ref, file])).values()] : page.items);
      setCursor(page.next_cursor);
      setBusy(page.busy);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [taskId, category, filters]);
  React.useEffect(() => {
    setItems([]);
    setCursor(null);
    void load();
    return () => request.current?.abort();
  }, [load]);

  async function remove() {
    if (!deleteFile || working) return;
    setWorking(true);
    setOperationError("");
    try {
      await api.deleteTaskFile(taskId, deleteFile.ref, deleteFile.version);
      setDeleteFile(null);
      if (selected?.ref === deleteFile.ref) setSelected(null);
      toast.success("文件已删除");
      await load();
    } catch (e) {
      setOperationError((e as Error).message);
      await load();
    } finally { setWorking(false); }
  }

  async function previewCleanup() {
    setCleanupOpen(true);
    setCleanup(null);
    setResult(null);
    setOperationError("");
    setWorking(true);
    try { setCleanup(await api.previewTaskFileCleanup(taskId)); }
    catch (e) { setOperationError((e as Error).message); }
    finally { setWorking(false); }
  }

  async function clean() {
    if (!cleanup?.snapshot || working) return;
    setWorking(true);
    setOperationError("");
    try {
      let batch: TaskFileCleanupResult;
      do {
        batch = await api.runTaskFileCleanup(taskId, cleanup.snapshot);
        setResult(batch);
      } while (batch.remaining && !batch.busy);
    } catch (e) { setOperationError((e as Error).message); }
    finally { setWorking(false); await load(); }
  }

  return <section aria-label="任务文件" className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2">
      <InputGroup className="min-w-36 flex-1 basis-52">
        <InputGroupAddon><Search/></InputGroupAddon>
        <InputGroupInput placeholder="搜索文件名或路径" aria-label="搜索文件" value={query} onChange={e => setQuery(e.target.value)} maxLength={240}/>
      </InputGroup>
      <Select value={category} onValueChange={value => { setCategory(value as typeof category); if (value === "attachment") setIntent(""); }}>
        <SelectTrigger aria-label="文件类别"><SelectValue/></SelectTrigger>
        <SelectContent><SelectGroup>{Object.entries(categories).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>
      <Input className="w-27" placeholder="意图编号" aria-label="按意图筛选" inputMode="numeric" maxLength={19}
        value={intent} disabled={category === "attachment"} onChange={e => setIntent(e.target.value.replace(/\D/g, ""))}/>
      <Button variant="outline" size="icon-sm" aria-label="刷新文件" title="刷新文件" disabled={loading} onClick={() => void load()}><RefreshCw/></Button>
      <Button variant="outline" size="sm" disabled={working} onClick={() => void previewCleanup()}><Trash2 data-icon="inline-start"/>一键清理临时文件</Button>
    </div>
    {busy && <Alert><AlertDescription>执行器正在使用任务工作区。文件仍可查看和下载，删除请在执行器空闲时重试。</AlertDescription></Alert>}
    {error && <WorkspaceError error={error} onRetry={() => void load()}/>}
    <div className="min-w-0 overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader><TableRow>
          <TableHead className="w-full">名称</TableHead><TableHead className="hidden sm:table-cell">来源</TableHead>
          <TableHead className="hidden md:table-cell">大小</TableHead><TableHead className="hidden lg:table-cell">修改时间</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow></TableHeader>
        <TableBody>{items.map(file => <TableRow key={file.ref}>
          <TableCell className="max-w-0 whitespace-normal">
            <Button variant="ghost" className="h-auto max-w-full justify-start px-1 text-left" onClick={() => setSelected(file)}>
              <FileText data-icon="inline-start"/><span className="break-all">{file.name}</span>
            </Button>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 ps-1 text-xs break-all text-muted-foreground">
              {file.relative_path !== file.name && <span>{file.relative_path}</span>}
              <span className="sm:hidden">{source(file)}</span>
              {file.category === "temporary" && <Badge variant="secondary">临时</Badge>}
            </div>
          </TableCell>
          <TableCell className="hidden whitespace-nowrap sm:table-cell">
            {file.intent_id ? <Button variant="link" className="h-auto p-0" onClick={() => setIntent(file.intent_id!)}>{source(file)}</Button> : source(file)}
          </TableCell>
          <TableCell className="hidden whitespace-nowrap md:table-cell">{size(file.size)}</TableCell>
          <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">{new Date(file.modified_at).toLocaleString()}</TableCell>
          <TableCell>
            <div className="flex justify-end gap-0.5">
              <Button variant="ghost" size="icon-sm" aria-label={`预览 ${file.name}`} title="在线预览" onClick={() => setSelected(file)}><Eye/></Button>
              <DownloadFile taskId={taskId} file={file} compact/>
              {file.origin === "work" && <Button variant="ghost" size="icon-sm" aria-label={`删除 ${file.name}`}
                title={file.delete_reason ?? "删除文件"} disabled={!file.deletable || working}
                onClick={() => { setDeleteFile(file); setOperationError(""); }}><Trash2/></Button>}
            </div>
          </TableCell>
        </TableRow>)}</TableBody>
      </Table>
      {!items.length && !error && <WorkspaceEmpty title={loading ? "正在读取文件…" : "暂无匹配文件"}
        description={query || intent || category !== "all" ? "可以调整搜索词或筛选条件。" : "上传附件或执行器生成工作文件后会显示在这里。"}/>}
    </div>
    {cursor && <Button className="self-start" variant="outline" disabled={loading} onClick={() => void load(cursor)}>加载更多</Button>}
    {selected && <FilePreview key={selected.ref} taskId={taskId} file={selected} close={() => setSelected(null)}/>}

    <AlertDialog open={!!deleteFile} onOpenChange={open => { if (!open && !working) setDeleteFile(null); }}>
      <AlertDialogContent className="max-w-[calc(100%-2rem)]">
        <AlertDialogHeader><AlertDialogTitle>删除工作文件？</AlertDialogTitle>
          <AlertDialogDescription className="break-all">{deleteFile?.relative_path} · {size(deleteFile?.size ?? 0)}。文件将从磁盘删除。</AlertDialogDescription>
        </AlertDialogHeader>
        {operationError && <Alert variant="destructive"><AlertDescription>{operationError}</AlertDescription></Alert>}
        <AlertDialogFooter><AlertDialogCancel disabled={working}>取消</AlertDialogCancel><Button variant="destructive" disabled={working} onClick={() => void remove()}>{working ? "正在删除…" : "确认删除"}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={cleanupOpen} onOpenChange={open => { if (!working) setCleanupOpen(open); }}>
      <AlertDialogContent className="max-w-[calc(100%-2rem)] overflow-hidden">
        <AlertDialogHeader><AlertDialogTitle>清理临时文件</AlertDialogTitle>
          <AlertDialogDescription>清理工作区专用临时目录中的候选文件。未完成或可恢复的意图文件将保留。</AlertDialogDescription>
        </AlertDialogHeader>
        {!cleanup && working && <p role="status" className="text-sm text-muted-foreground">正在核对候选文件…</p>}
        {cleanup && !result && <div className="flex min-w-0 flex-col gap-2 text-sm">
          <p>{cleanup.busy ? "执行器正在使用工作区，请稍后重新预览。" : `本批可删除 ${cleanup.count} 个文件，预计释放 ${size(cleanup.bytes)}。`}</p>
          {cleanup.skipped > 0 && <p className="text-muted-foreground">跳过 {cleanup.skipped} 个文件，所属意图尚未完成或可恢复。</p>}
          {cleanup.has_more && <p className="text-muted-foreground">还有更多候选，清理本批后可重新预览。</p>}
          {!!cleanup.sample.length && <>
            <p className="text-muted-foreground">候选路径{cleanup.count > cleanup.sample.length ? `（前 ${cleanup.sample.length} 项）` : ""}</p>
            <ul className="max-h-[35dvh] overflow-auto rounded-lg border p-2">{cleanup.sample.map(file => <li className="break-all" key={file.path}>{file.path} · {size(file.size)}</li>)}</ul>
          </>}
        </div>}
        {result && <div role="status" className="flex flex-col gap-1 text-sm">
          <p>已删除 {result.deleted} 个文件，释放 {size(result.deleted_bytes)}。</p>
          <p>已变化 {result.changed} · 已消失 {result.missing} · 受保护 {result.protected}</p>
          {!!result.busy && <p className="text-muted-foreground">执行器已占用工作区，剩余 {result.busy} 个文件待处理。</p>}
          {working && !!result.remaining && <p className="text-muted-foreground">正在处理，剩余 {result.remaining} 个文件。</p>}
        </div>}
        {operationError && <Alert variant="destructive"><AlertDescription>{operationError}</AlertDescription></Alert>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={working}>{result ? "关闭" : "取消"}</AlertDialogCancel>
          {cleanup?.snapshot && (!result || result.remaining > 0) && <Button variant="destructive" disabled={working} onClick={() => void clean()}>{working ? "正在清理…" : result ? "继续清理" : "确认清理"}</Button>}
          {!cleanup?.snapshot && !working && <Button variant="outline" onClick={() => void previewCleanup()}>重新预览</Button>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
