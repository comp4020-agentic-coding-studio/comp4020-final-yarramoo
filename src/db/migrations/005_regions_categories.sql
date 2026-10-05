-- Regions: each postcode is assigned a region slug (see src/regions.ts; filled at boot by the
-- postcode loader, including a one-off backfill for tables loaded before this migration).
-- Categories: each project has a category slug (src/categories.ts); NULL reads as "other".
ALTER TABLE postcodes ADD COLUMN region TEXT;
CREATE INDEX idx_postcodes_region ON postcodes(region);
ALTER TABLE projects ADD COLUMN category TEXT;
CREATE INDEX idx_projects_category ON projects(category);
