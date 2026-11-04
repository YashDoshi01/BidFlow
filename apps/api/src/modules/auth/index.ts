// Public surface of the auth module. Other modules import only from here.
export { authRoutes } from './routes.ts';
export { createAuthService, type AuthService, type PublicUser } from './service.ts';
export { getAuth, mustGetAuth, optionalAuth, requireAuth, type AuthContext } from './middleware.ts';
