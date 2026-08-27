import { describe, expect, it } from "vitest";
import { scoreAll, visualDelta, SCORER_VERSION, type ListingInput } from "../worker/scoring.ts";

const base: ListingInput = {
  adId: "a1",
  price: 4000,
  km: 120000,
  year: 2012,
  hasWarranty: true,
  isPro: true,
  dataQualityFlag: "ok",
};

describe("scoring", () => {
  it("is deterministic and versioned", () => {
    expect(SCORER_VERSION).toMatch(/^score-/);
    const a = scoreAll([base], new Map());
    const b = scoreAll([base], new Map());
    expect(a[0].final).toBe(b[0].final);
    expect(a[0].included).toBe(true);
    expect(a[0].rank).toBe(1);
  });

  it("excludes corrupt and duplicate listings", () => {
    const rows = scoreAll(
      [
        { ...base, adId: "ok" },
        { ...base, adId: "bad", dataQualityFlag: "corrupt" },
        { ...base, adId: "dup", dataQualityFlag: "duplicate", duplicateOfAdId: "ok" },
      ],
      new Map()
    );
    expect(rows.find((r) => r.adId === "ok")?.included).toBe(true);
    expect(rows.find((r) => r.adId === "bad")?.included).toBe(false);
    expect(rows.find((r) => r.adId === "dup")?.included).toBe(false);
  });

  it("applies the fixed visual delta table", () => {
    expect(visualDelta({ resolvedExterior: "regular", interiorGood: false, suspectStock: false, noPhotos: false }).visDelta).toBe(-6);
    expect(visualDelta({ resolvedExterior: "bien", interiorGood: true, suspectStock: false, noPhotos: false }).visDelta).toBe(6);
    expect(visualDelta({ resolvedExterior: "bien", interiorGood: false, suspectStock: true, noPhotos: false }).visDelta).toBe(-38);
    expect(visualDelta({ resolvedExterior: "no_evaluable", interiorGood: false, suspectStock: false, noPhotos: true }).visDelta).toBe(-7);
  });
});
