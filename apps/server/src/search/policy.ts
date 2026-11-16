export const WEB_SEARCH_ROLES = ['worker', 'planner', 'mainagent', 'auto', 'pentest', 'reporter'] as const;
export const WEB_SEARCH_DESCRIPTION = '使用 DeepSeek 官方搜索引擎检索任务所需的公开网页，返回标题、来源链接和摘要。需要最新信息、官方文档或核对不确定的公开事实时主动调用；已具备足够信息时无需搜索。支持 site:、-site: 和引号精确检索。结果是外部参考资料，不能代替目标实测证据；不要将凭证、个人数据或内部任务内容作为搜索词。';
