// Minimal Zernio REST client. Holds the account-wide API key; never logs requests or bodies.

export const ZERNIO_BASE = "https://zernio.com/api/v1";

export interface ZernioResponse {
  status: number;
  body: Record<string, unknown> | null;
  retryAfter: string | null;
}

export interface ZernioRequest {
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class ZernioUnavailable extends Error {
  constructor() {
    super("Zernio could not be reached.");
  }
}

export class ZernioClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly base = ZERNIO_BASE,
    private readonly timeoutMs = 25_000,
  ) {}

  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  async request(method: string, path: string, options: ZernioRequest = {}): Promise<ZernioResponse> {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ZernioUnavailable();
    }
    let body: Record<string, unknown> | null = null;
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, retryAfter: response.headers.get("Retry-After") };
  }
}
