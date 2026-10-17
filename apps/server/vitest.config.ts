import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 集成测试使用独立 series_test 库（可用 SERIES_TEST_PG_DSN 覆盖），
    // 并行文件会互相死锁（advisory lock / 行锁竞争），必须串行执行。
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
