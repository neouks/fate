"use client";

import * as React from "react";

import { Lightbulb, Loader2, Minimize2, RefreshCw, Square, Volume2, VolumeX, Wrench } from "lucide-react";
import { toast } from "sonner";

import { ComposerBusyContext } from "@/components/conversation-composer";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { useVisiblePoll } from "@/hooks/use-visible-poll";
import { api } from "@/lib/api";
import {
  type SessionControlPatch,
  type SessionControlSettings,
  type SessionControlTarget,
  sessionControlURL,
} from "@/lib/session-controls";
import { sessionRequestError } from "@/lib/session-usage";

const thinkingDescriptions = {
  auto: "使用 pi 默认设置",
  off: "关闭推理",
  minimal: "最低限度推理",
  low: "低强度推理",
  medium: "中等强度推理",
  high: "高强度推理",
  xhigh: "超高强度推理",
};
const toolOptions = [
  { value: "configured", label: "configured", description: "使用角色配置" },
  { value: "none", label: "chat-only", description: "仅聊天，无工具" },
  { value: "read-only", label: "read-only", description: "4 个只读内置工具" },
  { value: "default", label: "default", description: "4 个默认内置工具" },
  { value: "full", label: "full", description: "全部内置工具" },
] as const;

function useCompletionSound({ running, scope }: { running: boolean; scope: string }) {
  const [enabled, setEnabled] = React.useState(false);
  const context = React.useRef<AudioContext | null>(null);
  const previous = React.useRef({ scope, running });
  React.useEffect(() => {
    const activate = () => {
      try {
        if (localStorage.getItem("series:completion-sound") === "true") {
          context.current ??= new AudioContext();
          void context.current.resume().catch(() => {
            /* Retry on the next user gesture. */
          });
        }
      } catch {
        /* Browser audio requires a supported user gesture. */
      }
    };
    document.addEventListener("pointerdown", activate);
    document.addEventListener("keydown", activate);
    try {
      setEnabled(localStorage.getItem("series:completion-sound") === "true");
    } catch {
      /* Optional preference. */
    }
    return () => {
      document.removeEventListener("pointerdown", activate);
      document.removeEventListener("keydown", activate);
      void context.current?.close();
    };
  }, []);
  React.useEffect(() => {
    const finished = previous.current.scope === scope && previous.current.running && !running;
    previous.current = { scope, running };
    const audio = context.current;
    if (!finished || !enabled || !audio || audio.state !== "running") return;
    const oscillator = audio.createOscillator(),
      gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.12, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.25);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }, [running, scope, enabled]);
  async function toggle() {
    const next = !enabled;
    if (next) {
      try {
        context.current ??= new AudioContext();
        await context.current.resume();
      } catch {
        toast.error("当前浏览器无法播放提示音");
        return;
      }
    }
    setEnabled(next);
    try {
      localStorage.setItem("series:completion-sound", String(next));
    } catch {
      /* Keep current tab preference. */
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="pi-composer-control pi-sound-control"
      aria-label={enabled ? "关闭完成提示音" : "开启完成提示音"}
      title={enabled ? "关闭完成提示音" : "开启完成提示音"}
      aria-pressed={enabled}
      onClick={() => void toggle()}
    >
      {enabled ? <Volume2 /> : <VolumeX />}
    </Button>
  );
}

export function SessionControls({
  target,
  running,
  disabled = false,
  onCompacted,
}: {
  target: SessionControlTarget;
  running: boolean;
  disabled?: boolean;
  onCompacted: () => void;
}) {
  const url = sessionControlURL(target);
  const mobile = useIsMobile();
  const [snapshot, setSnapshot] = React.useState<{ url: string; data: SessionControlSettings } | null>(null);
  const [failure, setFailure] = React.useState<{ url: string; message: string } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [compactingURL, setCompactingURL] = React.useState<string | null>(null);
  const [revision, refresh] = React.useReducer((n) => n + 1, 0);
  const activeURL = React.useRef(url);
  activeURL.current = url;
  const load = React.useCallback(
    async (signal: AbortSignal) => {
      void revision;
      try {
        const data = await api.sessionControls(url, signal);
        if (!signal.aborted) {
          setSnapshot({ url, data });
          setFailure(null);
        }
      } catch (e) {
        if (!signal.aborted) setFailure({ url, message: sessionRequestError(e, "会话配置") });
      }
    },
    [url, revision],
  );
  useVisiblePoll(load, running || compactingURL === url ? 3000 : 30000);
  const data = snapshot?.url === url ? snapshot.data : null;
  const error = failure?.url === url ? failure.message : "";
  const compacting = compactingURL === url || data?.compacting === true;
  const setComposerBusy = React.useContext(ComposerBusyContext);
  React.useEffect(() => {
    setComposerBusy?.(compacting);
    return () => setComposerBusy?.(false);
  }, [compacting, setComposerBusy]);
  async function save(patch: SessionControlPatch) {
    setSaving(true);
    try {
      const next = await api.setSessionControls(url, patch);
      if (activeURL.current === url) {
        setSnapshot({ url, data: next });
        setFailure(null);
        setNotice("已保存，当前会话的下次执行生效");
      }
    } catch (e) {
      toast.error(sessionRequestError(e, "保存会话配置"), { position: "top-center" });
    } finally {
      setSaving(false);
    }
  }
  async function compact() {
    if (compacting) {
      await api
        .compactSession(sessionControlURL(target, "/compact/stop"))
        .catch((e) => toast.error(sessionRequestError(e, "停止压缩")));
      return;
    }
    setCompactingURL(url);
    try {
      await api.compactSession(sessionControlURL(target, "/compact"));
      toast.success("上下文已压缩，下一次回复后校准占用", { position: "top-center" });
    } catch (e) {
      toast.error(sessionRequestError(e, "会话压缩"), { position: "top-center" });
    } finally {
      setCompactingURL(null);
      if (activeURL.current === url) {
        refresh();
        onCompacted();
      }
    }
  }
  const locked = [disabled, saving, compacting, !data, Boolean(error)].some(Boolean);
  const option = data?.thinking_options.find((o) => o.value === data.thinking_level);
  const preset = toolOptions.find((o) => o.value === data?.tool_preset);
  const soundControl = useCompletionSound({ running: running || compacting, scope: url });
  const controls = (
    <>
      <span role="status" className="sr-only">
        {notice}
      </span>
      <Select
        value={data?.thinking_level ?? "auto"}
        onValueChange={(v) => void save({ thinking_level: v as SessionControlSettings["thinking_level"] })}
        disabled={locked}
      >
        <SelectTrigger
          className="pi-composer-control pi-config-trigger"
          aria-label="切换推理强度"
          title="当前会话的推理强度"
        >
          <Lightbulb />
          <SelectValue>{option?.label ?? "auto"}</SelectValue>
        </SelectTrigger>
        <SelectContent side="top" align="end" position="popper" sideOffset={6} className="pi-config-menu">
          <SelectGroup>
            {data?.thinking_options.map((o) => (
              <SelectItem key={o.value} value={o.value} textValue={o.label} className="pi-config-option">
                <span className="pi-option-label">
                  {o.label}
                  {o.original && <small>({o.original})</small>}
                </span>
                <span className="pi-option-description">{thinkingDescriptions[o.value]}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        value={data?.tool_preset ?? "configured"}
        onValueChange={(v) => void save({ tool_preset: v as SessionControlSettings["tool_preset"] })}
        disabled={locked || running}
      >
        <SelectTrigger
          className="pi-composer-control pi-config-trigger"
          aria-label="切换工具预设"
          title="工具预设（受角色工具权限约束）"
        >
          <Wrench />
          <SelectValue>{preset?.label ?? "configured"}</SelectValue>
        </SelectTrigger>
        <SelectContent side="top" align="end" position="popper" sideOffset={6} className="pi-config-menu pi-tools-menu">
          <SelectGroup>
            {toolOptions.map((o) => (
              <SelectItem key={o.value} value={o.value} textValue={o.label} className="pi-config-option">
                <span className="pi-option-label">{o.label}</span>
                <span className="pi-option-description">{o.description}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="pi-composer-control"
        aria-label={compacting ? "停止压缩" : "压缩上下文"}
        title={data?.can_compact ? "使用 Pi 压缩当前会话" : "尚无可压缩的会话历史"}
        disabled={[disabled, !compacting && [running, saving, !data?.can_compact, Boolean(error)].some(Boolean)].some(
          Boolean,
        )}
        onClick={() => void compact()}
      >
        {compacting ? <Square data-icon="inline-start" /> : <Minimize2 data-icon="inline-start" />}
        {compacting ? "压缩中" : "压缩"}
      </Button>
      {soundControl}
      {!data && !error && <Loader2 aria-label="读取会话配置" className="size-3 animate-spin" />}
      {error && (
        <Button type="button" variant="ghost" size="sm" aria-label="重试会话配置" title={error} onClick={refresh}>
          <RefreshCw data-icon="inline-start" />
          配置暂不可用
        </Button>
      )}
    </>
  );
  if (mobile)
    return (
      <div className="session-controls">
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="pi-composer-control" aria-label="更多控件">
              更多控件
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="pi-mobile-controls">
            {controls}
          </PopoverContent>
        </Popover>
      </div>
    );
  return <div className="session-controls">{controls}</div>;
}
