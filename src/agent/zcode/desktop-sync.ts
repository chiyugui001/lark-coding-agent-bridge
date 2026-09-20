import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { log } from '../../core/logger';

/**
 * Best-effort mirror of bridge-created zcode sessions into the ZCode desktop
 * app's task index (`~/.zcode/v2/tasks-index.sqlite`).
 *
 * The desktop UI reads this table per known workspace, so rows written here
 * show up in the desktop task list (after the list reloads — the desktop
 * refreshes on restart, view switches, and its own task events; external
 * writes cannot trigger its in-memory refresh event). All failures are
 * swallowed: syncing must never break a bridge run, and the private schema
 * may change across ZCode versions (disable via zcode.desktopSync: false).
 */
export interface DesktopTaskUpsert {
  sessionId: string;
  workspacePath: string;
  title: string;
  status: 'running' | 'completed' | 'error';
  model?: string;
}

interface MinimalDb {
  prepare: (sql: string) => { run: (params: Record<string, unknown>) => unknown };
  close?: () => void;
}

const require = createRequire(import.meta.url);

function taskIndexPath(): string | undefined {
  const path = join(homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
  return existsSync(path) ? path : undefined;
}

export function upsertDesktopTask(task: DesktopTaskUpsert): void {
  try {
    const path = taskIndexPath();
    if (!path) return;
    const mod = require('node:sqlite') as {
      DatabaseSync: new (path: string) => MinimalDb;
    };
    const db = new mod.DatabaseSync(path);
    try {
      const now = Date.now();
      const meta = {
        taskId: task.sessionId,
        title: task.title,
        workspacePath: task.workspacePath,
        createdAt: now,
        updatedAt: now,
        mode: 'yolo',
        ...(task.model ? { model: task.model } : {}),
        provider: 'glm',
        status: task.status,
        titleOverridden: true,
      };
      db.prepare(
        `INSERT INTO tasks (workspace_key,workspace_path,workspace_identity,task_id,title,task_status,provider,mode,model,migration_source,forked_from_task_id,created_at,updated_at,unread_at,last_unread_at,pinned,archived,deleted,title_overridden,meta_json,searchable_text,cron_automation_id,off_peak_task_id)
         VALUES (@wk,@wp,NULL,@task_id,@title,@task_status,'glm','yolo',@model,'lark-channel-bridge',NULL,@created_at,@updated_at,@unread_at,@last_unread_at,0,0,0,1,@meta_json,@searchable_text,NULL,NULL)
         ON CONFLICT(workspace_key, task_id) DO UPDATE SET
           title=excluded.title, task_status=excluded.task_status, updated_at=excluded.updated_at,
           unread_at=excluded.unread_at, last_unread_at=excluded.last_unread_at,
           meta_json=excluded.meta_json, searchable_text=excluded.searchable_text`,
      ).run({
        wk: task.workspacePath,
        wp: task.workspacePath,
        task_id: task.sessionId,
        title: task.title,
        task_status: task.status,
        model: task.model ?? null,
        created_at: now,
        updated_at: now,
        unread_at: task.status === 'running' ? null : now,
        last_unread_at: now,
        meta_json: JSON.stringify(meta),
        searchable_text: task.title,
      });
      log.info('agent', 'desktop-task-sync', { sessionId: task.sessionId, status: task.status });
    } finally {
      db.close?.();
    }
  } catch (err) {
    log.warn('agent', 'desktop-task-sync-failed', { message: (err as Error).message });
  }
}
