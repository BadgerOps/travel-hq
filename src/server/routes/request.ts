/**
 * Reveal actions require a non-simple browser request. A cross-origin HTML
 * form can submit POST, but it cannot submit application/json; fetch with this
 * content type requires a CORS preflight, and this same-origin API grants no
 * cross-origin access. Checking rather than merely documenting the content
 * type keeps the POST conversion from becoming a CSRF-able audit action.
 */
export function isJsonAction(req: Request): boolean {
  return req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
