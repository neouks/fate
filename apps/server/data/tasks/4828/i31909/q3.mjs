import pg from '/Users/pphua/Documents/GitHub/JARVIS/apps/server/node_modules/pg/lib/index.js';
const c=new pg.Client({host:'127.0.0.1',port:5433,user:'series',password:'series',database:'series'});
await c.connect();
const show=async(label,sql,p=[])=>{try{const r=await c.query(sql,p);console.log('=== '+label);console.log(JSON.stringify(r.rows,null,1).slice(0,5000));}catch(e){console.log('=== '+label+' ERR '+e.message);}};
await show('exploration 5509','select * from explorations where id=5509');
await show('nodes 5509','select id,type,payload,status,created_at from exploration_nodes where exploration_id=5509 order by id');
await show('cols nodes','select column_name from information_schema.columns where table_name=:t',[]);
await c.end();
