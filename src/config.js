'use strict';
const path = require('node:path');

function loadConfig(env = process.env) {
  function integer(name, fallback, min, max) {
    const n = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(n) || n < min || n > max) throw Error(`Invalid configuration: ${name}`);
    return n;
  }
  function bool(name, fallback=false) {
    if (env[name] === undefined) return fallback;
    if (!['true','false'].includes(env[name])) throw Error(`Invalid configuration: ${name}`);
    return env[name] === 'true';
  }
  const production = env.NODE_ENV === 'production';
  const port = integer('PORT',3000,0,65535);
  const origins = (env.APP_ORIGINS || `http://localhost:${port},http://127.0.0.1:${port}`).split(',').map(s=>s.trim());
  if (origins.some(s=>{try {const u=new URL(s);return !['http:','https:'].includes(u.protocol)||u.origin!==s;} catch {return true;}})) throw Error('Invalid APP_ORIGINS');
  const config = {
    production, port, host:env.HOST || '127.0.0.1', origins,
    databasePath:env.DATABASE_PATH || path.join(__dirname,'..','data','fire_guard.db'),
    cookieSecure:bool('COOKIE_SECURE',production), sessionTtlMs:integer('SESSION_TTL_SECONDS',28800,60,86400)*1000,
    staleMs:integer('DEVICE_STALE_SECONDS',10,1,3600)*1000,
    offlineMs:integer('DEVICE_OFFLINE_SECONDS',30,2,86400)*1000,
    telemetryMaxAgeMs:integer('TELEMETRY_MAX_AGE_SECONDS',10,1,3600)*1000,
    clockSkewMs:integer('CLOCK_SKEW_SECONDS',10,0,300)*1000,
    demoEnabled:bool('DEMO_ENABLED'),
    bootstrapUsername:env.BOOTSTRAP_ADMIN_USERNAME || '', bootstrapPassword:env.BOOTSTRAP_ADMIN_PASSWORD || '',
    aiUrl:env.AI_URL || 'http://127.0.0.1:5000/detect', aiTimeoutMs:integer('AI_TIMEOUT_MS',5000,100,30000),
    aiMaxFrameAgeMs:integer('AI_MAX_FRAME_AGE_MS',5000,100,30000),
    aiHoldMs:integer('AI_HOLD_MS',10000,0,60000),
    loginLimit:integer('LOGIN_RATE_LIMIT',10,1,1000), apiLimit:integer('API_RATE_LIMIT',600,1,100000),
    deviceLimit:integer('DEVICE_RATE_LIMIT',120,1,10000)
  };
  if (config.offlineMs <= config.staleMs) throw Error('DEVICE_OFFLINE_SECONDS must exceed DEVICE_STALE_SECONDS');
  if (config.telemetryMaxAgeMs > config.staleMs) throw Error('TELEMETRY_MAX_AGE_SECONDS must not exceed DEVICE_STALE_SECONDS');
  if (production && (!config.cookieSecure || origins.some(s=>!s.startsWith('https://')))) throw Error('Production requires HTTPS origins and COOKIE_SECURE=true');
  if (Boolean(config.bootstrapUsername) !== Boolean(config.bootstrapPassword)) throw Error('Both bootstrap username and password must be configured');
  return config;
}
module.exports = {loadConfig};
