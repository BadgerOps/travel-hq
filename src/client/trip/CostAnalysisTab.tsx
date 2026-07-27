import { useMemo, useState } from "react";
import type { Booking, Trip, TripRollup } from "../api/types.js";
import { formatMoney } from "../lib/money.js";

const number = new Intl.NumberFormat("en-US");
const MAX_CONTIGUOUS_CHART_DAYS = 366;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

const CATEGORIES = [
  { label: "Flights", kinds: ["flight"] },
  { label: "Lodging", kinds: ["lodging"] },
  { label: "Cars", kinds: ["car"] },
  { label: "Events", kinds: ["activity", "other"] },
] as const;

type DailyCost = {
  date: string;
  cents: number;
  bookings: Booking[];
};

export function CostAnalysisTab({
  trip,
  bookings,
  rollup,
}: {
  trip: Trip;
  bookings: Booking[];
  rollup: TripRollup;
}) {
  const costed = useMemo(
    () =>
      bookings.filter(
        (booking) =>
          (booking.status === "booked" || booking.status === "planned") &&
          booking.costCents !== null,
      ),
    [bookings],
  );
  const days = useMemo(() => dailyCosts(trip, costed), [trip, costed]);
  const [selectedDate, setSelectedDate] = useState("");
  const selectedDay = days.find((day) => day.date === selectedDate);
  const shownBookings = selectedDay ? selectedDay.bookings : costed;
  const average =
    costed.length > 0 ? Math.round(rollup.totalCents / costed.length) : 0;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section
        aria-label="Trip cost summary"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        <Metric label="Total trip cost" cents={rollup.totalCents} featured />
        <Metric label="Booked" cents={rollup.bookedCents} />
        <Metric label="Planned" cents={rollup.plannedCents} />
        <Metric label="Average per priced booking" cents={average} />
      </section>

      {rollup.draftCount > 0 && (
        <p className="card-meta" style={{ margin: 0 }}>
          Total excludes {rollup.draftCount} unreviewed{" "}
          {rollup.draftCount === 1 ? "draft" : "drafts"}.
        </p>
      )}

      <section className="card" style={{ display: "grid", gap: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h5 style={{ margin: 0 }}>Day-by-day cost</h5>
            <p className="card-body" style={{ marginTop: 4 }}>
              The line shows spend across the whole trip. Choose a day to focus
              the booking breakdown without losing the full-trip view.
            </p>
          </div>
          <label className="field" style={{ minWidth: 190 }}>
            <span>Filter booking breakdown</span>
            <select
              className="input"
              aria-label="Cost day"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            >
              <option value="">All trip days</option>
              {days.map((day) => (
                <option key={day.date} value={day.date}>
                  {formatDate(day.date)} · {formatMoney(day.cents)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {days.length > 0 ? (
          <DailyCostChart days={days} selectedDate={selectedDate} />
        ) : (
          <p className="text-muted" style={{ margin: 0 }}>
            Add dated booking costs to build the trip timeline.
          </p>
        )}

        {selectedDay && (
          <div className="card-meta" role="status">
            {formatDate(selectedDay.date)} total: {formatMoney(selectedDay.cents)}
          </div>
        )}
      </section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
          alignItems: "start",
        }}
      >
        <CategoryBreakdown bookings={costed} totalCents={rollup.totalCents} />
        <BookingCostBreakdown
          bookings={shownBookings}
          heading={selectedDay ? `Bookings on ${formatDate(selectedDay.date)}` : "Booking costs"}
        />
      </div>

      {rollup.points.length > 0 && (
        <section className="card">
          <h6 className="card-kicker">Points used</h6>
          <div style={{ display: "grid", gap: 7 }}>
            {rollup.points.map((point) => (
              <div key={point.program} className="card-meta">
                <strong>{number.format(point.used)}</strong> {point.program}
                {point.balance != null && (
                  <> · {number.format(point.balance)} available</>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Metric({
  label,
  cents,
  featured = false,
}: {
  label: string;
  cents: number;
  featured?: boolean;
}) {
  return (
    <article
      className="card"
      style={featured ? { borderColor: "var(--color-accent)" } : undefined}
    >
      <span className="card-kicker">{label}</span>
      <strong style={{ display: "block", marginTop: 6, fontSize: featured ? 25 : 20 }}>
        {formatMoney(cents)}
      </strong>
    </article>
  );
}

function CategoryBreakdown({
  bookings,
  totalCents,
}: {
  bookings: Booking[];
  totalCents: number;
}) {
  const rows = CATEGORIES.map((category) => ({
    label: category.label,
    cents: bookings
      .filter((booking) => category.kinds.some((kind) => kind === booking.kind))
      .reduce((sum, booking) => sum + (booking.costCents ?? 0), 0),
  })).filter((row) => row.cents > 0);

  return (
    <section className="card" aria-label="Cost by category">
      <h6 className="card-kicker">By category</h6>
      {rows.length === 0 ? (
        <p className="text-muted" style={{ margin: 0 }}>No priced bookings yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 13 }}>
          {rows.map((row) => {
            const percent = totalCents > 0
              ? Math.round((row.cents / totalCents) * 100)
              : 0;
            return (
              <div key={row.label}>
                <div
                  className="card-meta"
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <span>{row.label}</span>
                  <span>{formatMoney(row.cents)} · {percent}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${row.label} share of trip cost`}
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  style={{
                    height: 7,
                    marginTop: 5,
                    borderRadius: 999,
                    background: "var(--color-divider)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${percent}%`,
                      height: "100%",
                      background: "var(--color-accent)",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function BookingCostBreakdown({
  bookings,
  heading,
}: {
  bookings: Booking[];
  heading: string;
}) {
  return (
    <section className="card" aria-label={heading}>
      <h6 className="card-kicker">{heading}</h6>
      {bookings.length === 0 ? (
        <p className="text-muted" style={{ margin: 0 }}>No priced bookings for this view.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {bookings
            .slice()
            .sort((a, b) =>
              (a.startsAt ?? "9999").localeCompare(b.startsAt ?? "9999") ||
              a.title.localeCompare(b.title)
            )
            .map((booking) => {
              const date = bookingDate(booking);
              return (
                <div
                  key={booking.id}
                  style={{ display: "flex", alignItems: "baseline", gap: 10 }}
                >
                  <span style={{ minWidth: 0 }}>
                    <strong style={{ display: "block", fontSize: 13 }}>{booking.title}</strong>
                    <span className="card-meta">
                      {date ? formatDate(date) : "No date"} · {booking.status}
                    </span>
                  </span>
                  <strong style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
                    {formatMoney(booking.costCents ?? 0)}
                  </strong>
                </div>
              );
            })}
        </div>
      )}
    </section>
  );
}

function DailyCostChart({
  days,
  selectedDate,
}: {
  days: DailyCost[];
  selectedDate: string;
}) {
  const width = 720;
  const height = 220;
  const left = 52;
  const right = 18;
  const top = 18;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(...days.map((day) => day.cents), 1);
  const x = (index: number) =>
    days.length === 1 ? left + plotWidth / 2 : left + (index / (days.length - 1)) * plotWidth;
  const y = (cents: number) => top + plotHeight - (cents / max) * plotHeight;
  const points = days.map((day, index) => `${x(index)},${y(day.cents)}`).join(" ");
  const selectedIndex = days.findIndex((day) => day.date === selectedDate);

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        role="img"
        aria-label="Line graph of booking costs across the whole trip"
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: "block", width: "100%", minWidth: 520 }}
      >
        {[0, 0.5, 1].map((fraction) => {
          const gridY = top + plotHeight - fraction * plotHeight;
          return (
            <g key={fraction}>
              <line
                x1={left}
                x2={width - right}
                y1={gridY}
                y2={gridY}
                stroke="var(--color-divider)"
              />
              <text
                x={left - 8}
                y={gridY + 4}
                textAnchor="end"
                fill="currentColor"
                fontSize="10"
              >
                {formatCompactMoney(Math.round(max * fraction))}
              </text>
            </g>
          );
        })}
        <polyline
          points={points}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {days.map((day, index) => (
          <circle
            key={day.date}
            data-date={day.date}
            data-cost-cents={day.cents}
            cx={x(index)}
            cy={y(day.cents)}
            r={index === selectedIndex ? 6 : 4}
            fill={index === selectedIndex ? "var(--color-accent-100)" : "var(--color-accent)"}
            stroke="var(--color-accent)"
            strokeWidth="2"
          >
            <title>{formatDate(day.date)}: {formatMoney(day.cents)}</title>
          </circle>
        ))}
        {axisLabels(days).map(({ day, index }) => (
          <text
            key={day.date}
            x={x(index)}
            y={height - 12}
            textAnchor="middle"
            fill="currentColor"
            fontSize="10"
          >
            {formatShortDate(day.date)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function dailyCosts(trip: Trip, bookings: Booking[]): DailyCost[] {
  const dated = new Map<string, Booking[]>();
  for (const booking of bookings) {
    const date = bookingDate(booking);
    if (!date) continue;
    dated.set(date, [...(dated.get(date) ?? []), booking]);
  }

  const dateSet = new Set(tripDateRange(trip));
  for (const date of dated.keys()) dateSet.add(date);
  const dates = [...dateSet].sort();

  return dates.map((date) => {
    const dayBookings = dated.get(date) ?? [];
    return {
      date,
      bookings: dayBookings,
      cents: dayBookings.reduce((sum, booking) => sum + (booking.costCents ?? 0), 0),
    };
  });
}

function tripDateRange(trip: Trip): string[] {
  if (!trip.startsOn) return [];
  const end = trip.endsOn ?? trip.startsOn;
  const dates: string[] = [];
  let cursor = Date.parse(`${trip.startsOn}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(last) || cursor > last) return [];
  const dayCount = Math.floor((last - cursor) / 86_400_000) + 1;
  if (dayCount > MAX_CONTIGUOUS_CHART_DAYS) {
    return trip.startsOn === end ? [trip.startsOn] : [trip.startsOn, end];
  }
  while (cursor <= last) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return dates;
}

function bookingDate(booking: Booking): string | null {
  if (!booking.startsAt) return null;
  const timeZone = booking.startsAtTz ?? "UTC";
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(booking.startsAt));
  const part = (type: string) => parts.find((value) => value.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function axisLabels(days: DailyCost[]) {
  if (days.length <= 3) return days.map((day, index) => ({ day, index }));
  const middle = Math.floor((days.length - 1) / 2);
  return [0, middle, days.length - 1].map((index) => ({ day: days[index]!, index }));
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatShortDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatCompactMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}
