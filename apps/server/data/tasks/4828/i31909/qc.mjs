import pg from '/Users/pphua/Documents/GitHub/JARVIS/apps/server/node_modules/pg/lib/index.js';
const c=new pg.Client({host:'127.0.0.1',port:5433,user:'series',password:'series',database:'series'});
await c.connect();
const show=async(label,sql)=>{try{const r=await c.query(sql);console.log('=== '+label+' ('+r.rows.length+')');for(const row of r.rows)console.log(JSON.stringify(row).slice(0,900));}catch(e){console.log('=== '+label+' ERR '+e.message);}};
await show('fact 31944','select id,exploration_id,payload from exploration_nodes where id=31944');
await show('JsonParseException','select id,exploration_id,payload from exploration_nodes where payload::text ilike \'%JsonParseException%\' limit 5');
await show('register disabled','select id,exploration_id,payload from exploration_nodes where payload::text ilike \'%注册功能%\' limit 5');
await show('captcha','select id,exploration_id,payload from exploration_nodes where payload::text ilike \'%验证码已失效%\' limit 5');
await c.end();
