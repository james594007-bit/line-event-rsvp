-- Distinguish the activity venue from the meeting point used before departure.
ALTER TABLE events ADD COLUMN activity_location TEXT;

-- Existing events only had a meeting location. Preserve their current visible
-- location as the activity location until a moderator edits it explicitly.
UPDATE events
SET activity_location = meeting_location
WHERE activity_location IS NULL AND meeting_location IS NOT NULL;
