ALTER TABLE `file_versions` ADD `history_kind` text DEFAULT 'attachments' NOT NULL;--> statement-breakpoint
ALTER TABLE `vaults` ADD `history_limit_documents` integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE `vaults` ADD `history_limit_attachments` integer DEFAULT 10 NOT NULL;