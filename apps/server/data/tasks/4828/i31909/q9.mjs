import pg from '/Users/pphua/Documents/GitHub/JARVIS/apps/server/node_modules/pg/lib/index.js';
const c=new pg.Client({host:'127.0.0.1',port:5433,user:'series',password:'series',database:'series'});
await c.connect();
const x=await c.query("select id, task_id, worker, status, ts, substr(response_body,1,6000) resp from llm_records where task_id='4828' order by id desc limit 4");
for(const row of x.rows) console.log(JSON.stringify(row)),console.log('---');
await c.end();
