import { z } from 'zod';

// Compile-time types vanish at runtime. process.env is always
// Record<string, string | undefined>, so it must be validated at startup:
// a wrong or missing value should stop the process before it serves traffic.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Loopback by default so a development API is not reachable from the network. The container
  // setup (infra/compose.cluster.yaml) sets 0.0.0.0 because NGINX reaches it over the network.
  API_HOST: z.string().min(1).default('127.0.0.1'),
  // Names this instance in logs and in the X-Instance-Id header. Default: hostname-pid.
  INSTANCE_ID: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/)
    .optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  // --- Outbox worker (apps/workers). The API does not use these. ---
  // Sleep between polls when there is nothing to publish (a busy worker does not sleep).
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(10_000).default(100),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  // A claimed event not finished within this time is taken over by another worker.
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  // After this many failed attempts an event becomes `failed` and needs a manual retry.
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
  // Published events older than this are deleted (the outbox is a queue, not the history).
  OUTBOX_RETENTION_HOURS: z.coerce.number().int().min(1).max(8760).default(168),
  // --- Lifecycle worker (apps/workers). The API does not use these. ---
  // Sleep between passes when nothing is due. The worst-case delay between ends_at and the ending.
  LIFECYCLE_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  // Auctions handled per kind (start, end, ending soon) in one pass.
  LIFECYCLE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  // "Ending soon" notifications are written when an auction is this close to its end.
  ENDING_SOON_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),
  DATABASE_URL: z
    .url()
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      'must start with postgres:// or postgresql://',
    ),
  REDIS_URL: z
    .url()
    .refine((value) => /^rediss?:\/\//.test(value), 'must start with redis:// or rediss://'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvValidationError';
    this.problems = problems;
  }
}

/**
 * Validates an environment-like object. Error messages name the variable and
 * the rule, never the value: values may be secrets (plan rule 17).
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `${name}: ${issue.message}`;
    });
    throw new EnvValidationError(problems);
  }
  return result.data;
}
