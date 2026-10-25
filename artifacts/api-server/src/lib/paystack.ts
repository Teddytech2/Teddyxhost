import crypto from "node:crypto";
import type { Request } from "express";

// Two Paystack accounts: one charges NGN (naira), one charges KES (M-Pesa).
// A Paystack account is country-bound and cannot charge the other currency.
export const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY ?? "";
export const PAYSTACK_SECRET_KE = process.env.PAYSTACK_SECRET_KEY_KE ?? "";
export const PAYSTACK_BASE = "https://api.paystack.co";

export function secretForCurrency(currency: string | undefined): string {
  return (currency ?? "NGN").toUpperCase() === "KES" ? PAYSTACK_SECRET_KE : PAYSTACK_SECRET;
}

export function gatewayConfigured(currency: string | undefined): boolean {
  return !!secretForCurrency(currency);
}

export function paystackHeaders(currency: string | undefined = "NGN"): Record<string, string> {
  return {
    Authorization: `Bearer ${secretForCurrency(currency)}`,
    "Content-Type": "application/json",
  };
}

/**
 * Extract the RAW request body bytes.
 *
 * Paystack signs the exact bytes that arrived on the wire, so HMAC must be
 * computed over those bytes — never over a re-serialized JSON object.
 * Mount these webhook routes with `express.raw()` (see app.ts) so req.body
 * is a Buffer. The fallback fails closed: a re-serialized body almost never
 * reproduces the signature, so a misconfigured server rejects instead of
 * accepting forgeries.
 */
export function getRawBody(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  return Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
}

/**
 * Verify the x-paystack-signature header: hex(HMAC-SHA512(rawBody, secret)).
 * Webhooks from both accounts land on the same URL, so the signature is
 * accepted if it matches EITHER configured secret. Timing-safe comparison;
 * empty secrets or missing header always fail.
 */
export function verifyPaystackSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const providedBuf = Buffer.from(signature, "utf8");
  for (const secret of [PAYSTACK_SECRET, PAYSTACK_SECRET_KE]) {
    if (!secret) continue;
    const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      return true;
    }
  }
  return false;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
