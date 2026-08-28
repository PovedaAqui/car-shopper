import { describe, expect, it } from "vitest";
import { isCorruptListing, normalize, type RawListing } from "../worker/scrape.ts";

/** Synthetic rows that mimic real coches.net cards (no fixed inputs). */
function listing(over: Partial<RawListing> & Pick<RawListing, "adId" | "price" | "km">): RawListing {
  return {
    source: "firecrawl",
    adId: over.adId,
    sourceUrl: `https://www.coches.net/x-${over.adId}.aspx`,
    title: `Ad ${over.adId}`,
    price: over.price,
    km: over.km,
    year: over.year ?? 2015,
    fuel: over.fuel ?? "Gasolina",
    city: over.city ?? "Barcelona",
    hasWarranty: over.hasWarranty ?? false,
    isPro: over.isPro ?? false,
    photoCount: over.photoCount ?? 1,
    photoUrls: over.photoUrls ?? [`https://a.ccdn.es/cnet/vehicles/${over.adId}/560x421cut/`],
    dataQualityFlag: over.dataQualityFlag ?? "ok",
    fetchedAt: over.fetchedAt ?? 1,
  };
}

describe("isCorruptListing", () => {
  it("rejects implausible used-car rows (the 370€ / 568km lesson)", () => {
    expect(isCorruptListing({ price: 370, km: 568 })).toBe(true);
    expect(isCorruptListing({ price: 90, km: 50000 })).toBe(true); // <100 €
    expect(isCorruptListing({ price: 4000, km: 500 })).toBe(true); // <1000 km
    expect(isCorruptListing({ price: 4000, km: 120000 })).toBe(false);
  });
});

describe("normalize", () => {
  it("flags corrupt rows and dedupes by km+price+year+city", () => {
    const rows = [
      listing({ adId: "70000001", price: 4500, km: 110000, year: 2014 }),
      listing({ adId: "70000002", price: 370, km: 568, year: 2014 }), // corrupt
      // Same signature as 70000001 (km+price+year+city) -> duplicate.
      listing({ adId: "70000003", price: 4500, km: 110000, year: 2014 }),
      // Same km/price but different city -> not a duplicate.
      listing({ adId: "70000004", price: 4500, km: 110000, year: 2014, city: "Madrid" }),
    ];
    const { listings, valid, excluded } = normalize(rows);
    expect(listings.find((l) => l.adId === "70000002")?.dataQualityFlag).toBe("corrupt");
    expect(listings.find((l) => l.adId === "70000003")?.dataQualityFlag).toBe("duplicate");
    expect(listings.find((l) => l.adId === "70000003")?.duplicateOfAdId).toBe("70000001");
    expect(listings.find((l) => l.adId === "70000004")?.dataQualityFlag).toBe("ok");
    expect(valid).toBe(2);
    expect(excluded).toBe(2);
  });

  it("keeps every plausible row when nothing is corrupt or duplicated", () => {
    const rows = [
      listing({ adId: "70000011", price: 4900, km: 90000, year: 2019 }),
      listing({ adId: "70000012", price: 3800, km: 150000, year: 2013 }),
      listing({ adId: "70000013", price: 4200, km: 70000, year: 2017 }),
    ];
    expect(normalize(rows).valid).toBe(3);
  });
});
