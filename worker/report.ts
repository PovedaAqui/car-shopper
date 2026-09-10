/**
 * HTML report renderer (plan §4 stage 8).
 *
 * Pure template — every cell traces to stored normalized data, scores and
 * vision results (criterion: 0 invented findings). Escapes all external
 * content. No remote scripts; thumbnails hotlink to the portal CDN with an
 * `onerror` placeholder fallback (plan §13 risk: expiring CDN URLs).
 *
 * Language: English (default). Internal state values (bien/regular/mal/
 * no_evaluable, etc.) are the pipeline's fixed vocabulary — see
 * scoring.ts/consensus.ts/vision.ts — and are translated to English display
 * labels here at render time.
 */

import type { RawListing } from "./scrape.ts";
import type { ScoreRow } from "./scoring.ts";
import type { VisionResult } from "./vision.ts";
import type { ConsensusRow } from "./consensus.ts";

export interface ReportInput {
  criteria: { make: string; model: string; maxPrice: number; region: string; maxKm?: number };
  listings: RawListing[];
  scores: ScoreRow[];
  visionPrimary: VisionResult[];
  consensus: ConsensusRow[];
  providerLabel: string;
  /** "source: ..." label for the report meta line. */
  sourceLabel?: string;
  generatedAt: number;
  jobStage: string;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function badge(cls: string, text: string): string {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

const stateClass: Record<string, string> = {
  bien: "b-good",
  regular: "b-warn",
  mal: "b-bad",
  no_evaluable: "b-muted",
};

/** English display labels for the pipeline's internal exterior/interior/cleanliness states. */
const EXTERIOR_LABEL: Record<string, string> = {
  bien: "good",
  regular: "fair",
  mal: "poor",
  no_evaluable: "not evaluable",
};

const CLEANLINESS_LABEL: Record<string, string> = {
  limpio: "clean",
  regular: "fair",
  descuidado: "neglected",
  no_evaluable: "not evaluable",
};

const CONSENSUS_LABEL: Record<string, string> = {
  consenso: "consensus",
  discrepancia: "discrepancy",
  no_evaluable: "not evaluable",
};

export function renderReportHTML(input: ReportInput): string {
  const { criteria, listings, scores, visionPrimary, consensus, providerLabel } = input;
  const byAd = new Map(listings.map((l) => [l.adId, l]));
  const visionByAd = new Map(visionPrimary.map((v) => [v.adId, v]));
  const consensusByAd = new Map(consensus.map((c) => [c.adId, c]));
  const ranked = scores.filter((s) => s.included).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const excluded = scores.filter((s) => !s.included);

  const rows = ranked
    .map((s) => {
      const l = byAd.get(s.adId)!;
      const v = visionByAd.get(s.adId);
      const c = consensusByAd.get(s.adId);
      const photo = l.photoUrls[0];
      const photoHtml = photo
        ? `<img class="thumb" loading="lazy" src="${esc(photo)}" alt="thumbnail ${esc(l.adId)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="thumb-ph" style="display:none">${esc(s.adId)}</span>`
        : `<span class="thumb thumb-none">no photos</span>`;
      const vBadges = v
        ? [
            badge(stateClass[v.exteriorState], `exterior: ${EXTERIOR_LABEL[v.exteriorState] ?? v.exteriorState}`),
            v.color ? badge("b-info", esc(v.color)) : "",
            v.cleanliness !== "no_evaluable" ? badge("b-info", `cleanliness: ${CLEANLINESS_LABEL[v.cleanliness] ?? v.cleanliness}`) : "",
          ]
            .filter(Boolean)
            .join(" ")
        : "";
      const cBadge = c
        ? c.badge === "discrepancia"
          ? badge("b-bad", "⚠ discrepancy")
          : c.badge === "consenso"
            ? badge("b-good", "consensus")
            : badge("b-muted", "not evaluable")
        : "";
      const redFlags = v && v.redFlags.length > 0 ? `<div class="flags">${v.redFlags.map((f) => `· ${esc(f)}`).join("<br>")}</div>` : "";
      return `<tr>
        <td class="rank">${s.rank}</td>
        <td>${photoHtml}</td>
        <td class="title"><a href="${esc(l.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(l.title)}</a><div class="sub">${esc(l.city ?? "—")} · ${l.year ?? "year n/a"} · ${esc(l.fuel ?? "—")}</div></td>
        <td class="num">€ ${s.pricePerKm.toFixed(2)}/km</td>
        <td class="num">€${Number(l.price).toLocaleString("en-GB")}</td>
        <td class="num">${(l.km / 1000).toFixed(0)}k km</td>
        <td class="score">${s.final.toFixed(1)}${s.visDelta !== 0 ? `<span class="delta ${s.visDelta > 0 ? "pos" : "neg"}">(${s.visDelta > 0 ? "+" : ""}${s.visDelta})</span>` : ""}</td>
        <td class="vision">${vBadges} ${cBadge}${redFlags}</td>
      </tr>`;
    })
    .join("\n");

  const excludedHtml = excluded.length
    ? `<section><h2>Excluded from ranking (${excluded.length})</h2><table class="tbl"><thead><tr><th>Ad</th><th>Title</th><th>Reason</th></tr></thead><tbody>${excluded
        .map((s) => {
          const l = byAd.get(s.adId);
          return `<tr><td>${esc(s.adId)}</td><td>${esc(l?.title ?? "—")}</td><td>${esc(s.exclusionReason ?? "—")}</td></tr>`;
        })
        .join("")}</tbody></table></section>`
    : "";

  const nPhotos = visionPrimary.reduce((acc, v) => acc + (v.photosAnalyzed || 0), 0);
  const nEvaluable = visionPrimary.filter((v) => v.exteriorState !== "no_evaluable").length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Car Shopper — ${esc(criteria.make)} ${esc(criteria.model)} ≤ €${esc(criteria.maxPrice)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; line-height: 1.45; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .meta { color: #888; font-size: .9rem; margin-bottom: 16px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 20px; }
  .stat { border: 1px solid #ccc4; border-radius: 10px; padding: 10px 14px; min-width: 140px; }
  .stat b { display: block; font-size: 1.3rem; }
  .stat span { font-size: .8rem; color: #888; }
  table.tbl { width: 100%; border-collapse: collapse; font-size: .92rem; }
  .tbl th, .tbl td { padding: 8px 10px; border-bottom: 1px solid #ccc4; text-align: left; vertical-align: top; }
  .tbl th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  .rank { font-weight: 700; font-size: 1.1rem; width: 34px; }
  .thumb { width: 74px; height: 56px; object-fit: cover; border-radius: 8px; display: block; }
  .thumb-ph { width: 74px; height: 56px; border-radius: 8px; background: #ccc3; align-items: center; justify-content: center; font-size: .7rem; color: #888; }
  .thumb-none { width: 74px; height: 56px; border-radius: 8px; background: #ccc3; display: flex; align-items: center; justify-content: center; font-size: .7rem; color: #888; }
  .title .sub { font-size: .78rem; color: #888; }
  .title a { color: inherit; text-decoration: none; font-weight: 600; }
  .title a:hover { text-decoration: underline; }
  .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .score { font-weight: 600; }
  .delta { font-size: .75rem; } .delta.pos { color: #16a34a; } .delta.neg { color: #dc2626; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: .72rem; margin-right: 4px; white-space: nowrap; }
  .b-good { background: #dcfce7; color: #166534; } .b-warn { background: #fef9c3; color: #854d0e; }
  .b-bad { background: #fee2e2; color: #991b1b; } .b-muted { background: #e5e5e5; color: #555; }
  .b-info { background: #dbeafe; color: #1e40af; }
  .flags { font-size: .75rem; color: #b45309; margin-top: 4px; }
  .note { font-size: .8rem; color: #888; margin-top: 18px; }
  @media (max-width: 768px) { .tbl .vision { display: none; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(criteria.make)} ${esc(criteria.model)} — value ranking</h1>
  <div class="meta">Max. €${esc(criteria.maxPrice)} · ${esc(criteria.region)}${criteria.maxKm ? ` · ≤ ${esc(criteria.maxKm)} km` : ""} · generated ${esc(new Date(input.generatedAt).toLocaleString("en-GB"))} · source: ${esc(input.sourceLabel ?? "coches.net")} · vision: ${esc(providerLabel)}</div>

  <div class="stats">
    <div class="stat"><b>${ranked.length}</b><span>cars ranked</span></div>
    <div class="stat"><b>${excluded.length}</b><span>excluded (data)</span></div>
    <div class="stat"><b>${nPhotos}</b><span>photos analyzed</span></div>
    <div class="stat"><b>${nEvaluable}</b><span>exterior evaluable</span></div>
  </div>

  <table class="tbl">
    <thead><tr><th>#</th><th></th><th>Listing</th><th>€/km</th><th>Price</th><th>Km</th><th>Score</th><th>Visual inspection</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  ${excludedHtml}

  <p class="note">Method: score = f(€/km) + bonuses (warranty, professional seller, recent year) − mechanical risk + fixed visual delta (wear −6, no photos −5, suspect stock photos −40, interior looks good +4, exterior good +2 / fair −6 / poor −18 / not evaluable −2). Two independent visual inspection passes, strict rule on disagreement. This report does not replace an in-person mechanical inspection.</p>
</div>
</body>
</html>`;
}
