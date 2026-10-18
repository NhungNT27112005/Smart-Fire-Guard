'use strict';
const {randomUUID}=require('node:crypto');
function createAiDetector(config,{now=Date.now,fetchImpl=fetch}={}) {
  const holds=new Map(),pending=new Set();
  const maxAge=config.aiMaxFrameAgeMs??5000,holdMs=config.aiHoldMs??10000;
  const fallback={mode:'sensor_rules',affectsHardware:false};
  const serviceErrors=new Set(['MODEL_NOT_TRUSTED','MODEL_MISSING','MODEL_LOAD_FAILED','MODEL_CLASS_MISMATCH',
    'RESTRICTED_LOADER_UNAVAILABLE','AI_BUSY','STALE_FRAME','STALE_RESULT','AI_ERROR','VALIDATION_ERROR']);
  async function analyzeFrame(imageData,cameraId) {
    const started=now(),frameId=randomUUID(),capturedAt=new Date(started).toISOString();
    const controller=new AbortController();pending.add(controller);
    const timeout=setTimeout(()=>controller.abort(),Math.min(config.aiTimeoutMs,maxAge));
    try {
      const response=await fetchImpl(config.aiUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:imageData,frameId,capturedAt}),signal:controller.signal});
      if(!response.ok) {
        let failure;try {failure=await response.json();}catch {}
        throw Error(serviceErrors.has(failure?.error?.code)?failure.error.code:'AI_HTTP_ERROR');
      }
      const result=await response.json();
      const timestamp=Date.parse(result.capturedAt);
      if(result.available!==true||typeof result.hasFire!=='boolean'||typeof result.confidence!=='number'||!Number.isFinite(result.confidence)||result.confidence<0||result.confidence>100||result.frameId!==frameId||!Number.isFinite(timestamp))throw Error('AI_SCHEMA_ERROR');
      // The Python clock/response cannot turn an old or mismatched image into a new observation.
      if(Math.abs(timestamp-started)>1000||now()-started>=maxAge||now()-timestamp>=maxAge)throw Error('AI_STALE_RESULT');
      if(result.hasFire)holds.set(cameraId,{until:now()+holdMs,at:new Date(now()).toISOString()});
      const previous=holds.get(cameraId),held=!result.hasFire&&(previous?.until??0)>now();
      if(previous&&previous.until<=now())holds.delete(cameraId);
      return {
        available:true,hasFire:result.hasFire||held,observedHasFire:result.hasFire,
        confidence:held?null:result.confidence,held,lastPositiveAt:previous?.at??null,
        frameId,capturedAt,completedAt:result.completedAt??null,model:result.model??null,
        detections:result.detections??[],advisoryOnly:true,demo:false,fallback,
        statusText:held?'AI: previous advisory held; no new positive detection':result.hasFire?'AI: fire/smoke evidence requires verification':'AI: no detection; sensor rules remain active'
      };
    } catch(error) {
      const previous=holds.get(cameraId),held=(previous?.until??0)>now();
      if(previous&&!held)holds.delete(cameraId);
      return {available:false,hasFire:null,observedHasFire:null,confidence:null,held,
        lastPositiveAt:previous?.at??null,frameId,capturedAt,advisoryOnly:true,demo:false,fallback,
        reason:serviceErrors.has(error.message)||['AI_SCHEMA_ERROR','AI_STALE_RESULT','AI_HTTP_ERROR'].includes(error.message)?error.message:controller.signal.aborted?'AI_TIMEOUT':'AI_UNAVAILABLE',
        statusText:held?'AI unavailable; retaining previous advisory. Sensor rules remain active':'AI unavailable; sensor rules remain active'};
    } finally {clearTimeout(timeout);pending.delete(controller);}
  }
  return {analyzeFrame,release:id=>holds.delete(id),close:()=>{for(const c of pending)c.abort();holds.clear();}};
}
module.exports={createAiDetector};
