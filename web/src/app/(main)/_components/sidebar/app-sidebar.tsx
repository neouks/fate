"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import * as React from "react";
import {PlusIcon} from "lucide-react";
import {RecentTasks} from "./recent-tasks";
import {ThemeSwitcher} from "./theme-switcher";
import {LayoutControls} from "./layout-controls";

import { useShallow } from "zustand/react/shallow";

import {
  Sidebar,
  useSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { sidebarItems } from "@/navigation/sidebar/sidebar-items";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { NavMain } from "./nav-main";


export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname=usePathname();
  const {setOpenMobile}=useSidebar();
  React.useEffect(()=>setOpenMobile(false),[pathname,setOpenMobile]);
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
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link prefetch={false} href="/function/tasks">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/series-icon.svg" alt="SERIES" width={40} height={40} className="shrink-0" />
                <span className="font-semibold text-base">{APP_CONFIG.name}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarMenu className="px-2"><SidebarMenuItem><SidebarMenuButton asChild tooltip="新建任务"><Link href="/function/tasks?create=1" onClick={event=>{setOpenMobile(false);if(pathname.replace(/\/$/,'')==='/function/tasks'){event.preventDefault();window.dispatchEvent(new Event("series:create-task"));}}}><PlusIcon/><span>新建任务</span></Link></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      <SidebarContent>
        <NavMain items={sidebarItems} />
        <React.Suspense><RecentTasks/></React.Suspense>
        {/* <NavSecondary items={data.navSecondary} className="mt-auto" /> */}
      </SidebarContent>
      <SidebarFooter className="flex-row items-center gap-2 border-t group-data-[collapsible=icon]:flex-col"><ThemeSwitcher/><LayoutControls/></SidebarFooter>
    </Sidebar>
  );
}
