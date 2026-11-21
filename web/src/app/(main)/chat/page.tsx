"use client";

import * as React from "react";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import {
  Activity,
  ArrowRight,
  Bot,
  ChevronDown,
  Ellipsis,
  FileText,
  History,
  ImageIcon,
  Loader2,
  PanelLeft,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";

import { ConversationComposer } from "@/components/conversation-composer";
import { ModelPicker } from "@/components/model-picker";
import { SessionControls } from "@/components/session-controls";
import { ContextUsage, SessionInsights, SessionUsageButton, useSessionInsights } from "@/components/session-insights";
import { Transcript } from "@/components/transcript";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConversationActivity } from "@/hooks/use-conversation-activity";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api";
import { openSystemSettings } from "@/lib/system-settings";
import type { Agent, ChatAttachment, Conversation, LLMProfile } from "@/lib/types";
import { cn } from "@/lib/utils";

const CHAT_ROLES = new Set(["auto", "pentest", "reporter"]);
const TASK_ROLES = new Set(["goals", "planner", "main", "mainagent", "worker"]);
const isIndependent = (row: Conversation) => row.task_id == null && !TASK_ROLES.has(row.agent_key);
const isPinned = (row: Conversation) => row.pinned ?? Boolean(row.pinned_at);
const emptyDraft: { text: string; attachments: ChatAttachment[] } = { text: "", attachments: [] };
const conversationDate = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export default function ChatPage() {
  return (
    <React.Suspense
      fallback={
        <p role="status" className="p-5 text-muted-foreground text-sm">
          正在加载会话…
        </p>
      }
    >
      <ChatWorkspace />
    </React.Suspense>
  );
}

function ChatWorkspace() {
  const requested = useSearchParams().get("c");
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [listOpen, setListOpen] = React.useState(false);
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [sidebarHidden, setSidebarHidden] = React.useState(false);
  const [panel, setPanel] = React.useState<"usage" | "outline" | "files">("outline");
  const [focusActivity, setFocusActivity] = React.useState<number>();
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  const [profileError, setProfileError] = React.useState("");
  const [changingProfile, setChangingProfile] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState("");
  const [renameBusy, setRenameBusy] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [wide, setWide] = React.useState(false);
  const mobile = useIsMobile();
  React.useEffect(() => {
    const media = window.matchMedia("(min-width:1280px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  React.useEffect(() => {
    let active = true;
    api
      .llmProfiles()
      .then((rows) => {
        if (active) setProfiles(rows);
      })
      .catch(() => {
        if (active) setProfileError("模型配置读取失败");
      });
    return () => {
      active = false;
    };
  }, []);
  const [query, setQuery] = React.useState("");
  const [listLoading, setListLoading] = React.useState(true);
  const [listError, setListError] = React.useState("");
  const [agentsError, setAgentsError] = React.useState("");
  const [deleteTarget, setDeleteTarget] = React.useState<Conversation | null>(null);
  const listRequest = React.useRef(0);
  const independent = conversations.filter(isIndependent);
  const current = requested === null ? independent[0] : conversations.find((row) => String(row.id) === requested);
  const selected = current?.id ?? null;
  const readOnly = Boolean(current && (current.read_only || !isIndependent(current)));
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;
  const conversation = useConversationActivity(selected);
  const messages = conversation.items;
  const running = conversation.running;
  const [agentKey, setAgentKey] = React.useState("");
  const [drafts, setDrafts] = React.useState<Record<number, typeof emptyDraft>>({});
  const { text, attachments } = selected === null ? emptyDraft : (drafts[selected] ?? emptyDraft);
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
    void api
      .agents()
      .then((agentRows) => {
        if (!alive) return;
        const available = agentRows.filter(
          (agent) => agent.enabled && (CHAT_ROLES.has(agent.key) || (!agent.builtin && agent.role === "assistant")),
        );
        setAgents(available);
        setAgentKey(available[0]?.key ?? "");
      })
      .catch((err) => {
        if (alive) setAgentsError((err as Error).message);
      });
    return () => {
      alive = false;
      listRequest.current++;
    };
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
    setDrafts((current) => ({ ...current, [id]: update(current[id] ?? emptyDraft) }));
  }

  async function createConversation() {
    if (!agentKey || creating) return;
    setCreating(true);
    setError("");
    try {
      const row = await api.createConversation(agentKey, "新对话");
      setConversations((current) => [row, ...current]);
      selectConversation(row.id);
      void refreshConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function pickFiles(files: FileList | null) {
    if (readOnly || !selected || !files?.length) return;
    setError("");
    setSending(true);
    const uploadConversation = selected;
    try {
      const result = await api.chatUpload("session", String(uploadConversation), Array.from(files));
      updateDraft(uploadConversation, (current) => ({
        ...current,
        attachments: [...current.attachments, ...result.attachments],
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function send() {
    if (readOnly || !selected || (!text.trim() && !attachments.length) || sending || running) return;
    setSending(true);
    setError("");
    const sentText = text,
      sentAttachments = attachments,
      requestID = crypto.randomUUID(),
      conversationID = selected;
    conversation.add({
      seq: -Date.now(),
      worker: "user",
      kind: "user",
      summary: sentText,
      detail: sentText,
      ts: new Date().toISOString(),
      turn_id: requestID,
      metadata: { turn_id: requestID, attachments: sentAttachments },
    });
    updateDraft(conversationID, () => emptyDraft);
    conversation.setStatus("queued");
    try {
      await api.sendConversationMessage(conversationID, sentText, sentAttachments, requestID);
      await refreshConversations();
    } catch (err) {
      try {
        const history = await api.conversationHistory(conversationID);
        conversation.reconcile(history.items);
        if (!history.items.some((a) => (a.turn_id ?? a.metadata?.turn_id) === requestID)) {
          conversation.removePending(requestID);
          conversation.setStatus("idle");
          updateDraft(conversationID, () => ({ text: sentText, attachments: sentAttachments }));
          if (selectedRef.current === conversationID) setError((err as Error).message);
        }
      } catch {
        if (selectedRef.current === conversationID) setError("发送状态待确认，恢复连接后核对记录，请勿重复发送");
      }
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!selected || readOnly) return;
    conversation.setStatus("stopping");
    try {
      const result = await api.stopRetestConversation(selected);
      conversation.setStatus(result.status);
      await refreshConversations();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function togglePin(row: Conversation) {
    try {
      await api.pinConversation(row.id, !isPinned(row));
      await refreshConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(row: Conversation) {
    try {
      const result = await api.deleteConversation(row.id);
      if (result.deleted && selectedRef.current === row.id) selectConversation(null, true);
      await refreshConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const currentAgent = agents.find((agent) => agent.key === (current?.agent_key ?? agentKey));
  const needle = query.trim().toLowerCase();
  const visible = independent.filter((row) =>
    [row.title, row.agent_name, row.agent_key].some((value) => value?.toLowerCase().includes(needle)),
  );
  const groups = new Map<string, { name: string; rows: Conversation[] }>();
  for (const row of visible) {
    const key = isPinned(row) ? "" : row.agent_key;
    const name = key ? row.agent_name || key : "已置顶";
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { name, rows: [row] });
  }

  const configuredProfile = current?.llm_profile_id ?? currentAgent?.llm_profile_id;
  const profile = configuredProfile
    ? profiles.find((p) => String(p.id) === String(configuredProfile))
    : profiles.find((p) => p.is_default);
  const insights = useSessionInsights(selected, profile, text, running, undefined, profiles);
  const fileRows = [
    ...new Map(messages.flatMap((m) => m.metadata?.attachments ?? []).map((file) => [file.path, file])).values(),
  ];
  const userMessages = messages.filter((m) => m.kind === "user");
  React.useEffect(() => {
    setFocusActivity(undefined);
    setRenameOpen(false);
    void selected;
  }, [selected]);
  async function changeProfile(value: string) {
    if (!selected || readOnly || running || changingProfile) return;
    setChangingProfile(true);
    setError("");
    try {
      await api.updateConversationProfile(selected, value === "default" ? null : Number(value));
      await refreshConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "切换失败");
    } finally {
      setChangingProfile(false);
    }
  }
  async function rename() {
    if (!selected || !titleDraft.trim() || renameBusy) return;
    setRenameBusy(true);
    try {
      await api.renameConversation(selected, titleDraft.trim());
      await refreshConversations();
      setRenameOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名失败");
    } finally {
      setRenameBusy(false);
    }
  }
  function showPanel(next: typeof panel) {
    setPanel(next);
    setInspectorOpen(true);
  }
  function locate(seq: number) {
    setFocusActivity(seq);
    if (!wide) setInspectorOpen(false);
  }
  let emptyMessage = "选择或新建一个独立会话。";
  if (listLoading || conversation.loading) emptyMessage = "正在加载对话…";
  else if (current) emptyMessage = "此会话暂无消息，发送第一条消息开始工作。";
  else if (requested) emptyMessage = "找不到链接指向的会话，请从列表选择。";

  const sidebar = (
    <>
      <div className="pi-web-brand-row">
        <Link href="/dashboard" className="font-mono font-semibold text-lg">
          SERIES
        </Link>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={!agentKey || creating}
            onClick={() => void createConversation()}
          >
            <Plus />
            新建
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="搜索会话"
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search />
          </Button>
          {mobile && (
            <Button variant="ghost" size="icon-sm" aria-label="关闭会话列表" onClick={() => setListOpen(false)}>
              <X />
            </Button>
          )}
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-between">
            独立会话工作区
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            {[
              ["/dashboard", "仪表盘"],
              ["/function/tasks", "任务工作区"],
              ["/function/assets", "资产管理"],
              ["/function/findings", "发现与报告"],
            ].map(([url, label]) => (
              <DropdownMenuItem asChild key={url}>
                <Link href={url}>{label}</Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Field className="mt-2">
        <FieldLabel htmlFor="new-session-agent" className="sr-only">
          新会话 Agent
        </FieldLabel>
        <Select value={agentKey} onValueChange={setAgentKey} disabled={!agents.length}>
          <SelectTrigger id="new-session-agent" className="w-full">
            <SelectValue placeholder="暂无可用 Agent" />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectGroup>
              {agents.map((a) => (
                <SelectItem key={a.key} value={a.key}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {agentsError && (
        <p role="alert" className="mt-2 text-destructive text-xs">
          Agent 列表加载失败
        </p>
      )}
      {searchOpen && (
        <InputGroup className="mt-2 h-8">
          <InputGroupInput
            type="search"
            aria-label="搜索会话"
            placeholder="搜索标题或 Agent"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
        </InputGroup>
      )}
      <div className="flex justify-between px-1 pt-4 pb-2">
        <span className="pi-web-overline">会话</span>
        <span className="text-muted-foreground text-xs">{independent.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {listLoading && (
          <p role="status" className="p-3 text-muted-foreground text-xs">
            正在加载会话…
          </p>
        )}
        {listError && (
          <p role="alert" className="p-3 text-destructive text-xs">
            {listError}
            <Button variant="link" size="sm" onClick={() => void refreshConversations()}>
              重试
            </Button>
          </p>
        )}
        {[...groups].map(([key, { name, rows }]) => (
          <section key={key}>
            <h3 className="pi-web-session-group">{name}</h3>
            <ul>
              {rows.map((row) => {
                const active = selected === row.id,
                  title = row.title || "新对话",
                  date = new Date(row.updated_at || row.created_at);
                return (
                  <li key={row.id} className={cn("pi-web-session-row", active && "is-active")}>
                    <Button
                      variant="ghost"
                      type="button"
                      aria-current={active ? "true" : undefined}
                      title={title}
                      onClick={() => selectConversation(row.id)}
                      className="h-auto min-w-0 flex-1 flex-col items-start gap-0 whitespace-normal px-1 py-1 text-left"
                    >
                      <span className="block w-full truncate text-sm">
                        {isPinned(row) && "⌖ "}
                        {title}
                      </span>
                      <span className="mt-1 block text-muted-foreground text-xs">
                        {Number.isFinite(date.valueOf()) ? conversationDate.format(date) : "时间未知"}
                        {(active ? running : row.running) && " · 运行中"}
                      </span>
                    </Button>
                    {!row.read_only && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${title}的更多操作`}>
                            <Ellipsis />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem onSelect={() => void togglePin(row)}>
                              {isPinned(row) ? <PinOff /> : <Pin />}
                              {isPinned(row) ? "取消置顶" : "置顶"}
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget(row)}>
                              <Trash2 />
                              删除对话
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {!listLoading && !listError && !visible.length && (
          <p className="p-4 text-muted-foreground text-sm">{needle ? "没有匹配的会话" : "暂无独立会话"}</p>
        )}
      </div>
      <section className="pi-web-explorer">
        <div className="flex items-center justify-between">
          <h3 className="pi-web-overline">会话附件</h3>
          <Button variant="ghost" size="icon-sm" aria-label="查看附件记录" onClick={() => showPanel("files")}>
            <FileText />
          </Button>
        </div>
        {fileRows.slice(-5).map((f) => (
          <Button
            variant="ghost"
            type="button"
            key={f.path}
            title={f.path}
            size="sm"
            className="w-full justify-start"
            onClick={() => showPanel("files")}
          >
            <FileText />
            <span className="truncate">{f.name}</span>
          </Button>
        ))}
        {!fileRows.length && <p className="py-2 text-muted-foreground text-xs">发送的附件会显示在这里</p>}
      </section>
      <div className="pi-web-sidebar-footer">
        <Button variant="ghost" size="xs" type="button" onClick={() => openSystemSettings("llm")}>
          <Bot />
          模型
        </Button>
        <Button variant="ghost" size="xs" type="button" onClick={() => openSystemSettings("skills")}>
          <Sparkles />
          技能
        </Button>
        <Button variant="ghost" size="xs" type="button" onClick={() => openSystemSettings("settings")}>
          <Settings2 />
          设置
        </Button>
      </div>
    </>
  );
  const inspector = (
    <>
      <Tabs value={panel} onValueChange={(v) => setPanel(v as typeof panel)} className="shrink-0 border-b p-2">
        <TabsList className="w-full">
          <TabsTrigger value="outline">对话目录</TabsTrigger>
          <TabsTrigger value="files">附件</TabsTrigger>
          <TabsTrigger value="usage">用量</TabsTrigger>
        </TabsList>
      </Tabs>
      {panel === "usage" ? (
        <SessionInsights value={insights} onClose={() => setInspectorOpen(false)} />
      ) : (
        <>
          <header className="pi-web-inspector-head">
            <h2 className="font-medium">{panel === "outline" ? "对话目录" : "附件记录"}</h2>
            <Button variant="ghost" size="icon-sm" aria-label="关闭侧栏" onClick={() => setInspectorOpen(false)}>
              <X />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {conversation.hasMore && (
              <Button
                variant="ghost"
                size="sm"
                disabled={conversation.loading}
                onClick={() => void conversation.loadEarlier()}
              >
                加载更早记录
              </Button>
            )}
            {panel === "outline" &&
              userMessages.map((m, i) => {
                const index = messages.indexOf(m),
                  end = messages.findIndex((v, j) => j > index && v.kind === "user");
                const answer = messages
                  .slice(index + 1, end < 0 ? undefined : end)
                  .filter((v) => v.kind === "assistant" || v.kind === "text")
                  .at(-1);
                return (
                  <Button
                    variant="ghost"
                    type="button"
                    className="pi-web-outline-row h-auto whitespace-normal"
                    key={m.seq}
                    onClick={() => locate(m.seq)}
                  >
                    <span className="font-mono text-muted-foreground text-xs">{String(i + 1).padStart(2, "0")}</span>
                    <span className="min-w-0">
                      <strong className="line-clamp-2 font-medium">{m.detail || m.summary || "附件消息"}</strong>
                      {answer && (
                        <span className="mt-2 block truncate text-muted-foreground">
                          A · {answer.summary || answer.detail}
                        </span>
                      )}
                    </span>
                  </Button>
                );
              })}
            {panel === "files" &&
              fileRows.map((f) => (
                <div key={f.path} className="flex flex-col gap-2 border-b p-4">
                  <strong className="break-all text-sm">{f.name}</strong>
                  <code className="break-all text-muted-foreground text-xs">{f.path}</code>
                  <span className="text-muted-foreground text-xs">{Math.ceil(f.size / 1024)} KB</span>
                </div>
              ))}
            {((panel === "outline" && !userMessages.length) || (panel === "files" && !fileRows.length)) && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>暂无{panel === "outline" ? "对话" : "附件"}</EmptyTitle>
                  <EmptyDescription>发送消息后会显示记录。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </>
      )}
    </>
  );
  return (
    <main
      className={cn("pi-web-shell", !sidebarHidden && "has-session-list", inspectorOpen && wide && "has-inspector")}
      aria-label="SERIES 会话工作区"
    >
      {!mobile && !sidebarHidden && (
        <aside aria-label="会话列表" className="pi-web-sessions">
          {sidebar}
        </aside>
      )}
      <Sheet open={mobile && listOpen} onOpenChange={setListOpen}>
        <SheetContent side="left" showCloseButton={false} className="p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>会话列表</SheetTitle>
            <SheetDescription>选择会话或工作区</SheetDescription>
          </SheetHeader>
          <aside className="pi-web-sessions h-full">{sidebar}</aside>
        </SheetContent>
      </Sheet>
      <section className="pi-web-chat" aria-label="聊天内容">
        <header className="pi-web-topbar">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="切换会话列表"
            onClick={() => (mobile ? setListOpen(true) : setSidebarHidden((v) => !v))}
          >
            <PanelLeft />
          </Button>
          <nav className="pi-web-toolbar" aria-label="会话工具">
            <Button variant="ghost" size="sm" onClick={() => showPanel("outline")}>
              <History />
              对话目录
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!selected || readOnly}
              onClick={() => {
                setTitleDraft(current?.title ?? "");
                setRenameOpen(true);
              }}
            >
              <FileText />
              重命名
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openSystemSettings("agents", current?.agent_key)}>
              <Bot />
              系统提示
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openSystemSettings("tools")}>
              <Wrench />
              工具
            </Button>
          </nav>
          <SessionUsageButton value={insights} onClick={() => showPanel("usage")} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="切换右侧栏"
            aria-expanded={inspectorOpen}
            onClick={() => setInspectorOpen((v) => !v)}
          >
            <Activity />
          </Button>
        </header>
        <div className="pi-web-session-heading">
          <h1 className="truncate font-medium text-sm">{current?.title || "独立会话"}</h1>
          <span className="shrink-0 text-muted-foreground text-xs">
            {running ? "正在运行" : currentAgent?.name || current?.agent_name || "准备就绪"}
          </span>
        </div>
        <MessageScrollerProvider key={selected} autoScroll>
          <MessageScroller>
            <MessageScrollerViewport preserveScrollOnPrepend>
              <MessageScrollerContent className="pi-web-message-content">
                {conversation.hasMore && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={conversation.loading}
                    onClick={(e) =>
                      void conversation.loadEarlier(
                        e.currentTarget.closest<HTMLElement>('[data-slot="message-scroller-viewport"]'),
                      )
                    }
                  >
                    {conversation.loading ? "加载中…" : "加载更早消息"}
                  </Button>
                )}
                <Transcript
                  conversationId={selected ?? undefined}
                  activity={messages}
                  live={running}
                  pendingStatus={conversation.status === "stopping" ? "stopping" : undefined}
                  chat
                  scrollItems
                  focusActivity={focusActivity}
                  onLocated={(el) => el.scrollIntoView({ block: "center", behavior: "smooth" })}
                  fetchDetail={(seq) =>
                    selected === null ? Promise.resolve("") : api.conversationMsgDetail(selected, seq)
                  }
                />
                {!messages.length && !conversation.error && !listError && (
                  <Empty>
                    <EmptyHeader>
                      <Sparkles className="mx-auto" />
                      <EmptyTitle>开始一次对话</EmptyTitle>
                      <EmptyDescription>{emptyMessage}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
        {selected && !conversation.connected && !conversation.loading && !conversation.error && (
          <p role="status" className="px-4 text-muted-foreground text-xs">
            实时连接恢复中，已有内容已保留
          </p>
        )}
        {(error || conversation.error || profileError) && (
          <div role="alert" className="border-t p-3 text-destructive text-sm">
            {error || conversation.error || profileError}
            {conversation.historyFailed && (
              <Button
                variant="link"
                onClick={() => {
                  setError("");
                  conversation.retryHistory();
                }}
              >
                重试
              </Button>
            )}
          </div>
        )}
        {readOnly ? (
          <p role="status" className="border-t p-4 text-muted-foreground text-sm">
            此为只读会话。
            {current?.task_id && (
              <Link className="ml-2 underline" href={`/function/tasks/detail?id=${current.task_id}&tab=sessions`}>
                前往任务 #{current.task_id}
              </Link>
            )}
          </p>
        ) : (
          selected !== null && (
            <ConversationComposer
              attachments={
                !!attachments.length && (
                  <div className="pi-composer-attachments">
                    <ul className="flex flex-wrap gap-2" aria-label="待发送附件">
                      {attachments.map((f) => (
                        <li
                          key={f.path}
                          className="flex min-w-0 max-w-full items-center gap-2 rounded border p-1 text-xs"
                        >
                          <span className="truncate">{f.name}</span>
                          <InputGroupButton
                            size="icon-xs"
                            aria-label={`移除 ${f.name}`}
                            onClick={() =>
                              updateDraft(selected, (d) => ({
                                ...d,
                                attachments: d.attachments.filter((a) => a.path !== f.path),
                              }))
                            }
                          >
                            <X />
                          </InputGroupButton>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              }
              editor={
                <InputGroupTextarea
                  aria-label="会话消息"
                  placeholder="输入消息，Shift+Enter 换行…"
                  value={text}
                  disabled={sending}
                  className="max-h-40"
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    updateDraft(selected, (d) => ({ ...d, text: value }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
              }
              actions={
                running ? (
                  <InputGroupButton variant="destructive" size="sm" aria-label="停止生成" onClick={() => void stop()}>
                    <Square />
                    停止
                  </InputGroupButton>
                ) : (
                  <InputGroupButton
                    variant="secondary"
                    size="sm"
                    aria-label="发送"
                    disabled={sending || (!text.trim() && !attachments.length)}
                    onClick={() => void send()}
                  >
                    {sending ? <Loader2 className="animate-spin" /> : <ArrowRight data-icon="inline-start" />}发送
                  </InputGroupButton>
                )
              }
              footer={
                <>
                  <div className="flex min-w-0 flex-wrap items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="pi-composer-control"
                      aria-label="上传附件"
                      disabled={sending}
                      onClick={() => fileInput.current?.click()}
                    >
                      <ImageIcon />
                    </Button>
                    <input
                      ref={fileInput}
                      type="file"
                      hidden
                      multiple
                      onChange={(e) => {
                        void pickFiles(e.currentTarget.files);
                        e.currentTarget.value = "";
                      }}
                    />
                    <ModelPicker
                      profiles={profiles}
                      value={String(current?.llm_profile_id ?? "default")}
                      resolved={profile}
                      disabled={running || changingProfile || readOnly}
                      onChange={(value) => void changeProfile(value)}
                    />
                  </div>
                  <SessionControls
                    key={selected}
                    target={{ conversationId: selected }}
                    running={running}
                    disabled={readOnly}
                    onCompacted={insights.refresh}
                  />
                  <ContextUsage value={insights} />
                </>
              }
            />
          )
        )}
      </section>
      {inspectorOpen && wide && (
        <aside aria-label="会话详情侧栏" className="pi-web-inspector">
          {inspector}
        </aside>
      )}
      <Sheet open={inspectorOpen && !wide} onOpenChange={setInspectorOpen}>
        <SheetContent showCloseButton={false} className="gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>会话详情</SheetTitle>
            <SheetDescription>对话目录、附件和用量</SheetDescription>
          </SheetHeader>
          {inspector}
        </SheetContent>
      </Sheet>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>为这段对话设置便于查找的名称。</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
            className="flex flex-col gap-4"
          >
            <Field>
              <FieldLabel htmlFor="session-title">标题</FieldLabel>
              <Input
                id="session-title"
                value={titleDraft}
                maxLength={200}
                onChange={(e) => setTitleDraft(e.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={renameBusy || !titleDraft.trim()}>
                {renameBusy ? "保存中…" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除对话？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.title ?? "新对话"}」的消息和执行记录将一并删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) void remove(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              删除对话
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
