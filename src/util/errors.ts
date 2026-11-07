/** A BookOrbit API failure, carrying enough context to be shown to an LLM as-is. */
export class BookOrbitError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly detail: string,
    readonly errorCode?: string,
  ) {
    super(
      `BookOrbit ${method} ${path} -> ${status}: ${detail}${errorCode ? ` [${errorCode}]` : ""}`,
    );
    this.name = "BookOrbitError";
  }
}

/** Pull a readable message out of Nest's `{statusCode, message, errorCode}` error body. */
export function describeErrorBody(
  text: string,
  statusText: string,
): { detail: string; errorCode?: string } {
  if (!text) return { detail: statusText || "no response body" };
  try {
    const body = JSON.parse(text) as {
      message?: unknown;
      errorCode?: unknown;
      error?: unknown;
    };
    const message = Array.isArray(body.message)
      ? body.message.join("; ")
      : typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : undefined;
    const errorCode = typeof body.errorCode === "string" ? body.errorCode : undefined;
    if (message) return { detail: message, errorCode };
  } catch {
    // not JSON; fall through to raw text
  }
  return { detail: text.slice(0, 500) };
}

/** Render any thrown value as a message safe to return to the model. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
