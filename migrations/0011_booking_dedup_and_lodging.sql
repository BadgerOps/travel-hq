-- Fast exact-redelivery lookup. Independently forwarded copies have distinct
-- outer Message-IDs and are deduplicated semantically during import review.
CREATE INDEX idx_inbound_email_household_message
  ON inbound_email(household_id, message_id)
  WHERE message_id IS NOT NULL;

-- Older extraction prompts treated campgrounds and RV parks as freeform
-- "other" events. Reclassify existing accepted bookings so they render and
-- group as stays without discarding their freeform JSON details.
UPDATE booking
   SET kind = 'lodging'
 WHERE kind = 'other'
   AND (
     lower(title || ' ' || coalesce(location, '')) LIKE '%rv park%'
     OR lower(title || ' ' || coalesce(location, '')) LIKE '%campground%'
     OR lower(title || ' ' || coalesce(location, '')) LIKE '%campsite%'
     OR lower(title || ' ' || coalesce(location, '')) LIKE '% koa %'
   );

UPDATE draft_booking
   SET kind = 'lodging'
 WHERE kind = 'other'
   AND (
     lower(title || ' ' || coalesce(location, '')) LIKE '%rv park%'
     OR lower(title || ' ' || coalesce(location, '')) LIKE '%campground%'
     OR lower(title || ' ' || coalesce(location, '')) LIKE '%campsite%'
     OR lower(title || ' ' || coalesce(location, '')) LIKE '% koa %'
   );

-- Collapse previously accepted semantic duplicates. The plaintext
-- confirmation is retained only on the review draft, so use that provenance
-- to find bookings created from separately forwarded copies of the same
-- reservation. Title, local calendar dates, and any explicit room/site/unit
-- must also agree; this keeps multiple legs or multiple reserved sites apart.
CREATE TABLE _booking_duplicate_map_0011 (
  duplicate_id TEXT PRIMARY KEY,
  keeper_id    TEXT NOT NULL
);

INSERT INTO _booking_duplicate_map_0011 (duplicate_id, keeper_id)
WITH booking_confirmation AS (
  SELECT household_id, booking_id, min(confirmation_number) AS confirmation_number
    FROM draft_booking
   WHERE status = 'accepted'
     AND booking_id IS NOT NULL
     AND confirmation_number IS NOT NULL
     AND trim(confirmation_number) != ''
   GROUP BY household_id, booking_id
),
ranked AS (
  SELECT
    b.id,
    first_value(b.id) OVER (
      PARTITION BY
        b.household_id,
        b.trip_id,
        upper(replace(replace(trim(d.confirmation_number), '-', ''), ' ', '')),
        lower(trim(b.title)),
        coalesce(substr(b.starts_at, 1, 10), ''),
        coalesce(substr(b.ends_at, 1, 10), ''),
        lower(trim(CAST(coalesce(
          json_extract(b.details, '$.siteNumber'),
          json_extract(b.details, '$.site'),
          json_extract(b.details, '$.roomNumber'),
          json_extract(b.details, '$.room'),
          json_extract(b.details, '$.unit'),
          ''
        ) AS TEXT)))
      ORDER BY b.created_at, b.id
    ) AS keeper_id,
    row_number() OVER (
      PARTITION BY
        b.household_id,
        b.trip_id,
        upper(replace(replace(trim(d.confirmation_number), '-', ''), ' ', '')),
        lower(trim(b.title)),
        coalesce(substr(b.starts_at, 1, 10), ''),
        coalesce(substr(b.ends_at, 1, 10), ''),
        lower(trim(CAST(coalesce(
          json_extract(b.details, '$.siteNumber'),
          json_extract(b.details, '$.site'),
          json_extract(b.details, '$.roomNumber'),
          json_extract(b.details, '$.room'),
          json_extract(b.details, '$.unit'),
          ''
        ) AS TEXT)))
      ORDER BY b.created_at, b.id
    ) AS copy_number
  FROM booking b
  JOIN booking_confirmation d
    ON d.household_id = b.household_id
   AND d.booking_id = b.id
  WHERE b.status != 'cancelled'
)
SELECT id, keeper_id
  FROM ranked
 WHERE copy_number > 1;

-- Preserve useful fields found only by the richer repeated extraction while
-- keeping the earlier accepted values when the model outputs conflict.
UPDATE booking AS keeper
   SET details = (
     SELECT json_patch(duplicate.details, keeper.details)
       FROM _booking_duplicate_map_0011 map
       JOIN booking duplicate ON duplicate.id = map.duplicate_id
      WHERE map.keeper_id = keeper.id
      ORDER BY length(duplicate.details) DESC
      LIMIT 1
   )
 WHERE keeper.id IN (
   SELECT keeper_id FROM _booking_duplicate_map_0011
 );

INSERT OR IGNORE INTO booking_person (booking_id, person_id)
SELECT map.keeper_id, bp.person_id
  FROM _booking_duplicate_map_0011 map
  JOIN booking_person bp ON bp.booking_id = map.duplicate_id;

UPDATE draft_booking
   SET booking_id = (
     SELECT map.keeper_id
       FROM _booking_duplicate_map_0011 map
      WHERE map.duplicate_id = draft_booking.booking_id
   )
 WHERE booking_id IN (
   SELECT duplicate_id FROM _booking_duplicate_map_0011
 );

DELETE FROM booking
 WHERE id IN (
   SELECT duplicate_id FROM _booking_duplicate_map_0011
 );

DROP TABLE _booking_duplicate_map_0011;
