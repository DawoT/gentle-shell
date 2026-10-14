-- Migration 001: Create users table and accounts table
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00
);

ALTER TABLE users ADD COLUMN name VARCHAR(255);
