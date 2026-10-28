import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunner, type RunnableProject } from "./runner.js";

const dirs: string[] = [];
const runners: ReturnType<typeof createRunner>[] = [];

async function setup(script: string, autoRestart: boolean, timing: { base?: number; max?: number; fails?: number } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "botlaunch-test-"));
  dirs.push(dir);
  const ws = path.join(dir, "ws");
  await fs.mkdir(ws);
  await fs.writeFile(path.join(ws, "package.json"), JSON.stringify({ name: "t", version: "1.0.0" }));
  await fs.writeFile(path.join(ws, "bot.js"), script);
  const project: RunnableProject = { projectId: "p1", name: "t", workspace: ws, root: "", scripts: {}, entryPoint: "bot.js", env: {} };
  const statuses: string[] = [];
  const runner = createRunner({
    storage: dir,
    log: () => {},
    onStatus: (_id, status) => statuses.push(status),
    resolveProject: () => project,
    shouldAutoRestart: () => autoRestart,
    restartBaseMs: timing.base ?? 20,
    restartMaxMs: timing.max ?? 40,
    restartMaxFails: timing.fails ?? 3
  });
  runners.push(runner);
  return { runner, project, statuses };
}
async function waitFor(cond: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.stopAll().catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("runner", () => {
  it("runs a bot, reports runtime info and stops cleanly", async () => {
    const { runner, project, statuses } = await setup('setInterval(() => console.log("tick"), 50);', false);
    await runner.start(project);
    await waitFor(() => runner.logs("p1").some((l) => l.includes("tick")));
    const info = runner.info("p1");
    expect(info.pid).toBeGreaterThan(0);
    expect(info.uptimeSec).not.toBeNull();
    expect(runner.isRunning("p1")).toBe(true);
    expect(runner.runningCount()).toBe(1);
    expect(await runner.stop("p1")).toBe(true);
    expect(runner.isRunning("p1")).toBe(false);
    expect(statuses.at(-1)).toBe("stopped");
    expect(runner.info("p1").restarts).toBe(0);
  }, 15000);

  it("does not leak server secrets into the child and passes bot env", async () => {
    process.env.ADMIN_TOKEN = "super-secret-token-123";
    try {
      const { runner, project } = await setup('console.log("A=" + process.env.MY_VAR); console.log("T=" + (process.env.ADMIN_TOKEN ?? "none")); setInterval(() => {}, 1000);', false);
      project.env = { MY_VAR: "hello" };
      await runner.start(project);
      await waitFor(() => runner.logs("p1").some((l) => l.includes("T=")));
      const out = runner.logs("p1").join("\n");
      expect(out).toContain("A=hello");
      expect(out).toContain("T=none");
      expect(out).not.toContain("super-secret-token-123");
    } finally { delete process.env.ADMIN_TOKEN; }
  }, 15000);

  it("auto-restarts a crashing bot with backoff and gives up after the limit", async () => {
    const { runner, project, statuses } = await setup("process.exit(1);", true, { base: 20, max: 40, fails: 3 });
    await runner.start(project).catch(() => {});
    await waitFor(() => statuses.at(-1) === "error" && !runner.isBusy("p1"));
    const info = runner.info("p1");
    expect(info.restarts).toBe(3);
    expect(info.lastExit?.code).toBe(1);
    expect(statuses).toContain("restarting");
    expect(runner.logs("p1").join("\n")).toContain("Auto-restart dihentikan");
  }, 20000);

  it("does not restart when auto-restart is off", async () => {
    const { runner, project, statuses } = await setup("process.exit(2);", false);
    await runner.start(project);
    await waitFor(() => statuses.at(-1) === "error");
    await new Promise((r) => setTimeout(r, 150));
    expect(runner.info("p1").restarts).toBe(0);
    expect(statuses).not.toContain("restarting");
  }, 15000);

  it("stop cancels a pending auto-restart", async () => {
    const { runner, project, statuses } = await setup("process.exit(1);", true, { base: 600, max: 600, fails: 5 });
    await runner.start(project);
    await waitFor(() => statuses.at(-1) === "restarting");
    expect(runner.isBusy("p1")).toBe(true);
    expect(runner.info("p1").nextRestartAt).not.toBeNull();
    expect(await runner.stop("p1")).toBe(true);
    expect(statuses.at(-1)).toBe("stopped");
    await new Promise((r) => setTimeout(r, 800));
    expect(runner.info("p1").restarts).toBe(0);
    expect(runner.isRunning("p1")).toBe(false);
  }, 15000);

  it("refuses a second start while the first is still launching", async () => {
    const { runner, project } = await setup("setInterval(() => {}, 1000);", false);
    const results = await Promise.allSettled([runner.start(project), runner.start(project)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(runner.runningCount()).toBe(1);
  }, 15000);
});
