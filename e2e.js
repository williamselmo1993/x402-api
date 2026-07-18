// Collaudo end-to-end degli handler: avvia prima il server con TEST_FREE=1
import assert from "node:assert";

const B = process.env.BASE_URL || "http://localhost:3000";
const j = (m, path, body) =>
  fetch(B + path, {
    method: m,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

const iban = await j("POST", "/api/validate/iban", { iban: "IT60X0542811101000000123456" });
assert.equal(iban.valid, true);
const piva = await j("POST", "/api/validate/piva", { piva: "00743110158" });
assert.equal(piva.valid, false);
const cf = await j("POST", "/api/validate/cf", { cf: "RSSMRA85T10A562S" });
assert.equal(cf.valid, true);

const created = await j("POST", "/api/tasks", { title: "Trova email di 3 hotel a Milano", reward: "0.05 USDC" });
assert.equal(created.status, "open");

const claim = await j("POST", "/api/tasks/claim", { id: created.id, agent: "agent-test" });
assert.equal(claim.status, "claimed");
const claim2 = await j("POST", "/api/tasks/claim", { id: created.id, agent: "secondo" });
assert.equal(claim2.error, "task già claimed");

const done = await j("POST", "/api/tasks/complete", { id: created.id, result: "a@x.it, b@x.it, c@x.it" });
assert.equal(done.status, "done");

const status = await j("GET", `/api/tasks/status?id=${created.id}`);
assert.equal(status.status, "done");
assert.ok(status.result.includes("a@x.it"));

const missing = await j("GET", "/api/tasks/status?id=non-esiste");
assert.equal(missing.error, "task non trovato");

const board = await j("GET", "/api/tasks");
assert.ok(Array.isArray(board.open));

const mem = await j("POST", "/api/memory", { data: { note: "ricordati di me", n: 42 }, ttlDays: 7 });
assert.ok(mem.key);
const back = await j("GET", `/api/memory/get?key=${mem.key}`);
assert.equal(back.data.n, 42);
const noMem = await j("GET", "/api/memory/get?key=00000000-0000-0000-0000-000000000000");
assert.equal(noMem.error, "non trovato");

// Richiamami più tardi: ricevitore locale, job dovuto subito, dispatch, verifica consegna
const { createServer } = await import("node:http");
let receivedBody = null;
const receiver = createServer((req, r2) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { receivedBody = JSON.parse(b); r2.end("ok"); });
});
await new Promise((r) => receiver.listen(3999, r));

const sch = await j("POST", "/api/schedule", { url: "http://localhost:3999/cb", delayMinutes: 0, payload: { ciao: 1 } });
assert.equal(sch.status, "pending");
const disp = await j("GET", "/api/cron/dispatch");
assert.ok(disp.fired >= 1, "almeno una richiamata consegnata");
const schStatus = await j("GET", `/api/schedule/status?id=${sch.id}`);
assert.equal(schStatus.status, "fired");
assert.equal(schStatus.result, "HTTP 200");
assert.equal(receivedBody.payload.ciao, 1);
receiver.close();

const badUrl = await j("POST", "/api/schedule", { url: "ftp://x", delayMinutes: 1 });
assert.ok(badUrl.error);

const stats = await j("GET", "/api/stats");
assert.equal(stats.goalUsd, 50);

console.log("e2e ok — task", created.id, "— memory", mem.key, "— schedule", sch.id);
