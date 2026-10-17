"use client";

// 根路由：服务端 redirect() 在静态导出预渲染时会失败（导出产物变成 error shell），
// 改为客户端跳转。语义与 proxy.ts 一致：已登录 → 任务页；未登录 → 登录页。
import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { auth } from "@/lib/auth";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(auth.getToken() ? "/function/tasks" : "/login");
  }, [router]);
  return null;
}
