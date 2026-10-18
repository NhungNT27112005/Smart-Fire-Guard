'use strict';
const sqlite3 = require('sqlite3');
const fs = require('node:fs');
const path = require('node:path');

// A single queue owns the SQLite connection. Reads cannot see half-committed mutations.
async function openDatabase(filename) {
  if(filename!==':memory:')fs.mkdirSync(path.dirname(path.resolve(filename)),{recursive:true});
  const connection=await new Promise((resolve,reject)=>{
    const db=new sqlite3.Database(filename,err=>err?reject(err):resolve(db));
  });
  connection.configure('busyTimeout',5000);
  const run=(sql,params=[])=>new Promise((resolve,reject)=>connection.run(sql,params,function(err){err?reject(err):resolve({id:this.lastID,changes:this.changes});}));
  const get=(sql,params=[])=>new Promise((resolve,reject)=>connection.get(sql,params,(err,row)=>err?reject(err):resolve(row)));
  const all=(sql,params=[])=>new Promise((resolve,reject)=>connection.all(sql,params,(err,rows)=>err?reject(err):resolve(rows)));
  const exec=sql=>new Promise((resolve,reject)=>connection.exec(sql,err=>err?reject(err):resolve()));
  const sql={run,get,all,exec};let queue=Promise.resolve(),closed=false;
  function serial(task) {
    const operation=queue.then(()=>{if(closed)throw Error('Database is closed');return task();});
    queue=operation.catch(()=>{});return operation;
  }
  async function transaction(fn) {
    await run('BEGIN IMMEDIATE');
    try {const result=await fn(sql);await run('COMMIT');return result;}
    catch(err){await run('ROLLBACK').catch(()=>{});throw err;}
  }
  const db={read:fn=>serial(()=>fn(sql)),write:fn=>serial(()=>transaction(fn)),
    close:()=>serial(async()=>{await new Promise((resolve,reject)=>connection.close(err=>err?reject(err):resolve()));closed=true;})};
  try {
    await exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    await db.write(async tx=>{
      const version=(await tx.get('PRAGMA user_version')).user_version;
      if(version>1)throw Error('Database schema is newer than this application');
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS sensor_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          temperature REAL, smoke REAL, gas REAL, flame INTEGER, status TEXT, source TEXT
        );
        CREATE TABLE IF NOT EXISTS event_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          level TEXT, message TEXT
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
          csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
          token_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
          created_at INTEGER NOT NULL, last_seen INTEGER, last_sequence INTEGER,
          last_measured_at TEXT, alarm_level TEXT NOT NULL DEFAULT 'unknown',
          connection_status TEXT NOT NULL DEFAULT 'offline'
        );
        CREATE TABLE IF NOT EXISTS sensors (
          id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
          kind TEXT NOT NULL CHECK(kind IN ('temperature','smoke','gas','flame')),
          unit TEXT NOT NULL, min_value REAL NOT NULL, max_value REAL NOT NULL,
          UNIQUE(device_id,kind)
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id),
          action TEXT NOT NULL, target TEXT, created_at INTEGER NOT NULL
        );
      `);
      const additions={sensor_logs:{device_id:'TEXT REFERENCES devices(id)',received_at:'INTEGER',measured_at:'TEXT',sequence:'INTEGER',sensor_health:'TEXT'},event_logs:{device_id:'TEXT REFERENCES devices(id)',reading_id:'INTEGER REFERENCES sensor_logs(id)',source:'TEXT',code:'TEXT',acknowledged_by:'TEXT REFERENCES users(id)',acknowledged_at:'INTEGER'}};
      for(const [table,columns] of Object.entries(additions)) {
        const existing=new Set((await tx.all(`PRAGMA table_info(${table})`)).map(row=>row.name));
        for(const [name,type] of Object.entries(columns))if(!existing.has(name))await tx.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      await tx.exec(`
        CREATE INDEX IF NOT EXISTS sensor_device_time_idx ON sensor_logs(device_id,id DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS sensor_sequence_idx ON sensor_logs(device_id,sequence) WHERE sequence IS NOT NULL;
        CREATE INDEX IF NOT EXISTS event_device_time_idx ON event_logs(device_id,id DESC);
        PRAGMA user_version=1;
      `);
      await tx.run('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)',['thresholds',JSON.stringify({temp:{warn:45,danger:60},smoke:{warn:30,danger:60},gas:{warn:30,danger:60}})]);
    });
    return db;
  } catch(err){await db.close().catch(()=>{});throw err;}
}
module.exports={openDatabase};
