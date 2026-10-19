import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Database } from '../db/index.js';
import { activityDTO, type StreamScope } from '../engine/live-stream.js';
import {readTurnSummaries} from '../engine/turn-summary.js';

const connections = new WeakMap<object, Set<ServerResponse>>();
export function registerActivityStreamShutdown(app: FastifyInstance) {
  const streams = new Set<ServerResponse>();
  connections.set(app.server, streams);
  // Hijacked SSE responses outlive ordinary requests. Close them before Fastify
  // waits for connections, so clients reconnect and the old process can exit.
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });
}

export async function conversationReadable(db: Database, id: number) {
  return !!(await db.query(`SELECT 1 FROM conversations c WHERE c.id=$1
    AND (c.task_id IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=c.task_id AND t.deleted_at IS NULL))
    AND NOT EXISTS(SELECT 1 FROM finding_retests r WHERE r.conversation_id=c.id AND NOT finding_readable(r.finding_id))`, [id])).rowCount;
}

/** Durable cursor covers activities only. Live snapshots have their own offsets. */
export async function serveActivityStream(db: Database, req: FastifyRequest, reply: FastifyReply, scope: StreamScope, scopeID: number) {
  const query = req.query as Record<string,string|undefined>;
  let cursor = Math.max(0, Number(query.since)||0, Number(req.headers['last-event-id'])||0);
  reply.hijack();
  const raw = reply.raw;
  const connectionsForServer = connections.get(reply.server.server);
  connectionsForServer?.add(raw);
  raw.writeHead(200, {'Content-Type':'text/event-stream', 'Cache-Control':'no-cache, no-transform', Connection:'keep-alive', 'X-Accel-Buffering':'no'});
  raw.flushHeaders();
  raw.write(': connected\n\nretry: 500\n\n');
  let closed = false, polling = false, previousSnapshots = '', previousStatus = '';
  const delivered = new Map<string,string>();
  const finalized = new Set<string>();
  const activeTurns=new Set<string>();
  let initialTurns=true,lastTurnRefresh=0;
  const write = (event: string, value: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const readable = scope === 'conversation' ? await conversationReadable(db,scopeID)
        : !!(await db.query('SELECT 1 FROM explorations WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM tasks WHERE exploration_id=$1 AND deleted_at IS NOT NULL)',[scopeID])).rowCount;
      if (!readable) { write('access_revoked',{}); raw.end(); return; }
      // Read snapshots BEFORE activities. A snapshot is deleted only after its
      // durable row commits, so this order cannot expose an empty gap between
      // the last partial body and the final record (even across instances).
      const snapshots = await db.query(`SELECT *, expires_at>now() AS active FROM agent_stream_snapshots
        WHERE scope=$1 AND scope_id=$2 ${scope === 'task' ? 'AND exploration_activity_readable(scope_id,node_id,jsonb_build_object(\'turn_id\',turn_id))' : ''}
        ORDER BY created_at,stream_id,channel`, [scope,scopeID]);
      const changedTurns=new Set<string>();
      if(initialTurns){
        const recent=await db.query(scope==='task'
          ? "SELECT metadata->>'turn_id' AS turn_id FROM activity WHERE exploration_id=$1 AND metadata ? 'turn_id' AND exploration_activity_readable($1,node_id,metadata) ORDER BY id DESC LIMIT 500"
          : "SELECT metadata->>'turn_id' AS turn_id FROM conversation_activities WHERE conversation_id=$1 AND metadata ? 'turn_id' ORDER BY id DESC LIMIT 500",[scopeID]);
        for(const row of recent.rows)if(changedTurns.size<100)changedTurns.add(String(row.turn_id));
        initialTurns=false;
      }
      for (;;) {
        const rows = await db.query(scope === 'task'
          ? 'SELECT * FROM activity WHERE exploration_id=$1 AND id>$2 AND exploration_activity_readable($1,node_id,metadata) ORDER BY id LIMIT 500'
          : 'SELECT * FROM conversation_activities WHERE conversation_id=$1 AND id>$2 ORDER BY id LIMIT 500', [scopeID,cursor]);
        for (const row of rows.rows) {
          cursor = Number(row.id);
          const metadata = row.metadata as Record<string,unknown>|undefined;
          if(metadata?.turn_id)changedTurns.add(String(metadata.turn_id));
          if(metadata?.stream_id)finalized.add(`${metadata.stream_id}:${metadata.channel??(row.kind==='thinking'?'thinking':'text')}`);
          raw.write(`id: ${cursor}\ndata: ${JSON.stringify({...activityDTO(row),...(scope==='task'?{exp_id:scopeID,task_id:Number(query.task)||0}:{})})}\n\n`);
        }
        if (rows.rows.length < 500 || closed) break;
      }
      if(Date.now()-lastTurnRefresh>1000){for(const id of activeTurns)changedTurns.add(id);lastTurnRefresh=Date.now();}
      const ids=[...changedTurns];
      for(let offset=0;offset<ids.length;offset+=100){
        const batch=ids.slice(offset,offset+100),items=await readTurnSummaries(db,scope,scopeID,batch);
        for(const id of batch)activeTurns.delete(id);
        for(const item of items)if(['running','awaiting_confirmation'].includes(item.status))activeTurns.add(item.turn_id);
        write('turn_summary',{items,requested_ids:batch});
      }
      const snapshotKeys=new Set(snapshots.rows.map(row=>`${row.stream_id}:${row.channel}`));
      for(const key of finalized)if(!snapshotKeys.has(key))finalized.delete(key);
      const items = snapshots.rows.filter(row=>!finalized.has(`${row.stream_id}:${row.channel}`)).map(row => ({worker:row.worker === 'main'?'mainagent':row.worker,
        intent_id:row.node_id == null?undefined:String(row.node_id),main_seg:row.main_seg,
        turn_id:row.turn_id,stream_id:row.stream_id,channel:row.channel,text:row.body,
        offset:String(row.body).length,ts:row.created_at,active:row.active}));
      const activeIDs=new Set(items.map(item=>String(item.stream_id)));
      for(const key of delivered.keys())if(!activeIDs.has(key))delivered.delete(key);
      for(const item of items){
        if(item.channel!=='text')continue;
        const before=delivered.get(String(item.stream_id))??'';
        if(String(item.text).startsWith(before)&&String(item.text).length>before.length)write('delta',{...item,text:String(item.text).slice(before.length),offset:before.length});
        delivered.set(String(item.stream_id),String(item.text));
      }
      const serialized = JSON.stringify(items);
      if (serialized !== previousSnapshots) { write('streams',{items}); previousSnapshots = serialized; }
      if (scope === 'conversation') {
        const result = await db.query(`SELECT status,error FROM (
          SELECT status,error,created_at FROM conversation_runs WHERE conversation_id=$1
          UNION ALL SELECT status,error,created_at FROM finding_retests WHERE conversation_id=$1
        ) r ORDER BY created_at DESC LIMIT 1`,[scopeID]);
        const status = JSON.stringify(result.rows[0] ?? {status:'idle'});
        if (status !== previousStatus) { write('run_status',JSON.parse(status)); previousStatus = status; }
      }
    } catch { raw.end(); }
    finally { polling = false; }
  };
  const timer = setInterval(() => void poll(),100);
  const ping = setInterval(() => raw.write(': ping\n\n'),15000);
  const close = () => {closed=true;clearInterval(timer);clearInterval(ping);connectionsForServer?.delete(raw);};
  raw.on('close',close);raw.on('error',close);
  await poll();
}
