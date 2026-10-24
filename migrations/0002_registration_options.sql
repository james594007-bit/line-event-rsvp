ALTER TABLE events ADD COLUMN enable_attendance_type INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN enable_car_role INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN enable_plus_one INTEGER NOT NULL DEFAULT 0;

ALTER TABLE registrations ADD COLUMN attendance_type TEXT; -- activity_only | activity_and_meal | meal_only
ALTER TABLE registrations ADD COLUMN plus_one_count INTEGER NOT NULL DEFAULT 0;

-- the 松蘿湖 pilot event already uses driver/passenger via the old generic `role` column
UPDATE events SET enable_car_role = 1 WHERE passenger_fee IS NOT NULL OR id = 'ev_28ec66adbd';
