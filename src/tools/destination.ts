import type { BookOrbitClient } from "../client/bookorbit.js";
import { BookOrbitError } from "../util/errors.js";

export type MediaKind = "ebook" | "audiobook";
export interface Destination {
  libraryId: number | null;
  folderId: number | null;
}
export type Destinations = Record<MediaKind, Destination>;

export function isDestinationRequired(e: unknown): e is BookOrbitError {
  return e instanceof BookOrbitError && e.errorCode === "SUBMIT_DESTINATION_REQUIRED";
}

/** BookOrbit's configured default destination per medium (null library = none configured). */
export async function defaultDestinations(
  client: BookOrbitClient,
): Promise<Destinations> {
  const res = await client.get<Partial<Destinations>>(
    "/book-requests/default-destinations",
  );
  const none: Destination = { libraryId: null, folderId: null };
  return { ebook: res.ebook ?? none, audiobook: res.audiobook ?? none };
}

function withHint(e: BookOrbitError): Error {
  return new Error(
    `${e.message}. This user's requests are auto-approved, so a destination is required and no ` +
      `default is configured: pass targetLibraryId (library ids: manage_library list).`,
    { cause: e },
  );
}

/**
 * Submit a request; if BookOrbit refuses because no destination was given (the user's requests
 * are auto-approved), retry once using BookOrbit's configured default destinations. `send`
 * receives those defaults on the retry and must apply them where the caller left a gap.
 */
export async function submitWithDestination<T>(
  client: BookOrbitClient,
  send: (defaults?: Destinations) => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (e) {
    if (!isDestinationRequired(e)) throw e;
    let defaults: Destinations;
    try {
      defaults = await defaultDestinations(client);
    } catch {
      throw withHint(e);
    }
    if (!defaults.ebook.libraryId && !defaults.audiobook.libraryId) throw withHint(e);
    try {
      return await send(defaults);
    } catch (e2) {
      throw isDestinationRequired(e2) ? withHint(e2) : e2;
    }
  }
}
