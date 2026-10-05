import { parseMeasurement, attemptTotals, sumCounts, type RouterMeasurement } from "./measurement.js";
import { DEMO_CATALOG } from "./scenarios.js";
export interface UsageEntry { at: string; status: "success" | "failed" | "cancelled"; input: number | null; output: number | null; latencyMs: number | null; keySource: "personal" | "host"; measurement?: RouterMeasurement }
const validCount = (n: unknown) => n === null || typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const validLatency = (n: unknown) => n === null || typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 86_400_000;
export function parseEntries(raw: string | null): UsageEntry[] {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!Array.isArray(value)) return [];
    return value.slice(0, 200).filter(e => e && typeof e.at === "string" && Number.isFinite(Date.parse(e.at)) && ["success", "failed", "cancelled"].includes(e.status) && ["personal", "host"].includes(e.keySource) && [e.input, e.output].every(validCount) && validLatency(e.latencyMs)).flatMap(e => {
      try {
        const measurement = e.measurement === undefined ? undefined : parseMeasurement(e.measurement, [...DEMO_CATALOG.map(t => t.id), "needs_clarification"], undefined, true);
        if (measurement && (e.input !== measurement.inputTokens || e.output !== measurement.outputTokens || e.latencyMs !== measurement.latencyMs)) return [];
        return [{ at: e.at, status: e.status, input: e.input, output: e.output, latencyMs: e.latencyMs, keySource: e.keySource, ...(measurement ? { measurement } : {}) }];
      } catch { return []; }
    });
  } catch { return []; }
}
export function summarizeUsage(entries: readonly UsageEntry[]) {
  const ledgers = entries.map(e => e.measurement?.attemptLedger ? attemptTotals(e.measurement.attemptLedger) : null);
  const reported = (metric: "input" | "output") => {
    const values = entries.map((entry, index) => ledgers[index] ? ledgers[index]![metric].reported : entry[metric] ?? 0);
    return values.some(value => value === null) ? null : sumCounts(values as number[]);
  };
  return { requests: entries.length,
    providerRequests: ledgers.every(t => t?.providerRequests != null) ? ledgers.reduce((n, t) => n + t!.providerRequests!, 0) : null,
    observedProviderRequests: ledgers.reduce((n, t) => n + (t?.observedProviderRequests ?? 0), 0),
    retryRequests: ledgers.reduce((n, t) => n + Math.max(0, (t?.observedProviderRequests ?? 0) - 1), 0),
    input: reported("input"),
    output: reported("output"),
    unknown: entries.filter(e => e.input === null || e.output === null).length };
}
const STORAGE = "jev-harness-session-usage-v1";
let entries: UsageEntry[] | null = null;
export function getUsage() {
  if (entries === null) { try { entries = parseEntries(sessionStorage.getItem(STORAGE)); } catch { entries = []; } }
  return structuredClone(entries);
}
export function recordUsage(entry: UsageEntry) {
  let clean: UsageEntry | undefined;
  try { clean = parseEntries(JSON.stringify([entry]))[0]; } catch { return; }
  if (!clean) return;
  entries = [clean, ...getUsage()].slice(0, 200);
  try { sessionStorage.setItem(STORAGE, JSON.stringify(entries)); } catch { /* Memory-only remains usable. */ }
  window.dispatchEvent(new Event("jev-usage-change"));
}
export function clearUsage() { entries = []; try { sessionStorage.removeItem(STORAGE); } catch {} window.dispatchEvent(new Event("jev-usage-change")); }
