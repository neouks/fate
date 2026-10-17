import pg from '/Users/pphua/Documents/GitHub/JARVIS/apps/server/node_modules/pg/lib/index.js';
const c=new pg.Client({host:'127.0.0.1',port:5433,user:'series',password:'series',database:'series'});
await c.connect();
const t=await c.query("select table_name from information_schema.tables where table_schema='public' order by 1");
console.log(t.rows.map(r=>r.table_name).join('\n'));
await c.end();
