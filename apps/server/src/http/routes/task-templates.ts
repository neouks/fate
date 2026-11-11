import type { FastifyInstance } from "fastify";

const templatePath = "/api/task-templates";
const fields = ["name", "description", "goal"] as const;
const limits = { name: 120, description: 16_000, goal: 16_000 };
const labels = { name: "模板名称", description: "任务说明", goal: "验收目标" };
type Field = (typeof fields)[number];
type TemplateInput = Partial<Record<Field, string>>;
type TemplateRow = Record<Field, string> & { id: string; created_at: Date; updated_at: Date };
const columns = "id, name, description, goal, created_at, updated_at";
const dto = (row: TemplateRow) => ({ ...row, id: Number(row.id) });
const bodyOptions = { bodyLimit: 512 * 1024 };

function requestError(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function templateID(value: string) {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) {
    requestError(400, "无效的模板编号");
  }
  return id;
}

function readTemplateInput(value: unknown, partial: boolean): TemplateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    requestError(400, "请提交模板字段");
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => !fields.includes(key as Field))) {
    requestError(400, "模板只接受 name、description 和 goal 字段");
  }
  const result: TemplateInput = {};
  for (const field of fields) {
    if (partial && !Object.hasOwn(body, field)) continue;
    const raw = body[field];
    if (typeof raw !== "string" || raw.includes("\0") || !raw.trim()) {
      requestError(400, `${labels[field]}必须是非空文本`);
    }
    const content = field === "name" ? raw.trim().replace(/\s+/gu, " ") : raw.trim();
    if (Array.from(content).length > limits[field]) {
      requestError(400, `${labels[field]}最多 ${limits[field]} 个字符`);
    }
    result[field] = content;
  }
  return result;
}

function writeError(error: unknown): never {
  if ((error as { code?: string }).code === "23505") {
    requestError(409, "模板名称已存在");
  }
  throw error;
}

export function registerTaskTemplateRoutes(app: FastifyInstance) {
  app.get(templatePath, async () => {
    const { rows } = await app.db.query<TemplateRow>(
      `SELECT ${columns} FROM task_templates ORDER BY updated_at DESC, id DESC`,
    );
    return { templates: rows.map(dto) };
  });

  app.post(templatePath, bodyOptions, async (req, reply) => {
    const input = readTemplateInput(req.body, false);
    const { name, description, goal } = input;
    const { rows } = await app.db.query<TemplateRow>(
      `INSERT INTO task_templates(name, nkey, description, goal)
       VALUES($1, $2, $3, $4) RETURNING ${columns}`,
      [name, name!.toLowerCase(), description, goal],
    ).catch(writeError);
    return reply.code(201).send(dto(rows[0]!));
  });

  app.patch<{ Params: { id: string } }>(`${templatePath}/:id`, bodyOptions, async (req) => {
    const id = templateID(req.params.id);
    const { name, description, goal } = readTemplateInput(req.body, true);
    const { rows } = await app.db.query<TemplateRow>(
      `UPDATE task_templates
       SET name=COALESCE($2, name), nkey=COALESCE($3, nkey),
           description=COALESCE($4, description), goal=COALESCE($5, goal)
       WHERE id=$1 RETURNING ${columns}`,
      [id, name ?? null, name?.toLowerCase() ?? null, description ?? null, goal ?? null],
    ).catch(writeError);
    if (!rows[0]) requestError(404, "任务模板不存在");
    return dto(rows[0]);
  });

  app.delete<{ Params: { id: string } }>(`${templatePath}/:id`, async (req) => {
    const id = templateID(req.params.id);
    const { rowCount } = await app.db.query("DELETE FROM task_templates WHERE id=$1", [id]);
    if (!rowCount) requestError(404, "任务模板不存在");
    return { deleted: id };
  });
}
