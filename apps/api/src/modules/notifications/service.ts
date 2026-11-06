import { AppError } from '../../http/errors.ts';
import { decodeCursor, encodeCursor } from '../../http/pagination.ts';
import type { Db } from '../../db/pool.ts';
import * as repo from './repository.ts';

export interface NotificationView {
  id: string;
  auctionId: string;
  type: repo.NotificationType;
  data: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

function toView(r: repo.NotificationRow): NotificationView {
  return {
    id: r.id,
    auctionId: r.auction_id,
    type: r.type,
    data: r.data,
    createdAt: r.created_at.toISOString(),
    readAt: r.read_at ? r.read_at.toISOString() : null,
  };
}

export interface NotificationService {
  list: (
    userId: string,
    query: { limit: number; cursor?: string | undefined; unread?: boolean | undefined },
  ) => Promise<{ items: NotificationView[]; nextCursor: string | null; unreadCount: number }>;
  markRead: (userId: string, id: string) => Promise<NotificationView>;
  markAllRead: (userId: string) => Promise<{ updated: number }>;
}

/**
 * Every method takes the user id from the authenticated session (never from input) and every query
 * filters on it, so a user can only ever see or change their own notifications.
 */
export function createNotificationService(db: Db): NotificationService {
  return {
    async list(userId, query) {
      const rows = await repo.listNotifications(db, {
        userId,
        unreadOnly: query.unread === true,
        beforeSeq: query.cursor ? decodeCursor(query.cursor) : undefined,
        limit: query.limit + 1, // one extra row tells us whether another page exists
      });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toView),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.seq) : null,
        unreadCount: await repo.countUnread(db, userId),
      };
    },

    async markRead(userId, id) {
      const row = await repo.markRead(db, userId, id);
      if (!row) throw new AppError(404, 'NOT_FOUND', 'Notification not found');
      return toView(row);
    },

    async markAllRead(userId) {
      return { updated: await repo.markAllRead(db, userId) };
    },
  };
}
