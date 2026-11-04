import { Router } from 'express';
import { AppError } from '../../http/errors.ts';
import { parseInput } from '../../http/validate.ts';
import { mustGetAuth, requireAuth } from './middleware.ts';
import { loginSchema, registerSchema } from './schemas.ts';
import type { AuthService } from './service.ts';

export function authRoutes(auth: AuthService): Router {
  const router = Router();

  router.post('/auth/register', async (req, res) => {
    const input = parseInput(registerSchema, req.body);
    const user = await auth.register(input);
    res.status(201).json({ user });
  });

  router.post('/auth/login', async (req, res) => {
    const input = parseInput(loginSchema, req.body);
    res.status(200).json(await auth.login(input));
  });

  router.post('/auth/logout', requireAuth(auth), async (_req, res) => {
    await auth.logout(mustGetAuth(res).sessionId);
    res.status(204).end();
  });

  router.get('/users/me', requireAuth(auth), async (_req, res) => {
    const user = await auth.getUser(mustGetAuth(res).userId);
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    res.status(200).json({ user });
  });

  return router;
}
