import { useState } from "react";

/**
 * Trip cover art: the real photo when the trip has one, otherwise a
 * deterministic Nocturne-styled placeholder (layered ridge lines + a dashed
 * route with endpoint dots, varied by trip id) so an empty slot still looks
 * intentional. The photo gets the system's `lighten` blend via CSS; the
 * fallback opts out by not being an <img>.
 *
 * A photo URL that *fails* takes the placeholder too. Having a URL is not the
 * same as the bytes arriving: an uploaded photo whose R2 object is missing
 * (or whose GET 500s on a deployment with no bucket bound), and a pasted
 * external URL that later starts refusing hotlinks, both resolve to a dead
 * image. Left alone the browser paints its own broken-image glyph in the
 * middle of the banner — the trip page's largest element, reading as "the
 * page is broken" rather than "this trip has no picture".
 */
export function TripCoverPhoto({
  photoUrl,
  tripId,
}: {
  photoUrl: string | null;
  tripId: string;
}) {
  // Keyed by URL rather than a bare boolean, so a re-upload (which changes the
  // `?v=` cache-buster) gets a fresh attempt instead of inheriting the old
  // URL's failure — no effect needed to reset it.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (photoUrl && failedUrl !== photoUrl) {
    // Decorative: the card/banner text carries the trip's name.
    return (
      <img
        className="cover-img"
        src={photoUrl}
        alt=""
        loading="lazy"
        onError={() => setFailedUrl(photoUrl)}
      />
    );
  }
  return <FallbackArt tripId={tripId} />;
}

/* Same shape as PersonChip's palette hash: stable variation without a column. */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function FallbackArt({ tripId }: { tripId: string }) {
  const h = hashId(tripId);
  // Vary the ridge waviness, route endpoints, and which accent draws the route.
  const lift = (h % 5) * 6; // 0–24px vertical shift of the ridge stack
  const x1 = 60 + (h % 7) * 12;
  const y1 = 96 + (h % 3) * 10;
  const x2 = 340 - ((h >> 3) % 7) * 12;
  const y2 = 40 + ((h >> 5) % 3) * 8;
  const accent = h % 2 === 0 ? "var(--color-accent)" : "var(--color-accent-2)";
  const midX = (x1 + x2) / 2;
  const midY = Math.min(y1, y2) - 28;
  return (
    <svg
      className="cover-fallback"
      viewBox="0 0 400 150"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`cg-${h % 97}`} cx="30%" cy="40%" r="80%">
          <stop offset="0%" stopColor="var(--color-neutral-900)" />
          <stop offset="100%" stopColor="var(--color-bg)" />
        </radialGradient>
      </defs>
      <rect width="400" height="150" fill={`url(#cg-${h % 97})`} />
      <g stroke="var(--color-neutral-800)" strokeWidth="1" fill="none">
        <path d={`M0 ${40 + lift} Q120 ${25 + lift} 220 ${45 + lift} T400 ${35 + lift}`} />
        <path d={`M0 ${85 + lift} Q140 ${70 + lift} 250 ${92 + lift} T400 ${80 + lift}`} />
        <path d={`M0 ${125 + lift} Q130 ${112 + lift} 240 ${128 + lift} T400 ${120 + lift}`} />
      </g>
      <path
        d={`M${x2} ${y2} Q${midX} ${midY} ${x1} ${y1}`}
        stroke={accent}
        strokeWidth="1.5"
        fill="none"
        strokeDasharray="4 5"
      />
      <circle cx={x2} cy={y2} r="4" fill={accent} />
      <circle cx={x1} cy={y1} r="4" fill={accent} />
    </svg>
  );
}
