import { ApiError } from "../api/client.js";

/**
 * Status → a sentence a family member can act on. Mostly written here rather
 * than taken from the body: 403 and 500 bodies are intentionally contentless,
 * and 401/404 say more useful things in this app's own voice than "Unauthorized"
 * ever could. The two exceptions are 409 and the human half of 400 — see below.
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
      // Two different failures share this status, and only one of them is the
      // user's to read.
      //
      // A body carrying `details` is a Zod issue list: the app sent the wrong
      // SHAPE, which is a bug in this client and unactionable for whoever is
      // looking at the screen. Everything else is a repository
      // ValidationError, and routes/errors.ts hands its message back verbatim
      // for exactly this purpose — "Pending imports cannot be added to a
      // cancelled trip" and "Only pending imports can be reviewed" are
      // sentences written for a person, and replacing them with "this is a
      // bug" told the reviewer their own correct action had broken the app.
      // (Issue #7 asked for the server's message on validation failure; this
      // is where that happens.)
      return err instanceof ApiError && err.details === undefined && err.detail
        ? err.detail
        : "The app sent something the server could not accept. This is a bug.";
    case 409:
      // The one status whose body IS written for this screen: a conflict is
      // the server telling a human something they did not know (see
      // ConflictError in repos/base.ts), and the caller is expected to offer
      // them a way to proceed. Falls back if the body carried no message.
      return err instanceof ApiError && err.detail
        ? err.detail
        : "Some of this is already here. Check before importing again.";
    default:
      return "Something went wrong reaching Travel HQ. Try again in a moment.";
  }
}
