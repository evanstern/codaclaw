import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'coda-managed-session',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN coda_managed     INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN last_coda_sender TEXT;
    `);
  },
};
