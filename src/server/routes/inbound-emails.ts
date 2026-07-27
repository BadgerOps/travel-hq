import { Hono } from "hono";
import type { AppEnv } from "../index.js";
import { InboundEmailRepo } from "../repos/inbound-email.js";
import type { InboundEmailMetadata } from "../repos/inbound-email.js";
import { DraftBookingRepo } from "../repos/draft-booking.js";
import type { DraftBooking } from "../repos/draft-booking.js";
import { ForbiddenError, NotFoundError } from "../repos/base.js";
import { parseMime } from "../ingest/mime.js";

/**
 * What the activity feed's click-through shows: the email's envelope metadata,
 * the readable parts of the stored message, and every draft booking the
 * extractor parsed out of it. Never the raw RFC 5322 message or Message-ID.
 */
export type InboundEmailDetail = InboundEmailMetadata & {
  textBody: string | null;
  calendars: string[];
  drafts: DraftBooking[];
};

export const inboundEmails = new Hono<AppEnv>();

inboundEmails.get("/", async (c) => {
  const repo = new InboundEmailRepo(c.get("db"), c.get("identity"));
  return c.json(await repo.listMetadata());
});

inboundEmails.get("/:id", async (c) => {
  const identity = c.get("identity");
  // Same audience as listMetadata(): the feed and its detail view move
  // together. findById has no viewer gate of its own, so the route holds it.
  if (identity.role === "viewer") {
    throw new ForbiddenError("Viewers may not access inbound email activity");
  }
  const email = await new InboundEmailRepo(c.get("db"), identity).findById(c.req.param("id"));
  if (!email) throw new NotFoundError("Inbound email not found in this household");
  const drafts = await new DraftBookingRepo(c.get("db"), identity).listByEmail(email.id);

  let subject = email.subject;
  let textBody: string | null = null;
  let calendars: string[] = [];
  try {
    const parsed = parseMime(email.raw);
    subject = parsed.subject ?? email.subject;
    textBody = parsed.textBody;
    calendars = parsed.calendars;
  } catch {
    // Failed/rejected rows keep their raw best-effort and it may be
    // unparseable; the envelope metadata and drafts still render.
  }

  const detail: InboundEmailDetail = {
    id: email.id,
    from: email.from,
    to: email.to,
    subject,
    status: email.status,
    error: email.error,
    receivedAt: email.receivedAt,
    textBody,
    calendars,
    drafts,
  };
  return c.json(detail);
});
