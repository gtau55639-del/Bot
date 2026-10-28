import { describe, it, expect } from "vitest";
import { isReservedEnvName, parseDotEnv } from "./dotenv";

describe("parseDotEnv", () => {
  it("parses plain, quoted, exported and commented lines", () => {
    const r = parseDotEnv(`# comment
BOT_TOKEN=abc123
export OWNER = 6281
NAME="Bot \\"Satu\\""
SINGLE='a # b'
URL=https://x.test/path?a=1#frag
INLINE=value # trailing comment
EMPTY=
not valid line
1BAD=x`);
    expect(r).toEqual({
      BOT_TOKEN: "abc123", OWNER: "6281", NAME: 'Bot "Satu"', SINGLE: "a # b",
      URL: "https://x.test/path?a=1#frag", INLINE: "value", EMPTY: ""
    });
  });
  it("handles Windows line endings", () => {
    expect(parseDotEnv("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("isReservedEnvName", () => {
  it("matches the names the server refuses", () => {
    for (const n of ["PATH", "node_options", "LD_PRELOAD", "ADMIN_TOKEN", "BOTLAUNCH_STORAGE", "NPM_CONFIG_PREFIX"]) expect(isReservedEnvName(n)).toBe(true);
    for (const n of ["BOT_TOKEN", "OPENAI_API_KEY"]) expect(isReservedEnvName(n)).toBe(false);
  });
});
