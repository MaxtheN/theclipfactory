// Growth Factory posting server (WO-22). Holds the Zernio key and scopes every call to the
// caller's own workspace profile. See docs/posting-server.md for the HTTP contract.

import { type ZernioClient, type ZernioResponse, ZernioUnavailable } from "./zernio.ts";
import { type Auth, type PostingEvent, type Store, StoreError } from "./store.ts";

export const PLATFORMS = ["tiktok", "instagram", "youtube", "facebook", "linkedin", "twitter", "threads"];
export const UPLOAD_TYPES = new Set(["video/mp4", "video/quicktime", "image/jpeg", "image/png"]);
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
/** Per-workspace limits. The whole Zernio account allows 60 requests a minute on the free tier. */
export const LIMITS = { read: { window: 60, limit: 30 }, write: { window: 60, limit: 10 } };
const MAX_BODY_BYTES = 256 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_TARGETS = 10;
const MAX_TEXT = 10_000;
const ZERNIO_ID = /^[0-9a-f]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const EXPLICIT_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

export interface Deps {
  zernio: ZernioClient;
  store: Store;
  auth: Auth;
  webhookSecret: string;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
  limits?: typeof LIMITS;
}

interface Caller {
  workspaceId: string;
}

type Json = Record<string, unknown>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clip(value: unknown, max: number): string | null {
  const text = str(value);
  return text === null ? null : text.slice(0, max);
}

/** "/posting/posts/abc" or "/functions/v1/posting/posts/abc" -> "/posts/abc". */
export function routePath(pathname: string): string {
  const at = pathname.indexOf("/posting");
  const rest = at >= 0 ? pathname.slice(at + "/posting".length) : pathname;
  return (rest || "/").replace(/\/+$/, "") || "/";
}

/** Route label for logs: ids replaced so logs carry no account or post identifiers. */
function routeLabel(path: string): string {
  return path.split("/").map((part) => (ZERNIO_ID.test(part) ? ":id" : part)).join("/");
}

function upstream(response: ZernioResponse): HttpError {
  const body = response.body ?? {};
  const code = str(body.code) ?? "zernio_error";
  if (response.status === 429) {
    return new HttpError(
      429,
      "zernio_rate_limited",
      "Zernio is limiting requests right now. Try again shortly.",
      response.retryAfter ? { "Retry-After": response.retryAfter } : {},
    );
  }
  if (response.status >= 500 || response.status < 400) {
    return new HttpError(502, "zernio_unavailable", "Zernio had a problem. Try again shortly.");
  }
  if (response.status === 401) {
    return new HttpError(502, "server_misconfigured", "The posting server's Zernio key was rejected.");
  }
  if (response.status === 402) {
    // Plan limit on the shared Zernio account (e.g. free tier: 2 connected accounts). Not retryable by
    // the creator; Zernio's billing links are not forwarded to clients.
    return new HttpError(
      402,
      "posting_plan_limit",
      "The posting service has reached its plan limit. The Growth Factory administrator must add billing before more accounts or workspaces can connect.",
    );
  }
  const message = clip(body.error, 500) ?? "Zernio rejected the request.";
  return new HttpError(response.status, code, message);
}

async function readJson(request: Request, max = MAX_BODY_BYTES): Promise<Json> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) {
    throw new HttpError(413, "body_too_large", "The request body is too large.");
  }
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (isObject(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_json", "Send a JSON object.");
}

export async function signatureMatches(secret: string, raw: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const given = signature.trim().toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function accountProfileId(account: Json): string | null {
  const profile = account.profileId;
  if (typeof profile === "string") return profile;
  return isObject(profile) ? str(profile._id) : null;
}

function publicAccount(account: Json) {
  return {
    id: str(account._id),
    platform: str(account.platform),
    username: str(account.username),
    displayName: str(account.displayName),
    avatarUrl: str(account.profilePicture) ?? str(account.avatarUrl),
    connected: account.isActive !== false,
  };
}

function publicPost(post: Json) {
  const platforms = Array.isArray(post.platforms) ? post.platforms.filter(isObject) : [];
  return {
    id: str(post._id) ?? str(post.id),
    status: str(post.status),
    scheduledFor: str(post.scheduledFor),
    publishedAt: str(post.publishedAt),
    externalId: str(post.externalId),
    platforms: platforms.map((entry) => ({
      platform: str(entry.platform),
      accountId: typeof entry.accountId === "string"
        ? entry.accountId
        : isObject(entry.accountId)
        ? str(entry.accountId._id)
        : null,
      status: str(entry.status),
      platformPostId: str(entry.platformPostId),
      url: str(entry.platformPostUrl) ?? str(entry.publishedUrl),
      error: clip(entry.errorMessage, 1000) ?? clip(entry.error, 1000),
      errorCategory: str(entry.errorCategory),
      errorSource: str(entry.errorSource),
    })),
  };
}

function publicEvent(event: PostingEvent) {
  return {
    id: event.event_id,
    event: event.event,
    postStatus: event.post_status,
    platform: event.platform,
    accountId: event.account_id,
    platformStatus: event.platform_status,
    platformPostId: event.platform_post_id,
    url: event.published_url,
    error: event.error,
    errorCategory: event.error_category,
    errorSource: event.error_source,
    occurredAt: event.occurred_at,
  };
}

function postWorkspaceTag(post: Json): string | null {
  return isObject(post.metadata) ? str(post.metadata.gf_workspace) : null;
}

export function createHandler(deps: Deps) {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const { zernio, store } = deps;
  const limits = deps.limits ?? LIMITS;

  async function authenticate(request: Request): Promise<Caller> {
    const header = request.headers.get("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new HttpError(401, "sign_in_required", "Sign in to Growth Factory cloud first.");
    const workspaceId = (request.headers.get("X-GF-Workspace") ?? "").trim().toLowerCase();
    if (!UUID.test(workspaceId)) {
      throw new HttpError(400, "workspace_required", "Send your workspace id in the X-GF-Workspace header.");
    }
    const userId = await deps.auth.userId(token);
    if (!userId) throw new HttpError(401, "session_expired", "Your cloud session expired. Sign in again.");
    if ((await store.workspaceOwner(workspaceId)) !== userId) {
      throw new HttpError(403, "workspace_forbidden", "This workspace does not belong to the signed-in account.");
    }
    return { workspaceId };
  }

  async function ensureProfile(caller: Caller): Promise<string> {
    const existing = await store.profileFor(caller.workspaceId);
    if (existing) return existing;
    const created = await zernio.request("POST", "/profiles", {
      body: {
        name: `Growth Factory ${caller.workspaceId}`,
        externalId: caller.workspaceId,
        description: "Growth Factory workspace",
      },
      idempotencyKey: `gf-profile-${caller.workspaceId}`,
    });
    let profileId = isObject(created.body?.profile) ? str(created.body.profile._id) : null;
    if (!profileId && created.status === 409) {
      const found = await zernio.request("GET", "/profiles", { query: { externalId: caller.workspaceId } });
      const profiles = Array.isArray(found.body?.profiles) ? found.body.profiles.filter(isObject) : [];
      profileId = str(profiles.find((p) => p.externalId === caller.workspaceId)?._id);
    }
    if (!profileId || !ZERNIO_ID.test(profileId)) throw upstream(created);
    return await store.saveProfile(caller.workspaceId, profileId);
  }

  async function profileAccounts(profileId: string): Promise<Json[]> {
    const listed = await zernio.request("GET", "/accounts", { query: { profileId } });
    if (listed.status !== 200) throw upstream(listed);
    const accounts = Array.isArray(listed.body?.accounts) ? listed.body.accounts.filter(isObject) : [];
    // Defence in depth: keep only accounts Zernio reports on this exact profile.
    return accounts.filter((account) => accountProfileId(account) === profileId && str(account._id));
  }

  async function ownedAccount(profileId: string, accountId: string): Promise<Json> {
    if (!ZERNIO_ID.test(accountId)) throw new HttpError(404, "account_not_found", "No such connected account.");
    const account = (await profileAccounts(profileId)).find((a) => a._id === accountId);
    if (!account) throw new HttpError(404, "account_not_found", "No such connected account.");
    return account;
  }

  async function ownedPost(caller: Caller, postId: string): Promise<void> {
    if (!ZERNIO_ID.test(postId) || (await store.postOwner(postId)) !== caller.workspaceId) {
      throw new HttpError(404, "post_not_found", "No such post.");
    }
  }

  async function connect(caller: Caller, request: Request): Promise<Response> {
    const body = await readJson(request);
    const platform = str(body.platform);
    if (!platform || !PLATFORMS.includes(platform)) {
      throw new HttpError(400, "unsupported_platform", `Choose one of: ${PLATFORMS.join(", ")}.`);
    }
    let redirect: string | undefined;
    if (body.redirectUrl !== undefined) {
      const parsed = URL.canParse(String(body.redirectUrl)) ? new URL(String(body.redirectUrl)) : null;
      const loopback = parsed && ["127.0.0.1", "localhost"].includes(parsed.hostname) &&
        ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
      if (!loopback) {
        throw new HttpError(400, "invalid_redirect", "The redirect must return to the app on this computer.");
      }
      redirect = parsed!.toString();
    }
    const profileId = await ensureProfile(caller);
    const result = await zernio.request("GET", `/connect/${platform}`, {
      query: { profileId, redirect_url: redirect },
    });
    const authUrl = str(result.body?.authUrl);
    if (result.status !== 200 || !authUrl || !authUrl.startsWith("https://")) throw upstream(result);
    return json(200, { platform, authUrl });
  }

  async function presign(caller: Caller, request: Request): Promise<Response> {
    const body = await readJson(request);
    const filename = str(body.filename);
    const contentType = str(body.contentType);
    const size = body.size;
    if (!filename || !FILENAME.test(filename)) throw new HttpError(400, "invalid_filename", "Use a plain file name.");
    if (!contentType || !UPLOAD_TYPES.has(contentType)) {
      throw new HttpError(400, "unsupported_media", "Upload an MP4 or MOV video, or a JPEG or PNG image.");
    }
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
      throw new HttpError(400, "invalid_size", "Send the file size in bytes, up to 5 GB.");
    }
    await ensureProfile(caller);
    const result = await zernio.request("POST", "/media/presign", { body: { filename, contentType, size } });
    const uploadUrl = str(result.body?.uploadUrl);
    const publicUrl = str(result.body?.publicUrl);
    if (result.status !== 200 || !uploadUrl?.startsWith("https://") || !publicUrl?.startsWith("https://")) {
      throw upstream(result);
    }
    await store.saveUpload(caller.workspaceId, publicUrl, contentType);
    const expiresIn = typeof result.body?.expiresIn === "number" ? result.body.expiresIn : 3600;
    return json(200, { uploadUrl, publicUrl, contentType, expiresIn });
  }

  function validTarget(value: unknown): value is Json {
    return isObject(value) && typeof value.accountId === "string";
  }

  async function createPost(caller: Caller, request: Request): Promise<Response> {
    const key = (request.headers.get("Idempotency-Key") ?? "").trim();
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw new HttpError(400, "idempotency_key_required", "Send an Idempotency-Key header (8-128 characters).");
    }
    const body = await readJson(request);
    const content = body.content === undefined ? undefined : body.content;
    if (content !== undefined && (typeof content !== "string" || content.length > MAX_TEXT)) {
      throw new HttpError(400, "invalid_content", "The caption must be text of at most 10,000 characters.");
    }
    const targets = body.platforms;
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_TARGETS || !targets.every(validTarget)) {
      throw new HttpError(400, "invalid_targets", "Choose between 1 and 10 connected accounts.");
    }
    const media = body.mediaItems;
    if (
      !Array.isArray(media) || media.length < 1 || media.length > MAX_TARGETS ||
      !media.every((item) => isObject(item) && typeof item.url === "string" && item.url.startsWith("https://"))
    ) {
      throw new HttpError(400, "invalid_media", "Attach between 1 and 10 uploaded media files.");
    }
    const publishNow = body.publishNow === true;
    const scheduledFor = body.scheduledFor;
    if (publishNow === (scheduledFor !== undefined)) {
      throw new HttpError(400, "invalid_timing", "Choose either publishNow or scheduledFor.");
    }
    if (scheduledFor !== undefined) {
      const at = typeof scheduledFor === "string" && EXPLICIT_OFFSET.test(scheduledFor)
        ? Date.parse(scheduledFor)
        : NaN;
      if (Number.isNaN(at) || at < now().getTime() - 60_000) {
        throw new HttpError(400, "invalid_schedule", "Schedule a future time with a time zone offset.");
      }
    }
    for (const field of ["tiktokSettings", "metadata"] as const) {
      if (body[field] !== undefined && !isObject(body[field])) {
        throw new HttpError(400, "invalid_settings", `${field} must be an object.`);
      }
    }
    const externalId = body.externalId;
    if (externalId !== undefined && (typeof externalId !== "string" || !/^[\w.:-]{1,128}$/.test(externalId))) {
      throw new HttpError(400, "invalid_external_id", "externalId must be 1-128 letters, digits or ._:- characters.");
    }

    const profileId = await ensureProfile(caller);
    const accounts = new Map((await profileAccounts(profileId)).map((a) => [a._id as string, a]));
    const seen = new Set<string>();
    const platforms: Json[] = [];
    const rootTikTok = isObject(body.tiktokSettings) ? body.tiktokSettings : {};
    for (const target of targets as Json[]) {
      const accountId = target.accountId as string;
      const account = accounts.get(accountId);
      if (!account || seen.has(accountId)) {
        throw new HttpError(
          403,
          "account_not_allowed",
          "Post only to accounts connected to this workspace, once each.",
        );
      }
      seen.add(accountId);
      const platform = str(account.platform)!;
      const specific = target.platformSpecificData;
      if (specific !== undefined && !isObject(specific)) {
        throw new HttpError(400, "invalid_settings", "platformSpecificData must be an object.");
      }
      const custom = target.content;
      if (custom !== undefined && (typeof custom !== "string" || custom.length > MAX_TEXT)) {
        throw new HttpError(400, "invalid_content", "Each caption must be text of at most 10,000 characters.");
      }
      if (platform === "tiktok") {
        const merged = { ...rootTikTok, ...(isObject(specific) ? specific : {}) };
        if (
          merged.content_preview_confirmed !== true || merged.express_consent_given !== true ||
          typeof merged.privacy_level !== "string"
        ) {
          throw new HttpError(
            400,
            "tiktok_consent_required",
            "TikTok needs the creator's preview confirmation, consent and a privacy level.",
          );
        }
      }
      platforms.push({
        platform,
        accountId,
        ...(custom !== undefined ? { customContent: custom } : {}),
        ...(isObject(specific) ? { platformSpecificData: specific } : {}),
      });
    }
    const urls = (media as Json[]).map((item) => item.url as string);
    if (!(await store.uploadsOwned(caller.workspaceId, urls))) {
      throw new HttpError(403, "media_not_allowed", "Attach only media uploaded through this workspace.");
    }

    const payload: Json = {
      platforms,
      mediaItems: (media as Json[]).map((item) => ({
        url: item.url,
        ...(item.type === "video" || item.type === "image" ? { type: item.type } : {}),
      })),
      metadata: { gf_workspace: caller.workspaceId },
      ...(content !== undefined ? { content } : {}),
      ...(publishNow ? { publishNow: true } : { scheduledFor }),
      ...(Object.keys(rootTikTok).length ? { tiktokSettings: rootTikTok } : {}),
      ...(externalId !== undefined ? { externalId } : {}),
    };
    // Zernio scopes idempotency keys to the whole account, so namespace them per workspace.
    const result = await zernio.request("POST", "/posts", {
      body: payload,
      idempotencyKey: `gf:${caller.workspaceId}:${key}`,
    });
    if (result.status === 409 && result.body?.code === "idempotency_conflict") {
      throw new HttpError(
        409,
        "in_progress",
        "This post is still being created. Check again shortly.",
        result.retryAfter ? { "Retry-After": result.retryAfter } : {},
      );
    }
    const post = isObject(result.body?.post) ? result.body.post : null;
    const postId = post ? str(post._id) : null;
    if (![200, 201, 202, 207].includes(result.status) || !post || !postId || !ZERNIO_ID.test(postId)) {
      throw upstream(result);
    }
    const tag = postWorkspaceTag(post);
    if ((tag && tag !== caller.workspaceId) || !(await store.savePost(caller.workspaceId, postId))) {
      throw new HttpError(409, "post_conflict", "That post belongs to another workspace.");
    }
    return json(result.status === 200 ? 200 : 201, {
      replayed: result.status === 200,
      post: publicPost(post),
    });
  }

  async function readPost(caller: Caller, postId: string): Promise<Response> {
    await ownedPost(caller, postId);
    const result = await zernio.request("GET", `/posts/${postId}`);
    if (result.status !== 200 || !isObject(result.body?.post)) throw upstream(result);
    const events = (await store.events(postId)).map(publicEvent);
    return json(200, { post: publicPost(result.body.post), events });
  }

  async function findPosts(caller: Caller, externalId: string): Promise<Response> {
    if (!/^[\w.:-]{1,128}$/.test(externalId)) {
      throw new HttpError(400, "invalid_external_id", "externalId must be 1-128 letters, digits or ._:- characters.");
    }
    const profileId = await ensureProfile(caller);
    const result = await zernio.request("GET", "/posts", { query: { externalId, profileId } });
    if (result.status !== 200) throw upstream(result);
    const listed = Array.isArray(result.body?.posts) ? result.body.posts.filter(isObject) : [];
    const posts = [];
    for (const post of listed) {
      const id = str(post._id);
      if (id && ZERNIO_ID.test(id) && (await store.postOwner(id)) === caller.workspaceId) posts.push(publicPost(post));
    }
    return json(200, { posts });
  }

  async function analytics(caller: Caller, postId: string): Promise<Response> {
    await ownedPost(caller, postId);
    const profileId = await ensureProfile(caller);
    const result = await zernio.request("GET", "/analytics", { query: { postId, profileId } });
    if (result.status === 202) return json(200, { status: "syncing", analytics: null });
    if (result.status !== 200 || !result.body) throw upstream(result);
    const { content: _content, ...rest } = result.body;
    return json(200, { status: "ready", analytics: rest });
  }

  async function route(request: Request, path: string, url: URL, caller: Caller): Promise<Response> {
    const write = request.method !== "GET";
    const limit = write ? limits.write : limits.read;
    if (!(await store.takeRate(caller.workspaceId, write ? "write" : "read", limit.window, limit.limit))) {
      throw new HttpError(429, "rate_limited", "Too many posting requests from this workspace. Wait a minute.", {
        "Retry-After": String(limit.window),
      });
    }
    if (!zernio.configured) throw new HttpError(503, "not_configured", "The posting server is not configured yet.");
    const parts = path.split("/").filter(Boolean);
    const method = request.method;
    const [head, id, tail] = parts;

    if (method === "POST" && path === "/register") {
      await ensureProfile(caller);
      return json(200, { registered: true, workspaceId: caller.workspaceId });
    }
    if (head === "accounts") {
      if (method === "GET" && parts.length === 1) {
        const accounts = await profileAccounts(await ensureProfile(caller));
        return json(200, { accounts: accounts.map(publicAccount) });
      }
      if (method === "DELETE" && parts.length === 2) {
        await ownedAccount(await ensureProfile(caller), id);
        const result = await zernio.request("DELETE", `/accounts/${id}`);
        if (result.status !== 200) throw upstream(result);
        return json(200, { disconnected: true, accountId: id });
      }
      if (method === "GET" && parts.length === 3 && tail === "tiktok-creator-info") {
        const account = await ownedAccount(await ensureProfile(caller), id);
        if (account.platform !== "tiktok") {
          throw new HttpError(400, "not_tiktok", "Creator info is only available for TikTok accounts.");
        }
        const result = await zernio.request("GET", `/accounts/${id}/tiktok/creator-info`, {
          query: { mediaType: "video" },
        });
        if (result.status !== 200 || !result.body) throw upstream(result);
        const { creator, privacyLevels, postingLimits, commercialContentTypes } = result.body;
        return json(200, { creator, privacyLevels, postingLimits, commercialContentTypes });
      }
    }
    if (method === "POST" && path === "/connect") return await connect(caller, request);
    if (method === "POST" && path === "/uploads") return await presign(caller, request);
    if (head === "posts") {
      if (method === "POST" && parts.length === 1) return await createPost(caller, request);
      if (method === "GET" && parts.length === 1) {
        return await findPosts(caller, url.searchParams.get("externalId") ?? "");
      }
      if (method === "GET" && parts.length === 2) return await readPost(caller, id);
      if (method === "GET" && parts.length === 3 && tail === "analytics") return await analytics(caller, id);
      if (method === "DELETE" && parts.length === 2) {
        await ownedPost(caller, id);
        const result = await zernio.request("DELETE", `/posts/${id}`);
        if (result.status !== 200) throw upstream(result);
        return json(200, { cancelled: true, postId: id });
      }
    }
    throw new HttpError(404, "not_found", "No such posting route.");
  }

  async function webhook(request: Request): Promise<Response> {
    if (!deps.webhookSecret) throw new HttpError(503, "not_configured", "Webhooks are not configured yet.");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_WEBHOOK_BYTES) {
      throw new HttpError(413, "body_too_large", "The webhook body is too large.");
    }
    const signature = request.headers.get("X-Zernio-Signature") ?? "";
    if (!(await signatureMatches(deps.webhookSecret, raw, signature))) {
      throw new HttpError(401, "invalid_signature", "Invalid signature.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json", "Send a JSON object.");
    }
    if (!isObject(payload) || !str(payload.id) || !str(payload.event)) {
      throw new HttpError(400, "invalid_event", "The event has no id or name.");
    }
    const event = payload.event as string;
    const post = isObject(payload.post) ? payload.post : null;
    const postId = post ? str(post.id) ?? str(post._id) : null;
    if (payload.test === true || !event.startsWith("post.") || !post || !postId || !ZERNIO_ID.test(postId)) {
      return json(200, { received: true, stored: false });
    }
    const owner = await store.postOwner(postId);
    const tag = postWorkspaceTag(post);
    if (!owner || (tag && tag !== owner)) return json(200, { received: true, stored: false });
    const platform = isObject(payload.platform) ? payload.platform : {};
    const account = isObject(payload.account) ? payload.account : {};
    const occurred = str(payload.timestamp);
    await store.saveEvent({
      event_id: clip(payload.id, 128)!,
      zernio_post_id: postId,
      workspace_id: owner,
      event: clip(event, 64)!,
      post_status: clip(post.status, 32),
      platform: clip(platform.name, 32) ?? clip(account.platform, 32),
      account_id: clip(account.accountId, 64),
      platform_status: clip(platform.status, 32),
      platform_post_id: clip(platform.platformPostId, 256),
      published_url: clip(platform.publishedUrl, 2048),
      error_category: clip(platform.errorCategory, 64),
      error_source: clip(platform.errorSource, 16),
      error: clip(platform.error, 1000),
      occurred_at: occurred && !Number.isNaN(Date.parse(occurred)) ? occurred : now().toISOString(),
    });
    return json(200, { received: true, stored: true });
  }

  return async function handle(request: Request): Promise<Response> {
    const started = Date.now();
    const path = routePath(new URL(request.url).pathname);
    let workspace: string | null = null;
    let response: Response;
    try {
      if (request.method === "POST" && path === "/webhooks/zernio") {
        response = await webhook(request);
      } else {
        const caller = await authenticate(request);
        workspace = caller.workspaceId;
        response = await route(request, path, new URL(request.url), caller);
      }
    } catch (error) {
      if (error instanceof HttpError) {
        response = json(error.status, { error: { code: error.code, message: error.message } }, error.headers);
      } else if (error instanceof ZernioUnavailable) {
        response = json(502, { error: { code: "zernio_unavailable", message: "Zernio could not be reached." } });
      } else if (error instanceof StoreError) {
        response = json(503, { error: { code: "store_unavailable", message: "Posting state is unavailable." } });
      } else {
        response = json(500, { error: { code: "internal", message: "The posting server failed." } });
      }
    }
    // Request logs: route shape, status and timing only. Never bodies, captions, tokens or ids.
    log({
      method: request.method,
      route: routeLabel(path),
      status: response.status,
      ms: Date.now() - started,
      workspace: workspace ? workspace.slice(0, 8) : null,
    });
    return response;
  };
}
