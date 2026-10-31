// Set a new password for an account, for when someone forgets theirs. Only
// whoever runs the server can do this (it needs the data folder). The account
// is signed out everywhere. Can run while the server is running.
//   npm run reset-password -- <username>
import path from 'node:path';
import readline from 'node:readline/promises';
import { openStore } from '../db.js';
import { MESSAGES } from '../errors.js';

export async function resetPassword(store, username, password) {
  const login = String(username || '').trim().toLowerCase();
  const row = store.db.prepare('SELECT user_id FROM logins WHERE username = ?').get(login);
  if (!row) throw new Error(`No account with the username "${login}".`);
  await store.setPassword(row.user_id, password);
  store.deleteUserSessions(row.user_id);
  return row.user_id;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: npm run reset-password -- <username>');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question('New password (at least 10 characters): ');
  rl.close();
  const store = openStore({ file: path.join(path.resolve(process.env.DATA_DIR || 'data'), 'watch.db') });
  try {
    await resetPassword(store, username, password);
    console.log('Done. That account has been signed out everywhere; sign in with the new password.');
  } catch (e) {
    console.error(`Not changed: ${MESSAGES[e.code] || e.message}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
