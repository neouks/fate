/** Role guidance is not an authorization ceiling; tool bindings belong to the operator. */
export const PLANNER_CAPABILITY_PROTOCOL = 'Planner 默认负责规划、监督与目标验收。工具能力由用户的启用、Agent 绑定和加载配置决定，不按角色名称额外禁止工具。以本轮声明及 tool_search 回执为准，按任务需要使用已配置工具；未配置时明确说明缺少的能力。公开文档不能代替目标实测证据。遵守用户操作约束、任务暂停、主动停止和超时；需要协作时先查重再提交意图。';
