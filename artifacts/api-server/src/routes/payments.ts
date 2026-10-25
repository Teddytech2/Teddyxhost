import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";
import { db, paymentsTable, templatesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  PAYSTACK_BASE,
  paystackHeaders,
  gatewayConfigured,
  verifyPaystackSignature,
  getRawBody,
  headerValue,
} from "../lib/paystack";

const router: IRouter = Router();

// Currencies this gateway accepts. NGN is charged in kobo, KES in cents
// (Paystack "smallest currency unit" = amount × 100).
const SUPPORTED_CURRENCIES = new Set(["NGN", "KES"]);

// Paystack checkout channels per currency. For NGN, bank transfer and USSD
// are the everyday rails in Nigeria — card alone is not a naira payment gate.
const PAYSTACK_CHANNELS: Record<string, string[]> = {
  NGN: ["card", "bank_transfer", "ussd"],
  KES: ["card"],
};

function generateReference() {
  return `JUNEX-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function resolveCurrency(raw: string | null | undefined): string {
  return (raw ?? "NGN").toUpperCase();
}

// ── Check if user has paid for a template ─────────────────────
router.get("/payments/check/:templateId", requireAuth, async (req, res): Promise<void> => {
  const user = (req as any).user;
  const templateId = parseInt(req.params.templateId as string, 10);
  if (isNaN(templateId)) { res.status(400).json({ error: "Invalid templateId" }); return; }

  // Check if template is free
  const [template] = await db.select().from(templatesTable).where(eq(templatesTable.id, templateId));
  if (!template) { res.status(404).json({ error: "Template not found" }); return; }
  if (template.isFree) { res.json({ paid: true, isFree: true }); return; }

  // Check payments table
  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.userId, user.id), eq(paymentsTable.templateId, templateId), eq(paymentsTable.status, "success")));

  res.json({ paid: !!payment, isFree: false, payment: payment ?? null });
});

// ── Initiate payment (NGN: card / bank transfer / USSD; KES: card) ──
router.post("/payments/initiate", requireAuth, async (req, res): Promise<void> => {
  const user = (req as any).user;
  const { templateId, callbackUrl } = req.body;

  if (!templateId) { res.status(400).json({ error: "templateId is required" }); return; }

  const [template] = await db.select().from(templatesTable).where(eq(templatesTable.id, parseInt(templateId, 10)));
  if (!template) { res.status(404).json({ error: "Template not found" }); return; }
  if (template.isFree) { res.json({ isFree: true }); return; }

  // Currency is server-authoritative (the template's own price currency),
  // never client-supplied — a client cannot pick a different currency.
  const useCurrency = resolveCurrency(template.currency);
  if (!SUPPORTED_CURRENCIES.has(useCurrency)) {
    res.status(400).json({ error: `Unsupported currency: ${useCurrency}` }); return;
  }
  if (!gatewayConfigured(useCurrency)) {
    res.status(500).json({ error: useCurrency === "KES" ? "Kenyan gateway not configured (PAYSTACK_SECRET_KEY_KE)" : "Payment provider not configured. Add PAYSTACK_SECRET_KEY." });
    return;
  }

  const reference = generateReference();

  // Record pending payment
  await db.insert(paymentsTable).values({
    userId: user.id,
    templateId: template.id,
    reference,
    amount: template.price,
    currency: useCurrency,
    status: "pending",
    method: "card",
  });

  try {
    const response = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: "POST",
      headers: paystackHeaders(useCurrency),
      body: JSON.stringify({
        email: user.email,
        amount: template.price,     // smallest unit: kobo (NGN) / cents (KES)
        currency: useCurrency,
        reference,
        channels: PAYSTACK_CHANNELS[useCurrency],
        callback_url: callbackUrl ?? `${process.env.FRONTEND_URL ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:5000"}/payment-callback`,
        metadata: { templateId: template.id, templateName: template.name },
      }),
    });
    const data = await response.json() as any;
    if (!data.status || !data.data) {
      res.status(400).json({ error: data.message ?? "Failed to initialize payment" });
      return;
    }
    res.json({
      authorizationUrl: data.data.authorization_url,
      reference: data.data.reference,
      accessCode: data.data.access_code,
      amount: template.price,
      currency: useCurrency,
      channels: PAYSTACK_CHANNELS[useCurrency],
      templateName: template.name,
    });
  } catch (err) {
    logger.error({ err }, "Paystack initiate error");
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

// ── STK Push (M-Pesa) — KES templates only ───────────────────
router.post("/payments/stk-push", requireAuth, async (req, res): Promise<void> => {
  const user = (req as any).user;
  const { phone, templateId } = req.body;

  if (!phone || !templateId) { res.status(400).json({ error: "phone and templateId are required" }); return; }
  if (!gatewayConfigured("KES")) { res.status(500).json({ error: "Kenyan gateway not configured (PAYSTACK_SECRET_KEY_KE)" }); return; }

  const [template] = await db.select().from(templatesTable).where(eq(templatesTable.id, parseInt(templateId, 10)));
  if (!template) { res.status(404).json({ error: "Template not found" }); return; }
  if (template.isFree) { res.json({ isFree: true }); return; }
  if (resolveCurrency(template.currency) !== "KES") {
    res.status(400).json({ error: "M-Pesa is only available for KES templates. Use card, bank transfer or USSD for NGN." });
    return;
  }

  const reference = generateReference();
  const normalizedPhone = phone.startsWith("+") ? phone.slice(1) : phone;

  // Record pending payment
  await db.insert(paymentsTable).values({
    userId: user.id,
    templateId: template.id,
    reference,
    amount: template.price,
    currency: "KES",
    status: "pending",
    method: "mpesa",
  });

  try {
    const response = await fetch(`${PAYSTACK_BASE}/charge`, {
      method: "POST",
      headers: paystackHeaders("KES"),
      body: JSON.stringify({
        email: user.email,
        amount: template.price,
        currency: "KES",
        reference,
        mobile_money: { phone: normalizedPhone, provider: "mpesa" },
        metadata: { templateId: template.id, templateName: template.name },
      }),
    });
    const data = await response.json() as any;
    if (!data.status) {
      res.status(400).json({ error: data.message ?? "STK push failed" });
      return;
    }
    res.json({
      status: data.data?.status ?? "pending",
      reference: data.data?.reference ?? reference,
      message: "STK push sent. Check your phone and enter your M-Pesa PIN.",
    });
  } catch (err) {
    logger.error({ err }, "Paystack STK push error");
    res.status(500).json({ error: "STK push failed" });
  }
});

// ── Verify payment + unlock deployment ───────────────────────
router.get("/payments/verify/:reference", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.reference) ? req.params.reference[0] : req.params.reference;
  if (!raw) { res.status(400).json({ error: "Reference is required" }); return; }

  // Look up our record first so the Paystack amount can be matched against it.
  const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.reference, raw));
  if (!gatewayConfigured(payment?.currency)) { res.status(500).json({ error: "Payment provider not configured." }); return; }

  try {
    const response = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(raw)}`, {
      headers: paystackHeaders(payment?.currency),
    });
    const data = await response.json() as any;
    if (!data.status || !data.data) {
      res.status(400).json({ error: data.message ?? "Verification failed" });
      return;
    }

    const txStatus = data.data.status; // "success" | "failed" | "pending"
    const channel = typeof data.data.channel === "string" ? data.data.channel : undefined;

    if (txStatus === "success" && payment && (data.data.amount !== payment.amount || data.data.currency !== payment.currency)) {
      // Never unlock on an amount/currency Paystack did not actually charge.
      logger.warn({ reference: raw }, "Verify amount/currency mismatch — not unlocking");
      res.status(400).json({ error: "Payment amount or currency does not match this purchase" });
      return;
    }

    // Update our payments record
    if (txStatus === "success") {
      await db
        .update(paymentsTable)
        .set({ status: "success", paidAt: new Date(), ...(channel ? { method: channel } : {}) })
        .where(eq(paymentsTable.reference, raw));
    } else if (txStatus === "failed") {
      await db
        .update(paymentsTable)
        .set({ status: "failed" })
        .where(eq(paymentsTable.reference, raw));
    }

    res.json({
      status: txStatus,
      reference: data.data.reference,
      amount: data.data.amount,
      currency: data.data.currency,
      channel: channel ?? null,
      paidAt: data.data.paid_at ?? null,
      unlocked: txStatus === "success",
    });
  } catch (err) {
    logger.error({ err }, "Paystack verify error");
    res.status(500).json({ error: "Payment verification failed" });
  }
});

// ── Paystack Webhook (HMAC-SHA512 over the RAW body) ─────────
router.post("/payments/webhook", async (req, res): Promise<void> => {
  const signature = headerValue(req.headers["x-paystack-signature"]);
  const raw = getRawBody(req);

  if (!verifyPaystackSignature(raw, signature)) {
    logger.warn("Invalid Paystack webhook signature (payments)");
    res.sendStatus(401);
    return;
  }

  let event: any;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    res.sendStatus(400);
    return;
  }

  if (event.event === "charge.success") {
    const reference = event.data?.reference as string | undefined;
    const amount = event.data?.amount as number | undefined;
    const currency = event.data?.currency as string | undefined;
    const channel = typeof event.data?.channel === "string" ? event.data.channel : undefined;

    if (reference) {
      const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.reference, reference));
      if (payment && payment.status !== "success") {
        if (payment.amount === amount && payment.currency === currency) {
          await db
            .update(paymentsTable)
            .set({ status: "success", paidAt: new Date(), ...(channel ? { method: channel } : {}) })
            .where(eq(paymentsTable.reference, reference));
        } else {
          logger.warn({ reference }, "Webhook amount/currency mismatch — ignored");
        }
      }
    }
  } else if (event.event === "charge.failed") {
    const reference = event.data?.reference as string | undefined;
    if (reference) {
      await db
        .update(paymentsTable)
        .set({ status: "failed" })
        .where(eq(paymentsTable.reference, reference));
    }
  }

  res.sendStatus(200);
});

// ── List user payments ────────────────────────────────────────
router.get("/payments/my", requireAuth, async (req, res): Promise<void> => {
  const user = (req as any).user;
  const rows = await db
    .select({ payment: paymentsTable, templateName: templatesTable.name })
    .from(paymentsTable)
    .leftJoin(templatesTable, eq(paymentsTable.templateId, templatesTable.id))
    .where(eq(paymentsTable.userId, user.id));

  res.json(rows.map(r => ({
    ...r.payment,
    templateName: r.templateName ?? "Unknown",
  })));
});

export default router;
