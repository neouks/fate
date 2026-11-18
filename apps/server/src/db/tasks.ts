import type { PoolClient } from "pg";
import { Database } from "./index.js";
import { EXECUTION_MANAGED, EXECUTION_MANUAL, QueueTx } from "./exploration.js";

// ─── 常量（db/tasks.go）──────────────────────────────────────────────────────

/** 任务是否处于终态（done/failed/timeout）。单一真源（Go IsTerminal）。 */
export function isTerminalTaskStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "timeout";
}

/** planner 心跳触发间隔下限 = 默认 = 10min；低于一律抬到该值（Go MinPlanHeartbeatSeconds）。 */
export const MIN_PLAN_HEARTBEAT_SECONDS = 600;

/** 一个任务可直接继承的上下文来源任务数上限（Go MaxTaskSourceCount）。 */
export const MAX_TASK_SOURCE_COUNT = 8;

export function normalizeHeartbeat(sec: number): number {
  return sec < MIN_PLAN_HEARTBEAT_SECONDS ? MIN_PLAN_HEARTBEAT_SECONDS : sec;
}

// ─── 错误 ────────────────────────────────────────────────────────────────────

/** 准入 CAS 失败：任务生命周期在提交前被并发改变（HTTP 409 语义）。 */
export class TaskLifecycleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskLifecycleConflictError";
  }
}

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface Task {
  execution_mode: string;
  id: number;
  name: string;
  category_id?: number | null;
  category_name: string;
  pinned: boolean;
  pinned_at?: string | null;
  description: string;
  goal: string;
  exploration_id: number;
  status: string;
  paused: boolean;
  queued: boolean;
  queued_at?: string | null;
  queue_mode: string;
  llm_profile_id?: number | null;
  active_llm_profile_id?: number | null;
  source_task_ids: number[]; // 只读继承（task_relations）
  parent_ref: string;
  created_at: string;
  completed_at?: string | null;
  timeout_seconds: number;
  first_run_at?: string | null;
  deadline_at?: string | null;
  plan_heartbeat_seconds: number;
  coverage_enabled: boolean;
  llm_failover_state?: string;
}

interface TaskCreateOptions {
  name?: string;
  categoryID?: number | null;
  llmProfileIDs?: number[];
}

/** ApplyTaskAdmission 一条 UPDATE 原子提交后的落库生命周期快照。 */
export interface TaskAdmissionCommit {
  queuedAt: string | null;
  queueMode: string;
  completedAt: string | null;
  firstRunAt: string | null;
  deadlineAt: string | null;
}

// ─── 列清单（db/tasks.go taskCols；COALESCE 补 AS 别名——PG 默认列名为 coalesce，
//    Go 按位置 Scan 无感，TS 按列名读需要显式命名）────────────────────────────

const TASK_COLS = `id, COALESCE(name,'') AS name, category_id,
COALESCE((SELECT category.name FROM task_categories category WHERE category.id=tasks.category_id),'') AS category_name,
description, goal, exploration_id, status, paused, queued, queued_at, COALESCE(queue_mode,'') AS queue_mode, llm_profile_id, active_llm_profile_id, COALESCE(parent_ref,'') AS parent_ref, pinned_at, created_at, completed_at, COALESCE(timeout_seconds,0) AS timeout_seconds, COALESCE(plan_heartbeat_seconds,300) AS plan_heartbeat_seconds, COALESCE(coverage_enabled,true) AS coverage_enabled, first_run_at, deadline_at, execution_mode`;

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapTask(row: Record<string, unknown>, sourceTaskIDs: number[] = []): Task {
  return {
    id: Number(row["id"]),
    name: String(row["name"] ?? ""),
    category_id: row["category_id"] === null || row["category_id"] === undefined ? null : Number(row["category_id"]),
    category_name: String(row["category_name"] ?? ""),
    description: String(row["description"] ?? ""),
    goal: String(row["goal"] ?? ""),
    exploration_id: Number(row["exploration_id"]),
    status: String(row["status"]),
    paused: row["paused"] === true,
    queued: row["queued"] === true,
    queued_at: iso(row["queued_at"]),
    queue_mode: String(row["queue_mode"] ?? ""),
    llm_profile_id: row["llm_profile_id"] === null || row["llm_profile_id"] === undefined ? null : Number(row["llm_profile_id"]),
    active_llm_profile_id:
      row["active_llm_profile_id"] === null || row["active_llm_profile_id"] === undefined
        ? null
        : Number(row["active_llm_profile_id"]),
    source_task_ids: sourceTaskIDs,
    parent_ref: String(row["parent_ref"] ?? ""),
    created_at: iso(row["created_at"]) ?? "",
    completed_at: iso(row["completed_at"]),
    pinned: row["pinned_at"] !== null && row["pinned_at"] !== undefined,
    pinned_at: iso(row["pinned_at"]),
    timeout_seconds: Number(row["timeout_seconds"] ?? 0),
    first_run_at: iso(row["first_run_at"]),
    deadline_at: iso(row["deadline_at"]),
    plan_heartbeat_seconds: Number(row["plan_heartbeat_seconds"] ?? 300),
    coverage_enabled: row["coverage_enabled"] !== false,
    execution_mode: String(row["execution_mode"] ?? EXECUTION_MANAGED),
  };
}

export const TASK_DISPLAY_STATUS=`task_display_status(tasks.id)`;

// ─── Store ───────────────────────────────────────────────────────────────────

export class TaskStore {
  constructor(private db: Database) {}

  /** 探索级队列锁（与 ExplorationStore.beginQueue 同 key：pg_advisory_xact_lock(-expID)）。 */
  private async beginQueue(expID: number): Promise<{ tx: QueueTx; release: () => void }> {
    if(this.db.transactionClient){
      await this.db.query('SELECT pg_advisory_xact_lock($1)',[-expID]);
      return {tx:new QueueTx(this.db.transactionClient,false),release:()=>{}};
    }
    const client: PoolClient = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [-expID]);
      const tx = new QueueTx(client);
      return { tx, release: () => client.release() };
    } catch (err) {
      client.release();
      throw err;
    }
  }

  async createGoalTask(description: string, goal: string, opts: TaskCreateOptions = {}): Promise<Task> {
    return this.db.transaction(async db => {
      const profiles = opts.llmProfileIDs ?? [];
      const result = await db.query(
        `INSERT INTO tasks(name,category_id,description,goal,llm_profile_id,active_llm_profile_id,coverage_enabled)
         VALUES ($1,$2,$3,$4,$5,$5,false) RETURNING id`,
        [opts.name ?? '', opts.categoryID ?? null, description, goal, profiles[0] ?? null]);
      const id = Number(result.rows[0]!.id);
      await insertTaskLLMProfiles(db, id, profiles);
      return (await db.tasks().getTask(id))!;
    });
  }

  // ─── 读取（ListTasks/GetTask 最小集 + SourceTaskIDs 只读继承）──────────────

  async listTasks(): Promise<Task[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${TASK_COLS} FROM tasks WHERE deleted_at IS NULL
       ORDER BY (pinned_at IS NOT NULL) DESC, pinned_at DESC NULLS LAST, id DESC`,
    );
    return this.hydrateTasksContext(res.rows.map((r) => mapTask(r)));
  }

  async listTasksPage(options:{page:number;pageSize:number;q?:string;status?:string;category?:string;sort?:string;direction?:string;recent?:boolean}){
    const args:unknown[]=[],where=['deleted_at IS NULL'];
    const bind=(v:unknown)=>{args.push(v);return `$${args.length}`;};
    if(options.q){const ref=bind('%'+options.q.replace(/[\\%_]/g,'\\$&')+'%');where.push(`(id::text ILIKE ${ref} OR name ILIKE ${ref} OR description ILIKE ${ref} OR goal ILIKE ${ref} OR EXISTS(SELECT 1 FROM task_categories c WHERE c.id=tasks.category_id AND c.name ILIKE ${ref}))`);}
    if(options.status)where.push(`${TASK_DISPLAY_STATUS}=ANY(${bind(options.status.split(','))}::text[])`);
    if(options.category&&options.category!=='all')where.push(options.category==='uncategorized'?'category_id IS NULL':`category_id=${bind(Number(options.category))}`);
    const direction=options.direction==='asc'?'ASC':'DESC';
    const sort=options.sort==='created'?'created_at':options.sort==='activity'?'COALESCE((SELECT max(created_at) FROM activity WHERE exploration_id=tasks.exploration_id),tasks.created_at)':options.sort==='status'?`array_position(ARRAY['created','queued','running','pausing','paused','needs_attention','done','failed','timeout'],${TASK_DISPLAY_STATUS})`:options.sort==='duration'?`GREATEST(0,EXTRACT(EPOCH FROM (CASE WHEN ${TASK_DISPLAY_STATUS}='running' THEN now() ELSE COALESCE(completed_at,(SELECT max(created_at) FROM activity WHERE exploration_id=tasks.exploration_id),tasks.created_at) END-tasks.created_at)))`:'id';
    const filter=where.join(' AND ');
    const total=Number((await this.db.query(`SELECT count(*) n FROM tasks WHERE ${filter}`,args)).rows[0]?.n??0);
    const page=Math.max(1,Math.min(options.page,Math.max(1,Math.ceil(total/options.pageSize))));
    const limit=bind(options.pageSize),offset=bind((page-1)*options.pageSize);
    const rows=(await this.db.query(`SELECT ${TASK_COLS} FROM tasks WHERE ${filter} ORDER BY ${options.recent?'':'(pinned_at IS NOT NULL) DESC,pinned_at DESC NULLS LAST,'}${sort} ${direction},id DESC LIMIT ${limit} OFFSET ${offset}`,args)).rows;
    return {tasks:await this.hydrateTasksContext(rows.map(row=>mapTask(row))),total,page,page_size:options.pageSize};
  }

  async getTask(id: number): Promise<Task | null> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${TASK_COLS} FROM tasks WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    );
    if (res.rows.length === 0) return null;
    return (await this.hydrateTasksContext([mapTask(res.rows[0]!)]))[0]!;
  }

  /** 只读继承来源任务 id（task_relations，按创建序）。Go TaskSources。 */
  async sourceTaskIDs(taskID: number): Promise<number[]> {
    const res = await this.db.query<{ source_task_id: string }>(
      `SELECT source_task_id FROM task_relations WHERE task_id=$1 ORDER BY created_at, source_task_id`,
      [taskID],
    );
    return res.rows.map((r) => Number(r.source_task_id));
  }

  private async hydrateTasksContext(tasks: Task[]): Promise<Task[]> {
    if (tasks.length === 0) return tasks;
    const res = await this.db.query<{ task_id: string; source_task_id: string }>(
      `SELECT task_id, source_task_id FROM task_relations WHERE task_id=ANY($1::bigint[])`,
      [tasks.map((t) => t.id)],
    );
    const byTask = new Map<number, number[]>();
    for (const row of res.rows) {
      const id = Number(row.task_id);
      const list = byTask.get(id) ?? [];
      list.push(Number(row.source_task_id));
      byTask.set(id, list);
    }
    return tasks.map((t) => ({ ...t, source_task_ids: byTask.get(t.id) ?? [] }));
  }

  // ─── 状态迁移（db/tasks.go SetStatus/SetTerminalStatusGuarded/StampFirstRun）─

  /**
   * 更新任务生命周期状态。进入终态时 completed_at 只盖一次（COALESCE 保持首印稳定）；
   * 回到非终态时清空，重跑不留陈旧完成时间。
   */
  async setTaskStatus(id: number, status: string): Promise<void> {
    await this.db.query(
      `UPDATE tasks
         SET status = $1,
             completed_at = CASE WHEN $1 IN ('done','failed','timeout') THEN COALESCE(completed_at, now()) ELSE NULL END
       WHERE id = $2`,
      [status, id],
    );
  }

  /**
   * 守卫式终态写入：仅当任务尚未终态时写入，done↔timeout 竞态以首个写者胜（won=true）。
   * 已被其他终态钉住时返回 won=false（非错误），调用方应放弃改写。
   * 非终态迁移/重跑仍走 setTaskStatus。
   */
  async setTaskStatusGuarded(id: number, status: string, allowGoalless = false): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE tasks
         SET status = $1,
             completed_at = CASE WHEN $1 IN ('done','failed','timeout') THEN COALESCE(completed_at, now()) ELSE NULL END,
             status_reason=CASE WHEN $1='needs_attention' THEN '目标尚未全部核验，等待处理' ELSE '' END
       WHERE id = $2 AND deleted_at IS NULL AND status NOT IN ('done','failed','timeout')
         AND ($1<>'done' OR EXISTS (
           SELECT 1 FROM task_goal_progress(tasks.exploration_id) WHERE ready AND total=met AND (total>0 OR $3)
         ))`,
      [status, id, allowGoalless],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Explicit stop is allowed with pending goals, but only a full proof is success. */
  async finishManually(id: number): Promise<string | undefined> {
    return this.db.transaction(async db => {
      const task = (await db.query<{status:string;exploration_id:string}>(
        'SELECT status,exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id],
      )).rows[0];
      if (!task || ['done','failed','timeout'].includes(task.status)) return task?.status;
      if ((await db.query("SELECT 1 FROM engine_task_leases WHERE task_id=$1 AND expires_at>now() UNION ALL SELECT 1 FROM runtime_session_leases WHERE key LIKE $2 AND expires_at>now() LIMIT 1", [id,`main:${id}:%`])).rowCount) throw Object.assign(new Error('执行器尚未退出，请先暂停并等待确认后结束任务'),{statusCode:409});
      const expID = Number(task.exploration_id);
      await db.query('SELECT pg_advisory_xact_lock($1)', [-expID]);
      const counts = await db.exploration(expID).executionCounts();
      const status = counts.goalsReady && counts.goals > 0 && counts.met === counts.goals ? 'done' : 'needs_attention';
      await db.tasks().setTaskStatusGuarded(id, status);
      await db.query('UPDATE tasks SET paused=false,queued=false WHERE id=$1',[id]);
      return status;
    });
  }

  /**
   * 盖首跑章：记录首次真正运行的时刻并推导绝对截止（now+timeoutSeconds）。幂等——
   * first_run_at 已存在则不动（重启/重入保留原时钟）。timeoutSeconds<=0 → deadline_at
   * 保持 NULL（不限时）。返回结果截止时刻（null=不限/未变）。任务不存在时报错。
   */
  async stampFirstRun(id: number, timeoutSeconds: number): Promise<string | null> {
    const res = await this.db.query<{ deadline_at: Date | null }>(
      `UPDATE tasks
         SET first_run_at = COALESCE(first_run_at, now()),
             deadline_at  = CASE
                 WHEN first_run_at IS NOT NULL THEN deadline_at            -- 已盖过章：不动
                 WHEN $2 > 0 THEN now() + make_interval(secs => $2)
                 ELSE NULL END
       WHERE id = $1
       RETURNING deadline_at`,
      [id, timeoutSeconds],
    );
    if (res.rows.length === 0) throw new Error(`task ${id} not found`);
    return iso(res.rows[0]!.deadline_at);
  }

  // ─── FIFO 准入队列（db/tasks.go Enqueue/Dequeue）──────────────────────────

  /** 入队到持久准入队列尾部。已排队时重复入队保持原 FIFO 位置。 */
  async enqueue(id: number, mode: string): Promise<void> {
    if (mode !== "bootstrap" && mode !== "resume") throw new Error(`invalid queue mode "${mode}"`);
    await this.db.query(
      `UPDATE tasks
      SET queued=true,
          queued_at=CASE WHEN queued THEN COALESCE(queued_at, now()) ELSE now() END,
          queue_mode=CASE
              WHEN queue_mode='bootstrap' OR $2='bootstrap' THEN 'bootstrap'
              ELSE 'resume'
          END
      WHERE id=$1`,
      [id, mode],
    );
  }

  /** 解除并发占位。clearMode=false 用于用户暂停排队任务：保留下次准入需 bootstrap 还是 resume。 */
  async dequeue(id: number, clearMode: boolean): Promise<void> {
    await this.db.query(
      `UPDATE tasks
      SET queued=false,
          queued_at=NULL,
          queue_mode=CASE WHEN $2 THEN '' ELSE queue_mode END
      WHERE id=$1`,
      [id, clearMode],
    );
  }

  // ─── 调度器原子提交（server/manager.go ApplyTaskAdmission/ApplyTaskPause）─

  /**
   * 并发调度器受控的生命周期字段一条 UPDATE 原子提交：status/paused/queue 元数据
   * 一起落库，防止半复活（如 running 但仍用户暂停、或出队而引擎未启动）。
   * WHERE 带 expectedStatus CAS；行不匹配（并发改变）抛 TaskLifecycleConflictError。
   * preservePosition 只对已在队列中的行生效：重复准入保 FIFO 时间戳；显式暂停后
   * 重新入队拿新的队尾位置。timeout→非终态重跑会清空 first_run_at/deadline_at。
   */
  async applyTaskAdmission(
    id: number,
    expectedStatus: string,
    status: string,
    queued: boolean,
    mode: string,
    preservePosition: boolean,
  ): Promise<TaskAdmissionCommit> {
    if (queued) {
      if (mode !== "bootstrap" && mode !== "resume") throw new Error(`invalid queue mode "${mode}"`);
    } else {
      mode = "";
    }
    const res = await this.db.query<{
      queued_at: Date | null;
      queue_mode: string;
      completed_at: Date | null;
      first_run_at: Date | null;
      deadline_at: Date | null;
    }>(
      `UPDATE tasks
      SET status=$2,
          completed_at=CASE
              WHEN $2 IN ('done','failed','timeout') THEN COALESCE(completed_at, now())
              ELSE NULL
          END,
          paused=false,
          queued=$3,
          queued_at=CASE
              WHEN NOT $3 THEN NULL
              WHEN $5 AND queued THEN COALESCE(queued_at, now())
              ELSE now()
          END,
          queue_mode=CASE
              WHEN NOT $3 THEN ''
              WHEN ($5 AND queued AND queue_mode='bootstrap') OR $4='bootstrap' THEN 'bootstrap'
              ELSE 'resume'
          END,
          first_run_at=CASE
              WHEN $6='timeout' AND $2 NOT IN ('done','failed','timeout') THEN NULL
              ELSE first_run_at
          END,
          deadline_at=CASE
              WHEN $6='timeout' AND $2 NOT IN ('done','failed','timeout') THEN NULL
              ELSE deadline_at
          END
      WHERE id=$1 AND deleted_at IS NULL AND status=$6
      RETURNING queued_at, queue_mode, completed_at, first_run_at, deadline_at`,
      [id, status, queued, mode, preservePosition, expectedStatus],
    );
    const row = res.rows[0];
    if (!row) {
      throw new TaskLifecycleConflictError(
        `task ${id} lifecycle changed before admission (expected status "${expectedStatus}")`,
      );
    }
    return {
      queuedAt: iso(row.queued_at),
      queueMode: row.queue_mode ?? "",
      completedAt: iso(row.completed_at),
      firstRunAt: iso(row.first_run_at),
      deadlineAt: iso(row.deadline_at),
    };
  }

  /**
   * 原子出队 + 记录用户暂停。queue_mode 故意保留（从未运行的 bootstrap 任务恢复时仍做
   * 目标分解），但下次入队拿新的 queued_at 时间戳（FIFO 队尾）。行不匹配抛冲突错误。
   */
  async applyTaskPause(id: number): Promise<{ queueMode: string; commandID: number }> {
    return this.db.transaction(async tx => {
      const res = await tx.query<{ mode: string }>(
        `UPDATE tasks
            SET paused=true, paused_at=COALESCE(paused_at,now()), queued=false, queued_at=NULL
          WHERE id=$1 AND deleted_at IS NULL AND paused=false
            AND status NOT IN ('done','failed','timeout')
          RETURNING COALESCE(queue_mode,'') AS mode`,
        [id],
      );
      const row = res.rows[0];
      if (!row) throw new TaskLifecycleConflictError(`task ${id} is unavailable for pause`);
      await tx.query(`INSERT INTO runtime_task_commands(task_id,command) VALUES($1,'pause')
        ON CONFLICT(task_id,command) WHERE status='pending' DO NOTHING`, [id]);
      const command = await tx.query<{ id: string }>(`SELECT id FROM runtime_task_commands
        WHERE task_id=$1 AND command='pause' AND status='pending' ORDER BY id DESC LIMIT 1`, [id]);
      return { queueMode: row.mode ?? "", commandID: Number(command.rows[0]!.id) };
    });
  }

  // ─── execution_mode（db/execution_mode.go，与 planner 意图写入共用队列锁）──

  /** 读探索的执行模式；无任务行时按独立探索存储的既有自动行为返回 managed。 */
  async executionMode(expID: number): Promise<string> {
    const res = await this.db.query<{ execution_mode: string }>(
      `SELECT execution_mode FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL`,
      [expID],
    );
    if (res.rows.length === 0) return EXECUTION_MANAGED;
    return res.rows[0]!.execution_mode;
  }

  /**
   * 切换 managed/manual。走探索级队列锁（与认领、planner 意图写入互斥），行锁 FOR UPDATE
   * 后比较；已是目标模式直接返回 false（无副作用提交）。切 manual 时：running 意图盖
   * dispatch_requested、open 意图摘除 dispatch_requested；随后 bump worker_queue_version
   * 使并发重排快照失效。
   */
  async setExecutionMode(expID: number, mode: string): Promise<boolean> {
    if (mode !== EXECUTION_MANAGED && mode !== EXECUTION_MANUAL) {
      throw new Error("execution_mode must be managed|manual");
    }
    const { tx, release } = await this.beginQueue(expID);
    try {
      const before = await tx.query<{ execution_mode: string }>(
        `SELECT execution_mode FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [expID],
      );
      if (before.rows.length === 0) throw new Error(`no live task for exploration ${expID}`);
      if (before.rows[0]!.execution_mode === mode) {
        await tx.commit();
        return false;
      }
      if (mode === EXECUTION_MANUAL) {
        await tx.query(
          `UPDATE exploration_nodes SET payload=payload || jsonb_build_object('dispatch_requested',true)
           WHERE exploration_id=$1 AND kind='intent' AND state='running'`,
          [expID],
        );
        await tx.query(
          `UPDATE exploration_nodes SET payload=payload-'dispatch_requested'
           WHERE exploration_id=$1 AND kind='intent' AND state='open'`,
          [expID],
        );
      }
      await tx.query(`UPDATE tasks SET execution_mode=$2 WHERE exploration_id=$1 AND deleted_at IS NULL`, [expID, mode]);
      await tx.query(`UPDATE explorations SET worker_queue_version=worker_queue_version+1 WHERE id=$1`, [expID]);
      await tx.commit();
      return true;
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      release();
    }
  }
}

async function insertTaskLLMProfiles(tx: Database, taskID: number, profileIDs: number[]): Promise<void> {
  const seen = new Set<number>();
  for (let position = 0; position < profileIDs.length; position++) {
    const profileID = profileIDs[position]!;
    if (profileID <= 0 || seen.has(profileID)) throw new Error(`invalid or duplicate LLM profile id ${profileID}`);
    seen.add(profileID);
    await tx.query(`INSERT INTO task_llm_profiles(task_id, profile_id, position) VALUES ($1,$2,$3)`, [
      taskID,
      profileID,
      position,
    ]);
  }
}
