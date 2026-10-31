// Settings come from environment variables (see README). Settings that would
// make the app insecure stop it from starting instead of running anyway.
import path from 'node:path';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopback = (host) => LOOPBACK.has(host) || host.endsWith('.localhost');

export function loadConfig(env = process.env) {
  const errors = [];
  const port = Number(env.PORT) || 3000;

  let publicUrl;
  try {
    publicUrl = new URL(env.PUBLIC_URL || `http://localhost:${port}`);
  } catch {
    errors.push('PUBLIC_URL is not a valid address');
    publicUrl = new URL(`http://localhost:${port}`);
  }
  const secure = publicUrl.protocol === 'https:';
  if (!secure && !isLoopback(publicUrl.hostname)) {
    errors.push('PUBLIC_URL must start with https:// (plain http is only allowed on this computer)');
  }

  const issuer = (env.OIDC_ISSUER || 'https://accounts.google.com').replace(/\/+$/, '');
  try {
    const u = new URL(issuer);
    if (u.protocol !== 'https:' && !isLoopback(u.hostname)) errors.push('OIDC_ISSUER must use https://');
  } catch {
    errors.push('OIDC_ISSUER is not a valid address');
  }

  const clientId = (env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET || '').trim();
  const production = env.NODE_ENV === 'production';
  // Google sign-in is optional: without keys, people use a username and password.
  if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
    errors.push('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither');
  }
  if (production && !secure) errors.push('PUBLIC_URL must be your https:// site address');

  const scale = Number(env.RATE_LIMIT_SCALE || 1); // tests only: loosen limits
  const backupHours = Number(env.BACKUP_EVERY_HOURS ?? 6);
  return {
    port,
    host: env.HOST || '0.0.0.0',
    origin: publicUrl.origin,
    secure,
    redirectUri: `${publicUrl.origin}/auth/google/callback`,
    issuer,
    clientId,
    clientSecret,
    signInReady: !!(clientId && clientSecret),
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    // Ideally a different disk from DATA_DIR, so one failing disk can't take both.
    backupDir: path.resolve(env.BACKUP_DIR || path.join(env.DATA_DIR || 'data', 'backups')),
    backupEveryMs: Number.isFinite(backupHours) && backupHours > 0 ? backupHours * 3600_000 : 0,
    backupKeep: Math.max(1, Number(env.BACKUP_KEEP) || 28),
    trustProxy: env.TRUST_PROXY === '1',
    rateScale: Number.isFinite(scale) && scale >= 1 ? scale : 1,
    production,
    errors,
  };
}
