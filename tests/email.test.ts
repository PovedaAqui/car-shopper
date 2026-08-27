import { describe, expect, it } from "vitest";
import { hashEmail, htmlToText, idempotencyKey, isValidEmail, normalizeEmail } from "../convex/email_lib.ts";

describe("email helpers", () => {
  it("normalizes and validates addresses", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
    expect(isValidEmail("foo@bar.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
  });

  it("hashes the same address the same way regardless of case", () => {
    expect(hashEmail("A@B.com")).toBe(hashEmail("a@b.com"));
    expect(hashEmail("a@b.com")).not.toBe(hashEmail("c@d.com"));
  });

  it("builds an AgentMail-safe idempotency key", () => {
    const key = idempotencyKey("reports123", hashEmail("a@b.com"));
    expect(key).toMatch(/^report-reports123-to-[0-9a-f]+$/);
    expect(key.length).toBeLessThanOrEqual(256);
    expect(key).not.toContain("@");
  });

  it("turns report HTML into a plain-text alternative without tags", () => {
    const text = htmlToText("<h1>Yaris</h1><p>Score <b>17</b></p><script>alert(1)</script>");
    expect(text).toContain("Yaris");
    expect(text).toContain("Score 17");
    expect(text).not.toContain("<");
    expect(text).not.toContain("alert");
  });
});
