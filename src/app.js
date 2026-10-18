'use strict';
const express=require('express');
const http=require('node:http');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Server}=require('socket.io');
const {loadConfig}=require('./config');
const {openDatabase}=require('./database');
const {createSecurity,rateLimit}=require('./security');
const {createMonitoring}=require('./services/monitoring');
const {createUsers}=require('./services/users');
const {createApi}=require('./routes/api');
const {createAiDetector}=require('./ai-detector');
const {AppError}=require('./errors');

async function createApplication({config=loadConfig(),now=Date.now,aiDetector,logger=console}={}) {
  const db=await openDatabase(config.databasePath);
  let io,server,timer,closing=false;
  try {
    const security=await createSecurity(db,config,now),app=express();server=http.createServer(app);
    const allowed=origin=>!origin||config.origins.includes(origin);
    io=new Server(server,{
      maxHttpBufferSize:512*1024,
      cors:{origin:(origin,callback)=>callback(null,allowed(origin)),credentials:true,methods:['GET','POST']},
      allowRequest:(req,callback)=>{
        if(!allowed(req.headers.origin)||io.engine.clientsCount>=100)return callback(null,false);
        security.getSession(req.headers).then(session=>callback(null,Boolean(session))).catch(()=>callback(null,false));
      }
    });
    app.disable('x-powered-by');
    app.use((req,res,next)=>{
      req.requestId=randomUUID();res.setHeader('X-Request-ID',req.requestId);
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
      const socketSources=config.origins.map(origin=>origin.replace(/^http/,'ws')).join(' ');
      res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${socketSources}; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
      if(config.production)res.setHeader('Strict-Transport-Security','max-age=31536000');
      const origin=req.headers.origin;
      if(!allowed(origin))return next(new AppError(403,'ORIGIN_FORBIDDEN','Origin is not allowed'));
      if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS') {res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,X-CSRF-Token');return res.sendStatus(204);}
      next();
    });
    app.use('/api',rateLimit({limit:config.apiLimit,now}));
    app.use(express.json({limit:'16kb',strict:true}));
    const bus={async emit(event,payload) {
      for(const socket of io.sockets.sockets.values()) {
        if(await security.getSession(socket.request.headers))socket.emit(event,payload);
        else socket.disconnect(true);
      }
    }};
    const monitoring=createMonitoring(db,config,bus,now),users=createUsers(db,now),detector=aiDetector||createAiDetector(config);
    app.use('/api',createApi({db,security,monitoring,users,config,io,now}));
    app.use(express.static(path.join(__dirname,'..','public')));
    app.use((req,res,next)=>next(new AppError(404,'NOT_FOUND','Resource not found')));
    app.use((err,req,res,next)=>{
      if(res.headersSent)return next(err);
      let status=err.status||500,code=err.code||'INTERNAL_ERROR',message=err.message;
      if(err.type==='entity.parse.failed'){status=400;code='INVALID_JSON';message='Malformed JSON body';}
      if(err.type==='entity.too.large'){status=413;code='PAYLOAD_TOO_LARGE';message='Request body exceeds the size limit';}
      if(status>=500){logger.error({requestId:req.requestId,code:err.code||'INTERNAL_ERROR',message:err.message});code='INTERNAL_ERROR';message='An internal error occurred';}
      res.status(status).json({success:false,error:{code,message,...(err.details?{details:err.details}:{})},requestId:req.requestId});
    });
    io.use(async(socket,next)=>{
      try {
        const session=await security.getSession(socket.request.headers);
        if(!session)return next(Error('UNAUTHENTICATED'));
        socket.data.userId=session.id;socket.data.sessionHash=session.token_hash;socket.data.expiresAt=session.expires_at;
        next();
      } catch {next(Error('UNAUTHENTICATED'));}
    });
    io.on('connection',socket=>{
      socket.join(`session:${socket.data.sessionHash}`);
      let busy=false,lastFrame=-Infinity;
      socket.on('analyze_ai_frame',async payload=>{
        try {
          const session=await security.getSession(socket.request.headers);
          if(!session){socket.disconnect(true);return;}
          if(!['admin','operator'].includes(session.role))return socket.emit('ai_error',{code:'FORBIDDEN',message:'Operator role required'});
          if(busy||now()-lastFrame<2000)return socket.emit('ai_error',{code:'RATE_LIMITED',message:'One frame per two seconds'});
          if(!payload||typeof payload.image!=='string'||payload.image.length>450000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(payload.image))return socket.emit('ai_error',{code:'VALIDATION_ERROR',message:'Expected bounded JPEG data URL'});
          busy=true;lastFrame=now();
          const result=await detector.analyzeFrame(payload.image,socket.id);
          const active=await security.getSession(socket.request.headers);
          if(active&&socket.connected)socket.emit('ai_result',result);
        } catch {socket.emit('ai_error',{code:'AI_UNAVAILABLE',message:'AI service is unavailable'});}
        finally {busy=false;if(!socket.connected)detector.release?.(socket.id);}
      });
      socket.on('disconnect',()=>detector.release?.(socket.id));
    });
    async function tick() {
      // Passive subscribers must also lose access when sessions expire or are revoked.
      for(const socket of io.sockets.sockets.values()) {
        if(!await security.getSession(socket.request.headers))socket.disconnect(true);
      }
      await monitoring.tick();
    }
    async function start(port=config.port,host=config.host) {
      await new Promise((resolve,reject)=>{
        const error=err=>{server.off('listening',ready);reject(err);};
        const ready=()=>{server.off('error',error);resolve();};
        server.once('error',error);server.once('listening',ready);server.listen(port,host);
      });
      let ticking=false;
      timer=setInterval(async()=>{if(ticking||closing)return;ticking=true;try{await tick();}catch(err){logger.error({code:'MAINTENANCE_FAILED',message:err.message});}finally{ticking=false;}},1000);
      timer.unref();return server.address();
    }
    async function close() {
      if(closing)return;closing=true;clearInterval(timer);
      detector.close?.();
      await new Promise(resolve=>io.close(resolve));
      if(server.listening)await new Promise(resolve=>server.close(resolve));
      await db.close();
    }
    return {app,server,io,db,security,monitoring,config,start,close,tick};
  } catch(err){clearInterval(timer);if(io)io.close();if(server?.listening)server.close();await db.close().catch(()=>{});throw err;}
}
module.exports={createApplication};
