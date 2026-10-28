import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import unzipper from "unzipper";
import archiver from "archiver";
import { z } from "zod";
import { analyzeProject, isEnvTemplateFile, isUnsafePath, safeName, validateEnvVars, type Pkg } from "./analyzer.js";
import { createRunner } from "./runner.js";

const app = express();
const PORT = Number(process.env.PORT || 4000);
const IS_PROD = process.env.NODE_ENV === "production";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORAGE = path.resolve(process.env.BOTLAUNCH_STORAGE || path.join(HERE, "..", "storage"));
const UPLOADS = path.join(STORAGE, "uploads");
const WORKSPACES = path.join(STORAGE, "workspaces");
const BACKUPS = path.join(STORAGE, "backups");
const LOG_FILE = path.join(STORAGE, "events.json");
const PROJECTS_FILE = path.join(STORAGE, "projects.json");
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024;
const MAX_ENTRIES = 6000;
const MAX_UNCOMPRESSED = 250 * 1024 * 1024;

// ---- Access control -------------------------------------------------------
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const RUNNER_REQUESTED = process.env.ENABLE_RUNNER === "true";
// Running uploaded code is only allowed when the API is protected by a token.
const RUNNER_ENABLED = RUNNER_REQUESTED && ADMIN_TOKEN.length >= 12;

type Project = Record<string, any>;
const projects = new Map<string, Project>();
const logs: { time: string; level: string; message: string; projectId?: string }[] = [];
let persistenceQueue: Promise<void> = Promise.resolve();

await fs.mkdir(UPLOADS, { recursive: true });
await fs.mkdir(WORKSPACES, { recursive: true });
await fs.mkdir(BACKUPS, { recursive: true });

async function atomicJsonWrite(file: string, value: unknown) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temp, file);
}
function queuePersistence() {
  persistenceQueue = persistenceQueue
    .then(async () => {
      await atomicJsonWrite(PROJECTS_FILE, [...projects.values()]);
      await atomicJsonWrite(LOG_FILE, logs.slice(-500));
    })
    .catch((error) => console.error("BOTLAUNCH JSON persistence failed:", error));
  return persistenceQueue;
}
function log(level: string, message: string, projectId?: string) {
  logs.push({ time: new Date().toISOString(), level, message, projectId });
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  void queuePersistence();
}
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

// ---- Load persisted state -------------------------------------------------
try {
  const stored = JSON.parse(await fs.readFile(LOG_FILE, "utf8"));
  if (Array.isArray(stored)) logs.push(...stored.filter((x: any) => x && typeof x.time === "string" && typeof x.message === "string").slice(-500));
} catch { /* first run */ }
try {
  const stored = JSON.parse(await fs.readFile(PROJECTS_FILE, "utf8"));
  if (Array.isArray(stored)) {
    for (const item of stored.slice(0, 1000)) {
      if (!item || typeof item.projectId !== "string" || typeof item.name !== "string" || typeof item.createdAt !== "string") continue;
      const uploadPath = typeof item.uploadPath === "string" ? path.resolve(item.uploadPath) : "";
      const workspace = typeof item.workspace === "string" ? path.resolve(item.workspace) : "";
      if (!uploadPath.startsWith(UPLOADS + path.sep) || !workspace.startsWith(WORKSPACES + path.sep)) continue;
      item.root = typeof item.root === "string" ? item.root : "";
      item.extracted = item.extracted === true && (await fs.stat(workspace).then((st) => st.isDirectory()).catch(() => false));
      item.installed = item.installed === true && item.extracted && (await exists(path.join(workspace, item.root, "node_modules")));
      item.env = item.env && typeof item.env === "object" ? item.env : {};
      item.autoRestart = item.autoRestart === true;
      item.autoStart = item.autoStart === true;
      // Child processes do not survive a server restart, so nothing can be "online" here.
      item.runtimeStatus = item.extracted ? "ready" : "analyzed";
      projects.set(item.projectId, item);
    }
  }
} catch { /* first run */ }

// ---- Runner ---------------------------------------------------------------
const runner = createRunner({
  storage: STORAGE,
  log,
  resolveProject: (id) => { const p = projects.get(id); return p && p.extracted ? runnable(p) : null; },
  shouldAutoRestart: (id) => RUNNER_ENABLED && projects.get(id)?.autoRestart === true,
  onStatus: (id, status, extra) => {
    const p = projects.get(id);
    if (!p) return;
    p.runtimeStatus = status;
    if (extra?.installed !== undefined) p.installed = extra.installed;
    void queuePersistence();
  }
});
if (RUNNER_REQUESTED && !RUNNER_ENABLED) {
  console.warn("ENABLE_RUNNER=true diabaikan: ADMIN_TOKEN (minimal 12 karakter) wajib diatur agar runner aman diaktifkan.");
}

// ---- Middleware -----------------------------------------------------------
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
// Cross-origin callers: the Android app (Capacitor origins) plus anything in CORS_ORIGIN.
// Auth uses a Bearer token (no cookies), so this does not enable cross-site session abuse.
const allowedOrigins = new Set(["https://localhost", "capacitor://localhost", "http://localhost"]);
for (const o of (process.env.CORS_ORIGIN || "").split(",").map((x) => x.trim()).filter(Boolean)) allowedOrigins.add(o);
if (!IS_PROD) allowedOrigins.add("http://localhost:5173");
app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)) }));
app.use(express.json({ limit: "1mb" }));

const failures = new Map<string, { count: number; reset: number }>();
function tokenOk(provided: string) {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ADMIN_TOKEN) return next();
  const ip = req.ip || "unknown";
  const now = Date.now();
  const rec = failures.get(ip);
  if (rec && rec.reset > now && rec.count >= 20) return res.status(429).json({ error: "Terlalu banyak percobaan gagal. Coba lagi nanti." });
  const header = req.header("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (provided && tokenOk(provided)) return next();
  const cur = rec && rec.reset > now ? rec : { count: 0, reset: now + 10 * 60 * 1000 };
  cur.count += 1;
  failures.set(ip, cur);
  return res.status(401).json({ error: "Token akses tidak valid atau belum dimasukkan.", authRequired: true });
}

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== ".zip") return cb(new Error("Unggah hanya file dengan ekstensi .zip."));
    cb(null, true);
  }
});

function publicProject(p: Project): Record<string, any> {
  const { uploadPath, workspace, env, root, ...safe } = p;
  return { ...safe, envSet: Object.keys(env || {}) };
}

// ---- ZIP inspection / extraction -----------------------------------------
async function inspectZip(zipPath: string) {
  const directory = await unzipper.Open.file(zipPath);
  if (!directory.files.length) throw new Error("ZIP kosong atau tidak memiliki file yang dapat dibaca.");
  if (directory.files.length > MAX_ENTRIES) throw new Error(`ZIP berisi terlalu banyak entri (maksimal ${MAX_ENTRIES}).`);
  let total = 0;
  const names: string[] = [];
  const byName = new Map<string, (typeof directory.files)[number]>();
  for (const entry of directory.files) {
    const name = entry.path.replace(/\\/g, "/");
    if (isUnsafePath(name)) throw new Error("ZIP memiliki jalur file yang tidak aman. Arsip ditolak.");
    const attrs = (entry as any).externalFileAttributes;
    if ((entry.type as string) === "SymbolicLink" || (typeof attrs === "number" && ((attrs >>> 16) & 0xf000) === 0xa000)) {
      throw new Error("ZIP berisi symbolic link yang tidak diizinkan.");
    }
    total += entry.uncompressedSize || 0;
    if (total > MAX_UNCOMPRESSED) throw new Error("Ukuran total hasil ekstraksi terlalu besar (maksimal 250 MB).");
    if (entry.type !== "Directory") { names.push(name); byName.set(name, entry); }
  }
  if (!names.length) throw new Error("Tidak ditemukan file di dalam ZIP.");

  const rootPkgName = names.find((n) => n === "package.json") || names.find((n) => n.endsWith("/package.json") && n.split("/").length === 2);
  let pkg: Pkg | null = null;
  if (rootPkgName) {
    try { pkg = JSON.parse((await byName.get(rootPkgName)!.buffer()).toString("utf8")); }
    catch { throw new Error("package.json tidak valid. Periksa sintaks JSON pada template."); }
  }
  const relevant = names.filter((n) => /\.(js|cjs|mjs|ts|tsx|json|py)$/.test(n) && !n.includes("node_modules/") && !n.includes(".git/"));
  let text = "";
  for (const name of relevant.slice(0, 250)) {
    const entry = byName.get(name);
    if (!entry || entry.uncompressedSize > 500_000) continue;
    try { text += "\n" + (await entry.buffer()).toString("utf8"); } catch { /* skip unreadable */ }
  }
  let envFileText = "";
  for (const name of names.filter(isEnvTemplateFile).slice(0, 5)) {
    const entry = byName.get(name);
    if (!entry || entry.uncompressedSize > 100_000) continue;
    try { envFileText += "\n" + (await entry.buffer()).toString("utf8"); } catch { /* skip unreadable */ }
  }
  return { names, pkg, ...analyzeProject(names, pkg, text, envFileText) };
}

async function extractSafe(zipPath: string, destination: string) {
  const directory = await unzipper.Open.file(zipPath);
  await fs.mkdir(destination, { recursive: true });
  let written = 0;
  for (const entry of directory.files) {
    const name = entry.path.replace(/\\/g, "/");
    if (isUnsafePath(name)) throw new Error("Jalur arsip tidak aman.");
    const target = path.resolve(destination, ...name.split("/"));
    if (target !== destination && !target.startsWith(destination + path.sep)) throw new Error("Jalur ekstraksi keluar dari workspace.");
    if (entry.type === "Directory") { await fs.mkdir(target, { recursive: true }); continue; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Count real bytes: headers in a malicious ZIP can lie about uncompressed size.
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (written > MAX_UNCOMPRESSED) return cb(new Error("Ukuran hasil ekstraksi melebihi batas 250 MB."));
        cb(null, chunk);
      }
    });
    await pipeline(entry.stream(), counter, createWriteStream(target, { flags: "wx", mode: 0o644 }));
  }
}

const backupFileName = (p: Project) => `${p.name}-${p.projectId.slice(0, 8)}-backup.zip`;

function runnable(p: Project) {
  const root: string = p.root || "";
  return {
    projectId: p.projectId, name: p.name, workspace: p.workspace, root,
    scripts: p.scripts || {}, entryPoint: p.entryPoint ? String(p.entryPoint).slice(root.length) : null,
    env: p.env || {}
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ACTIONS = ["install", "start", "stop", "restart", "backup", "delete"] as const;
type Action = (typeof ACTIONS)[number];

// ---- Public routes --------------------------------------------------------
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "BOTLAUNCH AI API", time: new Date().toISOString(), runner: RUNNER_ENABLED }));
app.get("/api/session", (_req, res) => res.json({ authRequired: !!ADMIN_TOKEN, runnerEnabled: RUNNER_ENABLED, runnerRequested: RUNNER_REQUESTED, maxUploadMb: MAX_UPLOAD / 1024 / 1024 }));

// ---- Protected routes -----------------------------------------------------
app.use("/api", requireAuth);

app.get("/api/projects", (_req, res) => {
  res.json({ projects: [...projects.values()].map(publicProject).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});
app.get("/api/logs", (req, res) => {
  const id = typeof req.query.projectId === "string" ? req.query.projectId : null;
  res.json({ logs: logs.filter((l) => !id || l.projectId === id).slice(-200).map(({ time, level, message }) => ({ time, level, message })) });
});

app.post("/api/analyze", upload.single("template"), async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: "File ZIP belum dipilih." });
  try {
    const handle = await fs.open(f.path, "r");
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    await handle.close();
    if (header[0] !== 0x50 || header[1] !== 0x4b) throw new Error("File ini bukan arsip ZIP yang valid.");
    const inspected = await inspectZip(f.path);
    const id = crypto.randomUUID();
    const project: Project = {
      projectId: id, name: safeName(f.originalname), originalFilename: f.originalname, size: f.size,
      fileCount: inspected.names.length, files: inspected.names.slice(0, 250), language: inspected.language,
      entryPoint: inspected.entryPoint ? inspected.root + inspected.entryPoint : null, root: inspected.root,
      packageManager: inspected.packageManager, dependencies: inspected.dependencies, scripts: inspected.scripts,
      envKeys: inspected.envKeys, commands: inspected.commands, features: inspected.features,
      warnings: inspected.warnings, compatible: inspected.compatible, extracted: false, installed: false,
      runtimeStatus: "analyzed", createdAt: new Date().toISOString(), uploadPath: f.path,
      workspace: path.join(WORKSPACES, id), env: {}, autoRestart: false, autoStart: false
    };
    projects.set(id, project);
    await queuePersistence();
    log("info", `Template "${project.name}" analyzed (${project.fileCount} files).`, id);
    res.json({ project: publicProject(project) });
  } catch (e) {
    await fs.unlink(f.path).catch(() => {});
    const message = e instanceof Error ? e.message : "ZIP tidak dapat dianalisis.";
    log("warn", `Template analysis rejected: ${message}`);
    res.status(400).json({ error: message });
  }
});

app.post("/api/projects/:id/setup", async (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Proyek tidak ditemukan." });
  if (!p.compatible) return res.status(400).json({ error: "Template belum lolos pemeriksaan kompatibilitas dasar." });
  if (runner.isBusy(p.projectId)) return res.status(409).json({ error: "Hentikan proses yang sedang berjalan sebelum menyiapkan ulang workspace." });
  try {
    await fs.rm(p.workspace, { recursive: true, force: true });
    await extractSafe(p.uploadPath, p.workspace);
    p.extracted = true; p.installed = false; p.runtimeStatus = "ready";
    await queuePersistence();
    log("info", `Workspace prepared for "${p.name}". No project code was executed.`, p.projectId);
    res.json({ project: publicProject(p), message: "Workspace berhasil disiapkan. Langkah berikutnya: Install dependencies." });
  } catch (e) {
    await fs.rm(p.workspace, { recursive: true, force: true }).catch(() => {});
    p.extracted = false; p.runtimeStatus = "error";
    await queuePersistence();
    const message = e instanceof Error ? e.message : "Workspace gagal disiapkan.";
    log("error", `Workspace setup failed: ${message}`, p.projectId);
    res.status(500).json({ error: message });
  }
});

app.get("/api/projects/:id/runlog", (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Proyek tidak ditemukan." });
  res.json({ lines: runner.logs(p.projectId).slice(-400), status: p.runtimeStatus, info: runner.info(p.projectId) });
});
app.delete("/api/projects/:id/runlog", (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Proyek tidak ditemukan." });
  runner.clearLogs(p.projectId);
  res.json({ message: "Console dibersihkan." });
});

const settingsSchema = z.object({ autoRestart: z.boolean().optional(), autoStart: z.boolean().optional() }).strict();
app.patch("/api/projects/:id/settings", async (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Proyek tidak ditemukan." });
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success || Object.keys(parsed.data).length === 0) return res.status(400).json({ error: "Pengaturan tidak valid." });
  if (parsed.data.autoRestart !== undefined) p.autoRestart = parsed.data.autoRestart;
  if (parsed.data.autoStart !== undefined) p.autoStart = parsed.data.autoStart;
  await queuePersistence();
  log("info", `Settings updated for "${p.name}": auto-restart ${p.autoRestart ? "on" : "off"}, start on boot ${p.autoStart ? "on" : "off"}.`, p.projectId);
  res.json({ project: publicProject(p), message: "Pengaturan disimpan." });
});

app.get("/api/system", async (_req, res) => {
  let disk: { totalBytes: number; freeBytes: number } | null = null;
  try {
    const s = await fs.statfs(STORAGE);
    disk = { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) };
  } catch { /* statfs unsupported on this platform */ }
  res.json({
    node: process.version, platform: process.platform,
    serverUptimeSec: Math.floor(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), disk,
    bots: { running: runner.runningCount(), max: runner.limits.maxRunning, total: projects.size },
    runnerEnabled: RUNNER_ENABLED
  });
});

app.get("/api/projects/:id/env", (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Proyek tidak ditemukan." });
  res.json({ detected: p.envKeys || [], set: Object.keys(p.env || {}) }); // values are never sent back
});
app.put("/api/projects/:id/env", async (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Proyek tidak ditemukan." });
  const body = req.body || {};
  const remove: string[] = Array.isArray(body.remove) ? body.remove.filter((k: unknown) => typeof k === "string") : [];
  const merged: Record<string, string> = { ...(p.env || {}) };
  for (const k of remove) delete merged[k];
  const checked = validateEnvVars({ ...merged, ...(body.set && typeof body.set === "object" ? body.set : {}) });
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  p.env = checked.value;
  await queuePersistence();
  log("info", `Environment variables updated for "${p.name}" (${Object.keys(p.env).length} set). Restart bot to apply.`, p.projectId);
  res.json({ set: Object.keys(p.env), message: "Variabel disimpan. Restart bot agar berlaku." });
});

app.post("/api/projects/:id/:action", async (req, res) => {
  const p = projects.get(req.params.id);
  const action = req.params.action as Action;
  if (!p) return res.status(404).json({ error: "Proyek tidak ditemukan." });
  if (!ACTIONS.includes(action)) return res.status(400).json({ error: "Aksi tidak dikenal." });

  try {
    if (action === "backup") {
      if (!p.extracted) return res.status(400).json({ error: "Siapkan workspace terlebih dahulu sebelum membuat backup." });
      const archiveName = backupFileName(p);
      const outPath = path.join(BACKUPS, archiveName);
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(outPath);
        const arc = archiver("zip", { zlib: { level: 6 } });
        output.on("close", () => resolve());
        output.on("error", reject);
        arc.on("error", reject);
        arc.pipe(output);
        // node_modules is re-creatable and would make backups huge.
        arc.glob("**/*", { cwd: p.workspace, dot: true, ignore: ["**/node_modules/**", ".git/**"] });
        void arc.finalize();
      });
      log("info", `Backup created for "${p.name}".`, p.projectId);
      return res.json({ message: "Backup berhasil dibuat.", downloadUrl: `/api/backups/${encodeURIComponent(archiveName)}` });
    }

    if (action === "delete") {
      await runner.forget(p.projectId);
      await fs.rm(p.workspace, { recursive: true, force: true });
      await fs.unlink(p.uploadPath).catch(() => {});
      await fs.unlink(path.join(BACKUPS, backupFileName(p))).catch(() => {});
      projects.delete(p.projectId);
      await queuePersistence();
      log("info", `Project "${p.name}" deleted.`, p.projectId);
      return res.json({ message: "Proyek dihapus." });
    }

    // install / start / stop / restart
    if (!RUNNER_ENABLED) {
      log("warn", `Runtime ${action} requested for "${p.name}" but the runner is disabled.`, p.projectId);
      return res.status(501).json({
        error: RUNNER_REQUESTED
          ? "Runner nonaktif: atur ADMIN_TOKEN (minimal 12 karakter) lalu restart server."
          : "Runner nonaktif. Atur ENABLE_RUNNER=true dan ADMIN_TOKEN pada environment untuk menjalankan bot."
      });
    }
    if (!p.extracted) return res.status(400).json({ error: "Siapkan workspace terlebih dahulu." });

    if (action === "stop") {
      if (!(await runner.stop(p.projectId))) return res.status(409).json({ error: "Tidak ada proses aktif untuk dihentikan." });
      return res.json({ project: publicProject(p), message: "Proses dihentikan." });
    }
    if (action === "install") {
      await runner.install(runnable(p));
      return res.status(202).json({ project: publicProject(p), message: "Instalasi dimulai. Pantau di panel log." });
    }
    if (action === "restart") await runner.stop(p.projectId);
    await runner.start(runnable(p));
    await sleep(1200); // catch immediate crashes (missing env var, syntax error, ...)
    if (!runner.isRunning(p.projectId)) {
      const tail = runner.logs(p.projectId).slice(-3).join(" | ");
      const retry = runner.info(p.projectId).nextRestartAt ? " Auto-restart aktif dan akan mencoba lagi." : "";
      return res.status(500).json({ error: `Bot langsung berhenti.${retry} Periksa log. ${tail}`.slice(0, 500), project: publicProject(p) });
    }
    return res.json({ project: publicProject(p), message: action === "restart" ? "Bot dijalankan ulang." : "Bot berjalan." });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Aksi gagal.";
    log("error", `Action ${action} failed: ${message}`, p.projectId);
    return res.status(400).json({ error: message });
  }
});

app.get("/api/backups/:name", async (req, res) => {
  const name = path.basename(req.params.name);
  const target = path.resolve(BACKUPS, name);
  if (!target.startsWith(BACKUPS + path.sep)) return res.status(400).json({ error: "Nama file tidak valid." });
  if (!(await exists(target))) return res.status(404).json({ error: "Backup tidak ditemukan." });
  res.download(target, name);
});
app.use("/api", (_req, res) => res.status(404).json({ error: "Endpoint tidak ditemukan." }));

// ---- Dashboard (production) ----------------------------------------------
if (IS_PROD) {
  const WEB_DIST = path.resolve(HERE, "..", "dist");
  app.use(express.static(WEB_DIST, {
    index: false,
    maxAge: "1h",
    setHeaders: (res, file) => { if (path.basename(file) === "sw.js") res.setHeader("Cache-Control", "no-cache"); }
  }));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(WEB_DIST, "index.html"), (err) => {
      if (err && !res.headersSent) res.status(404).send("Dashboard build not found. Run npm run build first.");
    });
  });
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err?.code === "LIMIT_FILE_SIZE" ? "Ukuran ZIP melebihi batas upload." : err instanceof Error ? err.message : "Terjadi kesalahan server.";
  log("error", message);
  res.status(400).json({ error: message });
});

async function autoStartBots() {
  if (!RUNNER_ENABLED) return;
  for (const p of [...projects.values()].filter((x) => x.autoStart === true && x.extracted)) {
    try {
      await runner.start(runnable(p));
      log("info", `Start on boot: "${p.name}".`, p.projectId);
    } catch (e) {
      log("warn", `Start on boot failed for "${p.name}": ${e instanceof Error ? e.message : "unknown error"}`, p.projectId);
    }
    await sleep(1500); // stagger so several bots do not hit CPU/network at once
  }
}

const server = app.listen(PORT, "0.0.0.0", () => {
  log("info", `BOTLAUNCH API listening on port ${PORT} (runner ${RUNNER_ENABLED ? "enabled" : "disabled"}).`);
  console.log(`BOTLAUNCH API running on http://localhost:${PORT} — runner ${RUNNER_ENABLED ? "ENABLED" : "disabled"}`);
  void autoStartBots();
});

async function shutdown(signal: string) {
  console.log(`${signal} received, stopping bots and closing server...`);
  server.close();
  await runner.stopAll().catch(() => {});
  await persistenceQueue;
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
