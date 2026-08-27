import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCorruptListing, normalize, type RawListing } from "../worker/scrape.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../worker/fixtures/coches_net_yaris_5000.json"), "utf-8")
) as { listings: RawListing[] };

describe("normalize", () => {
  it("flags the 370€ / 568km listing as corrupt", () => {
    expect(isCorruptListing({ price: 370, km: 568 })).toBe(true);
    const { listings } = normalize(fixture.listings);
    const hit = listings.find((l) => l.adId === "71122244");
    expect(hit?.dataQualityFlag).toBe("corrupt");
  });

  it("flags 71108396/71108671 as duplicates by km+price+year+city", () => {
    const { listings, excluded } = normalize(fixture.listings);
    const a = listings.find((l) => l.adId === "71108396");
    const b = listings.find((l) => l.adId === "71108671");
    expect(a?.dataQualityFlag).toBe("ok");
    expect(b?.dataQualityFlag).toBe("duplicate");
    expect(b?.duplicateOfAdId).toBe("71108396");
    expect(excluded).toBeGreaterThanOrEqual(2);
  });

  it("keeps valid used cars in the ranking set", () => {
    const { valid } = normalize(fixture.listings);
    expect(valid).toBe(18);
  });
});
