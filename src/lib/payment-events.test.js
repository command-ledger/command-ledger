import { describe, it, expect } from "vitest";
import {
  readEvent, isChargeback, disputeWonBySeller, refundCoversOrder,
  isUuid, isSubscriptionId, looksLikeWebhookId,
} from "../../supabase/functions/_shared/payment-events.ts";

// Imports the module paypal-webhook runs, not a copy. PayPal cannot be made to
// send a real refund or chargeback on demand, so these fixtures, written from
// PayPal's documented event shapes, are the only cover those paths have.

const USER = "11111111-1111-1111-1111-111111111111";
const SUB = "I-BW452GLLEP1G";

describe("what counts as what", () => {
  it("accepts a real webhook id and rejects the value that broke payments", () => {
    expect(looksLikeWebhookId("7MX05908B47842619")).toBe(true);
    expect(looksLikeWebhookId("A".repeat(80))).toBe(false);
    expect(looksLikeWebhookId("")).toBe(false);
    expect(looksLikeWebhookId(undefined)).toBe(false);
  });

  it("recognises subscription ids and user ids", () => {
    expect(isSubscriptionId(SUB)).toBe(true);
    expect(isSubscriptionId("P-8CD25808KD889454JNKS7S7I")).toBe(false);
    expect(isSubscriptionId("I-1' OR '1'='1")).toBe(false);
    expect(isUuid(USER)).toBe(true);
    expect(isUuid("not-a-user")).toBe(false);
  });
});

describe("readEvent", () => {
  it("reads a subscription event from the subscription itself", () => {
    const e = readEvent({ event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: SUB, custom_id: USER, plan_id: "P-1", status: "ACTIVE" } });
    expect(e).toMatchObject({ action: "grant", subscriptionId: SUB, userId: USER, paymentConfirmed: false });
  });

  it("treats a re-activation as a grant", () => {
    expect(readEvent({ event_type: "BILLING.SUBSCRIPTION.RE-ACTIVATED", resource: { id: SUB } }).action).toBe("grant");
  });

  it("takes a completed sale as proof of payment for its subscription", () => {
    const e = readEvent({ event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "SALE1", state: "completed", amount: { total: "99.00", currency: "USD" }, billing_agreement_id: SUB } });
    expect(e).toMatchObject({ action: "grant", paymentConfirmed: true, subscriptionId: SUB, transactionId: "SALE1", amount: 99, currency: "USD" });
  });

  it("finds a subscription named only in a capture's related ids", () => {
    const e = readEvent({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP1", supplementary_data: { related_ids: { subscription_id: SUB } } } });
    expect(e).toMatchObject({ action: "grant", paymentConfirmed: true, subscriptionId: SUB });
  });

  it("sends a one-time capture to the Diagnostic, not to a subscription", () => {
    const e = readEvent({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP2", amount: { value: "750.00", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: "ORDER1" } } } });
    expect(e).toMatchObject({ action: "diagnostic_capture", orderId: "ORDER1", transactionId: "CAP2", amount: 750 });
    expect(e.paymentConfirmed).toBe(false);
  });

  it("does nothing with a sale that belongs to neither", () => {
    expect(readEvent({ event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "SALE2" } }).action).toBe("record");
  });

  it("follows a refund back to the sale it refunds", () => {
    const direct = readEvent({ event_type: "PAYMENT.SALE.REFUNDED", resource: { id: "R1", sale_id: "SALE1", amount: { total: "-99.00", currency: "USD" } } });
    expect(direct).toMatchObject({ action: "refund", transactionId: "SALE1", amount: 99 });
    const linked = readEvent({ event_type: "PAYMENT.SALE.REFUNDED", resource: { id: "R2", links: [{ rel: "self", href: "https://api.paypal.com/v1/payments/refund/R2" }, { rel: "sale", href: "https://api.paypal.com/v1/payments/sale/SALE9" }] } });
    expect(linked.transactionId).toBe("SALE9");
  });

  it("follows a capture refund through its parent link", () => {
    const e = readEvent({ event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "R3", amount: { value: "750.00", currency_code: "USD" }, links: [{ rel: "up", href: "https://api.paypal.com/v2/payments/captures/CAP2?x=1" }] } });
    expect(e).toMatchObject({ action: "refund", transactionId: "CAP2", amount: 750 });
  });

  it("reads a chargeback reversal the same way", () => {
    expect(readEvent({ event_type: "PAYMENT.SALE.REVERSED", resource: { id: "R4", sale_id: "SALE1" } })).toMatchObject({ action: "reversal", transactionId: "SALE1" });
  });

  it("finds the payment a dispute is about", () => {
    const e = readEvent({ event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1", dispute_amount: { currency_code: "USD", value: "99.00" }, disputed_transactions: [{ seller_transaction_id: "SALE1", custom: USER }] } });
    expect(e).toMatchObject({ action: "dispute", resourceId: "PP-D-1", transactionId: "SALE1", userId: USER, amount: 99 });
  });

  it("never treats an unknown custom value as a user", () => {
    expect(readEvent({ event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: SUB, custom_id: "someone-else" } }).userId).toBeNull();
  });

  it("keeps an event it does not act on, and survives one with no resource", () => {
    expect(readEvent({ event_type: "BILLING.SUBSCRIPTION.UPDATED", resource: { id: SUB } }).action).toBe("record");
    expect(readEvent({ event_type: "SOMETHING.NEW" }).action).toBe("record");
    expect(readEvent(null).action).toBe("record");
  });
});

describe("disputes", () => {
  it("takes access away for a chargeback, not for a buyer's inquiry", () => {
    expect(isChargeback({ dispute_life_cycle_stage: "CHARGEBACK" })).toBe(true);
    expect(isChargeback({ dispute_channel: "EXTERNAL" })).toBe(true);
    expect(isChargeback({ dispute_life_cycle_stage: "INQUIRY", dispute_channel: "INTERNAL" })).toBe(false);
  });

  it("knows who won", () => {
    expect(disputeWonBySeller({ dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" } })).toBe(true);
    expect(disputeWonBySeller({ dispute_outcome: { outcome_code: "CANCELED_BY_BUYER" } })).toBe(true);
    expect(disputeWonBySeller({ dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" } })).toBe(false);
    expect(disputeWonBySeller({})).toBe(false);
  });
});

describe("refundCoversOrder", () => {
  it("needs the whole amount back", () => {
    expect(refundCoversOrder(750, 750)).toBe(true);
    expect(refundCoversOrder(100, 750)).toBe(false);
    expect(refundCoversOrder(null, 750)).toBe(false);
  });
});
