import "dotenv/config";
import dotenv from "dotenv";
import express from "express";
import { paymentMiddleware } from "x402-express";
import { facilitator as cdpFacilitator } from "@coinbase/x402";
import { put, get, list as blobList } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { validIban, validPiva, validCf } from "./validators.js";

dotenv.config({ path: ".env.local" }); // in locale: BLOB_READ_WRITE_TOKEN

const PAY_TO = process.env.WALLET_ADDRESS; // il tuo indirizzo EVM (0x...) — i pagamenti USDC arrivano qui
const NETWORK = process.env.NETWORK || "base-sepolia"; // "base" in produzione
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";

if (!PAY_TO) {
  console.error("Manca WALLET_ADDRESS in .env — copia .env.example in .env e metti il tuo indirizzo");
  process.exit(1);
}

const app = express();
app.set("trust proxy", true); // dietro Vercel: così resource è https
app.use(express.json());

const paid = (price, description) => ({ price, network: NETWORK, config: { description } });

// Rotte a pagamento: l'agente riceve 402 + istruzioni, paga in USDC, riprova con la prova di pagamento
// TEST_FREE=1 solo in locale per collaudare gli handler senza pagare
if (!process.env.TEST_FREE) {
  app.use(
    paymentMiddleware(
      PAY_TO,
      {
        "GET /api/ping": paid("$0.001", "Ping di test a pagamento"),
        "POST /api/validate/iban": paid("$0.001", "Validazione IBAN (checksum mod-97) — body: { iban }"),
        "POST /api/validate/piva": paid("$0.001", "Validazione Partita IVA italiana — body: { piva }"),
        "POST /api/validate/cf": paid("$0.001", "Validazione Codice Fiscale italiano — body: { cf }"),
        "POST /api/tasks": paid("$0.005", "Taskboard: pubblica un task per altri agenti — body: { title, detail?, reward? }"),
        "GET /api/tasks": paid("$0.001", "Taskboard: lista dei task aperti"),
        "GET /api/tasks/status": paid("$0.001", "Taskboard: stato/risultato di un task — query: ?id="),
        "POST /api/tasks/claim": paid("$0.001", "Taskboard: prendi in carico un task — body: { id, agent }"),
        "POST /api/tasks/complete": paid("$0.001", "Taskboard: consegna il risultato — body: { id, result }"),
        "POST /api/memory": paid("$0.005", "Memoria per agenti: salva JSON (max 64KB, ttl gg) — body: { data, ttlDays? } → { key }"),
        "GET /api/memory/get": paid("$0.001", "Memoria per agenti: rileggi — query: ?key="),
        "POST /api/schedule": paid("$0.005", "Richiamami più tardi: webhook POST al tuo URL — body: { url, at|delayMinutes, payload? }"),
        "GET /api/schedule/status": paid("$0.001", "Stato di una richiamata — query: ?id="),
      },
      // mainnet: facilitator Coinbase (usa CDP_API_KEY_ID/SECRET da .env); testnet: quello pubblico
      NETWORK === "base" ? cdpFacilitator : { url: FACILITATOR_URL }
    )
  );
}

// Gratis: gli agenti scoprono qui cosa vendi
app.get("/", (_req, res) => {
  res.json({
    service: "x402 paid API — validazione dati IT + taskboard per agenti",
    paidEndpoints: {
      "GET /api/ping": "$0.001 — test",
      "POST /api/validate/iban": "$0.001 — { iban } → { valid }",
      "POST /api/validate/piva": "$0.001 — { piva } → { valid }",
      "POST /api/validate/cf": "$0.001 — { cf } → { valid }",
      "POST /api/tasks": "$0.005 — pubblica task { title, detail?, reward? } → { id }",
      "GET /api/tasks": "$0.001 — lista task aperti",
      "GET /api/tasks/status?id=": "$0.001 — stato e risultato",
      "POST /api/tasks/claim": "$0.001 — { id, agent }",
      "POST /api/tasks/complete": "$0.001 — { id, result }",
      "POST /api/memory": "$0.005 — salva JSON { data, ttlDays? } → { key }",
      "GET /api/memory/get?key=": "$0.001 — rileggi",
      "POST /api/schedule": "$0.005 — webhook futuro { url, at|delayMinutes, payload? } → { id }",
      "GET /api/schedule/status?id=": "$0.001 — stato richiamata",
    },
  });
});

app.get("/api/ping", (_req, res) => {
  res.json({ pong: true, ts: new Date().toISOString() });
});

// --- Validazione dati ---

const validators = { iban: ["iban", validIban], piva: ["piva", validPiva], cf: ["cf", validCf] };
for (const [name, [field, fn]] of Object.entries(validators)) {
  app.post(`/api/validate/${name}`, (req, res) => {
    const value = req.body?.[field];
    if (typeof value !== "string") return res.status(400).json({ error: `body { ${field} } richiesto` });
    res.json({ input: value, valid: fn(value) });
  });
}

// --- Taskboard per agenti (storage: Vercel Blob privato) ---
// ponytail: letture eventualmente stale e claim last-write-wins — passa a Redis se il traffico cresce

const taskPath = (id) => `tasks/${id}.json`;

async function readJson(path) {
  try {
    const r = await get(path, { access: "private" });
    return await new Response(r.stream).json();
  } catch {
    return null;
  }
}

async function writeJson(path, obj) {
  await put(path, JSON.stringify(obj), { access: "private", addRandomSuffix: false, allowOverwrite: true });
}

const readTask = (id) => readJson(taskPath(id));
const writeTask = (task) => writeJson(taskPath(task.id), task);

app.post("/api/tasks", async (req, res) => {
  const { title, detail, reward } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "body { title } richiesto" });
  const task = {
    id: randomUUID(),
    title: title.slice(0, 200),
    detail: typeof detail === "string" ? detail.slice(0, 2000) : "",
    reward: typeof reward === "string" ? reward.slice(0, 200) : "",
    status: "open",
    createdAt: new Date().toISOString(),
  };
  await writeTask(task);
  res.status(201).json({ id: task.id, status: task.status });
});

app.get("/api/tasks", async (_req, res) => {
  const { blobs } = await blobList({ prefix: "tasks/", limit: 100 });
  const recent = blobs
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .slice(0, 30); // ponytail: niente indice, leggo gli ultimi 30 blob — indicizza se superi i 100 task
  const tasks = (await Promise.all(recent.map((b) => readTask(b.pathname.slice(6, -5))))).filter(Boolean);
  res.json({ open: tasks.filter((t) => t.status === "open") });
});

app.get("/api/tasks/status", async (req, res) => {
  const task = await readTask(String(req.query.id || ""));
  if (!task) return res.status(404).json({ error: "task non trovato" });
  res.json(task);
});

app.post("/api/tasks/claim", async (req, res) => {
  const { id, agent } = req.body ?? {};
  const task = await readTask(String(id || ""));
  if (!task) return res.status(404).json({ error: "task non trovato" });
  if (task.status !== "open") return res.status(409).json({ error: `task già ${task.status}` });
  task.status = "claimed";
  task.claimedBy = typeof agent === "string" ? agent.slice(0, 200) : "anonimo";
  task.claimedAt = new Date().toISOString();
  await writeTask(task);
  res.json({ id: task.id, status: task.status });
});

app.post("/api/tasks/complete", async (req, res) => {
  const { id, result } = req.body ?? {};
  if (typeof result !== "string" || !result.trim()) return res.status(400).json({ error: "body { result } richiesto" });
  const task = await readTask(String(id || ""));
  if (!task) return res.status(404).json({ error: "task non trovato" });
  if (task.status === "done") return res.status(409).json({ error: "task già completato" });
  task.status = "done";
  task.result = result.slice(0, 10000);
  task.completedAt = new Date().toISOString();
  await writeTask(task);
  res.json({ id: task.id, status: task.status });
});

// --- Memoria per agenti (storage JSON a pagamento su Blob privato) ---
// ponytail: niente cleanup dei blob scaduti — si fa a mano o con un cron se il volume cresce

app.post("/api/memory", async (req, res) => {
  const { data, ttlDays } = req.body ?? {};
  if (data === undefined) return res.status(400).json({ error: "body { data } richiesto" });
  const payload = JSON.stringify(data);
  if (payload.length > 64 * 1024) return res.status(413).json({ error: "data oltre 64KB" });
  const ttl = Math.min(Math.max(Number(ttlDays) || 30, 1), 365);
  const key = randomUUID();
  await put(`memory/${key}.json`, JSON.stringify({ data, expiresAt: Date.now() + ttl * 86_400_000 }), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  res.status(201).json({ key, ttlDays: ttl });
});

app.get("/api/memory/get", async (req, res) => {
  const key = String(req.query.key || "");
  if (!/^[0-9a-f-]{36}$/.test(key)) return res.status(400).json({ error: "query ?key= richiesta" });
  try {
    const r = await get(`memory/${key}.json`, { access: "private" });
    const stored = await new Response(r.stream).json();
    if (stored.expiresAt < Date.now()) return res.status(410).json({ error: "scaduto" });
    res.json({ key, data: stored.data });
  } catch {
    res.status(404).json({ error: "non trovato" });
  }
});

// --- Richiamami più tardi (webhook schedulati, consegna best-effort) ---

const schedPath = (id) => `schedule/${id}.json`;

function urlOk(u) {
  try {
    const p = new URL(u);
    if (!/^https?:$/.test(p.protocol)) return false;
    if (process.env.TEST_FREE) return true; // in collaudo locale: consenti http/localhost
    if (p.protocol !== "https:") return false;
    const h = p.hostname;
    // ponytail: anti-SSRF basilare sul solo hostname — niente risoluzione DNS
    return !(h === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.endsWith(".local") || h.endsWith(".internal"));
  } catch {
    return false;
  }
}

app.post("/api/schedule", async (req, res) => {
  const { url, at, delayMinutes, payload } = req.body ?? {};
  if (!urlOk(url)) return res.status(400).json({ error: "body { url } https pubblico richiesto" });
  const when = at ? Date.parse(at) : Date.now() + (Number(delayMinutes) || 0) * 60_000;
  if (!Number.isFinite(when) || when > Date.now() + 28 * 86_400_000) {
    return res.status(400).json({ error: "at/delayMinutes non valido (max 28 giorni)" });
  }
  const job = {
    id: randomUUID(),
    url,
    at: new Date(when).toISOString(),
    payload: payload ?? null,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await writeJson(schedPath(job.id), job);
  res.status(201).json({ id: job.id, at: job.at, status: job.status, note: "consegna best-effort dopo l'orario indicato" });
});

app.get("/api/schedule/status", async (req, res) => {
  const job = await readJson(schedPath(String(req.query.id || "")));
  if (!job) return res.status(404).json({ error: "non trovato" });
  res.json(job);
});

async function dispatchDue() {
  const { blobs } = await blobList({ prefix: "schedule/", limit: 100 });
  let fired = 0;
  for (const b of blobs) {
    const job = await readJson(b.pathname);
    if (!job?.id || job.status !== "pending" || Date.parse(job.at) > Date.now()) continue;
    job.status = "fired"; // ponytail: at-most-once, nessun retry — aggiungili se qualcuno li paga
    job.firedAt = new Date().toISOString();
    try {
      const r = await fetch(job.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: job.id, at: job.at, payload: job.payload }),
        signal: AbortSignal.timeout(5000),
      });
      job.result = `HTTP ${r.status}`;
    } catch (e) {
      job.result = "errore: " + e.message;
    }
    await writeJson(schedPath(job.id), job);
    fired++;
  }
  return fired;
}

// Gratis: innesca solo richiamate già dovute, chiunque lo chiami. Cron giornaliero di Vercel
// come rete di sicurezza; la dashboard aperta (poll di /api/stats ogni 30s) lo fa girare spesso.
app.get("/api/cron/dispatch", async (_req, res) => {
  res.json({ fired: await dispatchDue() });
});

// --- Dashboard (gratis: incassi on-chain + attività taskboard) ---

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const dashboardHtml = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
let statsCache = { t: 0, data: null }; // ponytail: cache in memoria 30s per non martellare Blockscout

app.get("/dashboard", (_req, res) => {
  res.type("html").send(dashboardHtml);
});

app.get("/api/stats", async (_req, res) => {
  if (statsCache.data && Date.now() - statsCache.t < 30_000) return res.json(statsCache.data);

  try { await dispatchDue(); } catch {} // piggyback: la dashboard aperta smaltisce le richiamate dovute

  // Incassi: transfer USDC in entrata sul wallet, letti dalla chain via Blockscout (senza API key).
  // Nota: conta TUTTI gli USDC in arrivo, anche eventuali trasferimenti non-x402.
  let payments = [];
  try {
    const r = await fetch(
      `https://base.blockscout.com/api?module=account&action=tokentx&address=${PAY_TO}&contractaddress=${USDC_BASE}&sort=desc`
    );
    const j = await r.json();
    payments = (Array.isArray(j.result) ? j.result : [])
      .filter((tx) => tx.to?.toLowerCase() === PAY_TO.toLowerCase())
      .map((tx) => ({ from: tx.from, usd: Number(tx.value) / 1e6, ts: Number(tx.timeStamp) * 1000, hash: tx.hash }));
  } catch {}

  let tasks = [];
  try {
    const { blobs } = await blobList({ prefix: "tasks/", limit: 100 });
    const recent = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)).slice(0, 30);
    tasks = (await Promise.all(recent.map((b) => readTask(b.pathname.slice(6, -5))))).filter((t) => t?.id && t?.status);
  } catch {}

  let memoryCount = 0;
  try {
    memoryCount = (await blobList({ prefix: "memory/", limit: 1000 })).blobs.length;
  } catch {}

  let schedules = [];
  try {
    const { blobs } = await blobList({ prefix: "schedule/", limit: 100 });
    const recent = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)).slice(0, 10);
    schedules = (await Promise.all(recent.map((b) => readJson(b.pathname))))
      .filter((s) => s?.id)
      .map((s) => {
        let host = "";
        try { host = new URL(s.url).hostname; } catch {}
        return { id: s.id, at: s.at, status: s.status, result: s.result || "", host };
      });
  } catch {}

  const count = (st) => tasks.filter((t) => t.status === st).length;
  const data = {
    wallet: PAY_TO,
    network: NETWORK,
    goalUsd: Number(process.env.GOAL_USD) || 50,
    revenueUsd: payments.reduce((s, p) => s + p.usd, 0),
    paymentsCount: payments.length,
    payments: payments.slice(0, 20),
    tasks: { open: count("open"), claimed: count("claimed"), done: count("done"), recent: tasks },
    memoryCount,
    schedules,
    updatedAt: new Date().toISOString(),
  };
  statsCache = { t: Date.now(), data };
  res.json(data);
});

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`x402 API su http://localhost:${port} — incassi verso ${PAY_TO} (${NETWORK})`));
}

export default app;
