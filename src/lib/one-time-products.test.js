import { describe, it, expect } from "vitest";
import { DIAGNOSTIC, paypalAmount, verifyDiagnosticCapture } from "../../supabase/functions/_shared/one-time-products.ts";

// These import the module the diagnostic-order Edge Function and the PayPal
// webhook run, not a copy of it, so a change to how captured money is judged
// has to get past these first.

const USER = "11111111-1111-1111-1111-111111111111";
const capture = over => ({
  id: "3C679366HH908993F",
  status: "COMPLETED",
  amount: { currency_code: "USD", value: "750.00" },
  custom_id: USER,
  ...over,
});

describe("DIAGNOSTIC", () => {
  it("is priced at $750 USD", () => {
    expect(DIAGNOSTIC.amountUsd).toBe(750);
    expect(DIAGNOSTIC.currency).toBe("USD");
  });

  it("formats amounts the way PayPal requires", () => {
    expect(paypalAmount(750)).toBe("750.00");
    expect(paypalAmount(99)).toBe("99.00");
  });
});

describe("verifyDiagnosticCapture", () => {
  it("completes a $750 USD capture for the paying user", () => {
    expect(verifyDiagnosticCapture(capture(), USER)).toEqual({ ok: true, state: "completed", captureId: "3C679366HH908993F" });
  });

  it("holds a PayPal-pending capture as pending, not completed", () => {
    expect(verifyDiagnosticCapture(capture({ status: "PENDING" }), USER)).toEqual({ ok: true, state: "pending", captureId: "3C679366HH908993F" });
  });

  it("treats a declined or missing capture as no money moved, so the buyer can retry", () => {
    expect(verifyDiagnosticCapture(capture({ status: "DECLINED" }), USER).state).toBe("not_captured");
    expect(verifyDiagnosticCapture(null, USER).state).toBe("not_captured");
    expect(verifyDiagnosticCapture(capture({ id: undefined }), USER).state).toBe("not_captured");
  });

  it("sends a wrong amount to review — money moved on terms we did not sell", () => {
    const v = verifyDiagnosticCapture(capture({ amount: { currency_code: "USD", value: "1.00" } }), USER);
    expect(v.ok).toBe(false);
    expect(v.state).toBe("review");
    expect(v.captureId).toBe("3C679366HH908993F");
  });

  it("sends a wrong currency to review, even when the number matches", () => {
    expect(verifyDiagnosticCapture(capture({ amount: { currency_code: "ZAR", value: "750.00" } }), USER).state).toBe("review");
  });

  it("sends an unreadable amount to review rather than trusting it", () => {
    expect(verifyDiagnosticCapture(capture({ amount: { currency_code: "USD", value: "abc" } }), USER).state).toBe("review");
    expect(verifyDiagnosticCapture(capture({ amount: undefined }), USER).state).toBe("review");
  });

  it("accepts PayPal's amount written without trailing zeros", () => {
    expect(verifyDiagnosticCapture(capture({ amount: { currency_code: "USD", value: "750" } }), USER).state).toBe("completed");
  });

  it("sends a capture for a different user to review", () => {
    expect(verifyDiagnosticCapture(capture({ custom_id: "22222222-2222-2222-2222-222222222222" }), USER).state).toBe("review");
  });

  it("does not demand custom_id when the webhook resource omits it", () => {
    expect(verifyDiagnosticCapture(capture({ custom_id: undefined }), USER).state).toBe("completed");
    expect(verifyDiagnosticCapture(capture(), undefined).state).toBe("completed");
  });
});
