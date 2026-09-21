PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_preview_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`preview_id` text NOT NULL,
	`position` integer NOT NULL,
	`object_key` text NOT NULL,
	`original_name` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `preview_assets_preview_id_previews_id_fk` FOREIGN KEY (`preview_id`) REFERENCES `previews`(`id`) ON DELETE CASCADE,
	CONSTRAINT "preview_assets_position_check" CHECK("position" > 0),
	CONSTRAINT "preview_assets_byte_size_check" CHECK("byte_size" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_preview_assets`(`id`, `preview_id`, `position`, `object_key`, `original_name`, `media_type`, `byte_size`, `sha256`, `created_at`) SELECT `id`, `preview_id`, `position`, `object_key`, `original_name`, `media_type`, `byte_size`, `sha256`, `created_at` FROM `preview_assets`;--> statement-breakpoint
DROP TABLE `preview_assets`;--> statement-breakpoint
ALTER TABLE `__new_preview_assets` RENAME TO `preview_assets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`tags_json` text NOT NULL,
	`status` text NOT NULL,
	`image_count` integer NOT NULL,
	`content_hash` text NOT NULL,
	`source_ref` text,
	`created_at` integer NOT NULL,
	`published_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT "previews_status_check" CHECK("status" in ('PUBLISHED', 'REVOKED')),
	CONSTRAINT "previews_image_count_check" CHECK("image_count" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_previews`(`id`, `public_id`, `title`, `body`, `tags_json`, `status`, `image_count`, `content_hash`, `source_ref`, `created_at`, `published_at`, `revoked_at`) SELECT `id`, `public_id`, `title`, `body`, `tags_json`, `status`, `image_count`, `content_hash`, `source_ref`, `created_at`, `published_at`, `revoked_at` FROM `previews`;--> statement-breakpoint
DROP TABLE `previews`;--> statement-breakpoint
ALTER TABLE `__new_previews` RENAME TO `previews`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `preview_assets_object_key_uq` ON `preview_assets` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `preview_assets_position_uq` ON `preview_assets` (`preview_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `previews_public_id_uq` ON `previews` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `previews_source_ref_uq` ON `previews` (`source_ref`);--> statement-breakpoint
CREATE INDEX `previews_created_idx` ON `previews` (`created_at`);