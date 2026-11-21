"use client";

import * as React from "react";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Bot, CirclePlusIcon, Settings2, Sparkles } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Sidebar, SidebarContent, SidebarFooter, useSidebar } from "@/components/ui/sidebar";
import { openSystemSettings } from "@/lib/system-settings";
import { sidebarItems } from "@/navigation/sidebar/sidebar-items";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { NavMain } from "./nav-main";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  React.useEffect(() => {
    if (pathname) setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  const { sidebarVariant, sidebarCollapsible, isSynced } = usePreferencesStore(
    useShallow((s) => ({
      sidebarVariant: s.sidebarVariant,
      sidebarCollapsible: s.sidebarCollapsible,
      isSynced: s.isSynced,
    })),
  );

  const variant = isSynced ? sidebarVariant : props.variant;
  const collapsible = isSynced ? sidebarCollapsible : props.collapsible;

  return (
    <Sidebar {...props} variant={variant} collapsible={collapsible}>
      <div className="workbench-sidebar-header">
        <Link href="/dashboard">SERIES</Link>
        <Button asChild variant="outline" size="icon-sm" aria-label="新建任务">
          <Link href="/function/tasks/new">
            <CirclePlusIcon />
          </Link>
        </Button>
      </div>
      <SidebarContent className="app-sidebar-content">
        <NavMain items={sidebarItems} />
      </SidebarContent>
      <SidebarFooter className="workbench-footer">
        <Button variant="ghost" size="sm" aria-label="模型配置" onClick={() => openSystemSettings("llm")}>
          <Bot />
          <span>模型</span>
        </Button>
        <Button variant="ghost" size="sm" aria-label="技能配置" onClick={() => openSystemSettings("skills")}>
          <Sparkles />
          <span>技能</span>
        </Button>
        <Button variant="ghost" size="sm" aria-label="系统设置" onClick={() => openSystemSettings("settings")}>
          <Settings2 />
          <span>设置</span>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
