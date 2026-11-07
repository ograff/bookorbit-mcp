import { BookOrbitError, describeErrorBody } from "../util/errors.js";

export { BookOrbitError };

export interface ClientConfig {
  /** In-cluster service URL, e.g. http://bookorbit.bookorbit.svc:3000 */
  baseUrl: string;
  username: string;
  password: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface NativeCredentials {
  accessToken: string;
  refreshToken: string;
}

export type Query = Record<
  string,
  string | number | boolean | undefined | (string | number)[]
>;

export function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Typed fetch wrapper for BookOrbit's `/api/v1`.
 *
 * Authenticates as a `native` client so the rotating refresh token travels in the JSON body
 * rather than an HttpOnly cookie. On a 401 it refreshes once, then falls back to a full login.
 * Concurrent 401s share one re-auth.
 */
export class BookOrbitClient {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private inflightAuth: Promise<void> | null = null;

  constructor(private readonly config: ClientConfig) {
    this.apiBase = `${config.baseUrl.replace(/\/+$/, "")}/api/v1`;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }
  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }
  /** DELETE, optionally with a JSON body (BookOrbit's bulk deletes take one). */
  delete<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, { body, query });
  }

  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Query } = {},
  ): Promise<T> {
    const target = `${path}${buildQuery(opts.query)}`;
    if (!this.accessToken) await this.authenticate();

    let res = await this.send(method, target, opts.body);
    if (res.status === 401) {
      await this.authenticate();
      res = await this.send(method, target, opts.body);
    }
    if (!res.ok) {
      const { detail, errorCode } = describeErrorBody(await res.text(), res.statusText);
      throw new BookOrbitError(method, path, res.status, detail, errorCode);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  private send(method: string, target: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this.fetchImpl(`${this.apiBase}${target}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Single-flight: refresh once, else log in again. */
  private authenticate(): Promise<void> {
    this.inflightAuth ??= this.doAuthenticate().finally(() => {
      this.inflightAuth = null;
    });
    return this.inflightAuth;
  }

  private async doAuthenticate(): Promise<void> {
    if (this.refreshToken && (await this.tryRefresh())) return;
    await this.login();
  }

  private async tryRefresh(): Promise<boolean> {
    const res = await this.authPost("/auth/refresh", { refreshToken: this.refreshToken });
    if (!res.ok) {
      this.accessToken = this.refreshToken = null;
      return false;
    }
    this.store((await res.json()) as NativeCredentials);
    return true;
  }

  private async login(): Promise<void> {
    const res = await this.authPost("/auth/login", {
      username: this.config.username,
      password: this.config.password,
      clientKind: "native",
      deviceLabel: "bookorbit-mcp",
    });
    if (!res.ok) {
      const { detail, errorCode } = describeErrorBody(await res.text(), res.statusText);
      throw new BookOrbitError("POST", "/auth/login", res.status, detail, errorCode);
    }
    this.store((await res.json()) as NativeCredentials);
  }

  private store(creds: NativeCredentials): void {
    if (!creds.accessToken || !creds.refreshToken) {
      throw new BookOrbitError("POST", "/auth", 500, "auth response missing tokens");
    }
    this.accessToken = creds.accessToken;
    this.refreshToken = creds.refreshToken;
  }

  private authPost(path: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`${this.apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  }
}
