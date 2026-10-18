'use strict';
const {randomUUID} = require('node:crypto');
const v=require('../validation');
const {hashPassword}=require('../security');
const {fail}=require('../errors');
function createUsers(db,now=Date.now) {
  const list=()=>db.read(tx=>tx.all('SELECT id,username,role,active,created_at FROM users ORDER BY created_at'));
  async function create(body,actor) {
    v.keys(body,['username','password','role']);const username=v.username(body.username),role=v.role(body.role),passwordHash=await hashPassword(v.password(body.password));
    const id=randomUUID();
    await db.write(async tx=>{
      if(await tx.get('SELECT id FROM users WHERE username=?',[username]))fail(409,'USERNAME_EXISTS','Username already exists');
      await tx.run('INSERT INTO users(id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)',[id,username,passwordHash,role,now()]);
      await tx.run('INSERT INTO audit_logs(user_id,action,target,created_at) VALUES (?,?,?,?)',[actor,'USER_CREATED',id,now()]);
    });return {success:true,user:{id,username,role,active:true}};
  }
  async function update(id,body,actor) {
    v.id(id);v.keys(body,['role','active','password']);if(!Object.keys(body).length)v.invalid('body','At least one field is required');
    if(body.role!==undefined)v.role(body.role);if(body.active!==undefined&&typeof body.active!=='boolean')v.invalid('active','Expected boolean');
    const passwordHash=body.password===undefined?null:await hashPassword(v.password(body.password));
    await db.write(async tx=>{
      const old=await tx.get('SELECT * FROM users WHERE id=?',[id]);if(!old)fail(404,'USER_NOT_FOUND','User not found');
      const role=body.role??old.role,active=body.active===undefined?old.active:Number(body.active);
      if(old.role==='admin'&&old.active&&(role!=='admin'||!active)) {
        const admins=await tx.get('SELECT COUNT(*) count FROM users WHERE role=? AND active=1',['admin']);
        if(admins.count<=1)fail(409,'LAST_ADMIN','Cannot disable or demote the last active administrator');
      }
      await tx.run('UPDATE users SET role=?,active=?,password_hash=? WHERE id=?',[role,active,passwordHash??old.password_hash,id]);
      await tx.run('DELETE FROM sessions WHERE user_id=?',[id]);
      await tx.run('INSERT INTO audit_logs(user_id,action,target,created_at) VALUES (?,?,?,?)',[actor,'USER_UPDATED',id,now()]);
    });return {success:true};
  }
  return {list,create,update};
}
module.exports={createUsers};
