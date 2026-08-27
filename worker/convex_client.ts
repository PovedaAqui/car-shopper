/**
 * Convex client for the local worker.
 *
 * Talks to the deployment over HTTP:
 *  - public mutations/queries: POST {CONVEX_URL}/api/{module}.{fn}
 *  - worker endpoints:         POST {CONVEX_SITE_URL}/worker/*
 *    (CONVEX_SITE_URL is the static/site proxy; for self-hosted it is the
 *    site-proxy port. Falls back to CONVEX_URL when only one is configured.)
 */

import { readFileSync } from "node:fs";
import type { RawListing } from "./scrape.ts";
import type { VisionResult } from "./vision.ts";
import type { ConsensusRow } from "./consensus.ts";

export interface WorkerConfig {
  convexUrl: string;
  siteUrl?: string;
  apiBase: string;
  apiKey: string;
  workerId: string;
  useDevHeader: boolean;
}

export interface ClaimedJob {
  jobId: string;
  token: string;
  criteria: {
    make: string;
    model: string;
    maxPrice: number;
    region: string;
    maxKm?: number;
  };
  requestId?: string;
}

export interface JobSnapshot {
  listings: RawListing[];
  scores: Array<{ adId: string; scorerVersion: string }>;
  visionPrimary: VisionResult[];
  visionReverify: VisionResult[];
  consensus: ConsensusRow[];
  hasReport: boolean;
}

export function loadWorkerConfig(): WorkerConfig {
  // .env.local is gitignored and holds local self-hosted credentials.
  const envFile = new URL("../.env.local", import.meta.url);
  let env: Record<string, string> = {};
  try {
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    /* no .env.local */
  }
  const pick = (name: string, fallback?: string): string | undefined =>
    process.env[name] ?? env[name] ?? fallback;

  const convexUrl = (pick("CONVEX_URL") ?? "http://127.0.0.1:3210").replace(/\/$/, "");
  const configuredSiteUrl = pick("CONVEX_SITE_URL");
  const siteUrl = (configuredSiteUrl ?? deriveSiteUrl(convexUrl)).replace(/\/$/, "");
  // The app HTTP router in convex/http.ts is mounted under /api (see
  // convex/convex.config.ts, where static hosting owns the root).
  const apiBase = (pick("WORKER_API_BASE") ?? `${siteUrl}/api`).replace(/\/$/, "");
  // A deployment key in .env.local may belong to a different Convex
  // deployment. Self-hosted Convex intentionally supports the dev header;
  // only an explicitly exported shell key should override that local mode.
  const isLocalBackend = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(convexUrl);
  const apiKey = isLocalBackend
    ? (process.env.WORKER_API_KEY ?? "")
    : (pick("WORKER_API_KEY") ?? "");
  const useDevHeader = !apiKey;

  return { convexUrl, siteUrl, apiBase, apiKey, workerId: `worker-${process.pid}`, useDevHeader };
}

function deriveSiteUrl(convexUrl: string): string {
  if (convexUrl.endsWith(":3210")) return `${convexUrl.slice(0, -5)}:3211`;
  if (convexUrl.endsWith(".convex.cloud")) return convexUrl.replace(/\.convex\.cloud$/, ".convex.site");
  return convexUrl;
}

function authHeaders(cfg: WorkerConfig, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    ...(cfg.apiKey ? { "x-worker-key": cfg.apiKey } : { "x-worker-mode": "dev" }),
  };
}

async function parseJsonResponse(url: string, res: Response): Promise<any> {
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`worker endpoint ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`worker endpoint ${url} -> HTTP ${res.status}: ${data?.error ?? text.slice(0, 300)}`);
  }
  return data;
}

async function post(url: string, body: unknown, cfg: WorkerConfig): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(cfg, "application/json"),
    body: JSON.stringify(body),
  });
  return parseJsonResponse(url, res);
}

function unwrap(data: any): any {
  return data?.result !== undefined ? data.result : data;
}

/** Claim the next queued job. Returns null when the queue is empty. */
export async function claimJob(cfg: WorkerConfig): Promise<ClaimedJob | null> {
  const data = await post(`${cfg.apiBase}/worker/claim`, { workerId: cfg.workerId }, cfg);
  const result = unwrap(data);
  if (!result || !result.jobId) return null;
  return result as ClaimedJob;
}

export function updateStage(
  cfg: WorkerConfig,
  jobId: string,
  token: string,
  stage: string,
  progress: number,
  counts?: Record<string, number>
) {
  return post(`${cfg.apiBase}/worker/stage`, { jobId, workerToken: token, stage, progress, ...(counts ? { counts } : {}) }, cfg);
}

export function failJob(cfg: WorkerConfig, jobId: string, token: string, errorCode: string, errorMsg: string) {
  return post(`${cfg.apiBase}/worker/fail`, { jobId, workerToken: token, errorCode, errorMsg }, cfg);
}

export function insertListings(cfg: WorkerConfig, jobId: string, token: string, listings: unknown[]) {
  return post(`${cfg.apiBase}/worker/listings`, { jobId, workerToken: token, listings }, cfg);
}

export function insertScores(cfg: WorkerConfig, jobId: string, token: string, scores: unknown[]) {
  return post(`${cfg.apiBase}/worker/scores`, { jobId, workerToken: token, scores }, cfg);
}

export function insertVisionResults(cfg: WorkerConfig, jobId: string, token: string, results: unknown[]) {
  return post(`${cfg.apiBase}/worker/vision`, { jobId, workerToken: token, results }, cfg);
}

export function insertConsensus(cfg: WorkerConfig, jobId: string, token: string, rows: unknown[]) {
  return post(`${cfg.apiBase}/worker/consensus`, { jobId, workerToken: token, rows }, cfg);
}

/** Store the report HTML as raw text (not JSON-encoded) and register the report. */
export async function submitReport(
  cfg: WorkerConfig,
  jobId: string,
  token: string,
  html: string,
  reportVersion: string,
  listingCount: number
) {
  const upRes = await fetch(`${cfg.apiBase}/worker/report_upload`, {
    method: "POST",
    headers: authHeaders(cfg, "text/html; charset=utf-8"),
    body: html,
  });
  const up = await parseJsonResponse(`${cfg.apiBase}/worker/report_upload`, upRes);
  const storageId = up.storageId ?? unwrap(up)?.storageId;
  if (!storageId) throw new Error("report_upload did not return a storageId");
  await post(
    `${cfg.apiBase}/worker/report`,
    { jobId, workerToken: token, htmlStorageId: storageId, reportVersion, listingCount },
    cfg
  );
}

export async function getJobSnapshot(cfg: WorkerConfig, jobId: string, token: string): Promise<JobSnapshot> {
  const data = await post(`${cfg.apiBase}/worker/snapshot`, { jobId, workerToken: token }, cfg);
  const result = unwrap(data) ?? {};
  return {
    listings: result.listings ?? [],
    scores: result.scores ?? [],
    visionPrimary: result.visionPrimary ?? [],
    visionReverify: result.visionReverify ?? [],
    consensus: result.consensus ?? [],
    hasReport: Boolean(result.hasReport),
  };
}

/** Public read for tests / verification (no auth required for owned views). */
export async function queryJob(cfg: WorkerConfig, jobId: string, userId: string) {
  const res = await fetch(`${cfg.convexUrl}/api/api.watchJob`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId, userId }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`watchJob -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
