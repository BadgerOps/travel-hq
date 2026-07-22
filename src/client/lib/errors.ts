import { ApiError } from "../api/client.js";

/**
 * Status → a sentence a family member can act on. Never interpolates the
 * server's message: 403 and 500 bodies are intentionally contentless, and a
 * 400's message is written for an API caller, not for this screen.
 */
export function errorMessage(err: unknown): string {
  const status = err instanceof ApiError ? err.status : 0;
  switch (status) {
    case 401:
      return "Your session has expired. Reload the page to sign in again.";
    case 403:
      return "You do not have permission to see this.";
    case 404:
      return "This is no longer here — it may have been deleted.";
    case 400:
      return "The app sent something the server could not accept. This is a bug.";
    default:
      return "Something went wrong reaching Travel HQ. Try again in a moment.";
  }
}
