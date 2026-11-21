// deno-lint-ignore-file no-explicit-any require-await -- loose JSON shapes and sync fakes behind async interfaces.
// Posting server tests against a mocked Zernio API, an in-memory store and fake Supabase auth.
// Run: deno test supabase/functions/posting/

import { assert, assertEquals, assertFalse } from "@std/assert";
import { createHandler, LIMITS, signatureMatches } from "./handler.ts";
import { MemoryStore } from "./memory_store.ts";
import { ZernioClient } from "./zernio.ts";
import { entitlementFor, type PlanId } from "../_shared/plans.ts";
import { PlanSourceError } from "../_shared/plan_source.ts";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_B = "bbbbbbbb-0000-4000-8000-000000000002";
const TOKENS: Record<string, string> = { "token-a": USER_A, "token-b": USER_B };
const SECRET = "whsec-test";
let counter = 0;
const oid = () => (++counter).toString(16).padStart(24, "0");

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  idempotencyKey: string | null;
}

class FakeZernio {
  calls: Call[] = [];
  profiles: { _id: string; externalId: string }[] = [];
  accounts: Record<string, unknown>[] = [];
  posts = new Map<string, Record<string, unknown>>();
  keys = new Map<string, string>();
  overrides = new Map<string, () => Response>();
  analyticsStatus = 200;
  down = false;

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError("network down");
    const url = new URL(input);
    const path = url.pathname.replace("/api/v1", "");
    const headers = new Headers(init.headers);
    assertEquals(headers.get("Authorization"), "Bearer zk-test");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const call = {
      method: init.method!,
      path,
      query: url.searchParams,
      body,
      idempotencyKey: headers.get("Idempotency-Key"),
    };
    this.calls.push(call);
    const override = this.overrides.get(`${call.method} ${path}`);
    if (override) return override();
    return this.route(call);
  };

  addAccount(profileId: string, platform: string) {
    const account = {
      _id: oid(),
      platform,
      profileId: { _id: profileId },
      username: `${platform}_user`,
      displayName: "Creator",
      isActive: true,
      accessToken: "SECRET-OAUTH",
    };
    this.accounts.push(account);
    return account._id;
  }

  private route(call: Call): Response {
    const reply = (status: number, body: unknown) => Response.json(body, { status });
    const parts = call.path.split("/").filter(Boolean);
    if (call.method === "POST" && call.path === "/profiles") {
      if (this.profiles.some((p) => p.externalId === call.body.externalId)) {
        return reply(409, { error: "duplicate", code: "profile_external_id_conflict" });
      }
      const profile = { _id: oid(), externalId: call.body.externalId };
      this.profiles.push(profile);
      return reply(201, { profile });
    }
    if (call.method === "GET" && call.path === "/profiles") {
      return reply(200, { profiles: this.profiles.filter((p) => p.externalId === call.query.get("externalId")) });
    }
    // Deliberately ignores profileId: the server must filter accounts itself.
    if (call.method === "GET" && call.path === "/accounts") return reply(200, { accounts: this.accounts });
    if (call.method === "DELETE" && parts[0] === "accounts") {
      this.accounts = this.accounts.filter((account) => account._id !== parts[1]);
      return reply(200, { account: { _id: parts[1] } });
    }
    if (call.method === "GET" && parts[0] === "accounts" && parts[2] === "tiktok") {
      return reply(200, {
        creator: { nickname: "c" },
        privacyLevels: [{ value: "PUBLIC_TO_EVERYONE", label: "Everyone" }],
        postingLimits: {},
        commercialContentTypes: [],
        extra: "dropped",
      });
    }
    if (call.method === "GET" && parts[0] === "connect") {
      return reply(200, { authUrl: `https://zernio.com/connect/${parts[1]}?state=s` });
    }
    if (call.method === "POST" && call.path === "/media/presign") {
      const id = oid();
      return reply(200, {
        uploadUrl: `https://r2.example/upload/${id}?sig=x`,
        publicUrl: `https://media.zernio.com/${id}/${call.body.filename}`,
        expiresIn: 3600,
      });
    }
    if (call.method === "POST" && call.path === "/posts") {
      const known = call.idempotencyKey && this.keys.get(call.idempotencyKey);
      if (known) return reply(200, { post: this.posts.get(known) });
      const post = {
        _id: oid(),
        status: call.body.publishNow ? "published" : "scheduled",
        content: call.body.content,
        externalId: call.body.externalId,
        metadata: call.body.metadata,
        platforms: call.body.platforms.map((p: any) => ({
          platform: p.platform,
          accountId: { _id: p.accountId },
          status: "pending",
        })),
      };
      this.posts.set(post._id, post);
      if (call.idempotencyKey) this.keys.set(call.idempotencyKey, post._id);
      return reply(201, { post });
    }
    if (call.method === "GET" && call.path === "/posts") {
      return reply(200, {
        posts: [...this.posts.values()].filter((p) => p.externalId === call.query.get("externalId")),
      });
    }
    if (parts[0] === "posts" && parts.length === 2) {
      const post = this.posts.get(parts[1]);
      if (!post) return reply(404, { error: "not found", code: "not_found" });
      return reply(200, { post });
    }
    if (call.method === "GET" && call.path === "/analytics") {
      if (this.analyticsStatus === 202) return reply(202, { status: "syncing" });
      return reply(200, {
        postId: call.query.get("postId"),
        content: "caption text",
        analytics: { views: 10, likes: 2 },
      });
    }
    return reply(404, { error: "unknown route" });
  }
}

function setup(limits = { read: { window: 60, limit: 1000 }, write: { window: 60, limit: 1000 } }) {
  const zernio = new FakeZernio();
  const store = new MemoryStore();
  store.workspaces.set(WS_A, USER_A);
  store.workspaces.set(WS_B, USER_B);
  const logs: Record<string, unknown>[] = [];
  // Owners' plans; Business unless a test says otherwise.
  const plans = new Map<string, PlanId>();
  const planFor = (owner: string) => {
    const plan = plans.get(owner) ?? "business";
    if (plan === "free") return entitlementFor(null);
    return entitlementFor({
      owner_id: owner,
      stripe_customer_id: "cus_test",
      stripe_subscription_id: "sub_test",
      plan,
      billing_interval: "month",
      status: "active",
      current_period_end: null,
      cancel_at_period_end: false,
      synced_at: "2026-11-20T00:00:00Z",
    });
  };
  const handler = createHandler({
    zernio: new ZernioClient("zk-test", zernio.fetch, "https://zernio.com/api/v1"),
    store,
    auth: { userId: async (token) => TOKENS[token] ?? null },
    plans: { entitlement: async (owner) => planFor(owner) },
    webhookSecret: SECRET,
    log: (entry) => logs.push(entry),
    now: () => new Date("2026-11-20T00:00:00Z"),
    limits,
  });
  const call = (
    method: string,
    path: string,
    options: { body?: unknown; token?: string; ws?: string; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token !== "") headers.Authorization = `Bearer ${options.token ?? "token-a"}`;
    if (options.ws !== "") headers["X-GF-Workspace"] = options.ws ?? WS_A;
    return handler(
      new Request(`https://x.supabase.co/functions/v1/posting${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    );
  };
  return { zernio, store, logs, handler, call, plans };
}

async function body(response: Response) {
  return await response.json();
}

async function sign(raw: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readyWorkspace(t: ReturnType<typeof setup>, ws = WS_A, token = "token-a") {
  await t.call("POST", "/register", { ws, token });
  const profileId = t.store.profiles.get(ws)!;
  const tiktok = t.zernio.addAccount(profileId, "tiktok");
  const instagram = t.zernio.addAccount(profileId, "instagram");
  const upload = await body(
    await t.call("POST", "/uploads", {
      ws,
      token,
      body: { filename: "clip.mp4", contentType: "video/mp4", size: 1000 },
    }),
  );
  return { profileId, tiktok, instagram, mediaUrl: upload.publicUrl as string };
}

const TIKTOK_OK = { privacy_level: "PUBLIC_TO_EVERYONE", content_preview_confirmed: true, express_consent_given: true };

Deno.test("callers need a valid session that owns the workspace", async () => {
  const t = setup();
  assertEquals((await t.call("GET", "/accounts", { token: "" })).status, 401);
  assertEquals((await body(await t.call("GET", "/accounts", { ws: "" }))).error.code, "workspace_required");
  assertEquals((await body(await t.call("GET", "/accounts", { token: "bogus" }))).error.code, "session_expired");
  const foreign = await t.call("GET", "/accounts", { ws: WS_B });
  assertEquals(foreign.status, 403);
  assertEquals(t.zernio.calls.length, 0);
});

Deno.test("registration creates one Zernio profile per workspace, idempotently", async () => {
  const t = setup();
  assertEquals((await t.call("POST", "/register")).status, 200);
  assertEquals((await t.call("POST", "/register")).status, 200);
  const creates = t.zernio.calls.filter((c) => c.method === "POST" && c.path === "/profiles");
  assertEquals(creates.length, 1);
  assertEquals(creates[0].body.externalId, WS_A);
  assertEquals(creates[0].idempotencyKey, `gf-profile-${WS_A}`);
});

Deno.test("registration recovers an existing profile after a 409", async () => {
  const t = setup();
  t.zernio.profiles.push({ _id: "abcdefabcdefabcdefabcdef", externalId: WS_A });
  assertEquals((await t.call("POST", "/register")).status, 200);
  assertEquals(t.store.profiles.get(WS_A), "abcdefabcdefabcdefabcdef");
});

Deno.test("accounts list only this workspace's profile, without provider secrets", async () => {
  const t = setup();
  const a = await readyWorkspace(t);
  await readyWorkspace(t, WS_B, "token-b");
  const listed = await body(await t.call("GET", "/accounts"));
  assertEquals(listed.accounts.map((x: any) => x.id).sort(), [a.tiktok, a.instagram].sort());
  assertFalse(JSON.stringify(listed).includes("SECRET-OAUTH"));
  assertEquals(listed.accounts[0].connected, true);
});

Deno.test("connect validates the platform and keeps redirects on this computer", async () => {
  const t = setup();
  assertEquals(
    (await body(await t.call("POST", "/connect", { body: { platform: "myspace" } }))).error.code,
    "unsupported_platform",
  );
  assertEquals(
    (await body(
      await t.call("POST", "/connect", { body: { platform: "tiktok", redirectUrl: "https://evil.example/cb" } }),
    )).error.code,
    "invalid_redirect",
  );
  const ok = await body(
    await t.call("POST", "/connect", { body: { platform: "tiktok", redirectUrl: "http://127.0.0.1:8765/connected" } }),
  );
  assert(ok.authUrl.startsWith("https://zernio.com/connect/tiktok"));
  const connect = t.zernio.calls.find((c) => c.path === "/connect/tiktok")!;
  assertEquals(connect.query.get("profileId"), t.store.profiles.get(WS_A));
  assertEquals(connect.query.get("redirect_url"), "http://127.0.0.1:8765/connected");
});

Deno.test("disconnect and creator info refuse accounts of other workspaces", async () => {
  const t = setup();
  const a = await readyWorkspace(t);
  const b = await readyWorkspace(t, WS_B, "token-b");
  assertEquals((await t.call("DELETE", `/accounts/${b.instagram}`)).status, 404);
  assertEquals((await t.call("GET", `/accounts/${b.tiktok}/tiktok-creator-info`)).status, 404);
  assertFalse(t.zernio.calls.some((c) => c.method === "DELETE"));
  assertEquals(
    (await body(await t.call("GET", `/accounts/${a.instagram}/tiktok-creator-info`))).error.code,
    "not_tiktok",
  );
  const info = await body(await t.call("GET", `/accounts/${a.tiktok}/tiktok-creator-info`));
  assertEquals(info.privacyLevels[0].value, "PUBLIC_TO_EVERYONE");
  assertEquals(info.extra, undefined);
  assertEquals((await body(await t.call("DELETE", `/accounts/${a.instagram}`))).disconnected, true);
});

Deno.test("uploads are validated and remembered for this workspace", async () => {
  const t = setup();
  assertEquals(
    (await body(
      await t.call("POST", "/uploads", {
        body: { filename: "a.exe", contentType: "application/x-msdownload", size: 5 },
      }),
    )).error.code,
    "unsupported_media",
  );
  assertEquals(
    (await body(
      await t.call("POST", "/uploads", { body: { filename: "../etc/passwd", contentType: "video/mp4", size: 5 } }),
    )).error.code,
    "invalid_filename",
  );
  assertEquals(
    (await body(
      await t.call("POST", "/uploads", { body: { filename: "a.mp4", contentType: "video/mp4", size: 6 * 1024 ** 3 } }),
    )).error.code,
    "invalid_size",
  );
  const ok = await body(
    await t.call("POST", "/uploads", { body: { filename: "a.mp4", contentType: "video/mp4", size: 5 } }),
  );
  assert(ok.uploadUrl.startsWith("https://"));
  assertEquals(t.store.uploads.get(ok.publicUrl), WS_A);
});

Deno.test("posts are scoped, consent-gated and namespaced for idempotency", async () => {
  const t = setup();
  const a = await readyWorkspace(t);
  const b = await readyWorkspace(t, WS_B, "token-b");
  const base = { content: "Caption #one", mediaItems: [{ url: a.mediaUrl, type: "video" }], publishNow: true };
  const post = (payload: unknown, key = "attempt-0001", options: { ws?: string; token?: string } = {}) =>
    t.call("POST", "/posts", { ...options, body: payload, headers: key ? { "Idempotency-Key": key } : {} });

  assertEquals(
    (await body(await post({ ...base, platforms: [{ accountId: a.instagram }] }, ""))).error.code,
    "idempotency_key_required",
  );
  assertEquals(
    (await body(await post({ ...base, platforms: [{ accountId: b.instagram }] }))).error.code,
    "account_not_allowed",
  );
  assertEquals(
    (await body(await post({ ...base, platforms: [{ accountId: a.instagram }, { accountId: a.instagram }] }))).error
      .code,
    "account_not_allowed",
  );
  assertEquals(
    (await body(await post({ ...base, mediaItems: [{ url: b.mediaUrl }], platforms: [{ accountId: a.instagram }] })))
      .error.code,
    "media_not_allowed",
  );
  assertEquals(
    (await body(await post({ ...base, platforms: [{ accountId: a.tiktok }] }))).error.code,
    "tiktok_consent_required",
  );
  assertEquals(
    (await body(
      await post({
        ...base,
        platforms: [{
          accountId: a.tiktok,
          platformSpecificData: { privacy_level: "SELF_ONLY", content_preview_confirmed: true },
        }],
      }),
    )).error.code,
    "tiktok_consent_required",
  );
  assertEquals(
    (await body(await post({ ...base, scheduledFor: "2027-01-01T00:00:00Z", platforms: [{ accountId: a.instagram }] })))
      .error.code,
    "invalid_timing",
  );
  const { publishNow: _now, ...unscheduled } = base;
  assertEquals(
    (await body(
      await post({ ...unscheduled, scheduledFor: "2026-11-01T00:00:00Z", platforms: [{ accountId: a.instagram }] }),
    )).error.code,
    "invalid_schedule",
  );
  assertEquals(
    (await body(
      await post({ ...unscheduled, scheduledFor: "2027-01-01T09:00:00", platforms: [{ accountId: a.instagram }] }),
    )).error.code,
    "invalid_schedule",
  );
  assertFalse(t.zernio.calls.some((c) => c.method === "POST" && c.path === "/posts"));

  const created = await post({
    ...base,
    externalId: "gf-attempt-1",
    tiktokSettings: TIKTOK_OK,
    platforms: [{ accountId: a.tiktok, content: "TikTok caption" }, {
      accountId: a.instagram,
      platformSpecificData: { shareToFeed: true },
    }],
  });
  assertEquals(created.status, 201);
  const result = await body(created);
  assertEquals(result.replayed, false);
  assertEquals(result.post.platforms.map((p: any) => p.platform), ["tiktok", "instagram"]);
  const sent = t.zernio.calls.find((c) => c.method === "POST" && c.path === "/posts")!;
  assertEquals(sent.idempotencyKey, `gf:${WS_A}:attempt-0001`);
  assertEquals(sent.body.metadata, { gf_workspace: WS_A });
  assertEquals(sent.body.platforms[0], { platform: "tiktok", accountId: a.tiktok, customContent: "TikTok caption" });
  assertEquals(t.store.posts.get(result.post.id), WS_A);

  const replay = await post({ ...base, platforms: [{ accountId: a.instagram }] });
  assertEquals(replay.status, 200);
  assertEquals((await body(replay)).post.id, result.post.id);
  assertEquals(t.zernio.posts.size, 1);

  // The same client key from another workspace never reaches workspace A's post.
  const other = await body(
    await post(
      { ...base, mediaItems: [{ url: b.mediaUrl }], platforms: [{ accountId: b.instagram }] },
      "attempt-0001",
      { ws: WS_B, token: "token-b" },
    ),
  );
  assert(other.post.id !== result.post.id);
});

Deno.test("an in-flight duplicate create reports in_progress with Retry-After", async () => {
  const t = setup();
  const a = await readyWorkspace(t);
  t.zernio.overrides.set(
    "POST /posts",
    () =>
      Response.json({ error: "busy", code: "idempotency_conflict" }, { status: 409, headers: { "Retry-After": "3" } }),
  );
  const response = await t.call("POST", "/posts", {
    headers: { "Idempotency-Key": "attempt-0002" },
    body: { mediaItems: [{ url: a.mediaUrl }], publishNow: true, platforms: [{ accountId: a.instagram }] },
  });
  assertEquals(response.status, 409);
  assertEquals(response.headers.get("Retry-After"), "3");
  assertEquals((await body(response)).error.code, "in_progress");
});

Deno.test("reading, finding, cancelling and analytics are limited to owned posts", async () => {
  const t = setup();
  const a = await readyWorkspace(t);
  const b = await readyWorkspace(t, WS_B, "token-b");
  const mine = await body(
    await t.call("POST", "/posts", {
      headers: { "Idempotency-Key": "attempt-0003" },
      body: {
        externalId: "shared-id",
        mediaItems: [{ url: a.mediaUrl }],
        scheduledFor: "2026-12-01T10:00:00-08:00",
        platforms: [{ accountId: a.instagram }],
      },
    }),
  );
  const theirs = await body(
    await t.call("POST", "/posts", {
      ws: WS_B,
      token: "token-b",
      headers: { "Idempotency-Key": "attempt-0003" },
      body: {
        externalId: "shared-id",
        mediaItems: [{ url: b.mediaUrl }],
        publishNow: true,
        platforms: [{ accountId: b.instagram }],
      },
    }),
  );
  assertEquals((await t.call("GET", `/posts/${theirs.post.id}`)).status, 404);
  assertEquals((await t.call("DELETE", `/posts/${theirs.post.id}`)).status, 404);
  assertEquals((await t.call("GET", `/posts/${theirs.post.id}/analytics`)).status, 404);

  const read = await body(await t.call("GET", `/posts/${mine.post.id}`));
  assertEquals(read.post.status, "scheduled");
  assertEquals(read.events, []);
  const found = await body(await t.call("GET", "/posts?externalId=shared-id"));
  assertEquals(found.posts.map((p: any) => p.id), [mine.post.id]);

  t.zernio.analyticsStatus = 202;
  assertEquals((await body(await t.call("GET", `/posts/${mine.post.id}/analytics`))).status, "syncing");
  t.zernio.analyticsStatus = 200;
  const ready = await body(await t.call("GET", `/posts/${mine.post.id}/analytics`));
  assertEquals(ready.status, "ready");
  assertEquals(ready.analytics.analytics.views, 10);
  assertEquals(ready.analytics.content, undefined);

  assertEquals((await body(await t.call("DELETE", `/posts/${mine.post.id}`))).cancelled, true);
});

Deno.test("webhooks are verified, deduplicated and stored without captions", async () => {
  const t = setup();
  const a = await readyWorkspace(t);
  const created = await body(
    await t.call("POST", "/posts", {
      headers: { "Idempotency-Key": "attempt-0004" },
      body: {
        content: "Private caption",
        mediaItems: [{ url: a.mediaUrl }],
        publishNow: true,
        platforms: [{ accountId: a.instagram }],
      },
    }),
  );
  const event = {
    id: "evt-1",
    event: "post.platform.published",
    timestamp: "2026-11-20T00:05:00Z",
    post: {
      id: created.post.id,
      content: "Private caption",
      status: "published",
      metadata: { gf_workspace: WS_A },
      platforms: [],
    },
    platform: {
      name: "instagram",
      status: "published",
      platformPostId: "1789",
      publishedUrl: "https://instagram.com/reel/x",
    },
    account: { accountId: a.instagram, platform: "instagram", username: "u" },
  };
  const deliver = async (payload: unknown, signature?: string) => {
    const raw = JSON.stringify(payload);
    return await t.handler(
      new Request("https://x.supabase.co/functions/v1/posting/webhooks/zernio", {
        method: "POST",
        headers: { "X-Zernio-Signature": signature ?? await sign(raw), "Content-Type": "application/json" },
        body: raw,
      }),
    );
  };
  assertEquals((await deliver(event, "00".repeat(32))).status, 401);
  assertEquals((await body(await deliver(event))).stored, true);
  assertEquals((await deliver(event)).status, 200);
  assertEquals(t.store.eventRows.size, 1);
  assertFalse(JSON.stringify([...t.store.eventRows.values()]).includes("Private caption"));

  assertEquals(
    (await body(await deliver({ ...event, id: "evt-2", post: { ...event.post, id: "ffffffffffffffffffffffff" } })))
      .stored,
    false,
  );
  assertEquals(
    (await body(await deliver({ ...event, id: "evt-3", post: { ...event.post, metadata: { gf_workspace: WS_B } } })))
      .stored,
    false,
  );
  assertEquals((await body(await deliver({ id: "evt-4", event: "webhook.test", test: true }))).stored, false);

  const read = await body(await t.call("GET", `/posts/${created.post.id}`));
  assertEquals(read.events.length, 1);
  assertEquals(read.events[0].platformPostId, "1789");
  assertEquals(read.events[0].url, "https://instagram.com/reel/x");
});

Deno.test("signature comparison rejects lookalikes", async () => {
  const good = await sign("{}");
  assert(await signatureMatches(SECRET, "{}", good));
  assert(await signatureMatches(SECRET, "{}", good.toUpperCase()));
  assertFalse(await signatureMatches(SECRET, "{}", good.slice(0, -1)));
  assertFalse(await signatureMatches(SECRET, "{ }", good));
});

Deno.test("each workspace is rate limited on its own", async () => {
  const t = setup(LIMITS);
  for (let i = 0; i < LIMITS.write.limit; i++) assertEquals((await t.call("POST", "/register")).status, 200);
  const limited = await t.call("POST", "/register");
  assertEquals(limited.status, 429);
  assertEquals(limited.headers.get("Retry-After"), "60");
  assertEquals((await t.call("POST", "/register", { ws: WS_B, token: "token-b" })).status, 200);
});

Deno.test("Zernio failures map to retryable gateway errors", async () => {
  const t = setup();
  t.zernio.overrides.set("POST /profiles", () => new Response("oops", { status: 500 }));
  assertEquals((await body(await t.call("POST", "/register"))).error.code, "zernio_unavailable");
  t.zernio.overrides.clear();
  t.zernio.down = true;
  const response = await t.call("POST", "/register");
  assertEquals(response.status, 502);
  assertEquals((await body(response)).error.code, "zernio_unavailable");
});

Deno.test("a Zernio plan limit becomes a clear, non-retryable error without billing links", async () => {
  const t = setup();
  t.zernio.overrides.set("POST /profiles", () =>
    Response.json({
      error: "Add a payment method to connect more than 2 accounts.",
      code: "PAYMENT_REQUIRED",
      dashboard_url: "https://zernio.com/dashboard/billing",
    }, { status: 402 }));
  const response = await t.call("POST", "/register");
  assertEquals(response.status, 402);
  const payload = await body(response);
  assertEquals(payload.error.code, "posting_plan_limit");
  assertFalse(JSON.stringify(payload).includes("zernio.com"));
});

Deno.test("request logs carry no captions, tokens or identifiers", async () => {
  const t = setup();
  const a = await readyWorkspace(t);
  await t.call("POST", "/posts", {
    headers: { "Idempotency-Key": "attempt-0005" },
    body: {
      content: "Very private caption",
      mediaItems: [{ url: a.mediaUrl }],
      publishNow: true,
      platforms: [{ accountId: a.instagram }],
    },
  });
  await t.call("GET", `/accounts/${a.tiktok}/tiktok-creator-info`);
  const text = JSON.stringify(t.logs);
  for (const secret of ["Very private caption", "token-a", "zk-test", a.instagram, a.tiktok, a.mediaUrl, WS_A]) {
    assertFalse(text.includes(secret), `log leaked ${secret}`);
  }
  assert(t.logs.some((entry) => entry.route === "/accounts/:id/tiktok-creator-info"));
});

Deno.test("unknown routes are 404 after authentication", async () => {
  const t = setup();
  assertEquals((await body(await t.call("GET", "/nope"))).error.code, "not_found");
});

Deno.test("the Free plan cannot connect, upload or post but can still see and disconnect accounts", async () => {
  const t = setup();
  const ready = await readyWorkspace(t);
  t.plans.set(USER_A, "free");
  for (
    const [method, path, payload] of [
      ["POST", "/connect", { platform: "tiktok" }],
      ["POST", "/uploads", { filename: "clip.mp4", contentType: "video/mp4", size: 1000 }],
    ] as const
  ) {
    const response = await t.call(method, path, { body: payload });
    assertEquals(response.status, 402, path);
    const error = (await body(response)).error;
    assertEquals(error.code, "plan_required");
    assertEquals(error.plan, "free");
    assertEquals(error.limit, "connected_accounts");
  }
  const post = await t.call("POST", "/posts", {
    headers: { "Idempotency-Key": "free-plan-post-1" },
    body: {
      content: "hi",
      platforms: [{ accountId: ready.instagram }],
      mediaItems: [{ url: ready.mediaUrl }],
      publishNow: true,
    },
  });
  assertEquals(post.status, 402);
  assertEquals((await body(post)).error.code, "plan_required");
  assertFalse(t.zernio.calls.some((c) => c.method === "POST" && c.path === "/posts"));

  assertEquals((await t.call("GET", "/accounts")).status, 200);
  assertEquals((await t.call("DELETE", `/accounts/${ready.tiktok}`)).status, 200);
});

Deno.test("connecting stops at the plan's account limit", async () => {
  const t = setup();
  const ready = await readyWorkspace(t); // two accounts connected
  t.plans.set(USER_A, "pro"); // three included
  assertEquals((await t.call("POST", "/connect", { body: { platform: "youtube" } })).status, 200);
  t.zernio.addAccount(ready.profileId, "youtube");
  const refused = await t.call("POST", "/connect", { body: { platform: "facebook" } });
  assertEquals(refused.status, 402);
  const error = (await body(refused)).error;
  assertEquals([error.code, error.usage, error.max, error.plan], ["plan_limit", 3, 3, "pro"]);
  assert(error.message.includes("3 connected accounts"));
  // Another owner's plan is separate.
  await t.call("POST", "/register", { ws: WS_B, token: "token-b" });
  assertEquals(
    (await t.call("POST", "/connect", { ws: WS_B, token: "token-b", body: { platform: "tiktok" } })).status,
    200,
  );
});

Deno.test("after a downgrade, posting waits until the accounts fit the plan", async () => {
  const t = setup();
  const ready = await readyWorkspace(t);
  t.zernio.addAccount(ready.profileId, "youtube");
  const extra = t.zernio.addAccount(ready.profileId, "facebook"); // four connected
  t.plans.set(USER_A, "pro");
  const post = () =>
    t.call("POST", "/posts", {
      headers: { "Idempotency-Key": `downgrade-${crypto.randomUUID()}` },
      body: {
        content: "hi",
        platforms: [{ accountId: ready.instagram }],
        mediaItems: [{ url: ready.mediaUrl }],
        publishNow: true,
      },
    });
  const refused = await post();
  assertEquals(refused.status, 402);
  const error = (await body(refused)).error;
  assertEquals([error.code, error.usage, error.max], ["plan_over_limit", 4, 3]);
  assertEquals((await t.call("DELETE", `/accounts/${extra}`)).status, 200);
  assertEquals((await post()).status, 201);
});

Deno.test("an unavailable plan lookup fails closed", async () => {
  const t = setup();
  await readyWorkspace(t);
  const handler = createHandler({
    zernio: new ZernioClient("zk-test", t.zernio.fetch, "https://zernio.com/api/v1"),
    store: t.store,
    auth: { userId: async (token) => TOKENS[token] ?? null },
    plans: {
      entitlement: async () => {
        throw new PlanSourceError("down");
      },
    },
    webhookSecret: SECRET,
  });
  const response = await handler(
    new Request("https://x.supabase.co/functions/v1/posting/connect", {
      method: "POST",
      headers: { Authorization: "Bearer token-a", "X-GF-Workspace": WS_A },
      body: JSON.stringify({ platform: "tiktok" }),
    }),
  );
  assertEquals(response.status, 503);
});
