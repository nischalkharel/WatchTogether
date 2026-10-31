// Runs the real server for browser tests, signing in against a stand-in for
// Google (test/fake-google.js) and keeping its data in a throwaway folder.
import fs from 'node:fs';
import path from 'node:path';
import { startFakeGoogle } from '../test/fake-google.js';

const port = process.env.E2E_PORT || '3123';
const googlePort = process.env.E2E_GOOGLE_PORT || '3124';
const dataDir = path.resolve(process.env.E2E_DATA || '.e2e-env/e2e-data');
fs.rmSync(dataDir, { recursive: true, force: true });

// E2E_NO_GOOGLE=1: no Google keys at all, exactly like `npm start` with no setup.
const google = process.env.E2E_NO_GOOGLE
  ? null
  : await startFakeGoogle({ clientId: 'e2e-client', clientSecret: 'e2e-secret', port: Number(googlePort) });
// Tests pick which Google account "signs in" next: POST /next-user on the fake.
Object.assign(process.env, {
  PORT: port,
  HOST: '127.0.0.1',
  PUBLIC_URL: `http://127.0.0.1:${port}`,
  ...(google ? { OIDC_ISSUER: google.issuer, GOOGLE_CLIENT_ID: 'e2e-client', GOOGLE_CLIENT_SECRET: 'e2e-secret' } : {}),
  DATA_DIR: dataDir,
  BACKUP_EVERY_HOURS: '0',
  RATE_LIMIT_SCALE: '1000',
});
const { main } = await import('../server.js');
main();
