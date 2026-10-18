'use strict';
// Disposable authenticated DEMO. The production database and .env are never opened.
const {randomBytes}=require('node:crypto');
const {createApplication}=require('../src/app');
const {loadConfig}=require('../src/config');
async function main() {
  const password=randomBytes(18).toString('base64url');
  const config=loadConfig({DATABASE_PATH:':memory:',PORT:'4318',HOST:'127.0.0.1',DEMO_ENABLED:'true',BOOTSTRAP_ADMIN_USERNAME:'demo-admin',BOOTSTRAP_ADMIN_PASSWORD:password});
  const runtime=await createApplication({config});
  await runtime.start();
  const user=await runtime.db.read(tx=>tx.get('SELECT id FROM users WHERE username=?',['demo-admin']));
  await runtime.monitoring.simulate(user.id);
  console.log('Disposable DEMO preview: http://localhost:4318');
  console.log(`Username: demo-admin | One-run preview password: ${password}`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>runtime.close().then(()=>process.exit(0)));
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});
