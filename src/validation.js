'use strict';
const {fail} = require('./errors');
const ranges = {temperature:[-40,125],smoke:[0,100],gas:[0,100]};
const kinds = [...Object.keys(ranges),'flame'];
const roles = ['viewer','operator','admin'];
const invalid = (field,message) => fail(400,'VALIDATION_ERROR','Request validation failed',[{field,message}]);
function object(value, field='body') {
  if (!value || Array.isArray(value) || typeof value !== 'object') invalid(field,'Must be an object');
  return value;
}
function keys(value, allowed) { object(value); for(const k of Object.keys(value)) if(!allowed.includes(k))invalid(k,'Unknown field'); }
function text(value, field, min=1, max=100) {
  if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)invalid(field,`Must contain ${min}–${max} characters`);
  return value.trim();
}
function password(value) {if(typeof value!=='string'||value.length<12||value.length>128)invalid('password','Must contain 12–128 characters');return value;}
function username(value) {if(typeof value!=='string'||!/^[a-zA-Z0-9_.-]{3,64}$/.test(value))invalid('username','Use 3–64 letters, numbers, _, . or -');return value.toLowerCase();}
function id(value, field='id') { if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(value))invalid(field,'Invalid identifier');return value; }
function role(value) {if(!roles.includes(value))invalid('role','Expected viewer, operator or admin');return value;}
function pagination(query) {
  keys(query,['limit','offset','deviceId']);
  const number=(value,f,fallback,max)=>{if(value===undefined)return fallback;if(typeof value!=='string'||!/^\d+$/.test(value)||Number(value)>max)invalid(f,`Expected integer 0–${max}`);return Number(value);};
  const limit=number(query.limit,'limit',50,200);if(limit===0)invalid('limit','Must be positive');
  return {limit,offset:number(query.offset,'offset',0,1000000),deviceId:query.deviceId===undefined?null:id(query.deviceId,'deviceId')};
}
function telemetry(body, config, now) {
  keys(body,[...kinds,'deviceId','measuredAt','sequence','health']);
  const health=body.health===undefined?{}:object(body.health,'health');keys(health,kinds);
  const values={},quality={};
  for(const kind of kinds) {
    const status=health[kind]??'ok';if(!['ok','fault'].includes(status))invalid(`health.${kind}`,'Expected ok or fault');
    quality[kind]=status;
    if(status==='fault') {if(body[kind]!==null)invalid(kind,'Faulty sensors must send null');values[kind]=null;continue;}
    const v=body[kind];
    if(kind==='flame') {if(![true,false,0,1].includes(v))invalid(kind,'Expected boolean or integer 0/1');values[kind]=Boolean(v);}
    else {const [min,max]=ranges[kind];if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)invalid(kind,`Expected finite number ${min}–${max}`);values[kind]=v;}
  }
  let measuredAt=now;
  if(body.measuredAt!==undefined) {
    if(typeof body.measuredAt!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(body.measuredAt)||!Number.isFinite(Date.parse(body.measuredAt)))invalid('measuredAt','Expected ISO 8601 timestamp with timezone');
    measuredAt=Date.parse(body.measuredAt);
    if(now-measuredAt>=config.telemetryMaxAgeMs)fail(422,'STALE_TELEMETRY','Telemetry is too old');
    if(measuredAt-now>config.clockSkewMs)invalid('measuredAt','Timestamp is too far in the future');
  }
  if(body.sequence!==undefined&&(!Number.isSafeInteger(body.sequence)||body.sequence<0))invalid('sequence','Expected non-negative safe integer');
  if(body.deviceId!==undefined)id(body.deviceId,'deviceId');
  return {...values,health:quality,measuredAt:new Date(measuredAt).toISOString(),sequence:body.sequence??null};
}
function thresholds(body) {
  keys(body,['temp','smoke','gas']);const result={};
  for(const [key,range] of [['temp',ranges.temperature],['smoke',ranges.smoke],['gas',ranges.gas]]) {
    const pair=object(body[key],key);keys(pair,['warn','danger']);
    if(!Number.isFinite(pair.warn)||!Number.isFinite(pair.danger)||pair.warn<range[0]||pair.danger>range[1]||pair.warn>=pair.danger)invalid(key,'Expected warn < danger within sensor range');
    result[key]={warn:pair.warn,danger:pair.danger};
  }
  return result;
}
module.exports={object,keys,text,password,username,id,role,pagination,telemetry,thresholds,ranges,kinds,invalid};
