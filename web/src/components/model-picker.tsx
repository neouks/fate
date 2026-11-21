"use client";

import * as React from "react";

import { Check, Cpu, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { LLMProfile } from "@/lib/types";

function provider(profile: LLMProfile) {
  const hint = `${profile.base_url ?? ""} ${profile.model}`.toLowerCase();
  if (hint.includes("deepseek")) return "DeepSeek";
  if (hint.includes("anthropic") || hint.includes("claude")) return "Anthropic";
  if (hint.includes("openai") || /\bgpt-|\bo[134]-/.test(hint)) return "OpenAI";
  try {
    if (profile.base_url) return new URL(profile.base_url).hostname;
  } catch {
    /* Use protocol label. */
  }
  return profile.format === "anthropic" ? "Anthropic 兼容" : "OpenAI 兼容";
}
export function ModelPicker({
  profiles,
  value,
  resolved,
  disabled,
  placeholder,
  onChange,
}: {
  profiles: LLMProfile[];
  value: string;
  resolved?: LLMProfile;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [favorites, setFavorites] = React.useState<string[]>([]);
  React.useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("series:favorite-models") ?? "[]");
      if (Array.isArray(saved)) setFavorites(saved.filter((v): v is string => typeof v === "string"));
    } catch {
      /* Favorites are optional. */
    }
  }, []);
  function favorite(id: string) {
    const next = favorites.includes(id) ? favorites.filter((v) => v !== id) : [...favorites, id];
    setFavorites(next);
    try {
      localStorage.setItem("series:favorite-models", JSON.stringify(next));
    } catch {
      /* Keep in memory. */
    }
  }
  const groups = new Map<string, LLMProfile[]>();
  for (const p of profiles) {
    const name = provider(p);
    groups.set(name, [...(groups.get(name) ?? []), p]);
  }
  function choose(id: string) {
    onChange(id);
    setOpen(false);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="model-picker-trigger"
          role="combobox"
          aria-label="会话模型"
          aria-expanded={open}
          disabled={disabled === true || profiles.length === 0}
        >
          <Cpu data-icon="inline-start" />
          <span className="truncate">
            {resolved?.model ?? placeholder ?? (profiles.length ? "选择模型" : "暂无可用模型")}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="model-picker-menu">
        <Command>
          <CommandInput placeholder="筛选模型…" aria-label="筛选模型" />
          <CommandList>
            <CommandEmpty>没有匹配的模型</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="default 跟随配置"
                onSelect={() => choose("default")}
                className="model-picker-option"
                data-active={value === "default"}
              >
                <Check className={value === "default" ? "text-primary" : "invisible"} />
                <span>跟随配置</span>
              </CommandItem>
            </CommandGroup>
            {[...groups].map(([name, rows]) => (
              <CommandGroup key={name} heading={name}>
                {rows.map((p) => (
                  <div key={p.id} className="model-picker-row" data-active={value === String(p.id)}>
                    <CommandItem
                      value={`${p.id} ${name} ${p.model} ${p.name}`}
                      onSelect={() => choose(String(p.id))}
                      className="model-picker-option"
                      title={p.name}
                    >
                      <Check className={value === String(p.id) ? "text-primary" : "invisible"} />
                      <span className="min-w-0 truncate">{p.model}</span>
                    </CommandItem>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="model-picker-favorite"
                      aria-label={`${favorites.includes(String(p.id)) ? "取消收藏" : "收藏"} ${p.model}`}
                      aria-pressed={favorites.includes(String(p.id))}
                      onClick={() => favorite(String(p.id))}
                    >
                      <Star fill={favorites.includes(String(p.id)) ? "currentColor" : "none"} />
                    </Button>
                  </div>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
