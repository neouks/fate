"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowUp, Bot, Ellipsis, Loader2, Menu, MessageSquare, Paperclip, Pin, PinOff, Plus, Search, Square, Trash2, X } from "lucide-react";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupTextarea } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Transcript } from "@/components/transcript";
import { useConversationActivity } from "@/hooks/use-conversation-activity";
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerButton } from "@/components/ui/message-scroller";
import { api } from "@/lib/api";
import type { Agent, ChatAttachment, Conversation } from "@/lib/types";

const CHAT_ROLES = new Set(["auto", "pentest", "reporter"]);
const TASK_ROLES = new Set(["goals", "planner", "main", "mainagent", "worker"]);
const isIndependent = (row: Conversation) => row.task_id == null && !TASK_ROLES.has(row.agent_key);
const isPinned = (row: Conversation) => row.pinned ?? Boolean(row.pinned_at);
const emptyDraft: { text: string; attachments: ChatAttachment[] } = { text: "", attachments: [] };
const conversationDate = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default function ChatPage() {
  return (
    <React.Suspense fallback={<p role="status" className="p-5 text-sm text-muted-foreground">正在加载会话…</p>}>
      <ChatWorkspace />
    </React.Suspense>
  );
}

function ChatWorkspace() {
  const requested = useSearchParams().get("c");
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [listOpen, setListOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [listLoading, setListLoading] = React.useState(true);
  const [listError, setListError] = React.useState("");
  const [agentsError, setAgentsError] = React.useState("");
  const [deleteTarget, setDeleteTarget] = React.useState<Conversation | null>(null);
  const listRequest = React.useRef(0);
  const independent = conversations.filter(isIndependent);
  const current = requested === null ? independent[0] : conversations.find(row => String(row.id) === requested);
  const selected = current?.id ?? null;
  const readOnly = Boolean(current && (current.read_only || !isIndependent(current)));
  const selectedRef=React.useRef(selected);selectedRef.current=selected;
  const conversation=useConversationActivity(selected);
  const messages=conversation.items;
  const running=conversation.running;
  const [agentKey, setAgentKey] = React.useState("");
  const [drafts, setDrafts] = React.useState<Record<number, typeof emptyDraft>>({});
  const { text, attachments } = selected === null ? emptyDraft : drafts[selected] ?? emptyDraft;
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState("");
  const refreshConversations = React.useCallback(async () => {
    const request = ++listRequest.current;
    setListError("");
    try {
      const rows = await api.conversations();
      if (request === listRequest.current) setConversations(rows);
    } catch (err) {
      if (request === listRequest.current) setListError((err as Error).message);
    } finally {
      if (request === listRequest.current) setListLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let alive = true;
    void refreshConversations();
    void api.agents().then((agentRows) => {
      if (!alive) return;
      const available = agentRows.filter(agent => agent.enabled && (CHAT_ROLES.has(agent.key) || (!agent.builtin && agent.role === "assistant")));
      setAgents(available);
      setAgentKey(available[0]?.key ?? "");
    }).catch(err => { if (alive) setAgentsError((err as Error).message); });
    return () => { alive = false; listRequest.current++; };
  }, [refreshConversations]);

  React.useEffect(() => {
    if (requested !== null || selected === null) return;
    const url = new URL(window.location.href);
    if (url.searchParams.has("c")) return;
    url.searchParams.set("c", String(selected));
    window.history.replaceState(null, "", url);
  }, [requested, selected]);

  function selectConversation(id: number | null, replace = false) {
    const url = new URL(window.location.href);
    if (id === null) url.searchParams.delete("c");
    else url.searchParams.set("c", String(id));
    if (replace) window.history.replaceState(null, "", url);
    else if (url.href !== window.location.href) window.history.pushState(null, "", url);
    setError("");
    setListOpen(false);
  }

  function updateDraft(id: number, update: (draft: typeof emptyDraft) => typeof emptyDraft) {
    setDrafts(current => ({ ...current, [id]: update(current[id] ?? emptyDraft) }));
  }

  async function createConversation() {
    if (!agentKey) return;
    setError("");
    try {
      const row = await api.createConversation(agentKey, "新对话");
      setConversations(current => [row, ...current]);
      selectConversation(row.id);
      void refreshConversations();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  async function pickFiles(files: FileList | null) {
    if (readOnly || !selected || !files?.length) return;
    setError(""); setSending(true);
    const uploadConversation=selected;
    try {
      const result = await api.chatUpload("session", String(uploadConversation), Array.from(files));
      updateDraft(uploadConversation, current => ({ ...current, attachments: [...current.attachments, ...result.attachments] }));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSending(false); }
  }

  async function send() {
    if (readOnly || !selected || (!text.trim() && !attachments.length) || sending || running) return;
    setSending(true); setError("");
    const sentText=text,sentAttachments=attachments,requestID=crypto.randomUUID(),conversationID=selected;
    conversation.add({seq:-Date.now(),worker:"user",kind:"user",summary:sentText,detail:sentText,ts:new Date().toISOString(),turn_id:requestID,metadata:{turn_id:requestID,attachments:sentAttachments}});
    updateDraft(conversationID, () => emptyDraft);
    conversation.setStatus("queued");
    try {
      await api.sendConversationMessage(conversationID, sentText, sentAttachments,requestID);
      await refreshConversations();
    } catch (err) {
      try {const history=await api.conversationHistory(conversationID);conversation.reconcile(history.items);
        if(!history.items.some(a=>(a.turn_id??a.metadata?.turn_id)===requestID)){
          conversation.removePending(requestID);
          conversation.setStatus("idle");
          updateDraft(conversationID, () => ({ text: sentText, attachments: sentAttachments }));
          if (selectedRef.current===conversationID) setError((err as Error).message);
        }
      } catch {if (selectedRef.current===conversationID) setError("发送状态待确认，恢复连接后核对记录，请勿重复发送");}
    } finally {setSending(false);}
  }

  async function stop() {
    if (!selected || readOnly) return;
    conversation.setStatus("stopping");
    try {const result=await api.stopRetestConversation(selected);conversation.setStatus(result.status);await refreshConversations();}
    catch(err){setError((err as Error).message);}
  }

  async function togglePin(row: Conversation) {
    try { await api.pinConversation(row.id, !isPinned(row)); await refreshConversations(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  async function remove(row: Conversation) {
    try {
      const result = await api.deleteConversation(row.id);
      if (result.deleted && selectedRef.current === row.id) selectConversation(null, true);
      await refreshConversations();
    }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  const currentAgent = agents.find(agent => agent.key === (current?.agent_key ?? agentKey));
  const agentGroups = [
    { name: "内置 Agent", items: agents.filter(agent => agent.builtin) },
    { name: "自定义 Agent", items: agents.filter(agent => !agent.builtin) },
  ];
  const needle = query.trim().toLowerCase();
  const visible = independent.filter(row => [row.title, row.agent_name, row.agent_key]
    .some(value => value?.toLowerCase().includes(needle)));
  const groups = new Map<string, { name: string; rows: Conversation[] }>();
  for (const row of visible) {
    const key = isPinned(row) ? "" : row.agent_key;
    const name = key ? row.agent_name || key : "已置顶";
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { name, rows: [row] });
  }

  return (
    <main className="relative flex h-[calc(100dvh-9rem)] min-h-96 overflow-hidden rounded-xl border bg-card">
      <aside aria-label="独立会话列表" className={`${listOpen ? "flex" : "hidden"} absolute inset-y-0 left-0 z-10 w-72 max-w-full shrink-0 flex-col border-r bg-card md:static md:flex`}>
        <header className="flex flex-col gap-2.5 border-b px-3 pt-3 pb-2.5">
          <div className="flex min-h-7 items-center justify-between gap-2 px-1">
            <h2 className="text-sm font-semibold">会话</h2>
            <Button type="button" variant="ghost" size="icon-sm" className="md:hidden"
              aria-label="返回" onClick={() => setListOpen(false)}><X /></Button>
          </div>
          <div className="flex items-center gap-2">
            <Select value={agentKey} onValueChange={setAgentKey} disabled={!agents.length}>
              <SelectTrigger aria-label="选择 Agent" className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <Bot className="text-muted-foreground" />
                  <SelectValue placeholder="选择 Agent" className="min-w-0 truncate" />
                </span>
              </SelectTrigger>
              <SelectContent position="popper" align="start" sideOffset={4}
                className="max-h-[min(18rem,var(--radix-select-content-available-height))] w-(--radix-select-trigger-width) min-w-0 [&_[data-radix-select-viewport]]:h-auto">
                {agentGroups.map(({ name, items }) => items.length > 0 && <SelectGroup key={name}>
                  <SelectLabel>{name}</SelectLabel>
                  {items.map(agent => <SelectItem key={agent.key} value={agent.key} className="[&>span:last-child]:min-w-0">
                    <span className="min-w-0 truncate" title={agent.name}>{agent.name}</span>
                  </SelectItem>)}
                </SelectGroup>)}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-9"
              disabled={!agentKey} onClick={() => void createConversation()} aria-label="新建对话">
              <Plus data-icon="inline-start" />新建
            </Button>
          </div>
          <InputGroup className="h-8">
            <InputGroupInput type="search" aria-label="搜索会话" placeholder="搜索会话" value={query}
              onChange={event => setQuery(event.target.value)} />
            <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
          </InputGroup>
          {agentsError && <p role="status" className="px-1 text-xs text-muted-foreground">Agent 列表加载失败，可继续查看已有会话。</p>}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2.5">
          {listLoading && <p role="status" className="px-3 py-4 text-sm text-muted-foreground">正在加载会话…</p>}
          {listError && <div role="alert" className="px-3 py-2 text-sm text-destructive">
            读取会话列表失败。<Button variant="link" onClick={() => void refreshConversations()}>重试</Button>
          </div>}
          {[...groups].map(([key, { name, rows }]) => <section key={key} className="mb-2 last:mb-0">
            <h3 className="truncate px-2.5 py-1.5 text-xs font-medium text-muted-foreground" title={name}>{name}</h3>
            <ul className="flex flex-col gap-0.5">
              {rows.map(row => {
                const active = selected === row.id;
                const title = row.title || "新对话";
                const date = new Date(row.updated_at || row.created_at);
                const live = active ? running : row.running;
                const meta = [!key && (row.agent_name || row.agent_key), Number.isFinite(date.valueOf()) && conversationDate.format(date), live && "运行中"].filter(Boolean).join(" · ");
                return <li key={row.id} className={`flex items-center gap-0.5 rounded-lg pr-1 ${active ? "bg-accent" : "hover:bg-muted"}`}>
                  <button type="button" aria-current={active ? "true" : undefined} aria-label={title} title={title}
                    onClick={() => selectConversation(row.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left focus-visible:outline-ring">
                    {isPinned(row) ? <Pin className="size-3.5 shrink-0 text-muted-foreground" /> : <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{title}</span>
                      {meta && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{meta}</span>}
                    </span>
                  </button>
                  {!row.read_only && <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`${title}的更多操作`}>
                        <Ellipsis />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void togglePin(row)}>
                        {isPinned(row) ? <PinOff /> : <Pin />}{isPinned(row) ? "取消置顶" : "置顶"}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget(row)}>
                        <Trash2 />删除对话
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>}
                </li>;
              })}
            </ul>
          </section>)}
          {!listLoading && !listError && !visible.length && <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {needle ? "没有匹配的会话" : "暂无独立会话"}
          </p>}
        </div>
      </aside>

      <section className="task-main-conversation flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-5"><Button className="md:hidden" variant="ghost" size="icon-sm" aria-label="切换会话列表" onClick={()=>setListOpen(v=>!v)}><Menu/></Button>
          <div className="flex min-w-0 items-center gap-2"><Bot className="size-4 shrink-0 text-primary" /><span className="truncate font-medium">{current?.title || "独立会话"}</span>{current && <span className="truncate text-xs text-muted-foreground">{current.agent_name ?? currentAgent?.name ?? current.agent_key}</span>}</div>
          {running && <span className="flex items-center gap-2 text-xs text-blue-600"><span className="size-2 animate-pulse rounded-full bg-blue-500" />正在运行</span>}
        </header>

        <MessageScrollerProvider key={selected} autoScroll><MessageScroller><MessageScrollerViewport preserveScrollOnPrepend>
          <MessageScrollerContent className="gap-3 p-5">
            {conversation.hasMore&&<Button variant="ghost" disabled={conversation.loading} onClick={event=>void conversation.loadEarlier(event.currentTarget.closest<HTMLElement>('[data-slot="message-scroller-viewport"]'))}>加载更早消息</Button>}
            <Transcript conversationId={selected??undefined} activity={messages} live={running} pendingStatus={conversation.status==="stopping"?"stopping":undefined} chat scrollItems fetchDetail={seq=>api.conversationMsgDetail(selected!,seq)}/>
            {!messages.length && !conversation.error && !listError && <p className="text-sm text-muted-foreground">
              {listLoading || conversation.loading ? "正在加载对话…" : current ? "此会话暂无消息。"
                : requested ? "找不到链接指向的会话，请从列表选择。" : "选择或新建一个独立会话。"}
            </p>}
          </MessageScrollerContent>
        </MessageScrollerViewport><MessageScrollerButton /></MessageScroller></MessageScrollerProvider>
        {selected&&!conversation.connected&&!conversation.loading&&!conversation.error&&<div role="status" className="px-4 py-1 text-xs text-muted-foreground">实时连接恢复中，已有内容已保留</div>}
        {(error||conversation.error)&&<div role="alert" className="border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error||conversation.error}
          {conversation.historyFailed && <Button variant="link" onClick={() => { setError(""); conversation.retryHistory(); }}>重试读取消息</Button>}
        </div>}
        {readOnly ? <p role="status" className="border-t p-4 text-sm text-muted-foreground">
          {current?.retired ? "此为历史复测会话，仅供读取。" : "此会话属于任务执行记录，请在对应任务中继续。"}
          {current?.task_id && <Link className="ml-2 underline" href={`/function/tasks/detail?id=${current.task_id}&tab=sessions`}>查看任务 #{current.task_id}</Link>}
        </p> : selected !== null && <div className="task-composer chat-composer">
          <InputGroup aria-label="消息编辑区">
            {attachments.length > 0 && <InputGroupAddon align="block-start">
              <ul aria-label="待发送附件" className="flex min-w-0 flex-wrap gap-2">
                {attachments.map(file => <li key={file.path} className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border bg-muted px-2 py-1 text-xs">
                  <span title={file.name} className="truncate">{file.name}</span>
                  <span className="shrink-0 text-muted-foreground">{Math.ceil(file.size / 1024)} KB</span>
                  <InputGroupButton size="icon-xs" aria-label={`移除 ${file.name}`}
                    onClick={() => updateDraft(selected, draft => ({ ...draft, attachments: draft.attachments.filter(a => a.path !== file.path) }))}>
                    <X />
                  </InputGroupButton>
                </li>)}
              </ul>
            </InputGroupAddon>}
            <InputGroupTextarea aria-label="会话消息" value={text} disabled={sending}
              placeholder="输入消息…" className="max-h-40"
              onChange={event => {
                const text = event.currentTarget.value;
                updateDraft(selected, draft => ({ ...draft, text }));
              }}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }} />
            <InputGroupAddon align="block-end" className="justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <InputGroupButton size="icon-sm" aria-label="上传附件" title="上传附件"
                  disabled={sending} onClick={() => fileInput.current?.click()}>
                  <Paperclip />
                </InputGroupButton>
                <span className="hidden text-xs font-normal sm:inline">Enter 发送 · Shift+Enter 换行</span>
                <input ref={fileInput} type="file" hidden multiple disabled={sending}
                  onChange={event => { void pickFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
              </div>
              {running ? (
                <InputGroupButton className="composer-send" size="icon-sm" variant="destructive" aria-label="停止生成"
                  title="停止生成" onClick={() => void stop()}><Square /></InputGroupButton>
              ) : (
                <InputGroupButton className="composer-send" size="icon-sm" variant="outline" aria-label="发送" title="发送"
                  onClick={() => void send()} disabled={sending || (!text.trim() && !attachments.length)}>
                  {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
        </div>}
      </section>
      <AlertDialog open={deleteTarget !== null} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除对话？</AlertDialogTitle>
            <AlertDialogDescription className="break-words">「{deleteTarget?.title || "新对话"}」的消息和执行记录将一并删除。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button type="button" variant="destructive" onClick={() => {
              if (!deleteTarget) return;
              void remove(deleteTarget);
              setDeleteTarget(null);
            }}>删除对话</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
