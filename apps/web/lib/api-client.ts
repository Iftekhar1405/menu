const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Auth endpoints are proxied through Next.js so the refresh cookie stays on
 * the same origin as the web app (menu.irad.solutions). iOS Safari and locked
 * Android Chrome block cookies from third-party domains regardless of
 * SameSite=None, which made every page load after a tab close look like a
 * session expiry. Routing /auth/* through /api/auth/* keeps the cookie
 * first-party without any change to the API server.
 */
const AUTH_PROXY = "/api/auth";

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

/**
 * How long to wait before deciding a request is not coming back.
 *
 * Generous, because a write against a hosted database legitimately takes
 * several seconds. Finite, because nothing else here is: a phone on the wifi
 * in a busy restaurant does not get a refused connection, it gets an open
 * socket nobody ever answers, and the browser will wait on that one for
 * minutes. The dashboard's own failure states cannot help until something
 * decides the request has failed.
 */
const REQUEST_DEADLINE_MS = 30_000;

/**
 * `fetch` with a deadline, and with the resulting error named after what
 * happened. `AbortError` reads as something the application chose to do,
 * which is exactly wrong when what it means is that the server never replied.
 *
 * Exported for its own tests; everything else goes through `request`.
 */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_DEADLINE_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ApiError(0, "The server took too long to reply. Check your connection.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  // Auth routes go through the same-origin Next.js proxy so the refresh
  // cookie stays on menu.irad.solutions. All other API calls go direct.
  const url = path.startsWith("/auth")
    ? `${AUTH_PROXY}${path.slice("/auth".length)}`
    : `${API}${path}`;

  const res = await fetchWithDeadline(url, {
    method: opts.method ?? "GET",
    headers,
    credentials: "include",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  // One transparent retry: a 15-minute access token will expire mid-session
  // and the owner should never see that happen.
  if (res.status === 401 && !opts.noRetry) {
    // A refresh that could not be attempted leaves the original 401 to be
    // reported below, which is the more useful of the two errors here.
    const refreshed = await restoreSession().catch(() => false);
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

/**
 * Trades the httpOnly refresh cookie for a fresh access token, and at most
 * one refresh is ever in flight.
 *
 * The refresh token is rotated on every use, so a second concurrent
 * presentation of the same cookie is refused by the API — and a refused
 * `restoreSession()` is what sends an owner back to the sign-in screen. Two
 * callers at once is the normal case, not an edge one: the dashboard loads
 * `/auth/me` and `/businesses/mine` together, so a single expired access
 * token produces two 401s and two retries in the same tick.
 *
 * Callers that arrive while a refresh is running await that one instead of
 * starting another.
 */
let inFlight: Promise<boolean> | null = null;

export function restoreSession(): Promise<boolean> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetchWithDeadline(`${AUTH_PROXY}/refresh`, {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const data = (await res.json()) as { accessToken: string };
        accessToken = data.accessToken;
        return true;
      }

      /*
       * `false` is reserved for the one thing it is acted on as: the server
       * looked at the cookie and said this session is not valid, so the owner
       * has to sign in again.
       *
       * A 500, a 503 or a dropped connection is not that. Reporting those as
       * `false` signs someone out of a perfectly good account because the
       * database hiccuped — which, on the wifi in a busy restaurant, is not a
       * rare event. They are raised instead, so the caller can say "we
       * couldn't reach your account" and offer to retry.
       */
      if (res.status === 401 || res.status === 403) return false;
      throw new ApiError(res.status, "We couldn't reach your account just now.");
    } finally {
      // Cleared whatever the outcome: the next refresh is a new event, and a
      // cached result — success or failure — would strand a session that has
      // since changed.
      inFlight = null;
    }
  })();

  return inFlight;
}

export async function logout(): Promise<void> {
  await fetch(`${AUTH_PROXY}/logout`, { method: "POST", credentials: "include" }).catch(
    () => undefined,
  );
  accessToken = null;
}

export function apiOrigin(): string {
  return API;
}

/**
 * Downloads a file the API streams (QR card, print sheet).
 *
 * Pass `body` when the request is a selection rather than an address — a
 * print sheet is a POST because eighty table ids do not belong in a URL.
 */
export async function downloadFile(
  path: string,
  filename: string,
  body?: unknown,
): Promise<void> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
