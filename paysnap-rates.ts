import { createInsertSchema } from "drizzle-zod";
import { integer, numeric, pgTable, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const paysnapRatesTable = pgTable("paysnap_rates", {
  id: integer("id").primaryKey().default(1),
  aedRate: numeric("aed_rate", { precision: 18, scale: 8 }),
  inrRate: numeric("inr_rate", { precision: 18, scale: 8 }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertPaysnapRatesSchema = createInsertSchema(paysnapRatesTable).omit({
  id: true,
  updatedAt: true,
});

export type InsertPaysnapRates = z.infer<typeof insertPaysnapRatesSchema>;
export type PaysnapRates = typeof paysnapRatesTable.$inferSelect;
