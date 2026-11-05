// A thin fetch wrapper. `/api` is rewritten to the API by the dev server (and by
// NGINX later). The browser never talks to any other origin.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly data: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, data?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

interface Options {
  token?: string | undefined;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function api<T>(method: string, path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    // Network failure: the request may or may not have reached the server.
    throw new ApiError(0, 'NETWORK', 'Network error: the request may not have arrived');
  }
  const text = await response.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const error = (
      json as
        { error?: { code?: string; message?: string; data?: Record<string, string> } } | undefined
    )?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Request failed (${String(response.status)})`,
      error?.data,
    );
  }
  return json as T;
}
