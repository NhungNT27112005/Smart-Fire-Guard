'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createApplication}=require('../src/app');
const {loadConfig}=require('../src/config');
const {openDatabase}=require('../src/database');

// Generated per test run, never written to source, logs, .env or production data.
const {randomBytes}=require('node:crypto');
const password=()=>randomBytes(20).toString('base64url');
async function removeTestDirectory(dir) {
  const resolved=path.resolve(dir);
  assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved),/^fireguard-(test|migration)-/);
  await fs.rm(resolved,{recursive:true,force:true});
}

async function setup(t,overrides={},injectedDetector=null) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fireguard-test-'));
  let time=Date.parse('2026-10-18T08:00:00Z');
  const adminPassword=password();
  const config={...loadConfig({DATABASE_PATH:path.join(dir,'test.db'),BOOTSTRAP_ADMIN_USERNAME:'admin',BOOTSTRAP_ADMIN_PASSWORD:adminPassword,DEMO_ENABLED:'true',API_RATE_LIMIT:'10000',LOGIN_RATE_LIMIT:'100'}),...overrides};
  const errors=[];
  const app=await createApplication({config,now:()=>time,aiDetector:injectedDetector||{analyzeFrame:async()=>({available:true,hasFire:false,confidence:0,demo:false})},logger:{error:error=>errors.push(error)}});
  const address=await app.start(0);const base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await app.close();await removeTestDirectory(dir);});
  async function call(method,url,{body,session,token,headers={}}={}) {
    const response=await fetch(base+url,{method,signal:AbortSignal.timeout(6000),headers:{...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
    return {status:response.status,headers:response.headers,data:await response.json()};
  }
  async function login(username,pw) {
    const response=await call('POST','/api/auth/login',{body:{username,password:pw}});assert.equal(response.status,200,JSON.stringify(response.data));
    return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:response.data.csrfToken,user:response.data.user};
  }
  const admin=await login('admin',adminPassword);
  async function register(name='Test ESP32') {
    const response=await call('POST','/api/devices',{session:admin,body:{name,location:'Integration lab'}});assert.equal(response.status,201,JSON.stringify(response.data));return response.data;
  }
  return {app,base,dir,config,admin,adminPassword,errors,call,login,register,advance:ms=>{time+=ms;},now:()=>time};
}
const sample=(extra={})=>({temperature:32,smoke:12,gas:5,flame:0,...extra});

async function socket(h,cookie) {
  const headers=cookie?{Cookie:cookie}:{};
  const opening=await fetch(h.base+'/socket.io/?EIO=4&transport=polling',{headers,signal:AbortSignal.timeout(5000)});
  const text=await opening.text();assert.equal(text[0],'0');
  const sid=JSON.parse(text.slice(1)).sid,url=h.base+`/socket.io/?EIO=4&transport=polling&sid=${sid}`;
  async function send(packet) {const res=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body:packet,signal:AbortSignal.timeout(5000)});assert.equal(res.status,200);}
  async function poll(){const res=await fetch(url,{headers,signal:AbortSignal.timeout(5000)});return res.text();}
  await send('40');return {send,poll,handshake:await poll()};
}

test('authentication, CSRF, cookie flags, roles, session revocation and last-admin guard',async t=>{
  const h=await setup(t);
  assert.equal((await h.call('GET','/api/status')).status,401);
  assert.equal((await h.call('POST','/api/devices',{session:{...h.admin,csrf:''},body:{name:'No CSRF'}})).status,403);
  const viewerPw=password(),operatorPw=password();
  const viewer=await h.call('POST','/api/users',{session:h.admin,body:{username:'viewer',password:viewerPw,role:'viewer'}});
  assert.equal(viewer.status,201);
  await h.call('POST','/api/users',{session:h.admin,body:{username:'operator',password:operatorPw,role:'operator'}});
  const session=await h.login('viewer',viewerPw),op=await h.login('operator',operatorPw);
  assert.equal((await h.call('GET','/api/status',{session})).status,200);
  for(const url of ['/api/devices','/api/simulate/fire','/api/logs/clear'])assert.equal((await h.call('POST',url,{session,body:{name:'Denied'}})).status,403);
  assert.equal((await h.call('POST','/api/simulate/fire',{session:op})).status,200);
  assert.equal((await h.call('POST','/api/logs/clear',{session:op})).status,403);
  assert.equal((await h.call('PATCH',`/api/users/${h.admin.user.id}`,{session:h.admin,body:{active:false}})).status,409);
  await h.call('PATCH',`/api/users/${session.user.id}`,{session:h.admin,body:{active:false}});
  assert.equal((await h.call('GET','/api/status',{session})).status,401);
  const response=await h.call('POST','/api/auth/login',{body:{username:'admin',password:h.adminPassword}});
  assert.match(response.headers.get('set-cookie'),/HttpOnly/);assert.match(response.headers.get('set-cookie'),/SameSite=Strict/);
  assert.ok(!JSON.stringify((await h.call('GET','/api/users',{session:h.admin})).data).includes('password_hash'));
  await h.call('POST','/api/auth/logout',{session:h.admin});assert.equal((await h.call('GET','/api/status',{session:h.admin})).status,401);
});

test('registered devices, strict telemetry validation, replay/order controls and token rotation',async t=>{
  const h=await setup(t),one=await h.register('One'),two=await h.register('Two'),token=one.deviceToken;
  assert.equal((await h.call('POST','/api/sensor-data',{body:sample()})).status,401);
  assert.equal((await h.call('POST','/api/sensor-data',{token,body:sample({deviceId:two.device.id})})).status,403);
  for(const body of [sample({temperature:'33'}),sample({flame:'false'}),sample({gas:101}),{},sample({unknown:1}),sample({smoke:null})]) {
    const res=await h.call('POST','/api/sensor-data',{token,body});assert.equal(res.status,400,JSON.stringify(res));assert.equal(res.data.error.code,'VALIDATION_ERROR');
  }
  const before=await h.call('GET',`/api/status?deviceId=${one.device.id}`,{session:h.admin});assert.equal(before.data.state.lastEsp32Ping,null);
  const first=await h.call('POST','/api/sensor-data',{token,body:sample({temperature:0,smoke:0,gas:0,sequence:1})});assert.equal(first.status,200);assert.equal(first.data.alarmActive,false);
  assert.equal((await h.call('POST','/api/sensor-data',{token,body:sample({sequence:1})})).status,409);
  assert.equal((await h.call('POST','/api/sensor-data',{token,body:sample({sequence:2,measuredAt:new Date(h.now()-60000).toISOString()})})).status,422);
  assert.equal((await h.call('POST','/api/sensor-data',{token,body:sample({measuredAt:new Date(h.now()+60000).toISOString()})})).status,400);
  assert.equal((await h.call('POST','/api/sensor-data',{token,body:sample({sequence:2,measuredAt:new Date(h.now()-1000).toISOString()})})).status,409);
  const sensors=await h.call('GET',`/api/devices/${one.device.id}/sensors`,{session:h.admin});assert.equal(sensors.data.sensors.length,4);
  const stored=await h.app.db.read(tx=>tx.get('SELECT token_hash FROM devices WHERE id=?',[one.device.id]));assert.notEqual(stored.token_hash,token);assert.equal(stored.token_hash.length,64);
  const rotated=await h.call('POST',`/api/devices/${one.device.id}/rotate-token`,{session:h.admin});assert.equal(rotated.status,200);
  assert.equal((await h.call('POST','/api/sensor-data',{token,body:sample()})).status,401);
  assert.equal((await h.call('POST','/api/sensor-data',{token:rotated.data.deviceToken,body:sample({sequence:2})})).status,200);
  await h.call('PATCH',`/api/devices/${one.device.id}`,{session:h.admin,body:{enabled:false}});
  assert.equal((await h.call('POST','/api/sensor-data',{token:rotated.data.deviceToken,body:sample()})).status,401);
});

test('real Socket.IO authentication, telemetry delivery and session expiry',async t=>{
  const h=await setup(t),device=await h.register();
  const unauth=await fetch(h.base+'/socket.io/?EIO=4&transport=polling');assert.equal(unauth.status,403);
  const live=await socket(h,h.admin.cookie);assert.match(live.handshake,/40/);
  await h.call('POST','/api/sensor-data',{token:device.deviceToken,body:sample({temperature:75})});
  const update=await live.poll();assert.match(update,/sensor_update/);assert.match(update,/75/);assert.match(update,new RegExp(device.device.id));
  h.advance(h.config.sessionTtlMs+1);await h.app.tick();
  assert.equal(h.app.io.sockets.sockets.size,0);
  assert.equal((await h.call('GET','/api/status',{session:h.admin})).status,401);
});

test('sensor faults, danger precedence, stale/offline transitions, recovery and persisted history',async t=>{
  const h=await setup(t),d=await h.register(),token=d.deviceToken;
  await h.call('POST','/api/sensor-data',{token,body:sample({temperature:null,health:{temperature:'fault'}})});
  let current=(await h.call('GET',`/api/status?deviceId=${d.device.id}`,{session:h.admin})).data.state;
  assert.equal(current.level,'unknown');assert.equal(current.temperature,null);
  const fault=await h.call('POST','/api/sensor-data',{token,body:sample({temperature:null,health:{temperature:'fault'}})});
  assert.equal(fault.data.alarmActive,null);assert.equal(fault.data.buzzerCommand,'HOLD');
  const danger=await h.call('POST','/api/sensor-data',{token,body:sample({temperature:null,smoke:85,health:{temperature:'fault'}})});assert.equal(danger.data.status,'bad');
  h.advance(11000);await h.app.tick();
  current=(await h.call('GET','/api/status',{session:h.admin})).data.state;
  assert.equal(current.connectionStatus,'stale');assert.equal(current.level,'unknown');assert.equal(current.lastKnownLevel,'bad');assert.equal(current.smoke,85);assert.equal(current.source,'ESP32_HARDWARE');
  h.advance(20000);await h.app.tick();assert.equal((await h.call('GET','/api/status',{session:h.admin})).data.state.connectionStatus,'offline');
  const count=(await h.call('GET','/api/sensor-history',{session:h.admin})).data.pagination.total;assert.equal(count,3);
  await h.call('POST','/api/sensor-data',{token,body:sample()});assert.equal((await h.call('GET','/api/status',{session:h.admin})).data.state.connectionStatus,'online');
  const events=(await h.call('GET','/api/logs',{session:h.admin})).data.logs;for(const code of ['SENSOR_FAULT','DEVICE_STALE','DEVICE_OFFLINE','DEVICE_ONLINE'])assert.ok(events.some(e=>e.code===code),code);
  const alert=events.find(e=>e.level==='DANGER');await h.call('POST',`/api/alerts/${alert.id}/acknowledge`,{session:h.admin});
  const acknowledged=(await h.call('GET','/api/logs',{session:h.admin})).data.logs.find(e=>e.id===alert.id);assert.equal(acknowledged.acknowledged_by,h.admin.user.id);
});

test('DEMO and reset never modify hardware or device commands; thresholds persist and re-evaluate',async t=>{
  const h=await setup(t),d=await h.register(),token=d.deviceToken;
  await h.call('POST','/api/sensor-data',{token,body:sample({temperature:70})});
  assert.equal((await h.call('POST','/api/reset',{session:h.admin})).status,409);
  await h.call('POST','/api/simulate/fire',{session:h.admin});
  assert.equal((await h.call('GET','/api/status',{session:h.admin})).data.state.demo,true);
  const response=await h.call('POST','/api/sensor-data',{token,body:sample()});assert.equal(response.data.alarmActive,false);
  await h.call('POST','/api/reset',{session:h.admin});
  assert.equal((await h.call('GET','/api/status',{session:h.admin})).data.state.temperature,32);
  const limits={temp:{warn:25,danger:30},gas:{warn:30,danger:60},smoke:{warn:30,danger:60}};
  assert.equal((await h.call('PUT','/api/thresholds',{session:h.admin,body:{...limits,temp:{warn:60,danger:30}}})).status,400);
  assert.equal((await h.call('PUT','/api/thresholds',{session:h.admin,body:limits})).status,200);
  assert.equal((await h.call('GET','/api/status',{session:h.admin})).data.state.level,'bad');
  const stored=await h.app.db.read(tx=>tx.get('SELECT value FROM settings WHERE key=?',['thresholds']));assert.deepEqual(JSON.parse(stored.value),limits);
});

test('concurrent device ingestion uses isolated snapshots and transactions roll back on storage failure',async t=>{
  const h=await setup(t),a=await h.register('A'),b=await h.register('B');
  const responses=await Promise.all([h.call('POST','/api/sensor-data',{token:a.deviceToken,body:sample({temperature:75})}),h.call('POST','/api/sensor-data',{token:b.deviceToken,body:sample({temperature:20})})]);
  assert.equal(responses[0].data.alarmActive,true);assert.equal(responses[1].data.alarmActive,false);
  for(let i=0;i<2;i++) {
    const row=await h.app.db.read(tx=>tx.get('SELECT * FROM sensor_logs WHERE id=?',[responses[i].data.readingId]));assert.equal(row.device_id,[a,b][i].device.id);assert.equal(row.temperature,[75,20][i]);
  }
  const eventsBefore=(await h.call('GET','/api/logs',{session:h.admin})).data.pagination.total;
  // Fail after both reading and transition INSERTs, proving rollback of earlier writes.
  await h.app.db.write(tx=>tx.exec("CREATE TRIGGER reject_device_update BEFORE UPDATE ON devices BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;"));
  const failed=await h.call('POST','/api/sensor-data',{token:b.deviceToken,body:sample({temperature:80})});assert.equal(failed.status,500);assert.equal(failed.data.error.message,'An internal error occurred');
  const current=(await h.call('GET',`/api/status?deviceId=${b.device.id}`,{session:h.admin})).data.state;assert.equal(current.temperature,20);assert.equal(current.level,'ok');
  assert.equal((await h.call('GET','/api/sensor-history',{session:h.admin})).data.pagination.total,2);assert.equal(h.errors.length,1);
  assert.equal((await h.call('GET','/api/logs',{session:h.admin})).data.pagination.total,eventsBefore);
});

test('uniform JSON errors, hostile origins, bounded bodies, pagination and rate limits',async t=>{
  const h=await setup(t,{deviceLimit:2}),d=await h.register();
  const malformed=await h.call('POST','/api/auth/login',{body:'{broken'});assert.equal(malformed.status,400);assert.equal(malformed.data.error.code,'INVALID_JSON');assert.ok(malformed.data.requestId);
  const huge=await h.call('POST','/api/auth/login',{body:{username:'admin',password:'x'.repeat(20000)}});assert.equal(huge.status,413);
  assert.equal((await h.call('GET','/api/status',{session:h.admin,headers:{Origin:'https://untrusted.invalid'}})).status,403);
  assert.equal((await h.call('GET','/api/logs?limit=100000',{session:h.admin})).status,400);
  assert.equal((await h.call('GET','/api/does-not-exist',{session:h.admin})).status,404);
  await h.call('POST','/api/sensor-data',{token:d.deviceToken,body:sample()});await h.call('POST','/api/sensor-data',{token:d.deviceToken,body:sample()});
  const limited=await h.call('POST','/api/sensor-data',{token:d.deviceToken,body:sample()});assert.equal(limited.status,429);assert.ok(limited.headers.get('retry-after'));
  const health=await h.call('GET','/api/health');assert.equal(health.status,200);assert.equal(health.headers.get('x-powered-by'),null);assert.match(health.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});

test('legacy SQLite migration preserves existing rows and is restart-safe',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fireguard-migration-')),file=path.join(dir,'legacy.db');
  t.after(()=>removeTestDirectory(dir));
  const sqlite3=require('sqlite3');
  const legacy=await new Promise((resolve,reject)=>{const db=new sqlite3.Database(file,error=>error?reject(error):resolve(db));});
  await new Promise((resolve,reject)=>legacy.exec("CREATE TABLE sensor_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,temperature REAL,smoke REAL,gas REAL,flame INTEGER,status TEXT,source TEXT); CREATE TABLE event_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,level TEXT,message TEXT); INSERT INTO sensor_logs(temperature,source) VALUES(38,'SIMULATION'); INSERT INTO event_logs(level,message) VALUES('INFO','legacy');",err=>err?reject(err):resolve()));
  await new Promise(resolve=>legacy.close(resolve));
  for(let i=0;i<2;i++) {
    const db=await openDatabase(file);
    assert.equal((await db.read(tx=>tx.get('SELECT * FROM sensor_logs'))).temperature,38);
    assert.equal((await db.read(tx=>tx.get('SELECT * FROM event_logs'))).message,'legacy');
    assert.equal((await db.read(tx=>tx.get('PRAGMA foreign_keys'))).foreign_keys,1);
    assert.equal((await db.read(tx=>tx.get('PRAGMA user_version'))).user_version,1);
    await db.close();
  }
});

test('restart restores device telemetry, thresholds and login sessions without a new bootstrap password',async t=>{
  const h=await setup(t),device=await h.register();
  await h.call('POST','/api/sensor-data',{token:device.deviceToken,body:sample({temperature:65,sequence:7})});
  await h.app.close();
  const restarted=await createApplication({config:{...h.config,bootstrapUsername:'',bootstrapPassword:''},now:h.now,logger:{error(){}}});
  try {
    await restarted.start(0);
    const response=await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/status`,{headers:{Cookie:h.admin.cookie}});
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.state.temperature,65);assert.equal(body.state.level,'bad');assert.equal(body.state.sequence,7);
    assert.equal(body.devices.length,1);
  } finally {await restarted.close();}
});

test('disabled DEMO, failed login throttling and public payloads do not disclose credentials',async t=>{
  const h=await setup(t,{demoEnabled:false,loginLimit:3}),device=await h.register();
  assert.equal((await h.call('POST','/api/simulate/fire',{session:h.admin})).status,403);
  const status=await h.call('GET','/api/status',{session:h.admin});assert.equal(status.data.state.source,'ESP32_HARDWARE');assert.equal(status.data.state.temperature,null);
  for(const endpoint of ['/api/devices','/api/status','/api/devices/'+device.device.id+'/sensors']) {
    const response=await h.call('GET',endpoint,{session:h.admin}),serialized=JSON.stringify(response.data);
    assert.ok(!serialized.includes(device.deviceToken));assert.ok(!serialized.includes('token_hash'));assert.ok(!serialized.includes('password_hash'));
  }
  for(let i=0;i<2;i++)assert.equal((await h.call('POST','/api/auth/login',{body:{username:'admin',password:'incorrect'}})).status,401);
  assert.equal((await h.call('POST','/api/auth/login',{body:{username:'admin',password:'incorrect'}})).status,429);
  const closed=await h.call('POST','/api/logs/clear',{session:h.admin});assert.equal(closed.status,200);
  assert.equal((await h.call('GET','/api/logs',{session:h.admin})).data.logs.length,1);
  assert.ok((await h.call('GET','/api/audit-logs',{session:h.admin})).data.logs.some(row=>row.action==='LOGS_CLEARED'));
});

test('Socket.IO enforces origin and operator role on frame analysis, with logout disconnect',async t=>{
  const h=await setup(t);
  const denied=await fetch(h.base+'/socket.io/?EIO=4&transport=polling',{headers:{Cookie:h.admin.cookie,Origin:'https://untrusted.invalid'}});assert.equal(denied.status,403);
  const pw=password();await h.call('POST','/api/users',{session:h.admin,body:{username:'socket-viewer',password:pw,role:'viewer'}});
  const viewer=await h.login('socket-viewer',pw),readOnly=await socket(h,viewer.cookie);
  await readOnly.send('42'+JSON.stringify(['analyze_ai_frame',{image:'data:image/jpeg;base64,YQ=='}]));
  assert.match(await readOnly.poll(),/FORBIDDEN/);
  const admin=await socket(h,h.admin.cookie);
  await admin.send('42'+JSON.stringify(['analyze_ai_frame',{image:'data:image/jpeg;base64,YQ=='}]));
  const result=await admin.poll();assert.match(result,/ai_result/);assert.match(result,/available/);
  await h.call('POST','/api/auth/logout',{session:h.admin});
  assert.equal([...h.app.io.sockets.sockets.values()].filter(s=>s.data.userId===h.admin.user.id).length,0);
});

test('configuration rejects insecure production and inconsistent freshness without opening a database',()=>{
  assert.throws(()=>loadConfig({NODE_ENV:'production',COOKIE_SECURE:'false'}),/HTTPS/);
  assert.throws(()=>loadConfig({DEVICE_STALE_SECONDS:'30',DEVICE_OFFLINE_SECONDS:'10'}),/must exceed/);
  assert.throws(()=>loadConfig({TELEMETRY_MAX_AGE_SECONDS:'60'}),/must not exceed/);
  assert.throws(()=>loadConfig({BOOTSTRAP_ADMIN_USERNAME:'admin'}),/Both bootstrap/);
  assert.throws(()=>loadConfig({APP_ORIGINS:'*'}),/APP_ORIGINS/);
});

test('AI positive, negative and unavailable results never activate or clear live hardware rules',async t=>{
  let result={available:true,hasFire:true,confidence:80,advisoryOnly:true};
  const h=await setup(t,{}, {analyzeFrame:async()=>result}),device=await h.register();
  const camera=await socket(h,h.admin.cookie);
  for(const output of [{available:true,hasFire:true,confidence:80},{available:true,hasFire:false,confidence:0},{available:false,hasFire:null,confidence:null}]) {
    result={...output,advisoryOnly:true};h.advance(2000);
    await camera.send('42'+JSON.stringify(['analyze_ai_frame',{image:'data:image/jpeg;base64,YQ=='}]));
    let found=false;
    for(let i=0;i<3&&!found;i++)found=(await camera.poll()).includes('ai_result');
    assert.ok(found);
    const normal=await h.call('POST','/api/sensor-data',{token:device.deviceToken,body:sample()});
    assert.equal(normal.data.alarmActive,false);
    const danger=await h.call('POST','/api/sensor-data',{token:device.deviceToken,body:sample({temperature:70})});
    assert.equal(danger.data.alarmActive,true);
    const current=await h.call('GET','/api/status',{session:h.admin});assert.equal(current.data.state.level,'bad');
  }
});
