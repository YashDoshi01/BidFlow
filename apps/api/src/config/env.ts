import { z } from 'zod';

// Compile-time types vanish at runtime. process.env is always
// Record<string, string | undefined>, so it must be validated at startup:
// a wrong or missing value should stop the process before it serves traffic.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
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
