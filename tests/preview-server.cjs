const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const express=require('express'),{Server}=require('socket.io'),http=require('node:http');
const app=express(),server=http.createServer(app),io=new Server(server);
const events=[],readings=[];
const db={saveEventLog:async(level,message)=>events.unshift({id:events.length+1,level,message,formatted_time:new Date().toISOString()}),saveSensorReading:async row=>readings.push(row),getRecentLogs:async()=>events.slice(0,50),clearLogs:async()=>{events.length=0;}};
const moduleCopy={exports:{}};
const projectRoot=path.resolve(__dirname,'..');
vm.runInNewContext(fs.readFileSync(path.join(projectRoot,'src/routes/api.js'),'utf8'),{module:moduleCopy,require:n=>n==='express'?express:n==='../database'?db:require(path.join(projectRoot,'src/ai-detector.js')),console,Date,Math});
const api=moduleCopy.exports(io);
app.use(express.json());app.use(express.static(path.join(projectRoot,'public')));app.use('/api',api);
const timer=setInterval(()=>api.tickSimulation().catch(console.error),1500);
io.on('connection',socket=>socket.on('analyze_ai_frame',()=>socket.emit('ai_result',{hasFire:false,confidence:80})));
// Explicit testing controls: only bound to localhost, all events/readings are disposable in-memory data.
app.post('/__test/invalid',(req,res)=>{io.emit('sensor_update',{state:{temperature:null,gas:-1,smoke:'invalid',flame:null,level:'ok',source:'SIMULATION',esp32Connected:false}});res.json({success:true});});
server.listen(4318,'127.0.0.1',()=>console.log('Isolated DEMO preview http://localhost:4318 - database is NOT opened'));
function close(){clearInterval(timer);io.close();server.close();}
process.on('SIGINT',()=>{close();process.exit(0);});process.on('SIGTERM',()=>{close();process.exit(0);});
