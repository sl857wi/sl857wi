import fs from "fs";
import path from "path";
import type { NextFunction, Request, Response } from "express";
import { performance } from "perf_hooks";

// Jeden riadok metriky reprezentuje jedno meranie konkrétnej operácie
// na serveri. Takto vieme neskôr analyzovať časovanie, spotrebu CPU,
// zmenu pamäte aj výsledný stav spracovania.
type MetricRow = {
  ts_start: string;
  ts_end: string;
  duration_ms: number;

  component: "server";
  phase: string;
  operation: string;

  trace_id: string;
  span_id: string;
  parent_span_id?: string;

  status: "ok" | "error";
  http_method?: string;
  http_path?: string;
  http_status?: number;

  cpu_user_ms: number;
  cpu_system_ms: number;

  rss_start_bytes: number;
  rss_end_bytes: number;

  extra?: Record<string, any>;
};

function isoNow() {
  return new Date().toISOString();
}

// Pred zápisom metriky sa uistíme, že cieľový priečinok existuje.
function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function defaultMetricsPath() {
  return path.join(process.cwd(), "logs", "metrics.server.jsonl");
}

// Zber metrík vieme vypnúť cez premennú prostredia, ak chceme jednoduchší
// beh servera bez dodatočného zapisovania na disk.
function metricsEnabled(): boolean {
  const v = process.env.METRICS_ENABLED;
  if (!v) return true;
  return !(v === "0" || v.toLowerCase() === "false");
}

function getMetricsPath(): string {
  return process.env.METRICS_PATH || defaultMetricsPath();
}

// Metriky zapisujeme vo formáte JSON Lines, teda jeden JSON objekt
// na jeden riadok. Formát sa dobre hodí na neskoršie filtrovanie
// aj hromadné spracovanie výsledkov meraní.
function writeJsonl(row: any) {
  if (!metricsEnabled()) return;

  const outPath = getMetricsPath();
  ensureDir(path.dirname(outPath));
  fs.appendFileSync(outPath, JSON.stringify(row) + "\n", { encoding: "utf-8" });
}

function genId(prefix: string) {
  // Ide o ľahký interný identifikátor pre trace a span bez potreby
  // nasadzovať ďalšiu knižnicu pre distribuované trasovanie.
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

// Ak klient pošle vlastné trace ID, zachováme ho, aby bolo možné prepájať
// udalosti medzi Raspberry backendom, prehliadačom a lokálnym agentom.
export function traceId(req: Request): string {
  const h = req.headers["x-trace-id"];
  if (typeof h === "string" && h.trim().length > 0) return h.trim();
  return genId("trace");
}

// `withSpan` obalí ľubovoľnú asynchrónnu operáciu a zaznamená jej trvanie,
// využitie CPU, zmenu pamäte a výsledný stav. Pri sieťovej simulácii tak
// vieme sledovať aj to, koľko stojí vzdialený serverový krok.
export async function withSpan<T>(
  opts: {
    phase: string;
    operation: string;
    trace_id: string;
    parent_span_id?: string;
    extra?: Record<string, any>;
  },
  fn: () => Promise<T>
): Promise<T> {
  const span_id = genId("span");

  const ts_start = isoNow();
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const rss0 = process.memoryUsage().rss;

  try {
    const result = await fn();

    const t1 = performance.now();
    const cpu1 = process.cpuUsage(cpu0);
    const rss1 = process.memoryUsage().rss;
    const ts_end = isoNow();

    const row: MetricRow = {
      ts_start,
      ts_end,
      duration_ms: +(t1 - t0).toFixed(3),

      component: "server",
      phase: opts.phase,
      operation: opts.operation,

      trace_id: opts.trace_id,
      span_id,
      parent_span_id: opts.parent_span_id,

      status: "ok",

      cpu_user_ms: +(cpu1.user / 1000).toFixed(3),
      cpu_system_ms: +(cpu1.system / 1000).toFixed(3),

      rss_start_bytes: rss0,
      rss_end_bytes: rss1,

      extra: opts.extra,
    };

    writeJsonl(row);
    return result;
  } catch (e: any) {
    const t1 = performance.now();
    const cpu1 = process.cpuUsage(cpu0);
    const rss1 = process.memoryUsage().rss;
    const ts_end = isoNow();

    const row: MetricRow = {
      ts_start,
      ts_end,
      duration_ms: +(t1 - t0).toFixed(3),

      component: "server",
      phase: opts.phase,
      operation: opts.operation,

      trace_id: opts.trace_id,
      span_id,
      parent_span_id: opts.parent_span_id,

      status: "error",

      cpu_user_ms: +(cpu1.user / 1000).toFixed(3),
      cpu_system_ms: +(cpu1.system / 1000).toFixed(3),

      rss_start_bytes: rss0,
      rss_end_bytes: rss1,

      extra: {
        ...(opts.extra || {}),
        error: String(e?.message || e),
      },
    };

    writeJsonl(row);
    throw e;
  }
}

// Middleware automaticky meria každú HTTP požiadavku, takže vidíme
// celkový čas requestu aj bez ručného obalenia každej jednej routy.
export function metricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!metricsEnabled()) return next();

    const trace_id = traceId(req);
    (req as any).trace_id = trace_id;

    const span_id = genId("span_http");
    const ts_start = isoNow();
    const t0 = performance.now();
    const cpu0 = process.cpuUsage();
    const rss0 = process.memoryUsage().rss;

    res.on("finish", () => {
      const t1 = performance.now();
      const cpu1 = process.cpuUsage(cpu0);
      const rss1 = process.memoryUsage().rss;
      const ts_end = isoNow();

      const row: MetricRow = {
        ts_start,
        ts_end,
        duration_ms: +(t1 - t0).toFixed(3),

        component: "server",
        phase: "http",
        operation: "request",

        trace_id,
        span_id,

        status: res.statusCode >= 200 && res.statusCode < 500 ? "ok" : "error",
        http_method: req.method,
        http_path: req.path,
        http_status: res.statusCode,

        cpu_user_ms: +(cpu1.user / 1000).toFixed(3),
        cpu_system_ms: +(cpu1.system / 1000).toFixed(3),

        rss_start_bytes: rss0,
        rss_end_bytes: rss1,
      };

      writeJsonl(row);
    });

    next();
  };
}
