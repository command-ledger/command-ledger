import { describe, it, expect } from "vitest";
import { decideGrant, decideEnd } from "../../supabase/functions/_shared/subscription-entitlement.ts";

// Imports the module paypal-webhook runs, not a copy, so a change to which
// subscription controls access has to get past these first.

const USER = "11111111-1111-1111-1111-111111111111";
const software = { id: "I-SOFTWARE", planKey: "software", createTime: "2026-01-05T10:00:00Z", status: "ACTIVE", customId: USER };
const advisory = { id: "I-ADVISORY", planKey: "advisory", createTime: "2026-03-02T10:00:00Z", status: "ACTIVE", customId: USER };
const live = sub => ({ id: sub.id, status: "ACTIVE", createTime: sub.createTime, customId: sub.customId });

describe("decideGrant", () => {
  it("grants a first subscription and records it", () => {
    expect(decideGrant(software, null, null)).toEqual({ kind: "grant", planKey: "software", subscriptionId: "I-SOFTWARE" });
  });

  it("keeps granting renewals of the subscription on file", () => {
    expect(decideGrant(advisory, "I-ADVISORY", null).kind).toBe("grant");
  });

  it("grants nothing for an unmapped plan", () => {
    expect(decideGrant({ ...software, planKey: undefined }, null, null).kind).toBe("ignore");
  });

  it("moves access to an upgrade and cancels the older subscription", () => {
    const d = decideGrant(advisory, "I-SOFTWARE", live(software));
    expect(d).toEqual({ kind: "grant", planKey: "advisory", subscriptionId: "I-ADVISORY", cancel: "I-SOFTWARE" });
  });

  it("does not let the old subscription's renewal downgrade an upgraded customer, and cancels it", () => {
    const d = decideGrant(software, "I-ADVISORY", live(advisory));
    expect(d.kind).toBe("ignore");
    expect(d.cancel).toBe("I-SOFTWARE");
  });

  it("never cancels the old subscription while the new one is not ACTIVE", () => {
    const d = decideGrant({ ...advisory, status: "SUSPENDED" }, "I-SOFTWARE", live(software));
    expect(d.cancel).toBeUndefined();
    expect(d.duplicateOf).toBe("I-SOFTWARE"); // flagged for a person instead
  });

  it("never cancels a subscription bought for a different user", () => {
    const d = decideGrant(advisory, "I-SOFTWARE", { ...live(software), customId: "22222222-2222-2222-2222-222222222222" });
    expect(d.cancel).toBeUndefined();
    expect(d.duplicateOf).toBe("I-SOFTWARE");
  });

  it("cancels nothing when it cannot tell which subscription is newer", () => {
    const d = decideGrant({ ...advisory, createTime: software.createTime }, "I-SOFTWARE", live(software));
    expect(d.kind).toBe("ignore");
    expect(d.cancel).toBeUndefined();
  });

  it("lets a new subscription replace one that has ended", () => {
    const d = decideGrant(software, "I-ADVISORY", { ...live(advisory), status: "CANCELLED" });
    expect(d).toEqual({ kind: "grant", planKey: "software", subscriptionId: "I-SOFTWARE" });
  });

  it("throws, so PayPal retries, when the subscription on file cannot be read", () => {
    expect(() => decideGrant(advisory, "I-SOFTWARE", null)).toThrow();
  });

  it("never grants a subscription whose age cannot be compared over a live one", () => {
    expect(decideGrant({ ...advisory, createTime: null }, "I-SOFTWARE", live(software)).kind).toBe("ignore");
  });
});

describe("decideEnd", () => {
  it("revokes when the subscription on file is cancelled", () => {
    expect(decideEnd("revoke", "I-ADVISORY", "I-ADVISORY")).toEqual({ kind: "revoke" });
  });

  it("ignores the cancellation of a superseded subscription", () => {
    expect(decideEnd("revoke", "I-SOFTWARE", "I-ADVISORY").kind).toBe("ignore");
    expect(decideEnd("suspend", "I-SOFTWARE", "I-ADVISORY").kind).toBe("ignore");
  });

  it("applies the event to a profile with nothing on file, as before", () => {
    expect(decideEnd("revoke", "I-SOFTWARE", null)).toEqual({ kind: "revoke" });
  });
});
