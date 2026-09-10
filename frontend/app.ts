/**
 * Car Shopper frontend (static, no framework).
 *
 * Realtime via Convex `ConvexClient.onUpdate` subscriptions (plan §0:
 * "el dashboard debe usar suscripciones reactivas de Convex; el polling queda
 * como fallback operativo"). A lightweight poll fallback runs only when the
 * subscription connection drops.
 *
 * The deployment URL is injected at build time by the static-hosting deploy
 * (VITE_CONVEX_URL); for local dev it defaults to the self-hosted backend.
 */

import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";

const DEPLOYMENT_URL: string =
  (globalThis as any).VITE_CONVEX_URL ?? "http://127.0.0.1:3210";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function getOrCreateUserId(): string {
  const KEY = "car-shopper.user-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? `u-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(KEY, id);
  }
  return id;
}

const userId = getOrCreateUserId();
// Vanilla (non-React) usage still uses generated Convex function references.
// This keeps realtime subscriptions and calls on the same checked API as the
// backend instead of relying on undocumented string paths.
const client = new ConvexClient(DEPLOYMENT_URL);

const SETTINGS_KEY = "car-shopper.local-settings";

type LocalSettings = {
  /** Photos per ad to analyze: 0 = vision off, >=1 = cap. Default 1. */
  maxPhotos: number;
};

export const DEFAULT_MAX_PHOTOS = 1;

function loadSettings(): Partial<LocalSettings> {
  try {
    return JSON.parse(sessionStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function setupSettings() {
  const dialog = $("settings-dialog") as HTMLDialogElement | null;
  const form = $("settings-form") as HTMLFormElement | null;
  if (!dialog || !form) return;
  const saved = loadSettings();
  for (const [key, value] of Object.entries(saved)) {
    const field = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | null;
    if (!field) continue;
    if (field instanceof HTMLInputElement && field.type === "checkbox") field.checked = Boolean(value);
    else field.value = String(value ?? "");
  }
  $("settings-open").addEventListener("click", () => dialog.showModal());
  $("settings-clear").addEventListener("click", () => {
    sessionStorage.removeItem(SETTINGS_KEY);
    form.reset();
    $("settings-status").textContent = "Local settings cleared.";
  });
  form.addEventListener("submit", (event) => {
    if ((event as SubmitEvent).submitter?.id === "settings-close") return;
    event.preventDefault();
    const data = new FormData(form);
    const maxPhotosRaw = Number(data.get("maxPhotos"));
    const settings: LocalSettings = {
      maxPhotos: Number.isInteger(maxPhotosRaw) && maxPhotosRaw >= 0 ? maxPhotosRaw : DEFAULT_MAX_PHOTOS,
    };
    sessionStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    $("settings-status").textContent = "Saved for this browser session.";
  });
}

let activeJobId: Id<"jobs"> | null = null;
let unsubscribers: Array<() => void> = [];
let pollTimer: number | null = null;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

setupSettings();

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function friendlyError(error: unknown): string {
  // The Convex client wraps server errors as "[Request ID: …] Server Error
  // Called by client" and stashes the original thrown error on `.data`, so the
  // marker lives in `data`, not `message`. Build a haystack from the whole
  // error object and match against it.
  const e = error as { message?: unknown; code?: unknown; stack?: unknown; data?: unknown } | undefined;
  const parts: unknown[] = e ? [e.message, e.code, e.stack, e.data, error] : [error];
  const haystack = parts
    .map((p) => {
      if (p == null) return "";
      if (typeof p === "string") return p;
      try { return JSON.stringify(p); } catch { return String(p); }
    })
    .join("\n");
  if (haystack.includes("FREE_TIER_EXHAUSTED")) return "Your free search for today has already been used. Try again tomorrow.";
  if (haystack.includes("NO_LISTINGS")) return "No listings matched those criteria. Try a broader search.";
  return "The search could not be created. Please try again.";
}

function el(tag: string, cls: string, text = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  claimed: "Claimed by worker",
  scraping: "Collecting listings",
  normalizing: "Validating and cleaning data",
  ranking: "Scoring (€/km + extras)",
  vision: "Visual inspection (two passes)",
  consensus: "Cross-checking visual results",
  reporting: "Building report",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};

const VISUAL_STATE_LABELS: Record<string, string> = {
  bien: "Good",
  regular: "Fair",
  mal: "Poor",
  no_evaluable: "Not evaluable",
};

// ---------------------------------------------------------------------------
// Realtime subscriptions
// ---------------------------------------------------------------------------

function subscribeAll() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  if (!activeJobId) return;

  const jobId = activeJobId;

  unsubscribers.push(
    client.onUpdate(api.api.watchJob, { jobId, userId }, (job: any) => {
      renderJobView(job);
    })
  );
  unsubscribers.push(
    client.onUpdate(api.api.watchScores, { jobId, userId }, (scores: any[]) => {
      renderScores(scores);
    })
  );
  unsubscribers.push(
    client.onUpdate(api.api.watchVision, { jobId, userId }, (rows: any[]) => {
      renderVision(rows);
    })
  );
  unsubscribers.push(
    client.onUpdate(api.api.listJobs, { userId }, (jobs: any[]) => {
      renderHistory(jobs);
    })
  );
  unsubscribers.push(
    client.onUpdate(api.email.listDeliveries, { jobId, userId }, (rows: any[]) => {
      renderDeliveries(rows);
    })
  );
}

// Fallback polling (operational, per plan): only when the subscription
// connection is lost.
function startPollFallback() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(async () => {
    if (!activeJobId) return;
    try {
      const job = await client.query(api.api.watchJob, { jobId: activeJobId, userId });
      renderJobView(job as any);
    } catch {
      /* deployment unreachable; keep trying */
    }
  }, 5000);
}

client.onUpdate(api.api.listJobs, { userId }, (jobs: any[]) => {
  renderHistory(jobs);
  const hasActive = jobs.some((j: any) => ["queued", "claimed", "scraping", "normalizing", "ranking", "vision", "consensus", "reporting"].includes(j.status));
  if (hasActive && !activeJobId) {
    const j = jobs.find((j: any) => ["queued", "claimed", "scraping", "normalizing", "ranking", "vision", "consensus", "reporting"].includes(j.status));
    openJob(j.jobId);
  }
});

function openJob(jobId: Id<"jobs">) {
  activeJobId = jobId;
  $("dashboard").hidden = false;
  subscribeAll();
  startPollFallback();
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderJobView(job: any) {
  if (!job) {
    $("dashboard").hidden = true;
    return;
  }
  const status = job.status as string;
  $("job-meta").textContent = `${job.criteria?.make} ${job.criteria?.model} ≤ €${job.criteria?.maxPrice} · ${job.criteria?.region ?? ""} · ${new Date(job.createdAt).toLocaleString("en-GB")}`;
  const pct = Math.round(job.progress ?? 0);
  const bar = $("progress-bar") as HTMLElement;
  const wrap = $("progress") as HTMLElement;
  bar.style.width = `${pct}%`;
  wrap.setAttribute("aria-valuenow", String(pct));
  $("stage-text").textContent =
    status === "failed"
      ? `Error: ${job.errorMsg ?? job.errorCode ?? "desconocido"}`
      : `${STAGE_LABELS[status] ?? status} — ${pct}%`;

  const c = job.counts ?? {};
  $("counts").innerHTML = "";
  const chips: Array<[string, number]> = [
    ["listings", c.scraped ?? 0],
    ["valid", c.valid ?? 0],
    ["excluded", c.excluded ?? 0],
    ["vision evaluable", c.visionEvaluable ?? 0],
    ["vision n/e", c.visionNoEvaluable ?? 0],
  ];
  for (const [label, n] of chips) {
    const d = el("div", "chip");
    d.innerHTML = `<b>${n}</b> ${label}`;
    $("counts").appendChild(d);
  }

  if (status === "completed" && job.hasReport) {
    $("report-holder").hidden = false;
    loadReportLink(job.jobId);
  } else if (status !== "completed") {
    $("report-holder").hidden = true;
  }
}

async function loadReportLink(jobId: Id<"jobs">) {
  try {
    const r = await client.query(api.api.getReport, { jobId, userId });
    if (r?.url) {
      ($("report-link") as HTMLAnchorElement).href = r.url;
    }
  } catch {
    /* report not ready */
  }
}

function renderDeliveries(rows: any[]) {
  const box = $("email-status");
  if (!box || !rows?.length) return;
  const last = rows[0];
  const labels: Record<string, string> = {
    pending: "Email queued",
    sent: "Sent (HTML in message body)",
    bounced: "Bounced",
    failed: last.errorMsg ?? "Email failed",
  };
  box.textContent = labels[last.status] ?? last.status;
}

function renderScores(scores: any[]) {
  const box = $("scores");
  box.innerHTML = "";
  if (!scores.length) return;
  box.appendChild(el("h3", "", "Ranking"));
  const table = el("table", "tbl");
  table.innerHTML = `<thead><tr><th>#</th><th>Listing</th><th>€/km</th><th>Price</th><th>Km</th><th>Score</th><th></th></tr></thead>`;
  const tbody = el("tbody", "");
  for (const s of scores) {
    const tr = el("tr", "");
    const flag =
      s.dataQualityFlag === "ok" ? "" : `<span class="flag">${s.dataQualityFlag === "duplicate" ? "duplicado" : "datos corruptos"}</span>`;
    tr.innerHTML = `
      <td>${esc(s.rank ?? "–")}</td>
      <td>${esc(s.title)} <span class="sub">${esc(s.city ?? "—")} · ${esc(s.year ?? "n/d")}</span></td>
      <td class="num">${Number(s.pricePerKm).toFixed(2)}</td>
      <td class="num">€${Number(s.price).toLocaleString("en-GB")}</td>
      <td class="num">${(Number(s.km) / 1000).toFixed(0)}k</td>
      <td class="num">${Number(s.final).toFixed(1)}${s.visDelta ? `<span class="delta ${s.visDelta > 0 ? "pos" : "neg"}">(${s.visDelta > 0 ? "+" : ""}${esc(s.visDelta)})</span>` : ""}</td>
      <td>${flag}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
}

function renderVision(rows: any[]) {
  const box = $("vision");
  box.innerHTML = "";
  const evaluated = rows.filter((r) => r.badge === "consenso" || r.badge === "discrepancia");
  if (!evaluated.length) return;
  box.appendChild(el("h3", "", "Visual inspection (two passes)"));
  const table = el("table", "tbl");
  table.innerHTML = `<thead><tr><th>Listing</th><th>Exterior</th><th>Colour</th><th>Photos</th><th>Consensus</th><th>Alerts</th></tr></thead>`;
  const tbody = el("tbody", "");
  // Show the primary (step=primary) rows only; consensus badge is attached.
  for (const r of rows.filter((x) => x.step === "primary")) {
    const tr = el("tr", "");
    const badge =
      r.badge === "discrepancia"
        ? `<span class="badge bad">⚠ discrepancy</span>`
        : r.badge === "consenso"
          ? `<span class="badge good">consensus</span>`
          : `<span class="badge muted">not evaluable</span>`;
    tr.innerHTML = `
      <td>${esc(r.adId)}</td>
      <td class="badge ${r.exteriorState === "bien" ? "good" : r.exteriorState === "no_evaluable" ? "muted" : "warn"}">${esc(VISUAL_STATE_LABELS[r.exteriorState] ?? r.exteriorState)}</td>
      <td>${esc(r.color ?? "—")}</td>
      <td>${esc(r.photosAnalyzed)}</td>
      <td>${badge}</td>
      <td class="flags">${r.redFlags.length ? r.redFlags.map(esc).join(" · ") : "—"}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
}

function renderHistory(jobs: any[]) {
  if (!jobs?.length) return;
  $("history").hidden = false;
  const list = $("job-list");
  list.innerHTML = "";
  for (const j of jobs.slice(0, 10)) {
    const li = el("li", "jobitem");
    const statusCls =
      j.status === "completed" ? "good" : j.status === "failed" ? "bad" : "live";
    li.innerHTML = `
      <button data-job="${esc(j.jobId)}" class="jobbtn">${esc(j.criteria?.make)} ${esc(j.criteria?.model)} ≤ ${esc(j.criteria?.maxPrice)} €</button>
      <span class="badge ${statusCls}">${esc(STAGE_LABELS[j.status] ?? j.status)}</span>
      <span class="sub">${esc(new Date(j.createdAt).toLocaleDateString("en-GB"))}</span>`;
    list.appendChild(li);
  }
  list.querySelectorAll<HTMLButtonElement>("button.jobbtn").forEach((b) => {
    b.addEventListener("click", () => openJob(b.dataset.job as Id<"jobs">));
  });
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

const form = $("search-form") as HTMLFormElement;
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("form-error");
  err.hidden = true;
  const data = new FormData(form);
  const maxKmRaw = (data.get("maxKm") as string)?.trim();
  const saved = loadSettings();
  const maxPhotos =
    typeof saved.maxPhotos === "number" && Number.isInteger(saved.maxPhotos) && saved.maxPhotos >= 0
      ? saved.maxPhotos
      : DEFAULT_MAX_PHOTOS;
  const criteria = {
    make: (data.get("make") as string).trim(),
    model: (data.get("model") as string).trim(),
    maxPrice: Number(data.get("maxPrice")),
    region: (data.get("region") as string).trim(),
    ...(maxKmRaw ? { maxKm: Number(maxKmRaw) } : {}),
    maxPhotos,
  };
  const btn = $("search-btn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const created: any = await client.mutation(api.api.create, { userId, criteria });
    // Production Convex redacts thrown error messages, so the mutation returns
    // a structured rejection ({ code }) for known client-facing cases instead
    // of throwing. Map those codes to friendly messages.
    if (created && (created.code === "FREE_TIER_EXHAUSTED" || created.code === "PRICE_OUT_OF_RANGE" || created.code === "PHOTOS_OUT_OF_RANGE")) {
      err.hidden = false;
      err.textContent =
        created.code === "FREE_TIER_EXHAUSTED"
          ? "Your free search for today has already been used. Try again tomorrow."
          : created.code === "PRICE_OUT_OF_RANGE"
            ? "Please enter a price between €100 and €1,000,000."
            : "Photos per ad must be a whole number from 0 upward.";
      return;
    }
    const jobId = typeof created === "string" ? created : created?.jobId;
    if (!jobId) throw new Error("CREATE_JOB_FAILED: Convex returned no job id");
    openJob(jobId);
    window.scrollTo({ top: $("dashboard").offsetTop - 16, behavior: "smooth" });
  } catch (e: any) {
    err.hidden = false;
    err.textContent = friendlyError(e);
  } finally {
    btn.disabled = false;
  }
});

const emailForm = $("email-form") as HTMLFormElement | null;
emailForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeJobId) return;
  const status = $("email-status");
  const data = new FormData(emailForm);
  const btn = $("email-btn") as HTMLButtonElement;
  btn.disabled = true;
  status.textContent = "Enviando…";
  try {
    const result = await client.mutation(api.email.requestEmail, {
      jobId: activeJobId,
      userId,
      email: String(data.get("email") ?? ""),
      confirm: data.get("confirm") === "on",
    });
    status.textContent = result?.reused
      ? "Ya había un envío para esta dirección — no se ha reenviado."
      : "Envío en cola (AgentMail).";
  } catch (err: any) {
    status.textContent = err?.message ?? String(err);
  } finally {
    btn.disabled = false;
  }
});
