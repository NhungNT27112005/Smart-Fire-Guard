'use strict';
const express=require('express');
const {asyncRoute}=require('../errors');
const v=require('../validation');
const {rateLimit}=require('../security');

function createApi({db,security,monitoring,users,config,io,now=Date.now}) {
  const router=express.Router(),read=security.user,operator=security.allow('operator','admin'),admin=security.allow('admin');
  const route=(method,path,...handlers)=>router[method](path,...handlers.slice(0,-1),asyncRoute(handlers.at(-1)));
  router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  route('get','/health',async(req,res)=>{await db.read(tx=>tx.get('SELECT 1'));res.json({success:true,status:'ready'});});
  route('post','/auth/login',rateLimit({limit:config.loginLimit,windowMs:15*60000,now}),async(req,res)=>res.json(await security.login(req.body,res)));
  route('get','/auth/me',read,async(req,res)=>res.json({success:true,user:{id:req.user.id,username:req.user.username,role:req.user.role},csrfToken:req.user.csrf_token}));
  route('post','/auth/logout',read,async(req,res)=>{
    await db.write(tx=>tx.run('DELETE FROM sessions WHERE token_hash=?',[req.user.token_hash]));
    security.cookie(res,'',true);io.in(`session:${req.user.token_hash}`).disconnectSockets(true);res.json({success:true});
  });
  route('post','/sensor-data',security.device,rateLimit({limit:config.deviceLimit,now,key:req=>req.device.id}),async(req,res)=>res.json(await monitoring.ingest(req.device.id,req.body)));
  route('get','/status',read,async(req,res)=>{
    v.keys(req.query,['deviceId']);if(req.query.deviceId!==undefined)v.id(req.query.deviceId,'deviceId');
    res.json(await monitoring.status(req.query.deviceId));
  });
  route('get','/devices',read,async(req,res)=>{v.keys(req.query,[]);res.json({success:true,devices:(await monitoring.status()).devices});});
  route('post','/devices',read,admin,async(req,res)=>res.status(201).json(await monitoring.register(req.body,req.user.id)));
  route('patch','/devices/:id',read,admin,async(req,res)=>res.json(await monitoring.updateDevice(req.params.id,req.body,req.user.id)));
  route('post','/devices/:id/rotate-token',read,admin,async(req,res)=>res.json(await monitoring.rotateToken(req.params.id,req.user.id)));
  route('get','/devices/:id/sensors',read,async(req,res)=>{
    v.id(req.params.id);await monitoring.status(req.params.id);
    const sensors=await db.read(tx=>tx.all('SELECT * FROM sensors WHERE device_id=? ORDER BY kind',[req.params.id]));res.json({success:true,sensors});
  });
  route('get','/logs',read,async(req,res)=>res.json(await monitoring.history('events',req.query)));
  route('get','/sensor-history',read,async(req,res)=>res.json(await monitoring.history('readings',req.query)));
  route('post','/alerts/:id/acknowledge',read,operator,async(req,res)=>{v.keys(req.body??{},[]);res.json(await monitoring.acknowledge(req.params.id,req.user.id));});
  route('post','/logs/clear',read,admin,async(req,res)=>{v.keys(req.body??{},[]);res.json(await monitoring.clearLogs(req.user.id));});
  route('post','/simulate/fire',read,operator,async(req,res)=>{v.keys(req.body??{},[]);res.json(await monitoring.simulate(req.user.id));});
  route('post','/reset',read,operator,async(req,res)=>{v.keys(req.body??{},[]);res.json(await monitoring.reset(req.user.id));});
  route('get','/thresholds',read,async(req,res)=>res.json({success:true,thresholds:(await monitoring.status()).thresholds}));
  route('put','/thresholds',read,admin,async(req,res)=>res.json(await monitoring.setThresholds(req.body,req.user.id)));
  route('get','/users',read,admin,async(req,res)=>res.json({success:true,users:await users.list()}));
  route('post','/users',read,admin,async(req,res)=>res.status(201).json(await users.create(req.body,req.user.id)));
  route('patch','/users/:id',read,admin,async(req,res)=>{
    const result=await users.update(req.params.id,req.body,req.user.id);
    for(const socket of io.sockets.sockets.values())if(socket.data.userId===req.params.id)socket.disconnect(true);
    res.json(result);
  });
  route('get','/audit-logs',read,admin,async(req,res)=>{
    const {limit,offset}=v.pagination(req.query);res.json({success:true,logs:await db.read(tx=>tx.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?',[limit,offset]))});
  });
  return router;
}
module.exports={createApi};
