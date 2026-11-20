// Minimal Stripe REST client (Plans and Billing ADR-004). Form-encoded requests with the secret key;
// never logs requests or bodies. Only the endpoints the billing function uses are modelled.

export const STRIPE_BASE = "https://api.stripe.com/v1";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface StripeResponse {
  status: number;
  body: Record<string, unknown> | null;
}

export class StripeUnavailable extends Error {
  constructor() {
    super("Stripe could not be reached.");
  }
}

/** Flattens {a: {b: [1]}} to a[b][0]=1, the encoding Stripe expects. */
export function formEncode(value: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, item: unknown) => {
    if (item === undefined || item === null) return;
    if (Array.isArray(item)) item.forEach((entry, index) => walk(`${prefix}[${index}]`, entry));
    else if (typeof item === "object") {
      for (const [key, entry] of Object.entries(item as Record<string, unknown>)) walk(`${prefix}[${key}]`, entry);
    } else out.append(prefix, String(item));
  };
  for (const [key, item] of Object.entries(value)) walk(key, item);
  return out.toString();
}

export class StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly base = STRIPE_BASE,
    private readonly timeoutMs = 20_000,
  ) {}

  get configured(): boolean {
    return this.secretKey.length > 0;
  }

  async request(
    method: "GET" | "POST",
    path: string,
    options: { form?: Record<string, unknown>; query?: Record<string, string>; idempotencyKey?: string } = {},
  ): Promise<StripeResponse> {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.append(key, value);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (options.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = formEncode(options.form);
    }
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new StripeUnavailable();
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    return { status: response.status, body: isObject ? parsed as Record<string, unknown> : null };
  }
}

/** Verifies a Stripe-Signature header ("t=...,v1=...") over the raw body, within a tolerance. */
export async function stripeSignatureValid(
  secret: string,
  raw: string,
  header: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): Promise<boolean> {
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s?.trim() ?? "");
    if (key === "t") timestamp = value;
    else if (key === "v1" && value) signatures.push(value.toLowerCase());
  }
  if (!/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${raw}`)),
  );
  const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return signatures.some((given) => {
    if (given.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
    return diff === 0;
  });
}
