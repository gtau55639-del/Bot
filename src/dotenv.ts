// Parses pasted .env text in the browser. Values never leave the page until the user presses "Simpan".

/** Same rule as BLOCKED_ENV in server/analyzer.ts (the server rejects these names, so the UI skips them). */
const RESERVED = /^(PATH|HOME|SHELL|USER|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NPM_CONFIG_.*|ADMIN_TOKEN|BOTLAUNCH_.*)$/i;
export const isReservedEnvName = (name: string) => RESERVED.test(name);

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      const hash = value.search(/\s#/); // inline comment after an unquoted value
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out[m[1]] = value;
  }
  return out;
}
