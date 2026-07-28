-- A signed-in household member has at most one traveler profile. Older
-- households may have no linked profile; POST /api/people/me creates or links
-- it lazily.
CREATE UNIQUE INDEX IF NOT EXISTS idx_person_household_user
  ON person(household_id, user_id)
  WHERE user_id IS NOT NULL;
