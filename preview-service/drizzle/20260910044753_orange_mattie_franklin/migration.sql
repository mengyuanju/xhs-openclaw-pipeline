CREATE TABLE `preview_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`preview_id` text NOT NULL,
	`position` integer NOT NULL,
	`object_key` text NOT NULL,
	`original_name` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`preview_id`) REFERENCES `previews`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "preview_assets_position_check" CHECK("preview_assets"."position" > 0),
	CONSTRAINT "preview_assets_byte_size_check" CHECK("preview_assets"."byte_size" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preview_assets_object_key_uq` ON `preview_assets` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `preview_assets_position_uq` ON `preview_assets` (`preview_id`,`position`);--> statement-breakpoint
CREATE INDEX `preview_assets_preview_idx` ON `preview_assets` (`preview_id`);--> statement-breakpoint
CREATE TABLE `previews` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`tags_json` text NOT NULL,
	`status` text NOT NULL,
	`image_count` integer NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`published_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT "previews_status_check" CHECK("previews"."status" in ('PUBLISHED', 'REVOKED')),
	CONSTRAINT "previews_image_count_check" CHECK("previews"."image_count" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `previews_public_id_uq` ON `previews` (`public_id`);--> statement-breakpoint
CREATE INDEX `previews_status_created_idx` ON `previews` (`status`,`created_at`);