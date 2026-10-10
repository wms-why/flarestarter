-- Multi-provider billing: a subscription row can now belong to any of the four
-- supported vendors (stripe / waffo / creem / paypal), which changes two things.
--
-- 1. `customer_id` becomes NULLABLE. Only Stripe lets us pre-create a customer;
--    PayPal exposes no stable customer id at all, and Waffo/Creem identify the
--    buyer through the metadata we attach at checkout. Those rows store NULL and
--    are located by user_id instead.
--
-- 2. `lifetime_payment_intent_id` is RENAMED to `lifetime_payment_ref`. The old
--    name is Stripe-specific, but the column now holds each vendor's own payment
--    reference (Stripe payment_intent / Waffo orderId / Creem checkout id /
--    PayPal capture id) and refunds are matched against it exactly.
--    `ALTER TABLE ... RENAME COLUMN` is used rather than drop+add so existing
--    lifetime rows keep the reference they need for refund matching.
--> statement-breakpoint
ALTER TABLE `subscription` RENAME COLUMN `lifetime_payment_intent_id` TO `lifetime_payment_ref`;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'stripe' NOT NULL,
	`customer_id` text,
	`subscription_id` text,
	`status` text DEFAULT 'none' NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`price_id` text,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`lifetime` integer DEFAULT false NOT NULL,
	`lifetime_payment_ref` text,
	`payment_failed_at` integer,
	`last_event_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_subscription` (
	`id`,
	`user_id`,
	`provider`,
	`customer_id`,
	`subscription_id`,
	`status`,
	`plan`,
	`price_id`,
	`current_period_end`,
	`cancel_at_period_end`,
	`lifetime`,
	`lifetime_payment_ref`,
	`payment_failed_at`,
	`last_event_at`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`user_id`,
	`provider`,
	`customer_id`,
	`subscription_id`,
	`status`,
	`plan`,
	`price_id`,
	`current_period_end`,
	`cancel_at_period_end`,
	`lifetime`,
	`lifetime_payment_ref`,
	`payment_failed_at`,
	`last_event_at`,
	`created_at`,
	`updated_at`
FROM `subscription`;
--> statement-breakpoint
DROP TABLE `subscription`;
--> statement-breakpoint
ALTER TABLE `__new_subscription` RENAME TO `subscription`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_user_id_unique` ON `subscription` (`user_id`);
--> statement-breakpoint
CREATE INDEX `subscription_customer_id_idx` ON `subscription` (`customer_id`);