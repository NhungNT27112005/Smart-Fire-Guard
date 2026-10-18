'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAiDetector}=require('../src/ai-detector');
const {alarmLevel}=require('../src/services/monitoring');
const thresholds={temp:{warn:45,danger:60},smoke:{warn:30,danger:60},gas:{warn:30,danger:60}};

// All responses below are explicit DEMO unit fixtures, not measured model outputs.
function harness() {
  let time=Date.parse('2026-10-18T10:00:00Z'),positive=true,mode='ok';
  const config={aiUrl:'http://unit.test/detect',aiTimeoutMs:10,aiMaxFrameAgeMs:5000,aiHoldMs:10000};
  const detector=createAiDetector(config,{now:()=>time,fetchImpl:async(url,options)=>{
    const request=JSON.parse(options.body);
    if(mode==='network')throw Error('Connection refused');
    if(mode==='timeout')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
    if(mode==='http')return {ok:false,status:503};
    if(mode==='blocked')return {ok:false,status:503,json:async()=>({error:{code:'MODEL_NOT_TRUSTED'}})};
    if(mode==='unsupported-loader')return {ok:false,status:503,json:async()=>({error:{code:'RESTRICTED_LOADER_UNAVAILABLE'}})};
    if(mode==='late')time+=6000;
    return {ok:true,json:async()=>({available:mode!=='unavailable',frameId:mode==='mismatch'?'wrong':request.frameId,
      capturedAt:request.capturedAt,hasFire:mode==='schema'?'false':positive,confidence:positive?80:0,
      advisoryOnly:true,detections:[],model:{validationStatus:'DEMO_TEST_FIXTURE'}})};
  }});
  return {detector,advance:ms=>time+=ms,setPositive:value=>positive=value,setMode:value=>mode=value};
}

test('AI advisory hold is camera-scoped; a held negative has no invented score',async()=>{
  const h=harness();
  const positive=await h.detector.analyzeFrame('DEMO_IMAGE','camera-a');
  assert.equal(positive.available,true);assert.equal(positive.observedHasFire,true);
  h.setPositive(false);
  const held=await h.detector.analyzeFrame('DEMO_IMAGE','camera-a');
  assert.equal(held.held,true);assert.equal(held.confidence,null);assert.equal(held.observedHasFire,false);
  assert.equal((await h.detector.analyzeFrame('DEMO_IMAGE','camera-b')).hasFire,false);
  h.detector.release('camera-a');assert.equal((await h.detector.analyzeFrame('DEMO_IMAGE','camera-a')).hasFire,false);
  h.detector.close();
});

test('AI failure is unknown, retains an unexpired advisory and never commands hardware',async()=>{
  const h=harness();await h.detector.analyzeFrame('DEMO_IMAGE','a');h.setMode('network');
  const unavailable=await h.detector.analyzeFrame('DEMO_IMAGE','a');
  assert.equal(unavailable.available,false);assert.equal(unavailable.hasFire,null);assert.equal(unavailable.held,true);
  assert.equal(unavailable.fallback.mode,'sensor_rules');assert.equal(unavailable.fallback.affectsHardware,false);
  h.advance(10001);assert.equal((await h.detector.analyzeFrame('DEMO_IMAGE','a')).held,false);
  h.detector.close();
});

test('HTTP errors, bad schema, wrong frame IDs and late results cannot become safe negatives',async()=>{
  for(const mode of ['http','schema','mismatch','late','unavailable']) {
    const h=harness();h.setPositive(false);h.setMode(mode);
    const result=await h.detector.analyzeFrame('DEMO_IMAGE','a');
    assert.equal(result.available,false,mode);assert.equal(result.hasFire,null,mode);h.detector.close();
  }
});

test('model readiness failures reach the dashboard as specific reasons and unknown results',async()=>{
  for(const [mode,reason] of [['blocked','MODEL_NOT_TRUSTED'],['unsupported-loader','RESTRICTED_LOADER_UNAVAILABLE']]) {
    const h=harness();h.setMode(mode);
    const result=await h.detector.analyzeFrame('DEMO_IMAGE','a');
    assert.equal(result.reason,reason);assert.equal(result.available,false);assert.equal(result.hasFire,null);
    assert.equal(result.fallback.affectsHardware,false);h.detector.close();
  }
});

test('timeout and shutdown cancel pending AI requests without returning no-fire',async()=>{
  const h=harness();h.setMode('timeout');
  const timed=await h.detector.analyzeFrame('DEMO_IMAGE','a');assert.equal(timed.reason,'AI_TIMEOUT');
  const pending=h.detector.analyzeFrame('DEMO_IMAGE','b');h.detector.close();
  const stopped=await pending;assert.equal(stopped.available,false);assert.equal(stopped.hasFire,null);
});

test('sensor danger and fault rules remain independent of positive, negative or missing AI',async()=>{
  const h=harness();
  for(const mode of ['ok','network'])for(const positive of [true,false]) {
    h.setMode(mode);h.setPositive(positive);await h.detector.analyzeFrame('DEMO_IMAGE','a');
    assert.equal(alarmLevel({temperature:70,smoke:0,gas:0,flame:false},thresholds),'bad');
    assert.equal(alarmLevel({temperature:25,smoke:0,gas:0,flame:false},thresholds),'ok');
    assert.equal(alarmLevel({temperature:null,smoke:0,gas:0,flame:false},thresholds),'unknown');
  }h.detector.close();
});
