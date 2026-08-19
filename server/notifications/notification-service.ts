import { randomUUID } from "node:crypto";

import type {
  NotificationDto,
  NotificationListResponse,
  NotificationSourceType,
  NotificationTone,
} from "../../shared/contracts.js";
import type { SupportDatabase } from "../db/index.js";

export interface CreateNotificationInput {
  title: string;
  body: string;
  targetUrl?: string | null;
  sourceType: NotificationSourceType;
  sourceId?: string | null;
  idempotencyKey: string;
  tone?: NotificationTone;
}

export interface CreateNotificationResult {
  created: number;
  deduplicated: number;
}

type NotificationRow = {
  id: string;
  title: string;
  body: string;
  target_url: string | null;
  source_type: NotificationSourceType;
  source_id: string | null;
  tone: NotificationTone;
  read_at: string | null;
  created_at: string;
};

export class NotificationService {
  constructor(private readonly database: SupportDatabase) {}

  activeUserIds(): string[] {
    return (this.database.prepare(`
      SELECT id
      FROM local_users
      WHERE active = 1
      ORDER BY display_name COLLATE NOCASE, id
    `).all() as Array<{ id: string }>).map((row) => row.id);
  }

  createForAll(input: CreateNotificationInput): CreateNotificationResult {
    return this.createForUsers(this.activeUserIds(), input);
  }

  createForUsers(
    userIds: string[],
    input: CreateNotificationInput,
  ): CreateNotificationResult {
    const result = { created: 0, deduplicated: 0 };
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return result;
    const timestamp = new Date().toISOString();
    const title = bounded(input.title, 160);
    const body = bounded(input.body, 2_000);
    const targetUrl = internalTarget(input.targetUrl);
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO notifications (
        id, user_id, idempotency_key, source_type, source_id,
        title, body, target_url, tone, read_at, created_at
      )
      SELECT ?, user.id, ?, ?, ?, ?, ?, ?, ?, NULL, ?
      FROM local_users user
      WHERE user.id = ? AND user.active = 1
    `);
    this.database.transaction(() => {
      for (const userId of ids) {
        const write = insert.run(
          randomUUID(),
          bounded(input.idempotencyKey, 300),
          input.sourceType,
          input.sourceId ? bounded(input.sourceId, 300) : null,
          title,
          body,
          targetUrl,
          input.tone ?? "info",
          timestamp,
          userId,
        );
        if (write.changes > 0) result.created += 1;
        else result.deduplicated += 1;
      }
    })();
    return result;
  }

  listForUser(
    userId: string,
    options: { unreadOnly?: boolean; limit?: number; offset?: number } = {},
  ): NotificationListResponse {
    const unreadOnly = options.unreadOnly === true;
    const limit = Math.max(1, Math.min(100, options.limit ?? 30));
    const offset = Math.max(0, options.offset ?? 0);
    const filter = unreadOnly ? "AND read_at IS NULL" : "";
    const items = (this.database.prepare(`
      SELECT id, title, body, target_url, source_type, source_id,
             tone, read_at, created_at
      FROM notifications
      WHERE user_id = ? ${filter}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(userId, limit, offset) as NotificationRow[]).map(notificationDto);
    const totals = this.database.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread
      FROM notifications
      WHERE user_id = ?
    `).get(userId) as { total: number; unread: number | null };
    return { items, total: totals.total, unread: totals.unread ?? 0 };
  }

  unreadCount(userId: string): number {
    return (this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM notifications
      WHERE user_id = ? AND read_at IS NULL
    `).get(userId) as { count: number }).count;
  }

  markRead(userId: string, notificationId: string, read: boolean): boolean {
    const result = this.database.prepare(`
      UPDATE notifications
      SET read_at = ?
      WHERE id = ? AND user_id = ?
    `).run(read ? new Date().toISOString() : null, notificationId, userId);
    return result.changes > 0;
  }

  markAllRead(userId: string): number {
    return this.database.prepare(`
      UPDATE notifications
      SET read_at = ?
      WHERE user_id = ? AND read_at IS NULL
    `).run(new Date().toISOString(), userId).changes;
  }
}

function notificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    targetUrl: row.target_url,
    sourceType: row.source_type,
    sourceId: row.source_id,
    tone: row.tone,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

function bounded(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function internalTarget(value: string | null | undefined): string | null {
  const target = value?.trim();
  if (!target) return null;
  if (!target.startsWith("/") || target.startsWith("//")) {
    throw new Error("A tela da notificação precisa ser um caminho interno do Threadmark.");
  }
  return target.slice(0, 2_000);
}
