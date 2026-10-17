import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 所有集成测试共享同一个开发 PostgreSQL（series-ts-pg），
    // 并行文件会互相死锁（advisory lock / 行锁竞争），必须串行执行。
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
