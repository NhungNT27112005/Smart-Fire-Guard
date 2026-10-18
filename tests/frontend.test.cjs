/* Runtime checks without a browser dependency. No production server/database is opened. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const limits = {temp:{warn:45,danger:60},gas:{warn:30,danger:60},smoke:{warn:30,danger:60}};

function harness({httpError=false, socketEnabled=true}={}) {
  const elements = new Map(), callbacks = {}, intervals = [], persisted = new Map(), listeners={};
  let now = Date.now(), fail = httpError;
  class Element {
    constructor(id='') {
      this.id=id; this.textContent=''; this.value=''; this.hidden=false;
      this.dataset={}; this.attributes={}; this.disabled=false;
      const classes=new Set();
      this.classList={contains:c=>classes.has(c),toggle:(c,v)=>{v=v??!classes.has(c);v?classes.add(c):classes.delete(c);return v;}};
    }
    set innerHTML(value) {
      this.markup=value;
      for(const m of value.matchAll(/id="([^"]+)"[^>]*?(?:value="([^"]*)")?[^>]*>/g)) {
        if(!elements.has(m[1]))elements.set(m[1],new Element(m[1]));
        const tag=m[0],val=/value="([^"]*)"/.exec(tag);
        if(val)elements.get(m[1]).value=val[1];
      }
    }
    get innerHTML(){return this.markup||'';}
    setAttribute(k,v){this.attributes[k]=v;}
    removeAttribute(k){delete this.attributes[k];}
    replaceChildren(...items){this.textContent=items.map(i=>i.textContent||'').join('');}
    querySelector(){return anchors[0];}
    querySelectorAll(){return anchors;}
    focus(){document.activeElement=this;}
    click(){}
  }
  for(const m of html.matchAll(/id="([^"]+)"/g))elements.set(m[1],new Element(m[1]));
  elements.get('log-filter').value='all';
  const anchors=[...html.matchAll(/data-page="([^"]+)"/g)].map(m=>{const el=new Element();el.dataset.page=m[1];return el;});
  const views=['overview','sensors','devices','camera','alerts','history','settings'].map(id=>elements.get(id));
  const document={
    documentElement:new Element(),hidden:false,activeElement:null,
    getElementById:id=>elements.get(id)||null,
    querySelectorAll:selector=>selector==='.view'?views:selector==='#nav a'?anchors:[],
    createElement:()=>new Element(),createTextNode:text=>({textContent:text}),addEventListener(){}
  };
  const window={
    matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener:(event,fn)=>{listeners[event]=fn;},confirm:()=>false,
    io:socketEnabled?()=>({connected:true,on:(name,fn)=>callbacks[name]=fn,emit(){}}):undefined
  };
  class FakeDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context={
    document,window,location:{origin:'http://localhost:4318',hash:''},navigator:{},
    localStorage:{getItem:k=>persisted.get(k)??null,setItem:(k,v)=>persisted.set(k,v)},
    setTimeout:()=>1,clearTimeout(){},setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval(){},
    fetch:async url=>({ok:url==='/api/auth/me'||!fail,status:url==='/api/auth/me'?200:fail?503:200,json:async()=>url==='/api/auth/me'?{success:true,user:{id:'test-admin',username:'admin',role:'admin'},csrfToken:'test-csrf'}:url==='/api/status'?{success:true,thresholds:limits,state:{temperature:0,smoke:0,gas:0,flame:false,level:'ok',source:'SIMULATION',esp32Connected:false}}:{success:true,logs:[]}}),
    AbortController,Date:FakeDate,Intl,console,URL,Blob
  };
  // Expose closures only in the VM copy, leaving the shipped browser script unchanged.
  vm.runInNewContext(script.replace(/\}\)\(\);\s*$/, `globalThis.qa={render,renderCharts,renderLogs,acceptState,overall,fetchStatus,fetchLogs,sourceText,
    get samples(){return samples;},set logs(value){logs=value;},set server(value){serverOnline=value;},set camera(value){stream=value;}};})();`),context);
  return {context,ui:id=>elements.get(id),callbacks,intervals,persisted,listeners,
    api:context.qa,advance:ms=>{now+=ms;},setFailure:value=>{fail=value;},settle:async()=>{for(let i=0;i<40;i++)await Promise.resolve();}};
}

test('HTML routes and static assets exist; no garbled Vietnamese or duplicate IDs',()=>{
  const ids=[...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length);
  assert.ok(html.includes('Tổng quan hệ thống'));
  assert.ok(!html.includes('?'));
  for(const file of ['public/css/style.css','public/js/app.js'])assert.ok(fs.existsSync(path.join(root,file)));
});

test('initial loading, zero values, DEMO labels and threshold preview',async()=>{
  const h=harness();
  assert.match(h.ui('overview-chart').innerHTML,/Chưa có dữ liệu/);
  await h.settle();
  assert.match(h.ui('metrics').innerHTML,/0\.0<small>°C/);
  assert.ok(!h.ui('metrics').innerHTML.includes('32<'));
  assert.equal(h.ui('source-banner').hidden,false);
  assert.equal(h.api.overall(),'ok');
  assert.match(h.ui('threshold-table').innerHTML,/45°C/);
  h.ui('temperature-warn').value='70'; h.ui('temperature-danger').value='60';
  h.ui('threshold-preview').onsubmit({preventDefault(){}});
  assert.match(h.ui('preview-result').textContent,/WARN phải nhỏ hơn DANGER/);
});

test('invalid sensors never imply a healthy environment; sensor history remains bounded',async()=>{
  const h=harness(); await h.settle();
  h.api.acceptState({temperature:null,gas:-1,smoke:'bad',flame:null,level:'ok',source:'SIMULATION',esp32Connected:false});
  assert.equal(h.api.overall(),'unknown');
  assert.match(h.ui('sensor-health').innerHTML,/Dữ liệu thiếu \/ không hợp lệ/);
  for(let i=0;i<130;i++){h.advance(1500);h.api.acceptState({temperature:i%80,smoke:0,gas:0,flame:false,level:'ok',source:'SIMULATION',esp32Connected:false});}
  assert.equal(h.api.samples.length,120);
  assert.match(h.ui('overview-chart').innerHTML,/stroke-dasharray/);
  assert.match(h.ui('sensor-rows').innerHTML,/DEMO/);
});

test('server disconnect and old hardware ping show unknown, without erasing last values',async()=>{
  const h=harness();await h.settle();
  h.api.acceptState({temperature:26,smoke:0,gas:0,flame:false,level:'ok',esp32Connected:true,source:'ESP32_HARDWARE',lastEsp32Ping:new h.context.Date().toISOString()});
  assert.equal(h.api.overall(),'ok');
  assert.equal(h.ui('device-status').textContent,'Trực tuyến');
  h.advance(13000);h.api.render();
  assert.equal(h.api.overall(),'unknown');
  assert.equal(h.ui('connection-banner').hidden,false);
  h.callbacks.disconnect();
  assert.match(h.ui('server-status').textContent,/Mất kết nối/);
  assert.match(h.ui('metrics').innerHTML,/26\.0/);
});

test('event messages escape HTML, source remains explicit, filtering has an empty state',async()=>{
  const h=harness();await h.settle();
  h.api.logs=[{level:'DANGER',message:'<img src=x onerror=alert(1)> [Nguồn: SIMULATION]',formatted_time:'2026-10-18'}];h.api.renderLogs();
  assert.match(h.ui('event-rows').innerHTML,/&lt;img/);
  assert.ok(!h.ui('event-rows').innerHTML.includes('<img'));
  assert.match(h.ui('event-rows').innerHTML,/DEMO/);
  h.ui('log-filter').value='WARN';h.api.renderLogs();
  assert.match(h.ui('event-rows').innerHTML,/Không có sự kiện phù hợp/);
});

test('HTTP failures render error and empty states; refresh recovers',async()=>{
  const h=harness({httpError:true,socketEnabled:false});await h.settle();
  assert.equal(h.api.overall(),'unknown');
  assert.match(h.ui('log-feedback').textContent,/HTTP 503/);
  assert.match(h.ui('event-rows').innerHTML,/Không tải được nhật ký/);
  h.setFailure(false);await h.api.fetchStatus();await h.api.fetchLogs();
  assert.equal(h.api.overall(),'ok');assert.equal(h.ui('log-feedback').textContent,'');
});

test('device label persists locally; theme and hash navigation work without backend writes',async()=>{
  const h=harness();await h.settle();
  h.ui('device-name-input').value='ESP32 Lab';h.ui('device-location-input').value='Lab A';
  h.ui('device-form').onsubmit({preventDefault(){}});
  assert.equal(h.persisted.get('fg-device-name'),'ESP32 Lab');
  assert.equal(h.ui('device-row-name').textContent,'ESP32 Lab');
  h.ui('theme-select').onchange({target:{value:'dark'}});
  assert.equal(h.context.document.documentElement.dataset.theme,'dark');
  assert.equal(h.persisted.get('fg-theme'),'dark');
  for(const page of ['overview','sensors','devices','camera','alerts','history','settings']) {
    h.context.location.hash='#'+page;h.listeners.hashchange();
    assert.equal(h.ui(page).hidden,false);
    for(const other of ['overview','sensors','devices','camera','alerts','history','settings'].filter(p=>p!==page))assert.equal(h.ui(other).hidden,true);
  }
});

test('late HTTP status cannot overwrite newer socket telemetry',async()=>{
  const h=harness();await h.settle();let resolve;
  h.context.fetch=()=>new Promise(r=>{resolve=r;});
  const pending=h.api.fetchStatus();
  h.api.acceptState({temperature:75,smoke:85,gas:65,flame:true,level:'bad',esp32Connected:false,source:'SIMULATION'});
  resolve({ok:true,json:async()=>({success:true,state:{temperature:20,smoke:0,gas:0,flame:false,level:'ok'},thresholds:limits})});
  await pending;
  assert.equal(h.api.overall(),'bad');assert.match(h.ui('metrics').innerHTML,/75\.0/);
});

test('camera unsupported state and cancelled control actions do not transmit requests',async()=>{
  const h=harness();await h.settle();let posts=0;
  h.context.fetch=async()=>{posts++;throw Error('Unexpected request');};
  await h.ui('camera-toggle').onclick();
  assert.match(h.ui('camera-status').textContent,/Không thể truy cập webcam/);
  await h.ui('sim').onclick();await h.ui('rst').onclick();await h.ui('clear-log-btn').onclick();
  assert.equal(posts,0);
});

test('camera distinguishes model readiness failures, disconnected service and real inference status',async()=>{
  const h=harness();await h.settle();h.api.camera={};
  h.callbacks.ai_result({available:false,reason:'MODEL_NOT_TRUSTED'});
  assert.match(h.ui('camera-status').textContent,/Model chưa được xác minh/);
  h.callbacks.ai_result({available:false,reason:'AI_UNAVAILABLE'});
  assert.match(h.ui('camera-status').textContent,/npm run start:ai/);
  h.callbacks.ai_result({available:true,hasFire:false,confidence:0});
  assert.match(h.ui('camera-status').textContent,/Không phát hiện trong ảnh/);
  assert.match(h.ui('camera-status').textContent,/chưa được đánh giá/);
  assert.doesNotMatch(h.ui('camera-status').textContent,/AI không khả dụng/);
});
