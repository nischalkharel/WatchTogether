// Restore the database from a backup. Stop the server first.
//   npm run restore -- data/backups/watch-2026-10-29T12-00-00-000Z.db
// The current database is kept as watch.db.before-restore-<time> so this can be undone.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function restore(backupFile, dataDir) {
  const src = path.resolve(backupFile);
  if (!fs.existsSync(src)) throw new Error(`No such backup: ${src}`);
  const check = new DatabaseSync(src, { readOnly: true });
  let ok = false;
  try {
    ok = check.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
    check.prepare('SELECT COUNT(*) FROM users').get();
  } catch {
    ok = false;
  } finally {
    check.close();
  }
  if (!ok) throw new Error('That backup is damaged; nothing was changed. Try an older one.');

  const live = path.join(dataDir, 'watch.db');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let kept = null;
  if (fs.existsSync(live)) {
    // Fold any pending writes into the main file before moving it aside.
    const db = new DatabaseSync(live);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    kept = `${live}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(live, kept);
  }
  for (const x of ['-wal', '-shm']) fs.rmSync(live + x, { force: true });
  fs.copyFileSync(src, `${live}.tmp`);
  fs.chmodSync(`${live}.tmp`, 0o600);
  fs.renameSync(`${live}.tmp`, live); // atomic: never a half-written database
  return { restoredFrom: src, previousKeptAt: kept };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run restore -- <backup file>');
    process.exit(1);
  }
  try {
    const r = restore(file, path.resolve(process.env.DATA_DIR || 'data'));
    console.log(`Restored from ${r.restoredFrom}`);
    if (r.previousKeptAt) console.log(`The database it replaced is kept at ${r.previousKeptAt}`);
    console.log('Start the server again with: npm start');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
