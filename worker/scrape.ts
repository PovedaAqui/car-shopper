/**
 * Scraping stage (plan §4 stage 1).
 *
 * Production scraping of coches.net is intentionally OUT of this build (ToS,
 * and the reference workflow was a one-off manual session). The stage is
 * served from fixtures mirroring the real 2026-08-26 session (20 Toyota
 * Yaris ≤ 5.000 €, Zaragoza/Barcelona). The adapter interface is kept so a
 * real scraper (Firecrawl or Playwright-based `__INITIAL_PROPS__` extraction)
 * can be plugged in behind the same `ScrapeSource` contract.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface RawListing {
  source: string;
  adId: string;
  sourceUrl: string;
  title: string;
  price: number;
  km: number;
  year?: number | null;
  fuel?: string | null;
  city?: string | null;
  hasWarranty: boolean;
  isPro: boolean;
  photoCount: number;
  photoUrls: string[];
  dataQualityFlag: "ok" | "corrupt" | "duplicate";
  duplicateOfAdId?: string | null;
  fetchedAt: number;
}

export interface ScrapeSource {
  name: string;
  scrape(criteria: ScrapeCriteria): Promise<RawListing[]>;
}

export interface ScrapeCriteria {
  make: string;
  model: string;
  maxPrice: number;
  region: string;
  maxKm?: number;
}

/** Fixture-backed source (the only one shipped in this build). */
export class FixtureSource implements ScrapeSource {
  name = "fixtures";
  constructor(private fixturePath: string) {}

  async scrape(criteria: ScrapeCriteria): Promise<RawListing[]> {
    const raw = JSON.parse(readFileSync(this.fixturePath, "utf-8"));
    let listings: RawListing[] = raw.listings;
    // Apply the criteria filters the same way the portal would.
    if (criteria.maxPrice) {
      listings = listings.filter((l) => l.price <= criteria.maxPrice);
    }
    if (criteria.maxKm != null && criteria.maxKm > 0) {
      const maxKm = criteria.maxKm;
      listings = listings.filter((l) => l.km <= maxKm);
    }
    // Region filter is loose: fixtures are Zaragoza/Barcelona only.
    return listings.map((l) => ({ ...l, fetchedAt: Date.now() }));
  }
}

export function defaultSource(): ScrapeSource {
  const here = dirname(fileURLToPath(import.meta.url));
  return new FixtureSource(join(here, "fixtures", "coches_net_yaris_5000.json"));
}

/**
 * Normalization + quality flags + dedup (plan §4 stage 2).
 *
 * Rules from the reference session:
 * - corrupt: km/price implausible (e.g. 370 €/568 km) -> excluded from ranking
 * - duplicate: same km + price + photo-url signature as an already-seen ad
 */
export function normalize(raw: RawListing[]): {
  listings: RawListing[];
  valid: number;
  excluded: number;
} {
  const seen = new Map<string, string>(); // signature -> first adId
  const out: RawListing[] = [];
  let excluded = 0;

  for (const l of raw) {
    let flag: RawListing["dataQualityFlag"] = "ok";
    let dupOf: string | undefined;

    if (l.km < 500 || l.price < 100 || (l.price > 0 && l.km > 0 && l.price / (l.km / 1000) < 0.2)) {
      // Implausible €/km (the 370€/568km lesson).
      flag = "corrupt";
      excluded++;
    } else {
      const sig = `${l.km}|${l.price}|${l.photoUrls.slice(0, 2).join(",")}`;
      const first = seen.get(sig);
      if (first) {
        flag = "duplicate";
        dupOf = first;
        excluded++;
      } else {
        seen.set(sig, l.adId);
      }
    }

    out.push({
      ...l,
      dataQualityFlag: flag,
      duplicateOfAdId: dupOf ?? l.duplicateOfAdId ?? null,
    });
  }

  return { listings: out, valid: out.length - excluded, excluded };
}
