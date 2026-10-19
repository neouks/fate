"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { api } from "@/lib/api";
import type { Task } from "@/lib/types";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
export function RecentTasks() {
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const params = useSearchParams();
  const pathname = usePathname();
  React.useEffect(() => {
    let live = true;
    const load = () =>
      api
        .tasks()
        .then((r) => {
          if (live)
            setTasks(
              r.tasks
                .slice()
                .sort(
                  (a, b) => Date.parse(b.last_activity || b.created_at) - Date.parse(a.last_activity || a.created_at),
                )
                .slice(0, 8),
            );
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 30000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pathname]);
  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>最近任务</SidebarGroupLabel>
      <SidebarMenu>
        {tasks.map((t) => (
          <SidebarMenuItem key={t.id}>
            <SidebarMenuButton
              asChild
              isActive={pathname.includes("/tasks/detail") && params.get("id") === String(t.id)}
              tooltip={t.name || t.description}
            >
              <Link href={`/function/tasks/detail?id=${t.id}`}>
                <MessageSquare />
                <span>{t.name || t.description || `任务 #${t.id}`}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
