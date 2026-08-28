/**
 * Scraping stage (plan §4 stage 1).
 *
 * Fixtures remain the default because production scraping of coches.net has
 * ToS and rate-limit implications. A real Firecrawl-backed source is available
 * as an explicit opt-in with USE_FIRECRAWL=1 and FIRECRAWL_API_KEY.
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
  /** Photos per ad to analyze: 0 = vision deactivated, >=1 = cap, undefined = all. */
  maxPhotos?: number;
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

/**
 * Firecrawl search adapter. Firecrawl returns search results with markdown;
 * the parser extracts only fields that are actually present and leaves
 * incomplete rows for the normalizer to reject. No fixture data is mixed in.
 */
export class FirecrawlSource implements ScrapeSource {
  name = "firecrawl";
  constructor(private apiKey: string, private endpoint = "https://api.firecrawl.dev/v1") {}

  async scrape(criteria: ScrapeCriteria): Promise<RawListing[]> {
    const query = `${criteria.make} ${criteria.model} coches.net ${criteria.region}`;
    const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query, limit: 20, scrapeOptions: { formats: ["markdown"] } }),
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`FIRECRAWL_HTTP_${response.status}: ${payload?.error ?? "search failed"}`);
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.results) ? payload.results : [];
    const fetchedAt = Date.now();
    return rows
      .map((row: any, index: number) => {
        const url = String(row?.url ?? row?.link ?? "");
        const text = `${row?.title ?? ""}\n${row?.description ?? ""}\n${row?.markdown ?? ""}`;
        if (!url || !text) return null;
        const price = firstNumber(text, /(\d[\d.\s]*)\s*(?:€|eur|euros?)/i);
        const km = firstNumber(text, /(\d[\d.\s]*)\s*(?:km|kms|kil[oó]metros?)/i);
        const year = firstNumber(text, /\b(20\d{2}|19\d{2})\b/);
        const photoUrls = [...text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)].map((m) => m[1]);
        return {
          source: "firecrawl",
          adId: adIdFromUrl(url, index),
          sourceUrl: url,
          title: String(row?.title ?? `${criteria.make} ${criteria.model}`),
          price,
          km,
          year: year || null,
          city: criteria.region,
          hasWarranty: /garant[ií]a|warranty/i.test(text),
          isPro: /profesional|concesionario|dealer/i.test(text),
          photoCount: photoUrls.length,
          photoUrls,
          dataQualityFlag: "ok" as const,
          fetchedAt,
        } satisfies RawListing;
      })
      .filter((row: RawListing | null): row is RawListing => row !== null);
  }
}

function firstNumber(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  if (!match) return 0;
  const normalized = match[1].replace(/[.\s]/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

function adIdFromUrl(url: string, fallback: number): string {
  const match = url.match(/-(\d{6,})(?:-[^/]+)?\.(?:aspx|html?)?$/i) ?? url.match(/(\d{6,})/);
  return match?.[1] ?? `firecrawl-${fallback + 1}`;
}

export function defaultSource(): ScrapeSource {
  const here = dirname(fileURLToPath(import.meta.url));
  if (process.env.USE_FIRECRAWL === "1") {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error("FIRECRAWL_NOT_CONFIGURED: set FIRECRAWL_API_KEY");
    return new FirecrawlSource(apiKey, process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v1");
  }
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

    if (isCorruptListing(l)) {
      // Used-car listings with implausible mileage/price (lesson: 370 € / 568 km).
      flag = "corrupt";
      excluded++;
    } else {
      // Dedup by km+price+year+city. Photo URLs are NOT required — the
      // 71108396/71108671 pair shares km+price but has different CDN photos.
      const sig = `${l.km}|${l.price}|${l.year ?? ""}|${(l.city ?? "").toLowerCase()}`;
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

/** Cheap used-car listings with <1000 km or <100 € are treated as corrupt. */
export function isCorruptListing(l: Pick<RawListing, "km" | "price">): boolean {
  if (l.price < 100) return true;
  if (l.km < 1000) return true;
  if (l.price > 0 && l.km > 0 && l.price / (l.km / 1000) < 0.2) return true;
  return false;
}
