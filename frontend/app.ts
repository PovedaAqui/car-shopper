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
import { validateCriteria } from "../convex/criteria_lib.ts";

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

// Mirrors convex/email_lib.ts isValidEmail (kept duplicated, not imported,
// so the frontend bundle stays self-contained and framework-free).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isLikelyEmail(raw: string): boolean {
  const e = raw.trim().toLowerCase();
  return e.length >= 6 && e.length <= 254 && EMAIL_RE.test(e);
}

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
      ? `Error: ${job.errorMsg ?? job.errorCode ?? "unknown"}`
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
      s.dataQualityFlag === "ok" ? "" : `<span class="flag">${s.dataQualityFlag === "duplicate" ? "duplicate" : "corrupt data"}</span>`;
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
const FIELD_IDS: Record<string, string> = {
  make: "make",
  model: "model",
  maxPrice: "maxPrice",
  region: "region",
  maxKm: "maxKm",
  minYear: "minYear",
};

function setFieldInvalid(fieldName: string, message: string) {
  const el = form.elements.namedItem(fieldName) as HTMLInputElement | null;
  if (el) {
    el.setCustomValidity(message);
    el.reportValidity();
  }
}

function clearFieldValidity() {
  for (const name of Object.values(FIELD_IDS)) {
    const el = form.elements.namedItem(name) as HTMLInputElement | null;
    if (el) el.setCustomValidity("");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("form-error");
  err.hidden = true;
  clearFieldValidity();
  const data = new FormData(form);
  const saved = loadSettings();
  const maxPhotos =
    typeof saved.maxPhotos === "number" && Number.isInteger(saved.maxPhotos) && saved.maxPhotos >= 0
      ? saved.maxPhotos
      : DEFAULT_MAX_PHOTOS;

  // Client-side pre-check mirrors convex/api.ts's server-side validation
  // exactly (same validateCriteria function, imported directly — not
  // duplicated logic that could drift) so obviously-bad input (empty
  // fields beyond what HTML5 `required` catches after trimming whitespace,
  // out-of-range numbers, overlong text) is caught instantly with a
  // specific, actionable message, before spending a round trip. The server
  // re-validates regardless (this check is bypassable via devtools/direct
  // API calls), so this is purely a UX improvement, not the security
  // boundary.
  const precheck = validateCriteria({
    make: data.get("make"),
    model: data.get("model"),
    maxPrice: data.get("maxPrice"),
    region: data.get("region"),
    maxKm: (data.get("maxKm") as string)?.trim() || undefined,
    minYear: (data.get("minYear") as string)?.trim() || undefined,
    maxPhotos,
  });
  if (!precheck.ok) {
    err.hidden = false;
    err.textContent = precheck.message;
    if (precheck.field !== "form" && precheck.field in FIELD_IDS) {
      setFieldInvalid(FIELD_IDS[precheck.field], precheck.message);
    }
    return;
  }
  const criteria = precheck.criteria;

  const btn = $("search-btn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const created: any = await client.mutation(api.api.create, { userId, criteria });
    // Production Convex redacts thrown error messages, so the mutation returns
    // a structured rejection ({ code }) for known client-facing cases instead
    // of throwing. Map those codes to friendly messages. Most of these are
    // now also caught by the client-side precheck above, but this stays as
    // defense-in-depth against a stale/bypassed client and the server's own
    // authoritative validation (which can differ, e.g. FREE_TIER_EXHAUSTED).
    const SERVER_ERROR_MESSAGES: Record<string, string> = {
      FREE_TIER_EXHAUSTED: "Your free search for today has already been used. Try again tomorrow.",
      MAKE_REQUIRED: "Please enter a make (e.g. Toyota).",
      MODEL_REQUIRED: "Please enter a model (e.g. Yaris).",
      REGION_REQUIRED: "Please enter a region (e.g. Barcelona).",
      MAKE_TOO_LONG: "Make must be 40 characters or fewer.",
      MODEL_TOO_LONG: "Model must be 40 characters or fewer.",
      REGION_TOO_LONG: "Region must be 60 characters or fewer.",
      MAKE_INVALID_CHARS: "Make can only contain letters, numbers, spaces, hyphens, apostrophes, and periods.",
      MODEL_INVALID_CHARS: "Model can only contain letters, numbers, spaces, hyphens, apostrophes, and periods.",
      REGION_INVALID_CHARS: "Region can only contain letters, numbers, spaces, hyphens, apostrophes, and periods.",
      PRICE_REQUIRED: "Please enter a maximum price.",
      PRICE_OUT_OF_RANGE: "Please enter a price between €100 and €1,000,000.",
      KM_OUT_OF_RANGE: "Maximum kilometres must be a whole number between 0 and 2,000,000.",
      YEAR_OUT_OF_RANGE: "Please enter a minimum year between 1980 and 2030.",
      PHOTOS_OUT_OF_RANGE: "Photos per ad must be a whole number from 0 upward.",
    };
    if (created && typeof created.code === "string" && created.code in SERVER_ERROR_MESSAGES) {
      err.hidden = false;
      err.textContent = SERVER_ERROR_MESSAGES[created.code];
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
  const rawEmail = String(data.get("email") ?? "").trim();
  const confirm = data.get("confirm") === "on";
  const btn = $("email-btn") as HTMLButtonElement;

  // Client-side pre-check mirrors the server (convex/email_lib.ts
  // isValidEmail) so an obviously-bad address is rejected instantly,
  // without a round trip — the server re-validates regardless, since this
  // check can be bypassed (devtools, direct API calls).
  if (!rawEmail || !isLikelyEmail(rawEmail)) {
    status.textContent = "Please enter a valid email address.";
    return;
  }
  if (!confirm) {
    status.textContent = "Please check the confirmation box before sending.";
    return;
  }

  btn.disabled = true;
  status.textContent = "Sending…";
  try {
    const result: any = await client.mutation(api.email.requestEmail, {
      jobId: activeJobId,
      userId,
      email: rawEmail,
      confirm,
    });
    // Production Convex redacts thrown error messages, so requestEmail
    // returns a structured rejection ({ code }) for known client-facing
    // cases instead of throwing (same pattern as api.create). Map those
    // codes to friendly messages.
    const EMAIL_ERROR_MESSAGES: Record<string, string> = {
      CONFIRM_REQUIRED: "Please check the confirmation box before sending.",
      INVALID_EMAIL: "Please enter a valid email address.",
      NOT_FOUND: "This search could not be found.",
      REPORT_NOT_READY: "The report isn't ready yet — please wait for the search to complete.",
    };
    if (result && typeof result.code === "string" && result.code in EMAIL_ERROR_MESSAGES) {
      status.textContent = EMAIL_ERROR_MESSAGES[result.code];
      return;
    }
    status.textContent = result?.reused
      ? "A delivery to this address was already sent — not resent."
      : "Send queued (AgentMail).";
  } catch (err: any) {
    status.textContent = "The email could not be sent. Please try again.";
  } finally {
    btn.disabled = false;
  }
});
