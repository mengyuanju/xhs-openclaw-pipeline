ALTER TABLE `previews` ADD `source_ref` text;--> statement-breakpoint
CREATE UNIQUE INDEX `previews_source_ref_uq` ON `previews` (`source_ref`);