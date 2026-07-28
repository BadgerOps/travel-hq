import { useId } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";

/** "Fri 9" — Intl's own {weekday, day} order for en-US is "9 Fri", so the
 * label is composed from parts. UTC keeps a plain calendar date from
 * drifting a day in western zones. */
function shortDayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(d);
  const day = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" }).format(d);
  return `${weekday} ${day}`;
}

function fullDayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * The 1c pager: prev/next icon buttons with a segmented day control between
 * them. The seg only fits a short trip — past seven days it degrades to a
 * "Day n of m" count so a three-week trip doesn't render a scroll strip of
 * twenty radio pills.
 */
const MAX_SEG_DAYS = 7;

export function DatePager({
  dates,
  index,
  onChange,
}: {
  dates: string[];
  index: number;
  onChange: (index: number) => void;
}) {
  // Radios need a document-unique group name: another seg control (the trip
  // tabs, a second pager) sharing it would steal the checked state.
  const groupName = useId();
  if (dates.length === 0) return null;

  const atStart = index === 0;
  const atEnd = index >= dates.length - 1;

  return (
    <div className="date-pager">
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
      {dates.length <= MAX_SEG_DAYS ? (
        <div className="seg">
          {dates.map((date, i) => (
            <label key={date} className="seg-opt">
              <input
                type="radio"
                name={groupName}
                checked={i === index}
                onChange={() => onChange(i)}
                aria-label={fullDayLabel(date)}
              />
              {shortDayLabel(date)}
            </label>
          ))}
        </div>
      ) : (
        <span className="date-pager-count">
          Day {index + 1} of {dates.length}
        </span>
      )}
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
