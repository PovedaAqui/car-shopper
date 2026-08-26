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
// Vanilla (non-React) usage: the client is typed for function references,
// which the static site cannot import at build time, so we use string paths.
const client = new ConvexClient(DEPLOYMENT_URL) as any;

let activeJobId: string | null = null;
let unsubscribers: Array<() => void> = [];
let pollTimer: number | null = null;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el(tag: string, cls: string, text = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const STAGE_LABELS: Record<string, string> = {
  queued: "En cola",
  claimed: "Reservado por el worker",
  scraping: "Recogiendo anuncios",
  normalizing: "Normalizando y depurando datos",
  ranking: "Puntuando (€/km + extras)",
  vision: "Inspección visual (doble pasada)",
  consensus: "Cruce de visiones (consenso)",
  reporting: "Generando informe",
  completed: "Completado",
  failed: "Fallido",
  cancelled: "Cancelado",
  expired: "Expirado",
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
    client.onUpdate("api.watchJob", { jobId, userId }, (job: any) => {
      renderJobView(job);
    })
  );
  unsubscribers.push(
    client.onUpdate("api.watchScores", { jobId, userId }, (scores: any[]) => {
      renderScores(scores);
    })
  );
  unsubscribers.push(
    client.onUpdate("api.watchVision", { jobId, userId }, (rows: any[]) => {
      renderVision(rows);
    })
  );
  unsubscribers.push(
    client.onUpdate("api.listJobs", { userId }, (jobs: any[]) => {
      renderHistory(jobs);
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
      const job = await client.query("api.watchJob", { jobId: activeJobId, userId });
      renderJobView(job as any);
    } catch {
      /* deployment unreachable; keep trying */
    }
  }, 5000);
}

client.onUpdate("api.listJobs", { userId }, (jobs: any[]) => {
  renderHistory(jobs);
  const hasActive = jobs.some((j: any) => ["queued", "claimed", "scraping", "normalizing", "ranking", "vision", "consensus", "reporting"].includes(j.status));
  if (hasActive && !activeJobId) {
    const j = jobs.find((j: any) => ["queued", "claimed", "scraping", "normalizing", "ranking", "vision", "consensus", "reporting"].includes(j.status));
    openJob(j.jobId);
  }
});

function openJob(jobId: string) {
  activeJobId = jobId;
  $("dashboard").hidden = false;
  subscribeAll();
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
  $("job-meta").textContent = `${job.criteria?.make} ${job.criteria?.model} ≤ ${job.criteria?.maxPrice} € · ${job.criteria?.region ?? ""} · ${new Date(job.createdAt).toLocaleString("es-ES")}`;
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
    ["anuncios", c.scraped ?? 0],
    ["válidos", c.valid ?? 0],
    ["excluidos", c.excluded ?? 0],
    ["visión evaluable", c.visionEvaluable ?? 0],
    ["visión n/e", c.visionNoEvaluable ?? 0],
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

async function loadReportLink(jobId: string) {
  try {
    const r = await client.query("api.getReport", { jobId, userId });
    if (r?.url) {
      ($("report-link") as HTMLAnchorElement).href = r.url;
    }
  } catch {
    /* report not ready */
  }
}

function renderScores(scores: any[]) {
  const box = $("scores");
  box.innerHTML = "";
  if (!scores.length) return;
  box.appendChild(el("h3", "", "Ranking"));
  const table = el("table", "tbl");
  table.innerHTML = `<thead><tr><th>#</th><th>Anuncio</th><th>€/km</th><th>Precio</th><th>Km</th><th>Score</th><th></th></tr></thead>`;
  const tbody = el("tbody", "");
  for (const s of scores) {
    const tr = el("tr", "");
    const flag =
      s.dataQualityFlag === "ok" ? "" : `<span class="flag">${s.dataQualityFlag === "duplicate" ? "duplicado" : "datos corruptos"}</span>`;
    tr.innerHTML = `
      <td>${s.rank ?? "–"}</td>
      <td>${s.title} <span class="sub">${s.city ?? "—"} · ${s.year ?? "n/d"}</span></td>
      <td class="num">${s.pricePerKm.toFixed(2)}</td>
      <td class="num">${s.price.toLocaleString("es-ES")} €</td>
      <td class="num">${(s.km / 1000).toFixed(0)}k</td>
      <td class="num">${s.final.toFixed(1)}${s.visDelta ? `<span class="delta ${s.visDelta > 0 ? "pos" : "neg"}">(${s.visDelta > 0 ? "+" : ""}${s.visDelta})</span>` : ""}</td>
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
  box.appendChild(el("h3", "", "Inspección visual (doble pasada)"));
  const table = el("table", "tbl");
  table.innerHTML = `<thead><tr><th>Anuncio</th><th>Exterior</th><th>Color</th><th>Fotos</th><th>Consenso</th><th>Alertas</th></tr></thead>`;
  const tbody = el("tbody", "");
  // Show the primary (step=primary) rows only; consensus badge is attached.
  for (const r of rows.filter((x) => x.step === "primary")) {
    const tr = el("tr", "");
    const badge =
      r.badge === "discrepancia"
        ? `<span class="badge bad">⚠ discrepancia</span>`
        : r.badge === "consenso"
          ? `<span class="badge good">consenso</span>`
          : `<span class="badge muted">no evaluable</span>`;
    tr.innerHTML = `
      <td>${r.adId}</td>
      <td class="badge ${r.exteriorState === "bien" ? "good" : r.exteriorState === "no_evaluable" ? "muted" : "warn"}">${r.exteriorState}</td>
      <td>${r.color ?? "—"}</td>
      <td>${r.photosAnalyzed}</td>
      <td>${badge}</td>
      <td class="flags">${r.redFlags.length ? r.redFlags.join(" · ") : "—"}</td>`;
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
      <button data-job="${j.jobId}" class="jobbtn">${j.criteria?.make} ${j.criteria?.model} ≤ ${j.criteria?.maxPrice} €</button>
      <span class="badge ${statusCls}">${STAGE_LABELS[j.status] ?? j.status}</span>
      <span class="sub">${new Date(j.createdAt).toLocaleDateString("es-ES")}</span>`;
    list.appendChild(li);
  }
  list.querySelectorAll<HTMLButtonElement>("button.jobbtn").forEach((b) => {
    b.addEventListener("click", () => openJob(b.dataset.job!));
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
  const criteria = {
    make: (data.get("make") as string).trim(),
    model: (data.get("model") as string).trim(),
    maxPrice: Number(data.get("maxPrice")),
    region: (data.get("region") as string).trim(),
    ...(maxKmRaw ? { maxKm: Number(maxKmRaw) } : {}),
  };
  const btn = $("search-btn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const jobId = await client.mutation("api.create", { userId, criteria });
    openJob(jobId as string);
    window.scrollTo({ top: $("dashboard").offsetTop - 16, behavior: "smooth" });
  } catch (e: any) {
    err.hidden = false;
    err.textContent = e?.message ?? String(e);
  } finally {
    btn.disabled = false;
  }
});
