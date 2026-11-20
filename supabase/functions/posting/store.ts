// Server-side state and identity for the posting function. The production store talks to
// PostgREST as service_role; tests use MemoryStore. Neither ever stores captions or tokens.

import type { FetchLike } from "./zernio.ts";

export interface PostingEvent {
  event_id: string;
  zernio_post_id: string;
  workspace_id: string;
  event: string;
  post_status: string | null;
  platform: string | null;
  account_id: string | null;
  platform_status: string | null;
  platform_post_id: string | null;
  published_url: string | null;
  error_category: string | null;
  error_source: string | null;
  error: string | null;
  occurred_at: string;
}

export interface Store {
  workspaceOwner(workspaceId: string): Promise<string | null>;
  profileFor(workspaceId: string): Promise<string | null>;
  /** Saves the mapping; returns the stored profile id (an earlier concurrent save wins). */
  saveProfile(workspaceId: string, profileId: string): Promise<string>;
  takeRate(workspaceId: string, bucket: string, windowSeconds: number, limit: number): Promise<boolean>;
  saveUpload(workspaceId: string, publicUrl: string, contentType: string): Promise<void>;
  /** True when every URL was presigned for this workspace. */
  uploadsOwned(workspaceId: string, publicUrls: string[]): Promise<boolean>;
  /** Records ownership; returns false if the post already belongs to another workspace. */
  savePost(workspaceId: string, postId: string): Promise<boolean>;
  postOwner(postId: string): Promise<string | null>;
  /** Inserts once per event id; duplicates are ignored. */
  saveEvent(event: PostingEvent): Promise<void>;
  events(postId: string): Promise<PostingEvent[]>;
}

export interface Auth {
  /** The Supabase user id behind an access token, or null when the token is not valid. */
  userId(accessToken: string): Promise<string | null>;
}

export class StoreError extends Error {}

export class SupabaseAuth implements Auth {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async userId(accessToken: string): Promise<string | null> {
    const response = await this.fetchImpl(`${this.url}/auth/v1/user`, {
      method: "GET",
      headers: { apikey: this.apiKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new StoreError("auth lookup failed");
    const body = await response.json().catch(() => null);
    return body && typeof body.id === "string" ? body.id : null;
  }
}

export class PostgrestStore implements Store {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call(method: string, path: string, body?: unknown, prefer?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;
    const response = await this.fetchImpl(`${this.url}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new StoreError(`store ${method} ${path.split("?")[0]} failed (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  private async rows(path: string): Promise<Record<string, unknown>[]> {
    const rows = await this.call("GET", path);
    return Array.isArray(rows) ? rows : [];
  }

  async workspaceOwner(workspaceId: string) {
    const rows = await this.rows(`gf_workspaces?select=owner_id&id=eq.${encodeURIComponent(workspaceId)}`);
    return typeof rows[0]?.owner_id === "string" ? rows[0].owner_id as string : null;
  }

  async profileFor(workspaceId: string) {
    const rows = await this.rows(
      `gf_posting_profiles?select=zernio_profile_id&workspace_id=eq.${encodeURIComponent(workspaceId)}`,
    );
    return typeof rows[0]?.zernio_profile_id === "string" ? rows[0].zernio_profile_id as string : null;
  }

  async saveProfile(workspaceId: string, profileId: string) {
    await this.call(
      "POST",
      "gf_posting_profiles?on_conflict=workspace_id",
      { workspace_id: workspaceId, zernio_profile_id: profileId },
      "resolution=ignore-duplicates,return=minimal",
    );
    const stored = await this.profileFor(workspaceId);
    if (!stored) throw new StoreError("profile mapping was not saved");
    return stored;
  }

  async takeRate(workspaceId: string, bucket: string, windowSeconds: number, limit: number) {
    const allowed = await this.call("POST", "rpc/gf_posting_take", {
      p_workspace: workspaceId,
      p_bucket: bucket,
      p_window_seconds: windowSeconds,
      p_limit: limit,
    });
    return allowed === true;
  }

  async saveUpload(workspaceId: string, publicUrl: string, contentType: string) {
    await this.call(
      "POST",
      "gf_posting_uploads?on_conflict=public_url",
      { workspace_id: workspaceId, public_url: publicUrl, content_type: contentType },
      "resolution=ignore-duplicates,return=minimal",
    );
  }

  async uploadsOwned(workspaceId: string, publicUrls: string[]) {
    const unique = [...new Set(publicUrls)];
    if (unique.length === 0) return true;
    const list = unique.map((url) => `"${url.replaceAll('"', '\\"')}"`).join(",");
    const rows = await this.rows(
      `gf_posting_uploads?select=public_url&workspace_id=eq.${encodeURIComponent(workspaceId)}` +
        `&public_url=in.(${encodeURIComponent(list)})`,
    );
    return rows.length === unique.length;
  }

  async savePost(workspaceId: string, postId: string) {
    await this.call(
      "POST",
      "gf_posting_posts?on_conflict=zernio_post_id",
      { workspace_id: workspaceId, zernio_post_id: postId },
      "resolution=ignore-duplicates,return=minimal",
    );
    return (await this.postOwner(postId)) === workspaceId;
  }

  async postOwner(postId: string) {
    const rows = await this.rows(
      `gf_posting_posts?select=workspace_id&zernio_post_id=eq.${encodeURIComponent(postId)}`,
    );
    return typeof rows[0]?.workspace_id === "string" ? rows[0].workspace_id as string : null;
  }

  async saveEvent(event: PostingEvent) {
    await this.call(
      "POST",
      "gf_posting_events?on_conflict=event_id",
      event,
      "resolution=ignore-duplicates,return=minimal",
    );
  }

  async events(postId: string) {
    const rows = await this.rows(
      `gf_posting_events?select=*&zernio_post_id=eq.${encodeURIComponent(postId)}&order=occurred_at.asc&limit=200`,
    );
    return rows as unknown as PostingEvent[];
  }
}
