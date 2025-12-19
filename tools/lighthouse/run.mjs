import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import process from "node:process";
import { thresholds, defaultRoutes } from "../scripts/thresholds.mjs";
import { startSpinner } from "../utils/spinner.mjs";

//const WEB_DIR = path.resolve("web");
//const DIST_DIR = path.resolve("web/dist");
const PRESETS = ["mobile", "desktop"];
const PORT_RAW = process.env.TEST_PORT;
if (!PORT_RAW) {
  console.error("Missing TEST_PORT env var. Example: TEST_PORT=3000");
  process.exit(1);
}
const PORT = Number(PORT_RAW);
if (!Number.isFinite(PORT) || PORT <= 0) {
  console.error(`Invalid TEST_PORT: ${PORT_RAW}`);
  process.exit(1);
}
const ROUTES = (
  process.env.LH_ROUTES ? process.env.LH_ROUTES.split(",") : defaultRoutes
)
  .map((s) => s.trim())
  .filter(Boolean);

const OUT_DIR = path.resolve("artifacts/lighthouse");
fs.mkdirSync(OUT_DIR, { recursive: true });

function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net
      .createConnection({ port, host })
      .once("connect", () => {
        socket.end();
        resolve(true);
      })
      .once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function runAsync(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      shell: true,
      stdio: ["ignore", "ignore", "pipe"], // keep spinner clean; keep stderr for errors
    });

    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `${cmd} exited with code ${code}`));
    });
  });
}

function scoreTo100(v) {
  return Math.round((v ?? 0) * 100);
}

function failIfBelow(name, score, min) {
  if (score < min) return `${name} ${score} < ${min}`;
  return null;
}

function failIfAbove(name, score, max) {
  if (score > max) return `${name} ${score} > ${max}`;
  return null;
}

function auditNumericValue(audits, id) {
  const a = audits?.[id];
  if (!a) return null;
  // numericValue is usually in ms for paints, unit depends on audit
  return typeof a.numericValue === "number" ? a.numericValue : null;
}

function auditDisplayValue(audits, id) {
  const a = audits?.[id];
  return a?.displayValue ?? null;
}

const server = null;

if (await isPortInUse(PORT)) {
  console.error(
    `Test Server on port ${PORT} is already running. Proceeding...`
  );
} else {
  console.log(
    `Test Server on port ${PORT} is not running. Please start the test server and try again.`
  );
  process.exit(1);
  /*
    // Park this for now - assume test server is running.
    // We can think about automating this later. For smoke tests it's fine.
    console.log("==> Building web...");
    run("npm run build", WEB_DIR);

    console.log(`==> Serving ${DIST_DIR} on :${PORT}...`);
    const server = spawn("npx", ["serve", "-s", "dist", "-l", String(PORT)], {
    cwd: WEB_DIR,
    stdio: "inherit",
    shell: true
    });*/
}

function cleanup(code = 0) {
  if (server) {
    server.kill("SIGTERM");
    process.exit(code);
  }
}

if (server) {
  process.on("SIGINT", () => cleanup(130));
  process.on("SIGTERM", () => cleanup(143));
}

// small wait for server
await new Promise((r) => setTimeout(r, 1200));

const failures = [];
const restults = [];
for (const route of ROUTES) {
  const url = `http://localhost:${PORT}${
    route.startsWith("/") ? route : `/${route}`
  }`;
  const slugBase = route === "/" ? "home" : route.replaceAll("/", "_").replace(/^_+/, "");

    for (const preset of PRESETS) {
        const slug = `${slugBase}-${preset}`;
        const jsonPath = path.join(OUT_DIR, `${slug}.json`);

        const spin = startSpinner(`Lighthouse: ${route}`);

        try {
            await runAsync(
            "npx",
            [
                "lighthouse",
                url,
                `${preset == "desktop" ? "--preset=desktop" : ""}`,
                "--output=json",
                `--output-path=${jsonPath}`,
                "--quiet",
                "--only-categories=performance,accessibility,best-practices,seo",
                '--chrome-flags="--headless --no-sandbox"',
            ],
            process.cwd()
            );

            spin.succeed(`Lighthouse done (${preset}): ${route}`);
        } catch (e) {
            spin.fail(`Lighthouse failed (${preset}): ${route}`);
            throw e; // keeps your script failing properly
        }

        const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        const cats = report.categories || {};
        const scores = {
            performance: scoreTo100(cats.performance?.score),
            accessibility: scoreTo100(cats.accessibility?.score),
            bestPractices: scoreTo100(cats["best-practices"]?.score),
            seo: scoreTo100(cats.seo?.score),
        };

        console.log(` ${preset} Scores:`, scores);

        const audits = report.audits || {};

        const metrics = {
            fcpMs: auditNumericValue(audits, "first-contentful-paint"),
            lcpMs: auditNumericValue(audits, "largest-contentful-paint"),
            cls: auditNumericValue(audits, "cumulative-layout-shift"),
            inpMs: auditNumericValue(audits, "interaction-to-next-paint"),
            tbtMs: auditNumericValue(audits, "total-blocking-time"),
        };

        console.log(`${preset} Metrics:`, {
            fcp: auditDisplayValue(audits, "first-contentful-paint"),
            lcp: auditDisplayValue(audits, "largest-contentful-paint"),
            cls: auditDisplayValue(audits, "cumulative-layout-shift"),
            inp: auditDisplayValue(audits, "interaction-to-next-paint"),
            tbt: auditDisplayValue(audits, "total-blocking-time"),
        });

        const fialedMetrics = [];


        fialedMetrics.push(
            failIfBelow("SEO", scores.seo, thresholds.seo),
            failIfBelow("Perf", scores.performance, thresholds.performance),
            failIfBelow("A11y", scores.accessibility, thresholds.accessibility),
            failIfBelow("BP", scores.bestPractices, thresholds.bestPractices),
            failIfAbove("CLS", metrics.cls, thresholds.cls),
            failIfAbove("FCP", metrics.fcpMs, thresholds.fcpMs),
            failIfAbove("LCP", metrics.lcpMs, thresholds.lcpMs),
            failIfAbove("INP", metrics.inpMs, thresholds.inpMs),
            failIfAbove("TBT", metrics.tbtMs, thresholds.tbtMs)
        );
        
        failures.push({route: `${preset} ${route}`, failures: fialedMetrics.filter(Boolean)});
    }
}
const realFailures = failures.filter(Boolean);
if (realFailures.length) {
  console.error("Lighthouse gate failed:");
  for (const f of realFailures){
    if(f.failures) console.error(` - ${f.route}:`, f.failures);
  }
  if (server) cleanup(1);
}else{
    console.log("Lighthouse gate passed");
    if (server) cleanup(0);
}