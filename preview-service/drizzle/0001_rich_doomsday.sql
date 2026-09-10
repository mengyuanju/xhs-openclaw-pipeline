DROP INDEX `preview_assets_preview_idx`;--> statement-breakpoint
DROP INDEX `previews_status_created_idx`;--> statement-breakpoint
CREATE INDEX `previews_created_idx` ON `previews` (`created_at`);