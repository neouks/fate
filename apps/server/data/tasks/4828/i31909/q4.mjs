import pg from '/Users/pphua/Documents/GitHub/JARVIS/apps/server/node_modules/pg/lib/index.js';
const c=new pg.Client({host:'127.0.0.1',port:5433,user:'series',password:'series',database:'series'});
await c.connect();
const r=await c.query("select column_name,data_type from information_schema.columns where table_name='exploration_nodes' order by ordinal_position");
console.log(r.rows.map(x=>x.column_name+':'+x.data_type).join('\n'));
const n=await c.query("select * from exploration_nodes where exploration_id=5509 order by id");
console.log('=== NODES', n.rows.length);
for(const row of n.rows){ console.log(JSON.stringify(row).slice(0,1200)); }
await c.end();
