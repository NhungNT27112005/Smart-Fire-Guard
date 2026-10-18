'use strict';
const {randomBytes,createHash,scrypt:rawScrypt,timingSafeEqual} = require('node:crypto');
const {promisify} = require('node:util');
const {fail,asyncRoute} = require('./errors');
const v = require('./validation');
const scrypt=promisify(rawScrypt),hash=token=>createHash('sha256').update(token).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
async function hashPassword(password) {
  const salt=randomBytes(16).toString('hex');
  const key=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  return `scrypt$${salt}$${key.toString('hex')}`;
}
async function verifyPassword(password,encoded) {
  const [scheme,salt,digest]=encoded.split('$');if(scheme!=='scrypt')return false;
  const expected=Buffer.from(digest,'hex');const actual=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
function sessionCookie(headers) {
  const match=/(?:^|;\s*)fg_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(headers.cookie||'');return match?.[1]||null;
}
function rateLimit({limit,windowMs=60000,now=Date.now,key=req=>req.ip}) {
  const buckets=new Map();
  return (req,res,next)=>{
    const current=now();for(const [k,b] of buckets)if(b.until<=current)buckets.delete(k);
    const k=key(req);let bucket=buckets.get(k);
    // Bounded memory; fail closed instead of evicting active rate limits.
    if(!bucket){if(buckets.size>=10000)return next(Object.assign(Error('Too many clients'),{status:429,code:'RATE_LIMITED'}));bucket={count:0,until:current+windowMs};buckets.set(k,bucket);}
    if(++bucket.count>limit){res.setHeader('Retry-After',Math.ceil((bucket.until-current)/1000));return next(Object.assign(Error('Too many requests'),{status:429,code:'RATE_LIMITED'}));}
    next();
  };
}
async function createSecurity(db,config,now=Date.now) {
  const dummy=await hashPassword(token());
  if(config.bootstrapUsername) {
    const name=v.username(config.bootstrapUsername),password=v.password(config.bootstrapPassword);
    const exists=await db.read(tx=>tx.get('SELECT id FROM users WHERE role=? AND active=1',['admin']));
    if(!exists) {
      const passwordHash=await hashPassword(password);
      await db.write(async tx=>{
        if(!await tx.get('SELECT id FROM users WHERE role=? AND active=1',['admin']))await tx.run('INSERT INTO users(id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)',[randomBytes(16).toString('hex'),name,passwordHash,'admin',now()]);
      });
    }
  }
  if(!await db.read(tx=>tx.get('SELECT id FROM users WHERE role=? AND active=1',['admin']))) {
    throw Error('No administrator exists. Configure BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD for the first start.');
  }
  async function getSession(headers) {
    const raw=sessionCookie(headers);if(!raw)return null;
    return db.read(tx=>tx.get(`SELECT u.id,u.username,u.role,s.csrf_token,s.expires_at,s.token_hash FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`,[hash(raw),now()]));
  }
  const user=asyncRoute(async(req,res,next)=>{
    req.user=await getSession(req.headers);if(!req.user)fail(401,'UNAUTHENTICATED','Sign in is required');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers['x-csrf-token']!==req.user.csrf_token)fail(403,'CSRF_INVALID','CSRF token is missing or invalid');
    next();
  });
  const allow=(...roles)=>(req,res,next)=>{if(!roles.includes(req.user?.role))return next(Object.assign(Error('Insufficient permissions'),{status:403,code:'FORBIDDEN'}));next();};
  const device=asyncRoute(async(req,res,next)=>{
    const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');
    if(!match)fail(401,'DEVICE_UNAUTHENTICATED','A device bearer token is required');
    req.device=await db.read(tx=>tx.get('SELECT id FROM devices WHERE token_hash=? AND enabled=1',[hash(match[1])]));
    if(!req.device)fail(401,'DEVICE_UNAUTHENTICATED','Invalid device credentials');next();
  });
  function cookie(res,raw,clear=false) {
    res.setHeader('Set-Cookie',`fg_session=${clear?'':raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:Math.floor(config.sessionTtlMs/1000)}${config.cookieSecure?'; Secure':''}`);
  }
  async function login(body,res) {
    v.keys(body,['username','password']);const name=v.username(body.username);
    if(typeof body.password!=='string'||body.password.length>128)v.invalid('password','Invalid password');
    const found=await db.read(tx=>tx.get('SELECT * FROM users WHERE username=?',[name]));
    const valid=await verifyPassword(body.password,found?.password_hash||dummy);
    if(!found||!valid||!found.active)fail(401,'INVALID_CREDENTIALS','Invalid username or password');
    const raw=token(),csrf=token(),expires=now()+config.sessionTtlMs;
    let current;
    await db.write(async tx=>{
      current=await tx.get('SELECT id,username,role,password_hash,active FROM users WHERE id=?',[found.id]);
      if(!current?.active||current.password_hash!==found.password_hash)fail(401,'INVALID_CREDENTIALS','Invalid username or password');
      await tx.run('DELETE FROM sessions WHERE expires_at<=?',[now()]);
      await tx.run('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,?)',[hash(raw),found.id,csrf,expires]);
      await tx.run('INSERT INTO audit_logs(user_id,action,target,created_at) VALUES (?,?,?,?)',[found.id,'LOGIN',found.id,now()]);
    });
    cookie(res,raw);return {success:true,user:{id:current.id,username:current.username,role:current.role},csrfToken:csrf};
  }
  return {user,allow,device,getSession,cookie,login};
}
module.exports={createSecurity,hashPassword,hash,token,rateLimit,sessionCookie};
