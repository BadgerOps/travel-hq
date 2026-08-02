-- Renames the middle household role from `adult` to `admin`.
--
-- 0001 named the roles for a family: owner, adult, viewer. That reads as a
-- statement about age, and until now nothing could change a member's role
-- anyway -- they were set once at seeding, or hardcoded to `viewer` by
-- TripAccessRepo.invite(). The name never had to answer for itself.
--
-- It does now. An owner can promote and demote members, so the middle tier has
-- become something you GRANT, and what you are granting is the ability to edit
-- every person in the household. That is a statement about trust, not age: a
-- teenager can be the one who keeps everyone's passports current, and a
-- grandparent who is only along for one trip should not be. Calling the grant
-- `adult` would have meant every future reader learning that the word on the
-- screen and the word in the schema are different, which is the drift this
-- codebase writes comments to prevent -- so it is fixed at the schema instead.
--
-- The table is rebuilt because SQLite cannot ALTER a CHECK constraint in place,
-- the same reason 0018 rebuilt audit_log. Nothing holds a foreign key to
-- household_member, so the DROP takes no dependants with it.
--
-- `owner` and `viewer` are deliberately untouched. Only the ambiguous one moves.

CREATE TABLE household_member_rebuilt (
  household_id  TEXT NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner','admin','viewer')),
  PRIMARY KEY (household_id, user_id)
);

-- CASE rather than a blanket UPDATE after the copy: the new CHECK would reject
-- an 'adult' row on the way in, so the value has to be translated during the
-- INSERT rather than corrected afterwards.
INSERT INTO household_member_rebuilt (household_id, user_id, role)
SELECT household_id,
       user_id,
       CASE role WHEN 'adult' THEN 'admin' ELSE role END
  FROM household_member;

DROP TABLE household_member;
ALTER TABLE household_member_rebuilt RENAME TO household_member;
