'use strict';
const {createApplication}=require('./src/app');
const {loadConfig}=require('./src/config');
const fs=require('node:fs');

async function main() {
  // Node's native dotenv loader: no runtime dependency and no tracked real credentials.
  if(fs.existsSync('.env'))process.loadEnvFile('.env');
  const application=await createApplication({config:loadConfig()});
  try {
    const address=await application.start();
    console.log(`Smart Fire Guard listening on ${address.address}:${address.port}`);
  } catch(err) {await application.close();throw err;}
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
    application.close().then(()=>process.exit(0)).catch(()=>process.exit(1));
  });
}
if(require.main===module)main().catch(err=>{console.error(`Startup failed: ${err.message}`);process.exitCode=1;});
module.exports={main};
