<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## UI 一致性

- 新增或修改功能时，复用 `src/components/ui` 中的统一组件及主题样式；按钮、表单标签、输入框和选择器应与现有页面一致。
- 功能页面的下拉选择使用 `Select`（含 `SelectTrigger`、`SelectContent`、`SelectGroup`、`SelectItem`），不要使用 `NativeSelect` 或直接写原生 `<select>`，除非用户明确要求原生控件。
- 验证展开后的菜单、焦点、键盘操作和禁用状态，不只检查收起时的外观。
