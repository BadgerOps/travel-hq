-- Accepting a booking extracted from a confirmation email means the
-- reservation already exists. Older imports were incorrectly stored as
-- planned, which made the UI ask the traveler to book them again.
UPDATE booking
   SET status = 'booked'
 WHERE status = 'planned'
   AND source_inbound_email_id IS NOT NULL;
