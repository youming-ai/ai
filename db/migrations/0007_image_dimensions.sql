-- Image dimensions extracted from feed metadata (media:thumbnail/media:content
-- width+height, ESPN image.width/height). 0 = unknown (card falls back to 16:9).
-- Lets ExploreCard reserve the natural aspect ratio and avoid CLS without an
-- extra HTTP probe per image.
ALTER TABLE articles ADD COLUMN image_width INTEGER NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN image_height INTEGER NOT NULL DEFAULT 0;
