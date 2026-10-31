-- Time Nick blocks off by hand in the owner dashboard (classes, appointments, days off from detailing)
CREATE TABLE IF NOT EXISTS blockouts (
  id TEXT PRIMARY KEY,
  title TEXT,
  repeat TEXT NOT NULL,              -- once | weekly
  day TEXT,                          -- YYYY-MM-DD (once)
  weekdays TEXT,                     -- weekly: comma list, 0 = Sunday … 6 = Saturday
  from_day TEXT,                     -- weekly: first day it applies
  until_day TEXT,                    -- weekly: last day it applies (empty = no end)
  start_min INTEGER,                 -- minutes after midnight, New York time (NULL = all day)
  end_min INTEGER,
  skip_days TEXT NOT NULL DEFAULT '[]',   -- weekly: dates it doesn't apply (holidays, no class)
  created_at INTEGER NOT NULL
);
