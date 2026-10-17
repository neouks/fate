import pg from '/Users/pphua/Documents/GitHub/JARVIS/apps/server/node_modules/pg/lib/index.js';
const c=new pg.Client({host:'127.0.0.1',port:5433,user:'series',password:'series',database:'series'});
await c.connect();
const r=await c.query("select column_name from information_schema.columns where table_name='llm_records' order by ordinal_position");
console.log(r.rows.map(x=>x.column_name).join(','));
const x=await c.query("select id, kind, created_at, substr(request,1,200) req, substr(response,1,1000) resp from llm_records order by id desc limit 6");
for(const row of x.rows) console.log(JSON.stringify(row).slice(0,1800));
await c.end();
