'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const python = process.env.AI_PYTHON_EXECUTABLE || 'python';
const child = spawn(python, ['-u', path.join(root, 'ai', 'ai_service.py')], {
  cwd: root, stdio: 'inherit', shell: false, env: {...process.env, PYTHONIOENCODING: 'utf-8'}
});
child.on('error', error => {console.error(`Cannot start Python AI service (${error.code}). Check AI_PYTHON_EXECUTABLE.`);process.exitCode=1;});
child.on('exit', (code, signal) => {process.exitCode=code ?? (signal ? 1 : 0);});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => child.kill(signal));
