// Shared retry utility with exponential backoff + jitter

export interface RetryOptions {
  maxRetries?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: number;
  isRetryable?: (err: unknown) => boolean;
}

function defaultIsRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || status === 529 || status === 500 || status === 503;
}

/**
 * Retries `fn` with exponential backoff.
 * Defaults: baseMs=500, jitter=0.25, isRetryable checks HTTP 429/529/500/503.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 5;
  const baseMs = opts?.baseMs ?? 500;
  const maxMs = opts?.maxMs ?? 16_000;
  const jitter = opts?.jitter ?? 0.25;
  const isRetryable = opts?.isRetryable ?? defaultIsRetryable;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isRetryable(err) || attempt === maxRetries) throw err;
      const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs) * (1 + jitter * Math.random());
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}
