// Pure helpers used by the API. No I/O here so everything is unit-testable.

export type Feature = { name: string; status: string; detail: string };

export function safeName(name: string): string {
  const base = name
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]*$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "bot-template";
}

/** True when a ZIP entry path could escape the extraction folder. */
export function isUnsafePath(raw: string): boolean {
  const name = raw.replace(/\\/g, "/");
  return (
    name.startsWith("/") ||
    /^[a-zA-Z]:/.test(name) ||
    name.includes("\0") ||
    name.split("/").some((p) => p === ".." || p === ".")
  );
}

const ENV_RE =
  /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]|import\.meta\.env\.([A-Z][A-Z0-9_]*)|os\.environ(?:\.get)?\(['"]([A-Z][A-Z0-9_]*)['"]\)/g;

/** `.env.example`-style files list the variables a bot expects (values are never read). */
export function isEnvTemplateFile(name: string): boolean {
  return /(^|\/)(\.env\.(example|sample|template|dist)|example\.env)$/i.test(name) && !name.includes("node_modules/");
}

export function envKeysFromFile(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)) {
    if (!BLOCKED_ENV.test(m[1])) keys.add(m[1]);
  }
  return [...keys].slice(0, 80);
}

export function envKeysFrom(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(ENV_RE)) {
    const key = m.slice(1).find(Boolean);
    if (key && !["NODE_ENV", "PATH", "HOME"].includes(key)) keys.add(key);
  }
  return [...keys].slice(0, 80);
}

export function featureScan(files: string[], text: string): Feature[] {
  const all = (files.join("\n") + "\n" + text).toLowerCase();
  const tests: [string, RegExp, string][] = [
    ["WhatsApp integration", /whatsapp-web\.js|@whiskeysockets\/baileys|baileys|whatsapp business|whatsapp/, "Possible WhatsApp library or API reference detected."],
    ["Admin module", /isowner|isadmin|adminonly|owneronly|menuadmin|admin-menu|case ['"]admin/, "Possible admin-related code detected."],
    ["AI integration", /openai|anthropic|gemini|langchain|generativeai/, "Possible AI provider reference detected."],
    ["Welcome feature", /welcome|greetings|welcomemessage|welcome_message/, "Possible welcome feature reference detected."],
    ["Command handler", /command|case ['"]!|prefix|commander/, "Possible command handling reference detected."],
    ["Database", /postgres|pg-promise|prisma|sequelize|mongoose|sqlite|mysql/, "Possible database integration reference detected."]
  ];
  return tests.filter(([, re]) => re.test(all)).map(([name, , detail]) => ({ name, status: "detected", detail }));
}

export function findCommands(text: string): string[] {
  const out = new Set<string>();
  const skip = ["default", "module", "exports", "online", "offline", "error", "admin"];
  for (const m of text.matchAll(/(?:case\s+|command\s*[:=]\s*|name\s*[:=]\s*)['"`]([a-zA-Z0-9_-]{2,32})['"`]/g)) {
    if (!skip.includes(m[1].toLowerCase())) out.add(m[1]);
  }
  return [...out].slice(0, 100);
}

export type Pkg = {
  main?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  type?: string;
};

const ENTRY_CANDIDATES = [
  "src/index.ts", "src/main.ts", "src/index.js", "src/main.js", "index.ts",
  "index.js", "main.js", "bot.js", "app.js", "server.js", "dist/index.js"
];

/** Strip a single wrapping top-level folder ("bot/package.json" -> "package.json"). */
export function detectRoot(names: string[]): string {
  if (names.includes("package.json")) return "";
  const pkgs = names.filter((n) => n.endsWith("/package.json") && n.split("/").length === 2);
  return pkgs.length ? pkgs[0].slice(0, -"package.json".length) : "";
}

export function analyzeProject(names: string[], pkg: Pkg | null, text: string, envFileText = "") {
  const root = detectRoot(names);
  const rel = names.filter((n) => n.startsWith(root)).map((n) => n.slice(root.length));
  const ts = rel.some((n) => /\.tsx?$/.test(n));
  const js = rel.some((n) => /\.(js|cjs|mjs)$/.test(n));
  const py = rel.some((n) => /\.py$/.test(n));
  const language = pkg
    ? pkg.devDependencies?.typescript || ts ? "TypeScript" : "Node.js"
    : ts ? "TypeScript" : js ? "Node.js" : py ? "Python" : "Unknown";
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const entryPoint =
    (typeof pkg?.main === "string" && rel.includes(pkg.main.replace(/^\.\//, "")) ? pkg.main.replace(/^\.\//, "") : null) ||
    ENTRY_CANDIDATES.find((n) => rel.includes(n)) ||
    rel.find((n) => /^src\/.*\.(ts|js|mjs|cjs)$/.test(n)) ||
    null;
  const deps = [...new Set([...Object.keys(pkg?.dependencies || {}), ...Object.keys(pkg?.devDependencies || {})])].slice(0, 100);
  const warnings: string[] = [];
  if (!pkg && !py) warnings.push("package.json tidak ditemukan. Template Node.js belum dapat diverifikasi sebagai proyek yang dapat dipasang.");
  if (pkg && !entryPoint && !scripts.start) warnings.push("Entry point dan script start tidak terdeteksi. Proyek perlu ditinjau sebelum dapat dijalankan.");
  if (py && !pkg && !js && !ts) warnings.push("Template tampak menggunakan Python, tetapi runner Python tidak tersedia pada versi ini.");
  if (scripts.preinstall || scripts.install || scripts.postinstall) warnings.push("Script lifecycle instalasi terdeteksi. Script ini TIDAK dijalankan saat install (--ignore-scripts); beberapa paket native mungkin gagal.");
  if (deps.some((d) => /baileys|whatsapp-web\.js/i.test(d))) warnings.push("Library WhatsApp pihak ketiga terdeteksi. Kompatibilitas, kebijakan, dan autentikasinya harus ditinjau.");
  if (deps.some((d) => /puppeteer|playwright/i.test(d))) warnings.push("Dependensi browser terdeteksi dan mungkin memerlukan konfigurasi sistem tambahan.");
  if (!scripts.start && entryPoint && /\.tsx?$/.test(entryPoint)) warnings.push("Entry point TypeScript tanpa script start. Tambahkan script \"start\" pada package.json agar dapat dijalankan.");
  const compatible = !!pkg && (language === "Node.js" || language === "TypeScript") && (!!entryPoint || !!scripts.start) && !py;
  return {
    root, language, entryPoint, scripts, dependencies: deps, warnings, compatible,
    envKeys: [...new Set([...envKeysFrom(text), ...envKeysFromFile(envFileText)])].slice(0, 80), features: featureScan(rel, text), commands: findCommands(text),
    packageManager: pkg ? (typeof pkg.packageManager === "string" ? pkg.packageManager : "npm") : null
  };
}

/** Env var names that must never be set by a user (they could hijack the child process). */
const BLOCKED_ENV = /^(PATH|HOME|SHELL|USER|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NPM_CONFIG_.*|ADMIN_TOKEN|BOTLAUNCH_.*)$/i;

export function validateEnvVars(input: unknown): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Format variabel tidak valid." };
  const out: Record<string, string> = {};
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 60) return { ok: false, error: "Terlalu banyak variabel (maksimal 60)." };
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) return { ok: false, error: `Nama variabel tidak valid: ${k.slice(0, 40)}` };
    if (BLOCKED_ENV.test(k)) return { ok: false, error: `Nama variabel dicadangkan sistem: ${k}` };
    if (typeof v !== "string" || v.length > 4000 || v.includes("\0")) return { ok: false, error: `Nilai tidak valid untuk ${k}.` };
    out[k] = v;
  }
  return { ok: true, value: out };
}
