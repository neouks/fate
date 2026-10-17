import pg from '/Users/pphua/Documents/GitHub/JARVIS/apps/server/node_modules/pg/lib/index.js';
const c=new pg.Client({host:'127.0.0.1',port:5433,user:'series',password:'series',database:'series'});
await c.connect();
const show=async(label,sql)=>{try{const r=await c.query(sql);console.log('=== '+label+' ('+r.rows.length+')');for(const row of r.rows)console.log(JSON.stringify(row).slice(0,1200));}catch(e){console.log('=== '+label+' ERR '+e.message);}};
await show('findings cols','select column_name from information_schema.columns where table_name=\'findings\' order by ordinal_position');
await show('findings','select id,title,severity,status,task_id,created_at from findings order by id desc limit 20');
await show('facts actuator','select id,exploration_id,payload from exploration_nodes where kind=\'fact\' and payload::text ilike \'%actuator%\' order by id desc limit 10');
await show('facts 4828-like','select id,exploration_id,payload from exploration_nodes where kind=\'fact\' and payload::text ilike \'%144.123.22.234%\' order by id desc limit 10');
await c.end();
