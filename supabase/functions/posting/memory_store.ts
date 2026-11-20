// deno-lint-ignore-file require-await -- async to match the Store interface exactly.
import type { PostingEvent, Store } from "./store.ts";

/** In-memory store with the same semantics, for tests. */
export class MemoryStore implements Store {
  workspaces = new Map<string, string>();
  profiles = new Map<string, string>();
  uploads = new Map<string, string>();
  posts = new Map<string, string>();
  eventRows = new Map<string, PostingEvent>();
  rate = new Map<string, number>();

  async workspaceOwner(id: string) {
    return this.workspaces.get(id) ?? null;
  }
  async profileFor(id: string) {
    return this.profiles.get(id) ?? null;
  }
  async saveProfile(id: string, profileId: string) {
    if (!this.profiles.has(id)) this.profiles.set(id, profileId);
    return this.profiles.get(id)!;
  }
  async takeRate(id: string, bucket: string, _windowSeconds: number, limit: number) {
    const key = `${id}:${bucket}`;
    const hits = (this.rate.get(key) ?? 0) + 1;
    this.rate.set(key, hits);
    return hits <= limit;
  }
  async saveUpload(id: string, url: string) {
    if (!this.uploads.has(url)) this.uploads.set(url, id);
  }
  async uploadsOwned(id: string, urls: string[]) {
    return urls.every((url) => this.uploads.get(url) === id);
  }
  async savePost(id: string, postId: string) {
    if (!this.posts.has(postId)) this.posts.set(postId, id);
    return this.posts.get(postId) === id;
  }
  async postOwner(postId: string) {
    return this.posts.get(postId) ?? null;
  }
  async saveEvent(event: PostingEvent) {
    if (!this.eventRows.has(event.event_id)) this.eventRows.set(event.event_id, event);
  }
  async events(postId: string) {
    return [...this.eventRows.values()]
      .filter((event) => event.zernio_post_id === postId)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  }
}
