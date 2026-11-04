import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from './migrations.ts';

export type Db = Database.Database;

export function migrate(db: Db, steps: string[] = migrations): void {
  const applied = db.pragma('user_version', { simple: true }) as number;
  steps.slice(applied).forEach((sql, index) => {
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${applied + index + 1}`);
    })();
  });
}

/** Opens the database and brings it up to date. Pass `:memory:` for a throwaway one. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
