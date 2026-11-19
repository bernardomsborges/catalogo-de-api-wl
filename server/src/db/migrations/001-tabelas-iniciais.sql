-- Structure the catalog already had before migrations got versions (PRO-202).
-- IF NOT EXISTS: databases created by older versions adopt this version without changes.

CREATE TABLE IF NOT EXISTS apis (
  id          text PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  data        jsonb NOT NULL,
  revision    integer NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_versions (
  api_id      text NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
  revision    integer NOT NULL,
  data        jsonb NOT NULL,
  saved_at    timestamptz NOT NULL DEFAULT now(),
  saved_by    text NOT NULL DEFAULT '',
  note        text NOT NULL DEFAULT '',
  PRIMARY KEY (api_id, revision)
);

CREATE TABLE IF NOT EXISTS api_drafts (
  api_id        text PRIMARY KEY REFERENCES apis(id) ON DELETE CASCADE,
  data          jsonb NOT NULL,
  base_revision integer NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL DEFAULT ''
);

-- Accounts, recipes, subscriptions, sync, monitoring and AI data: one JSON document each.
CREATE TABLE IF NOT EXISTS documents (
  name       text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
