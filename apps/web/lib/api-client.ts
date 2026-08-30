const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * The access token lives in a module variable, never in localStorage.
 *
 * A token in localStorage is readable by any script that ends up on the page.
 * Keeping it in memory means a refresh loses it, which is exactly what the
 * httpOnly refresh cookie is for: `restoreSession()` trades that cookie for a
 * new access token on load, and the token itself never touches disk.
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skips the automatic refresh-and-retry. Used by refresh itself. */
  noRetry?: boolean;
  raw?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? "GET",
    headers,
    credentials: "include",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  // One transparent retry: a 15-minute access token will expire mid-session
  // and the owner should never see that happen.
  if (res.status === 401 && !opts.noRetry) {
    const refreshed = await restoreSession();
    if (refreshed) return request<T>(path, { ...opts, noRetry: true });
  }

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      detail.message ?? "Something went wrong. Try again.",
      detail.fieldErrors,
    );
  }

  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/** Trades the httpOnly refresh cookie for a fresh access token. */
export async function restoreSession(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken: string };
    accessToken = data.accessToken;
    return true;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" }).catch(
    () => undefined,
  );
  accessToken = null;
}

export function apiOrigin(): string {
  return API;
}

/** Downloads a file the API streams (QR card). */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await fetch(`${API}${path}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    credentials: "include",
  });
  if (!res.ok) throw new ApiError(res.status, "Could not prepare the download");

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
