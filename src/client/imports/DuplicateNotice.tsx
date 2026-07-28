import { CopySimple } from "@phosphor-icons/react";
import type { PendingImportDuplicate } from "../api/types.js";

/**
 * The one line on a pending import that says "you may already have this".
 *
 * Shown in the queue rather than only after acceptance because an accepted
 * draft is a booking: undoing it means finding it again on the trip page and
 * merging it back. The cheapest duplicate is the one that never got imported.
 *
 * A `high` match is amber and will block the import until the reviewer says
 * otherwise; a `medium` one is plain text and blocks nothing — see
 * ImportReviewRepo.assertNoDuplicates for why that line is drawn there.
 */
export function DuplicateNotice({
  duplicates,
}: {
  duplicates: PendingImportDuplicate[];
}) {
  if (duplicates.length === 0) return null;
  // Strongest first, so the sentence shown is the one that will actually stop
  // the import rather than whichever match happened to be found first.
  const ordered = [...duplicates].sort((a, b) =>
    a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1,
  );
  const first = ordered[0]!;
  const rest = ordered.length - 1;

  return (
    <span
      className={first.confidence === "high" ? "card-meta warning" : "card-meta"}
      data-testid="duplicate-notice"
    >
      <CopySimple size={12} /> {sentence(first)}
      {rest > 0 && ` (+${rest} more)`}
    </span>
  );
}

function sentence(duplicate: PendingImportDuplicate): string {
  const name = `“${duplicate.title}”`;
  if (duplicate.target === "draft") {
    return duplicate.confidence === "high"
      ? `Also waiting in this queue as ${name}`
      : `Might be the same as ${name} in this queue`;
  }
  const where = duplicate.tripTitle ?? "another trip";
  return duplicate.confidence === "high"
    ? `Already on ${where} as ${name}`
    : `Might already be on ${where} as ${name}`;
}
