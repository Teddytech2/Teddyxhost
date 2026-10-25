import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { templatesTable } from "./templates";

export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  templateId: integer("template_id").notNull().references(() => templatesTable.id, { onDelete: "cascade" }),
  reference: text("reference").notNull().unique(),
  amount: integer("amount").notNull(),               // in smallest currency unit
  currency: text("currency").notNull().default("NGN"),
  status: text("status").notNull().default("pending"), // pending | success | failed
  method: text("method").notNull().default("card"),    // card | mpesa
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({ id: true, createdAt: true });
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type Payment = typeof paymentsTable.$inferSelect;
