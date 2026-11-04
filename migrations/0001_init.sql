-- Migration 0001: initial schema.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','admin')),
  birthday TEXT,
  gender TEXT CHECK(gender IN ('M','F','other') OR gender IS NULL),
  height_cm REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE daily_weight (
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  weight_kg REAL NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE weekly_vitals (
  user_id INTEGER NOT NULL,
  iso_week TEXT NOT NULL,
  heart_rate INTEGER,
  bp_systolic INTEGER,
  bp_diastolic INTEGER,
  measured_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, iso_week),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE weekly_menu (
  user_id INTEGER NOT NULL,
  iso_week TEXT NOT NULL,
  menu_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  PRIMARY KEY (user_id, iso_week),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_weight_user_date ON daily_weight(user_id, date DESC);
