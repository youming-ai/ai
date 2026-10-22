PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rss', 'api-json')),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  sport TEXT NOT NULL DEFAULT 'soccer',
  comp TEXT,
  authority_score INTEGER NOT NULL DEFAULT 50 CHECK (authority_score BETWEEN 0 AND 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_health (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  last_fetch_at INTEGER,
  last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms INTEGER NOT NULL DEFAULT 0,
  articles_fetched_count INTEGER NOT NULL DEFAULT 0,
  articles_inserted_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ai_summary TEXT NOT NULL,
  ai_blurb TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  sport TEXT NOT NULL DEFAULT 'soccer',
  comp TEXT,
  article_type TEXT NOT NULL DEFAULT 'news',
  is_football INTEGER NOT NULL DEFAULT 1 CHECK (is_football IN (0, 1)),
  quality_score INTEGER NOT NULL DEFAULT 0 CHECK (quality_score BETWEEN 0 AND 100),
  freshness_score INTEGER NOT NULL DEFAULT 0 CHECK (freshness_score BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'filtered', 'archived')),
  raw_metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (article_id, tag)
);

CREATE TABLE IF NOT EXISTS article_clusters (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL,
  is_representative INTEGER NOT NULL DEFAULT 0 CHECK (is_representative IN (0, 1)),
  PRIMARY KEY (article_id, cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_articles_published
  ON articles (status, is_football, published_at DESC, quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_articles_comp
  ON articles (status, comp, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_source
  ON articles (status, source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_tags_tag
  ON article_tags (tag, article_id);
CREATE INDEX IF NOT EXISTS idx_clusters_cluster
  ON article_clusters (cluster_id);

INSERT OR IGNORE INTO sources (
  id, kind, name, url, sport, authority_score, enabled, created_at, updated_at
)
VALUES
  (
    'bbc-football',
    'rss',
    'BBC Sport Football',
    'https://feeds.bbci.co.uk/sport/football/rss.xml',
    'soccer',
    92,
    1,
    unixepoch(),
    unixepoch()
  ),
  (
    'guardian-football',
    'rss',
    'The Guardian Football',
    'https://www.theguardian.com/football/rss',
    'soccer',
    88,
    1,
    unixepoch(),
    unixepoch()
  ),
  (
    'sky-football',
    'rss',
    'Sky Sports Football',
    'https://www.skysports.com/rss/12040',
    'soccer',
    90,
    1,
    unixepoch(),
    unixepoch()
  );

INSERT OR IGNORE INTO source_health (source_id)
SELECT id FROM sources;
