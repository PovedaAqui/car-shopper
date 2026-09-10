import { describe, expect, it } from "vitest";
import { validateCriteria } from "../convex/criteria_lib.ts";

describe("validateCriteria", () => {
  it("accepts a minimal valid search and trims/normalizes whitespace", () => {
    const r = validateCriteria({ make: "  Toyota  ", model: "Yaris\t", maxPrice: 5000, region: "  Barcelona " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.criteria).toEqual({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Barcelona" });
    }
  });

  it("collapses internal whitespace runs", () => {
    const r = validateCriteria({ make: "Alfa   Romeo", model: "Giulia", maxPrice: 9000, region: "Madrid" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.criteria.make).toBe("Alfa Romeo");
  });

  it("rejects empty required fields with field-specific codes", () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ make: "", model: "Yaris", maxPrice: 5000, region: "Madrid" }, "MAKE_REQUIRED", "make"],
      [{ make: "Toyota", model: "   ", maxPrice: 5000, region: "Madrid" }, "MODEL_REQUIRED", "model"],
      [{ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "" }, "REGION_REQUIRED", "region"],
      [{ make: "Toyota", model: "Yaris", maxPrice: undefined, region: "Madrid" }, "PRICE_REQUIRED", "maxPrice"],
    ];
    for (const [input, code, field] of cases) {
      const r = validateCriteria(input as any);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe(code);
        expect(r.field).toBe(field);
      }
    }
  });

  it("rejects overlong text fields", () => {
    const r1 = validateCriteria({ make: "x".repeat(41), model: "Yaris", maxPrice: 5000, region: "Madrid" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("MAKE_TOO_LONG");

    const r2 = validateCriteria({ make: "Toyota", model: "x".repeat(41), maxPrice: 5000, region: "Madrid" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("MODEL_TOO_LONG");

    const r3 = validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "x".repeat(61) });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.code).toBe("REGION_TOO_LONG");
  });

  it("rejects price outside 100..1_000_000, including NaN/garbage input", () => {
    for (const bad of [99, 1_000_001, Number.NaN, "not-a-number" as any]) {
      const r = validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: bad, region: "Madrid" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("PRICE_OUT_OF_RANGE");
    }
  });

  it("accepts price at the exact boundaries", () => {
    expect(validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 100, region: "Madrid" }).ok).toBe(true);
    expect(validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 1_000_000, region: "Madrid" }).ok).toBe(true);
  });

  it("treats blank optional fields as omitted, not as errors", () => {
    const r = validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Madrid", maxKm: "", minYear: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.criteria.maxKm).toBeUndefined();
      expect(r.criteria.minYear).toBeUndefined();
    }
  });

  it("rejects a non-integer or out-of-range maxKm", () => {
    for (const bad of [-1, 2.5, "abc" as any, 2_000_001]) {
      const r = validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Madrid", maxKm: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("KM_OUT_OF_RANGE");
    }
  });

  it("accepts a valid maxKm and includes it in the normalized criteria", () => {
    const r = validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Madrid", maxKm: 150000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.criteria.maxKm).toBe(150000);
  });

  it("rejects a minYear outside 1980..2030 or non-integer", () => {
    for (const bad of [1979, 2031, 2015.5, "soon" as any]) {
      const r = validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Madrid", minYear: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("YEAR_OUT_OF_RANGE");
    }
  });

  it("accepts minYear at the exact boundaries", () => {
    expect(validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Madrid", minYear: 1980 }).ok).toBe(true);
    expect(validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Madrid", minYear: 2030 }).ok).toBe(true);
  });

  it("rejects a negative or non-integer maxPhotos", () => {
    for (const bad of [-1, 1.5, "many" as any]) {
      const r = validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Madrid", maxPhotos: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("PHOTOS_OUT_OF_RANGE");
    }
  });

  it("accepts maxPhotos of 0 (vision explicitly disabled)", () => {
    const r = validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Madrid", maxPhotos: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.criteria.maxPhotos).toBe(0);
  });

  it("rejects HTML/URL-structural characters in make/model/region (defense against reshaping the coches.net scrape URL, not an injection risk since the report renderer escapes on output)", () => {
    const r1 = validateCriteria({ make: "Toyota/../etc", model: "Yaris", maxPrice: 5000, region: "Madrid" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("MAKE_INVALID_CHARS");

    const r2 = validateCriteria({ make: "Toyota", model: "Yaris?x=1", maxPrice: 5000, region: "Madrid" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("MODEL_INVALID_CHARS");

    const r3 = validateCriteria({ make: "Toyota", model: "Yaris", maxPrice: 5000, region: "<script>alert(1)</script>" });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.code).toBe("REGION_INVALID_CHARS");
  });

  it("accepts legitimate punctuation in make/model (hyphens, apostrophes, periods, accents)", () => {
    const r = validateCriteria({ make: "Citroën", model: "DS 3", region: "L'Aquila", maxPrice: 5000 });
    expect(r.ok).toBe(true);
  });
});
