import { CaretLeft, CaretRight } from "@phosphor-icons/react";

export function DatePager({
  dates,
  index,
  onChange,
}: {
  dates: string[];
  index: number;
  onChange: (index: number) => void;
}) {
  if (dates.length === 0) return null;

  const label = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dates[index]}T00:00:00Z`));

  const atStart = index === 0;
  const atEnd = index >= dates.length - 1;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="btn btn-secondary btn-icon"
        aria-label="previous day"
        // `disabled` (rather than `aria-disabled`) drops focus to the body
        // when this is the focused element and a day is paged such that
        // this button becomes the boundary — real, reachable via keyboard
        // paging, not just a hypothetical. aria-disabled plus a no-op
        // handler keeps the button focusable and in the tab order while
        // still refusing the click.
        aria-disabled={atStart}
        onClick={() => {
          if (!atStart) onChange(index - 1);
        }}
      >
        <CaretLeft size={14} />
      </button>
      <span style={{ fontSize: 15, fontWeight: 500, minWidth: 200 }}>{label}</span>
      <button
        type="button"
        className="btn btn-secondary btn-icon"
        aria-label="next day"
        aria-disabled={atEnd}
        onClick={() => {
          if (!atEnd) onChange(index + 1);
        }}
      >
        <CaretRight size={14} />
      </button>
    </div>
  );
}
