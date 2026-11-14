export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!path.startsWith("/api/"))
    throw new Error("Only same-origin API requests are allowed.");
  if (import.meta.env.VITE_REVIEW_PREVIEW === "true") {
    const { previewRequest } = await import("./growth/previewApi");
    return previewRequest<T>(path, options);
  }
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(
      "Cannot reach the local service. Start Growth Factory and retry.",
      0,
    );
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body: unknown = await response.json();
      if (
        body &&
        typeof body === "object" &&
        "detail" in body &&
        typeof body.detail === "string"
      )
        detail = body.detail;
    } catch {
      /* Never expose an HTML error page. */
    }
    throw new ApiError(
      detail ||
        (response.status === 401 || response.status === 403
          ? "Local session unavailable. Open the app through its launcher to authenticate."
          : `Request failed (${response.status}). Please retry.`),
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      "The local service returned an invalid JSON response.",
      response.status,
    );
  }
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const remove = (path: string) =>
  api<unknown>(path, { method: "DELETE" });
export const endpoint = (
  kind: "videos" | "clips" | "models" | "jobs",
  id: string,
  action?: string,
) => `/api/${kind}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
/** Media URLs reported by the service are only ever loaded from this origin's API. */
export function localMediaUrl(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.startsWith("/api/") &&
    !value.startsWith("/api//") &&
    !value.includes("\\")
    ? value
    : undefined;
}
