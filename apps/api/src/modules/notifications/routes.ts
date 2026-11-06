import { Router } from 'express';
import { z } from 'zod';
import { parseInput } from '../../http/validate.ts';
import { mustGetAuth, requireAuth, type AuthService } from '../auth/index.ts';
import type { NotificationService } from './service.ts';

const listQuerySchema = z
  .object({
    unread: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(100).optional(),
  })
  .strict();

export function notificationRoutes(notifications: NotificationService, auth: AuthService): Router {
  const router = Router();
  const required = requireAuth(auth);

  // The owner is always the authenticated user; there is no way to name another user.
  router.get('/notifications', required, async (req, res) => {
    const query = parseInput(listQuerySchema, req.query);
    res.status(200).json(
      await notifications.list(mustGetAuth(res).userId, {
        limit: query.limit,
        cursor: query.cursor,
        unread: query.unread === 'true',
      }),
    );
  });

  // Registered before `/:id/read` so "read-all" is never taken for an id.
  router.post('/notifications/read-all', required, async (_req, res) => {
    res.status(200).json(await notifications.markAllRead(mustGetAuth(res).userId));
  });

  router.post('/notifications/:id/read', required, async (req, res) => {
    const id = parseInput(z.uuid(), req.params['id'], 'id');
    res
      .status(200)
      .json({ notification: await notifications.markRead(mustGetAuth(res).userId, id) });
  });

  return router;
}
