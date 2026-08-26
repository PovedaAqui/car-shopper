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

export interface WorkerConfig {
  convexUrl: string;
  siteUrl?: string;
  apiBase: string;
  apiKey: string;
  workerId: string;
  useDevHeader: boolean;
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
  const siteUrl = (pick("CONVEX_SITE_URL") ?? convexUrl).replace(/\/$/, "");
  // The app HTTP router is mounted under /api (see convex/convex.config.ts,
  // where the static-hosting component owns the root).
  const apiBase = (pick("WORKER_API_BASE") ?? `${siteUrl}/api`).replace(/\/$/, "");
  const apiKey = pick("WORKER_API_KEY") ?? "";
  const useDevHeader = !apiKey;

  return { convexUrl, siteUrl, apiBase, apiKey, workerId: `worker-${process.pid}`, useDevHeader };
}

async function post(url: string, body: unknown, cfg: WorkerConfig): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.apiKey ? { "x-worker-key": cfg.apiKey } : { "x-worker-mode": "dev" }),
    },
    body: JSON.stringify(body),
  });
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

/** Claim the next queued job. Returns null when the queue is empty. */
export function claimJob(cfg: WorkerConfig) {
  return post(`${cfg.apiBase}/worker/claim`, { workerId: cfg.workerId }, cfg);
}

export function updateStage(cfg: WorkerConfig, jobId: string, stage: string, progress: number, counts?: Record<string, number>) {
  return post(`${cfg.apiBase}/worker/stage`, { jobId, stage, progress, ...(counts ? { counts } : {}) }, cfg);
}

export function failJob(cfg: WorkerConfig, jobId: string, errorCode: string, errorMsg: string) {
  return post(`${cfg.apiBase}/worker/fail`, { jobId, errorCode, errorMsg }, cfg);
}

export function insertListings(cfg: WorkerConfig, jobId: string, listings: unknown[]) {
  return post(`${cfg.apiBase}/worker/listings`, { jobId, listings }, cfg);
}

export function insertScores(cfg: WorkerConfig, jobId: string, scores: unknown[]) {
  return post(`${cfg.apiBase}/worker/scores`, { jobId, scores }, cfg);
}

export function insertVisionResults(cfg: WorkerConfig, jobId: string, results: unknown[]) {
  return post(`${cfg.apiBase}/worker/vision`, { jobId, results }, cfg);
}

export function insertConsensus(cfg: WorkerConfig, jobId: string, rows: unknown[]) {
  return post(`${cfg.apiBase}/worker/consensus`, { jobId, rows }, cfg);
}

/** Store the report HTML and register the report. */
export async function submitReport(cfg: WorkerConfig, jobId: string, html: string, reportVersion: string, listingCount: number) {
  const up = await post(`${cfg.apiBase}/worker/report_upload`, html, cfg);
  await post(`${cfg.apiBase}/worker/report`, { jobId, htmlStorageId: up.storageId, reportVersion, listingCount }, cfg);
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
