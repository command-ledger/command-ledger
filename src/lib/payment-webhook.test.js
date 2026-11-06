import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAccess } from "../../supabase/functions/_shared/paypal-access.ts";
import { createEventProcessor } from "../../supabase/functions/_shared/paypal-events.ts";
import { CURRENT_PLAN_IDS } from "../../supabase/functions/_shared/paypal-plans.ts";

// The payment acceptance tests. These run the exact code paypal-webhook and
// confirm-subscription run, against a simulated PayPal and database. They prove
// the logic. They do not prove PayPal delivers real events: only a real payment
// can show that.

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const SOFTWARE = CURRENT_PLAN_IDS.software;
const ADVISORY = CURRENT_PLAN_IDS.advisory;
const paidInfo = { billing_info: { last_payment: { amount: { value: "99.00", currency_code: "USD" }, time: "2026-11-06T00:12:00Z" } } };

// Just enough of supabase-js for these modules. failNext makes one write fail.
function fakeDb(tables) {
  const failures = [];
  class Q {
    constructor(t) { this.t = t; this.f = []; this.op = "select"; }
    select() { this.wantRows = true; return this; }
    upsert(row, opts) { this.op = "upsert"; this.row = row; this.opts = opts; return this; }
    update(fields) { this.op = "update"; this.fields = fields; return this; }
    eq(k, v) { this.f.push(r => r[k] === v); return this; }
    in(k, v) { this.f.push(r => v.includes(r[k])); return this; }
    limit(n) { this.n = n; return this; }
    single() { this.one = "single"; return this; }
    maybeSingle() { this.one = "maybe"; return this; }
    matches() { return (tables[this.t] ||= []).filter(r => this.f.every(fn => fn(r))); }
    run() {
      const i = failures.findIndex(x => x.t === this.t && x.op === this.op);
      if (i >= 0) { failures.splice(i, 1); return { data: null, error: { message: "simulated database failure" } }; }
      if (this.op === "upsert") {
        const rows = (tables[this.t] ||= []);
        const clash = rows.find(r => r.provider === this.row.provider && r.event_id === this.row.event_id);
        if (clash) return { data: [], error: null };
        const row = { id: `row${rows.length + 1}`, status: "received", attempts: 1, ...this.row };
        rows.push(row);
        return { data: [row], error: null };
      }
      if (this.op === "update") {
        const hit = this.matches();
        hit.forEach(r => Object.assign(r, this.fields));
        return { data: hit, error: null };
      }
      let hit = this.matches();
      if (this.n) hit = hit.slice(0, this.n);
      if (this.one) return { data: hit[0] ?? null, error: hit[0] || this.one === "maybe" ? null : { message: "no rows" } };
      return { data: hit, error: null };
    }
    then(ok, no) { return Promise.resolve(this.run()).then(ok, no); }
  }
  return { from: t => new Q(t), failNext: (t, op) => failures.push({ t, op }), tables };
}

let db, paypal, events, access;
const profile = () => db.tables.profiles.find(p => p.id === USER);
const eventRow = id => db.tables.payment_events.find(e => e.event_id === id);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  db = fakeDb({
    profiles: [{ id: USER, plan: null, status: null, paypal_subscription_id: null }],
    payment_events: [],
    subscription_checkouts: [],
    diagnostic_orders: [],
  });
  paypal = { subs: {}, cancelled: [] };
  vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    const cancel = u.match(/subscriptions\/([^/]+)\/cancel$/);
    if (cancel) { paypal.cancelled.push(cancel[1]); return new Response(null, { status: 204 }); }
    const read = u.match(/subscriptions\/([^/?]+)$/);
    if (read && opts?.method !== "POST") {
      const s = paypal.subs[read[1]];
      return s ? new Response(JSON.stringify(s), { status: 200 }) : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 500 });
  }));
  access = createAccess(db, { apiBase: "https://paypal.test", clientId: "id", clientSecret: "secret" });
  events = createEventProcessor(db, access);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const sub = (id, plan = SOFTWARE, over = {}) => (paypal.subs[id] = {
  id, plan_id: plan, custom_id: USER, status: "ACTIVE", create_time: "2026-11-06T00:11:00Z", ...paidInfo, ...over,
});
const activated = (id, eventId = `E-ACT-${id}`) => ({ id: eventId, event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id, custom_id: USER } });
const sale = (id, saleId = "SALE1", eventId = `E-SALE-${saleId}`) => ({
  id: eventId, event_type: "PAYMENT.SALE.COMPLETED",
  resource: { id: saleId, state: "completed", billing_agreement_id: id, amount: { total: "99.00", currency: "USD" } },
});

describe("Test 1 and 2: paying grants the plan bought", () => {
  it("gives Command Ledger the software plan", async () => {
    sub("I-CL1");
    await events.processEvent(activated("I-CL1"), "t");
    expect(profile()).toMatchObject({ plan: "software", status: "active", paypal_subscription_id: "I-CL1" });
  });

  it("gives Command Advisory the advisory plan", async () => {
    sub("I-AD1", ADVISORY);
    await events.processEvent(activated("I-AD1"), "t");
    expect(profile()).toMatchObject({ plan: "advisory", status: "active" });
  });

  it("applies to the account PayPal names, not to whoever is asking", async () => {
    db.tables.profiles.push({ id: OTHER, plan: null, status: null, paypal_subscription_id: null });
    sub("I-CL2", SOFTWARE, { custom_id: OTHER });
    await events.processEvent(activated("I-CL2"), "t");
    expect(db.tables.profiles.find(p => p.id === OTHER).plan).toBe("software");
    expect(profile().plan).toBeNull();
  });
});

describe("Test 3: the Diagnostic is one-time and opens no workspace", () => {
  it("records the payment and grants no plan", async () => {
    db.tables.diagnostic_orders.push({ id: "o1", paypal_order_id: "ORDER1", status: "created", user_id: USER, amount_usd: 750 });
    await events.processEvent({
      id: "E-CAP1", event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP1", status: "COMPLETED", amount: { value: "750.00", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: "ORDER1" } } },
    }, "t");
    expect(db.tables.diagnostic_orders[0]).toMatchObject({ status: "completed", paypal_capture_id: "CAP1" });
    expect(profile().plan).toBeNull();
  });

  it("flags money for the wrong amount instead of accepting it", async () => {
    db.tables.diagnostic_orders.push({ id: "o1", paypal_order_id: "ORDER1", status: "created", user_id: USER, amount_usd: 750 });
    const out = await events.processEvent({
      id: "E-CAP2", event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP2", status: "COMPLETED", amount: { value: "1.00", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: "ORDER1" } } },
    }, "t");
    expect(out.status).toBe("needs_review");
    expect(db.tables.diagnostic_orders[0].status).toBe("review");
  });
});

describe("Test 4: access lives on the account, not in the session", () => {
  it("is stored against the user id, so a new sign-in reads the same plan", async () => {
    sub("I-CL1");
    await events.processEvent(activated("I-CL1"), "t");
    const { data } = await db.from("profiles").select("*").eq("id", USER).single();
    expect(data.plan).toBe("software");
  });
});

describe("Tests 5 and 6: repeats change nothing", () => {
  it("applies a webhook delivered twice once", async () => {
    sub("I-CL1");
    await events.processEvent(activated("I-CL1", "E-1"), "t");
    const second = await events.processEvent(activated("I-CL1", "E-1"), "t");
    expect(second.duplicate).toBe(true);
    expect(db.tables.payment_events).toHaveLength(1);
    expect(profile().plan).toBe("software");
  });

  it("does not duplicate anything when a checkout is confirmed again after a refresh", async () => {
    const s = sub("I-CL1");
    await access.applyGrant(s, "t");
    await access.applyGrant(s, "t");
    expect(profile()).toMatchObject({ plan: "software", paypal_subscription_id: "I-CL1" });
    expect(paypal.cancelled).toEqual([]);
  });

  it("gives one result however the browser and webhook race", async () => {
    const s = sub("I-CL1");
    await access.applyGrant(s, "t");
    await events.processEvent(activated("I-CL1"), "t");
    await events.processEvent(sale("I-CL1"), "t");
    expect(profile()).toMatchObject({ plan: "software", status: "active", paypal_subscription_id: "I-CL1" });
  });
});

describe("Test 7: delayed and out-of-order events", () => {
  it("grants when a delayed payment event finally arrives", async () => {
    sub("I-CL1", SOFTWARE, { billing_info: {} });
    await events.processEvent(activated("I-CL1"), "t");
    expect(profile().plan).toBeNull();
    await events.processEvent(sale("I-CL1"), "t");
    expect(profile().plan).toBe("software");
  });

  it("does not revive a cancelled subscription when its payment event arrives late", async () => {
    sub("I-CL1", SOFTWARE, { status: "CANCELLED" });
    const out = await events.processEvent(sale("I-CL1"), "t");
    expect(out.status).toBe("ignored");
    expect(profile().plan).toBeNull();
  });

  it("asks PayPal to retry when money arrived but the subscription has not caught up", async () => {
    sub("I-CL1", SOFTWARE, { status: "APPROVED" });
    await expect(events.processEvent(sale("I-CL1"), "t")).rejects.toThrow(/retry/);
    expect(eventRow("E-SALE-SALE1").status).toBe("failed");
    paypal.subs["I-CL1"].status = "ACTIVE";
    await events.processEvent(sale("I-CL1"), "t");
    expect(profile().plan).toBe("software");
  });
});

describe("Test 8: a failure is recorded, retried and recoverable", () => {
  it("records a failed grant, then succeeds when PayPal redelivers", async () => {
    sub("I-CL1");
    db.failNext("profiles", "update");
    await expect(events.processEvent(activated("I-CL1", "E-1"), "t")).rejects.toThrow();
    expect(eventRow("E-1")).toMatchObject({ status: "failed" });
    expect(eventRow("E-1").detail).toMatch(/database failure/);
    expect(profile().plan).toBeNull();

    await events.processEvent(activated("I-CL1", "E-1"), "t");
    expect(eventRow("E-1")).toMatchObject({ status: "processed", attempts: 2 });
    expect(profile().plan).toBe("software");
  });

  it("does not acknowledge an event it could not record", async () => {
    sub("I-CL1");
    db.failNext("payment_events", "upsert");
    await expect(events.processEvent(activated("I-CL1"), "t")).rejects.toThrow();
    expect(profile().plan).toBeNull();
  });

  it("retries a paying customer whose profile row does not exist yet", async () => {
    db.tables.profiles.length = 0;
    sub("I-CL1");
    await expect(events.processEvent(activated("I-CL1", "E-1"), "t")).rejects.toThrow(/No profile row/);
    db.tables.profiles.push({ id: USER, plan: null, status: null, paypal_subscription_id: null });
    await events.processEvent(activated("I-CL1", "E-1"), "t");
    expect(profile().plan).toBe("software");
  });

  it("lets repair apply a payment the webhook never delivered", async () => {
    const s = sub("I-CL1");
    const out = await access.applyGrant(await access.fetchSubscription("I-CL1", "t"), "t");
    expect(out).toMatchObject({ kind: "granted", planKey: "software" });
    expect(s.id).toBe("I-CL1");
    expect(profile().plan).toBe("software");
  });
});

describe("Test 9: no verified payment, no access", () => {
  it("does not grant an active subscription with no payment", async () => {
    sub("I-CL1", SOFTWARE, { billing_info: {} });
    const out = await access.applyGrant(paypal.subs["I-CL1"], "t");
    expect(out.kind).toBe("waiting");
    expect(profile().plan).toBeNull();
  });

  it("does not grant a subscription the buyer never approved", async () => {
    sub("I-CL1", SOFTWARE, { status: "APPROVAL_PENDING", billing_info: {} });
    expect((await access.applyGrant(paypal.subs["I-CL1"], "t")).kind).toBe("waiting");
    expect(profile().plan).toBeNull();
  });

  it("does not grant a plan we do not sell, and flags it", async () => {
    sub("I-CL1", "P-NOT-OURS");
    const out = await events.processEvent(activated("I-CL1"), "t");
    expect(out.status).toBe("needs_review");
    expect(profile().plan).toBeNull();
  });

  it("does not grant a subscription that names no valid user", async () => {
    sub("I-CL1", SOFTWARE, { custom_id: "not-a-user" });
    expect((await access.applyGrant(paypal.subs["I-CL1"], "t")).kind).toBe("refused");
  });

  it("treats a failed payment as no change", async () => {
    sub("I-CL1");
    await events.processEvent(activated("I-CL1"), "t");
    await events.processEvent({ id: "E-F", event_type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED", resource: { id: "I-CL1", custom_id: USER } }, "t");
    expect(eventRow("E-F").status).toBe("processed");
    expect(profile().plan).toBe("software");
  });
});

describe("Test 10: cancellations, refunds and chargebacks follow the agreed policy", () => {
  const paidCustomer = async () => {
    sub("I-CL1");
    await events.processEvent(sale("I-CL1", "SALE1"), "t");
    expect(profile().plan).toBe("software");
  };

  it("ends access when the subscription on file is cancelled", async () => {
    await paidCustomer();
    await events.processEvent({ id: "E-C", event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: "I-CL1", custom_id: USER } }, "t");
    expect(profile()).toMatchObject({ plan: null, status: "canceled" });
  });

  it("ignores the cancellation of a subscription that no longer grants access", async () => {
    await paidCustomer();
    await events.processEvent({ id: "E-C", event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: "I-OLD", custom_id: USER } }, "t");
    expect(profile().plan).toBe("software");
  });

  it("keeps access through a suspension, then restores active", async () => {
    await paidCustomer();
    await events.processEvent({ id: "E-S", event_type: "BILLING.SUBSCRIPTION.SUSPENDED", resource: { id: "I-CL1", custom_id: USER } }, "t");
    expect(profile()).toMatchObject({ plan: "software", status: "suspended" });
    await events.processEvent({ id: "E-R", event_type: "BILLING.SUBSCRIPTION.RE-ACTIVATED", resource: { id: "I-CL1", custom_id: USER } }, "t");
    expect(profile()).toMatchObject({ plan: "software", status: "active" });
  });

  it("records a subscription refund and flags it, leaving access alone", async () => {
    await paidCustomer();
    const out = await events.processEvent({ id: "E-RF", event_type: "PAYMENT.SALE.REFUNDED", resource: { id: "R1", sale_id: "SALE1", amount: { total: "-99.00", currency: "USD" } } }, "t");
    expect(out.status).toBe("needs_review");
    expect(eventRow("E-RF")).toMatchObject({ user_id: USER, subscription_id: "I-CL1" });
    expect(profile().plan).toBe("software");
  });

  it("puts access on hold at once for a chargeback, and flags it", async () => {
    await paidCustomer();
    await events.processEvent({ id: "E-RV", event_type: "PAYMENT.SALE.REVERSED", resource: { id: "R2", sale_id: "SALE1" } }, "t");
    expect(profile()).toMatchObject({ plan: null, status: "disputed", paypal_subscription_id: "I-CL1" });
    expect(eventRow("E-RV").status).toBe("needs_review");
  });

  it("does not let a renewal lift a chargeback hold", async () => {
    await paidCustomer();
    await events.processEvent({ id: "E-RV", event_type: "PAYMENT.SALE.REVERSED", resource: { id: "R2", sale_id: "SALE1" } }, "t");
    await events.processEvent(sale("I-CL1", "SALE2"), "t");
    expect(profile()).toMatchObject({ plan: null, status: "disputed" });
  });

  it("restores access when the chargeback is won, and not when it is lost", async () => {
    await paidCustomer();
    const dispute = { disputed_transactions: [{ seller_transaction_id: "SALE1" }], dispute_channel: "EXTERNAL" };
    await events.processEvent({ id: "E-D1", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "D1", ...dispute } }, "t");
    expect(profile().status).toBe("disputed");
    await events.processEvent({ id: "E-D2", event_type: "CUSTOMER.DISPUTE.RESOLVED", resource: { dispute_id: "D1", ...dispute, dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" } } }, "t");
    expect(profile().plan).toBeNull();
    await events.processEvent({ id: "E-D3", event_type: "CUSTOMER.DISPUTE.RESOLVED", resource: { dispute_id: "D1", ...dispute, dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" } } }, "t");
    expect(profile()).toMatchObject({ plan: "software", status: "active" });
  });

  it("leaves access alone for a buyer's own inquiry, but flags it", async () => {
    await paidCustomer();
    const out = await events.processEvent({ id: "E-I", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "D2", dispute_life_cycle_stage: "INQUIRY", dispute_channel: "INTERNAL", disputed_transactions: [{ seller_transaction_id: "SALE1" }] } }, "t");
    expect(out.status).toBe("needs_review");
    expect(profile().plan).toBe("software");
  });

  it("marks a fully refunded Diagnostic refunded, and only flags a part refund", async () => {
    db.tables.diagnostic_orders.push({ id: "o1", paypal_order_id: "ORDER1", paypal_capture_id: "CAP1", status: "completed", user_id: USER, amount_usd: 750 });
    const part = await events.processEvent({ id: "E-P", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "R3", amount: { value: "100.00", currency_code: "USD" }, links: [{ rel: "up", href: "https://paypal.test/v2/payments/captures/CAP1" }] } }, "t");
    expect(part.status).toBe("needs_review");
    expect(db.tables.diagnostic_orders[0].status).toBe("completed");
    await events.processEvent({ id: "E-W", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "R4", amount: { value: "750.00", currency_code: "USD" }, links: [{ rel: "up", href: "https://paypal.test/v2/payments/captures/CAP1" }] } }, "t");
    expect(db.tables.diagnostic_orders[0].status).toBe("refunded");
  });

  it("moves a Diagnostic with a chargeback to review", async () => {
    db.tables.diagnostic_orders.push({ id: "o1", paypal_order_id: "ORDER1", paypal_capture_id: "CAP1", status: "completed", user_id: USER, amount_usd: 750 });
    await events.processEvent({ id: "E-X", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: "R5", links: [{ rel: "up", href: "https://paypal.test/v2/payments/captures/CAP1" }] } }, "t");
    expect(db.tables.diagnostic_orders[0].status).toBe("review");
  });

  it("flags money it cannot match rather than dropping it", async () => {
    const out = await events.processEvent({ id: "E-U", event_type: "PAYMENT.SALE.REFUNDED", resource: { id: "R6", sale_id: "UNKNOWN" } }, "t");
    expect(out.status).toBe("needs_review");
  });
});

describe("upgrades still replace the older subscription", () => {
  it("moves to the newer plan and cancels the old one", async () => {
    sub("I-CL1");
    await events.processEvent(activated("I-CL1"), "t");
    sub("I-AD1", ADVISORY, { create_time: "2026-12-01T00:00:00Z" });
    await events.processEvent(activated("I-AD1"), "t");
    expect(profile()).toMatchObject({ plan: "advisory", paypal_subscription_id: "I-AD1" });
    expect(paypal.cancelled).toEqual(["I-CL1"]);
  });
});
