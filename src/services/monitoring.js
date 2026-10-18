'use strict';
const {randomUUID} = require('node:crypto');
const {fail} = require('../errors');
const v = require('../validation');
const {token,hash} = require('../security');

const statusLabel = level => ({ok:'NORMAL',warn:'WARN',bad:'DANGER',unknown:'UNKNOWN'}[level]);
function alarmLevel(data,thresholds) {
  if(data.flame===true || ['temperature','smoke','gas'].some(k=>data[k]!==null&&data[k]>thresholds[k==='temperature'?'temp':k].danger))return 'bad';
  if(v.kinds.some(k=>data[k]===null))return 'unknown';
  if(['temperature','smoke','gas'].some(k=>data[k]>thresholds[k==='temperature'?'temp':k].warn))return 'warn';
  return 'ok';
}
function createMonitoring(db,config,io,now=Date.now) {
  let demo=null,maintenance=Promise.resolve();
  const getThresholds=async tx=>JSON.parse((await tx.get('SELECT value FROM settings WHERE key=?',['thresholds'])).value);
  const audit=(tx,user,action,target)=>tx.run('INSERT INTO audit_logs(user_id,action,target,created_at) VALUES (?,?,?,?)',[user,action,target,now()]);
  async function event(tx,{deviceId=null,readingId=null,level,code,message,source='ESP32_HARDWARE'}) {
    return tx.run('INSERT INTO event_logs(timestamp,level,message,device_id,reading_id,source,code) VALUES (?,?,?,?,?,?,?)',
      [new Date(now()).toISOString(),level,message,deviceId,readingId,source,code]);
  }
  function connection(device) {
    if(!device.enabled||!device.last_seen)return 'offline';
    const age=now()-device.last_seen;return age>=config.offlineMs?'offline':age>=config.staleMs?'stale':'online';
  }
  function snapshot(device,row) {
    const connected=connection(device);
    const stale=!row||connected!=='online'||now()-Date.parse(row.measured_at||row.timestamp)>config.staleMs;
    return {
      deviceId:device.id,deviceName:device.name,readingId:row?.id??null,temperature:row?.temperature??null,smoke:row?.smoke??null,gas:row?.gas??null,
      flame:row?.flame===null||row?.flame===undefined?null:Boolean(row.flame),fire:false,
      level:stale?'unknown':device.alarm_level,lastKnownLevel:device.alarm_level,source:'ESP32_HARDWARE',demo:false,
      esp32Connected:connected==='online',connectionStatus:connected,dataStale:stale,
      lastEsp32Ping:device.last_seen?new Date(device.last_seen).toISOString():null,
      measuredAt:row?.measured_at??null,receivedAt:row?.received_at?new Date(row.received_at).toISOString():null,
      sensorHealth:row?.sensor_health?JSON.parse(row.sensor_health):null,sequence:row?.sequence??null,
      aiResult:{hasFire:null,confidence:null,available:false,statusText:'AI chưa có kết quả cho thiết bị này'}
    };
  }
  async function status(deviceId=null) {
    return db.read(async tx=>{
      const devices=await tx.all('SELECT id,name,location,enabled,created_at,last_seen,last_sequence,last_measured_at,alarm_level,connection_status FROM devices ORDER BY created_at,id');
      const latest=await tx.all('SELECT s.* FROM sensor_logs s WHERE s.id=(SELECT id FROM sensor_logs WHERE device_id=s.device_id ORDER BY id DESC LIMIT 1)');
      const list=devices.map(d=>({...d,enabled:Boolean(d.enabled),connectionStatus:connection(d),state:snapshot(d,latest.find(r=>r.device_id===d.id))}));
      if(deviceId&&!list.some(d=>d.id===deviceId))fail(404,'DEVICE_NOT_FOUND','Device not found');
      const priority={bad:0,warn:1,unknown:2,ok:3};
      const selected=deviceId?list.find(d=>d.id===deviceId):[...list].filter(d=>d.enabled).sort((a,b)=>priority[a.state.level]-priority[b.state.level]||(b.last_seen||0)-(a.last_seen||0))[0];
      const empty={temperature:null,smoke:null,gas:null,flame:null,fire:false,level:'unknown',source:'NONE',demo:false,esp32Connected:false,connectionStatus:'offline',dataStale:true,lastEsp32Ping:null,aiResult:{available:false,hasFire:null,confidence:null}};
      return {success:true,state:!deviceId&&demo?{...demo}:selected?.state||empty,devices:list,thresholds:await getThresholds(tx),freshness:{staleMs:config.staleMs,offlineMs:config.offlineMs},capabilities:{demo:config.demoEnabled,ai:'python',thresholdsWritable:true}};
    });
  }
  async function publish(reason,deviceId=null) {
    const payload=await status();await io.emit('sensor_update',{...payload,reason,deviceId});return payload;
  }
  async function register(body,user) {
    v.keys(body,['name','location']);const name=v.text(body.name,'name',1,100),location=body.location===undefined?'':v.text(body.location,'location',0,200);
    const id=randomUUID(),secret=token();
    await db.write(async tx=>{
      await tx.run('INSERT INTO devices(id,name,location,token_hash,created_at) VALUES (?,?,?,?,?)',[id,name,location,hash(secret),now()]);
      for(const kind of v.kinds) {
        const range=v.ranges[kind]||[0,1];await tx.run('INSERT INTO sensors(id,device_id,kind,unit,min_value,max_value) VALUES (?,?,?,?,?,?)',[randomUUID(),id,kind,kind==='temperature'?'C':kind==='flame'?'boolean':'relative_percent',...range]);
      }
      await audit(tx,user,'DEVICE_CREATED',id);
    });
    await publish('device_created',id);return {success:true,device:{id,name,location,enabled:true},deviceToken:secret};
  }
  async function updateDevice(id,body,user) {
    v.id(id);v.keys(body,['name','location','enabled']);if(!Object.keys(body).length)v.invalid('body','At least one field is required');
    if(body.name!==undefined)v.text(body.name,'name',1,100);if(body.location!==undefined)v.text(body.location,'location',0,200);
    if(body.enabled!==undefined&&typeof body.enabled!=='boolean')v.invalid('enabled','Expected boolean');
    await db.write(async tx=>{
      const d=await tx.get('SELECT * FROM devices WHERE id=?',[id]);if(!d)fail(404,'DEVICE_NOT_FOUND','Device not found');
      await tx.run('UPDATE devices SET name=?,location=?,enabled=? WHERE id=?',[body.name?.trim()??d.name,body.location?.trim()??d.location,body.enabled===undefined?d.enabled:Number(body.enabled),id]);
      await audit(tx,user,'DEVICE_UPDATED',id);
    });return publish('device_updated',id);
  }
  async function rotateToken(id,user) {
    v.id(id);const secret=token();
    await db.write(async tx=>{const result=await tx.run('UPDATE devices SET token_hash=? WHERE id=?',[hash(secret),id]);if(!result.changes)fail(404,'DEVICE_NOT_FOUND','Device not found');await audit(tx,user,'DEVICE_TOKEN_ROTATED',id);});
    return {success:true,deviceToken:secret};
  }
  async function ingest(deviceId,body) {
    const receivedAt=now(),data=v.telemetry(body,config,receivedAt);
    if(body.deviceId!==undefined&&body.deviceId!==deviceId)fail(403,'DEVICE_MISMATCH','Token does not belong to the requested device');
    const result=await db.write(async tx=>{
      const device=await tx.get('SELECT * FROM devices WHERE id=? AND enabled=1',[deviceId]);if(!device)fail(401,'DEVICE_UNAUTHENTICATED','Device is disabled or missing');
      if(data.sequence!==null&&device.last_sequence!==null&&data.sequence<=device.last_sequence)fail(409,'SEQUENCE_CONFLICT','Duplicate or out-of-order sequence');
      if(device.last_measured_at&&Date.parse(data.measuredAt)<Date.parse(device.last_measured_at))fail(409,'OUT_OF_ORDER_TELEMETRY','Measured time precedes the last accepted sample');
      const limits=await getThresholds(tx),level=alarmLevel(data,limits);
      const previous=await tx.get('SELECT sensor_health FROM sensor_logs WHERE device_id=? ORDER BY id DESC LIMIT 1',[deviceId]);
      const reading=await tx.run('INSERT INTO sensor_logs(timestamp,temperature,smoke,gas,flame,status,source,device_id,received_at,measured_at,sequence,sensor_health) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [new Date(receivedAt).toISOString(),data.temperature,data.smoke,data.gas,data.flame===null?null:Number(data.flame),statusLabel(level),'ESP32_HARDWARE',deviceId,receivedAt,data.measuredAt,data.sequence,JSON.stringify(data.health)]);
      if(level!==device.alarm_level)await event(tx,{deviceId,readingId:reading.id,level:level==='bad'?'DANGER':level==='ok'?'INFO':'WARN',code:'LEVEL_CHANGED',message:`Device ${deviceId}: ${device.alarm_level} -> ${level} [Nguồn: ESP32_HARDWARE]`});
      if(v.kinds.some(k=>data.health[k]==='fault')&&previous?.sensor_health!==JSON.stringify(data.health))await event(tx,{deviceId,readingId:reading.id,level:'WARN',code:'SENSOR_FAULT',message:`Sensor fault on device ${deviceId} [Nguồn: ESP32_HARDWARE]`});
      if(device.connection_status!=='online')await event(tx,{deviceId,readingId:reading.id,level:'INFO',code:'DEVICE_ONLINE',message:`Device ${deviceId} connected [Nguồn: ESP32_HARDWARE]`});
      await tx.run('UPDATE devices SET last_seen=?,last_sequence=COALESCE(?,last_sequence),last_measured_at=?,alarm_level=?,connection_status=? WHERE id=?',[receivedAt,data.sequence,data.measuredAt,level,'online',deviceId]);
      return {success:true,readingId:reading.id,status:level,alarmActive:level==='unknown'?null:level==='bad',buzzerCommand:level==='bad'?'BUZZER_ON':level==='unknown'?'HOLD':'BUZZER_OFF',ledCommand:level==='bad'?'RED_BLINK':level==='warn'?'YELLOW_ON':level==='unknown'?'FAULT':'GREEN_ON',sensorHealth:data.health};
    });
    await publish('esp32_post',deviceId);return result;
  }
  async function tick() {
    // Prevent timer overlap; all SQLite mutations still go through the connection queue.
    const job=maintenance.then(async()=>{
      const changed=await db.write(async tx=>{
        const devices=await tx.all('SELECT * FROM devices');let updated=false;
        for(const device of devices) {
          const current=connection(device);
          if(current!==device.connection_status) {
            await tx.run('UPDATE devices SET connection_status=? WHERE id=?',[current,device.id]);
            await event(tx,{deviceId:device.id,level:current==='online'?'INFO':'WARN',code:`DEVICE_${current.toUpperCase()}`,message:`Device ${device.id}: ${current}; last readings retained [Nguồn: ESP32_HARDWARE]`});updated=true;
          }
        }return updated;
      });
      // A heartbeat never generates telemetry or writes a fabricated normal value.
      await publish(changed?'connection_changed':'heartbeat');
    });maintenance=job.catch(()=>{});return job;
  }
  async function setThresholds(body,user) {
    const limits=v.thresholds(body);
    await db.write(async tx=>{
      await tx.run('UPDATE settings SET value=? WHERE key=?',[JSON.stringify(limits),'thresholds']);
      for(const d of await tx.all('SELECT * FROM devices')) {
        const row=await tx.get('SELECT * FROM sensor_logs WHERE device_id=? ORDER BY id DESC LIMIT 1',[d.id]);if(!row)continue;
        const level=alarmLevel({...row,flame:row.flame===null?null:Boolean(row.flame)},limits);
        await tx.run('UPDATE devices SET alarm_level=? WHERE id=?',[level,d.id]);
        if(level!==d.alarm_level)await event(tx,{deviceId:d.id,readingId:row.id,level:level==='bad'?'DANGER':level==='ok'?'INFO':'WARN',code:'THRESHOLD_REEVALUATED',message:`Threshold change re-evaluated device ${d.id}: ${level} [Nguồn: ESP32_HARDWARE]`});
      }
      await audit(tx,user,'THRESHOLDS_UPDATED','thresholds');
    });return publish('thresholds_updated');
  }
  async function history(type,query) {
    const {limit,offset,deviceId}=v.pagination(query);
    return db.read(async tx=>{
      const table=type==='events'?'event_logs':'sensor_logs';
      const where=deviceId?' WHERE device_id=?':'';const params=deviceId?[deviceId]:[];
      const total=(await tx.get(`SELECT COUNT(*) count FROM ${table}${where}`,params)).count;
      const rows=await tx.all(`SELECT * FROM ${table}${where} ORDER BY id DESC LIMIT ? OFFSET ?`,[...params,limit,offset]);
      return {success:true,[type==='events'?'logs':'readings']:rows.map(r=>({...r,formatted_time:r.timestamp})),pagination:{limit,offset,total}};
    });
  }
  async function acknowledge(id,user) {
    if(!/^\d+$/.test(id))v.invalid('id','Expected numeric event id');
    await db.write(async tx=>{
      const result=await tx.run('UPDATE event_logs SET acknowledged_by=?,acknowledged_at=? WHERE id=?',[user,now(),id]);
      if(!result.changes)fail(404,'ALERT_NOT_FOUND','Alert not found');await audit(tx,user,'ALERT_ACKNOWLEDGED',id);
    });await io.emit('alerts_changed');return {success:true};
  }
  async function clearLogs(user) {
    await db.write(async tx=>{
      await tx.run('DELETE FROM event_logs');await event(tx,{level:'INFO',code:'LOGS_CLEARED',message:'Alert history cleared by administrator',source:'SYSTEM'});
      await audit(tx,user,'LOGS_CLEARED','event_logs');
    });await io.emit('logs_cleared');return {success:true};
  }
  async function simulate(user) {
    if(!config.demoEnabled)fail(403,'DEMO_DISABLED','Demo mode is disabled');
    await db.write(async tx=>{await event(tx,{level:'DANGER',code:'DEMO_FIRE',message:'DEMO fire simulation [Nguồn: SIMULATION]',source:'SIMULATION'});await audit(tx,user,'DEMO_STARTED','demo');});
    demo={temperature:75,smoke:85,gas:65,flame:true,fire:true,level:'bad',source:'SIMULATION',demo:true,esp32Connected:false,connectionStatus:'demo',dataStale:false,lastEsp32Ping:null,receivedAt:new Date(now()).toISOString(),aiResult:{available:false,hasFire:null,confidence:null}};
    return publish('simulate_fire');
  }
  async function reset(user) {
    if(!demo)fail(409,'NO_ACTIVE_DEMO','Reset only ends an active demo. Acknowledge live alerts without modifying measurements.');
    await db.write(tx=>audit(tx,user,'DEMO_STOPPED','demo'));demo=null;return publish('reset_demo');
  }
  return {status,publish,register,updateDevice,rotateToken,ingest,tick,setThresholds,history,acknowledge,clearLogs,simulate,reset};
}
module.exports={createMonitoring,alarmLevel};
