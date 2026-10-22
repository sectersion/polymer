#!/usr/bin/env node
// Coverage ratchet (issue #42): render a per-file lines-% delta between
// main's last vitest json-summary and the current one, and upsert a
// sticky PR comment. Visibility only — no threshold, never fails the
// run (issue #27 decision). No third-party app: baselines live as
// workflow artifacts uploaded by the tests job on main pushes.
//
// Usage:
//   node scripts/coverage-delta.mjs --current <path> [--baseline <path>]
//        [--pr <number>] [--repo <owner/name>]
//
// Without --pr the rendered markdown is printed to stdout (dry-run).

import { readFileSync } from "node:fs";

const MARKER = "<!-- coverage-delta -->";
const MAX_ROWS = 15;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pr") args.pr = argv[++i];
    else if (argv[i] === "--repo") args.repo = argv[++i];
    else if (argv[i] === "--current") args.current = argv[++i];
    else if (argv[i] === "--baseline") args.baseline = argv[++i];
  }
  return args;
}

const fmt = (pct) => `${pct.toFixed(1)}%`;

function fileRows(cur, base, strip) {
  const rows = [];
  for (const [absPath, { lines }] of Object.entries(cur)) {
    if (absPath === "total") continue;
    const curPct = lines?.pct;
    if (curPct == null) continue;
    // json-summary keys are absolute; render repo-relative paths.
    // `strip` is the repo root: process.cwd() in CI (correct), and the
    // usual case locally too — a dry-run from elsewhere shows absolute
    // paths, which is fine for eyeballing.
    const path =
      strip && absPath.startsWith(strip)
        ? absPath.slice(strip.length)
        : absPath;
    const basePct = base?.[absPath]?.lines?.pct;
    if (basePct == null) {
      rows.push({ path, curPct, basePct: null, delta: null });
    } else if (curPct !== basePct) {
      rows.push({ path, curPct, basePct, delta: curPct - basePct });
    }
  }
  // Regressions first, then improvements, then new files.
  rows.sort((a, b) => {
    const da = a.delta ?? 0;
    const db = b.delta ?? 0;
    if (da !== db) return da - db;
    return a.path.localeCompare(b.path);
  });
  return rows;
}

function render(currentJson, baselineJson) {
  const cur = JSON.parse(currentJson);
  const base = baselineJson ? JSON.parse(baselineJson) : null;
  const curTotal = cur.total?.lines?.pct;
  if (curTotal == null) {
    throw new Error(
      "current summary has no total.lines.pct — was it a json-summary run?",
    );
  }
  const baseTotal = base?.total?.lines?.pct;
  const lines = [];
  lines.push(`## Coverage (lines)`);
  lines.push("");
  if (baseTotal == null) {
    lines.push(
      `No baseline on \`main\` yet — totals only: **${fmt(curTotal)}**`,
    );
  } else {
    const d = curTotal - baseTotal;
    const arrow =
      d === 0 ? "=" : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`;
    lines.push(`**Total:** ${fmt(baseTotal)} → ${fmt(curTotal)} (${arrow})`);
  }
  const rows = base ? fileRows(cur, base, `${process.cwd()}/`) : [];
  if (rows.length > 0) {
    lines.push("");
    lines.push(`| file | main | this PR |`);
    lines.push(`| --- | --- | --- |`);
    for (const r of rows.slice(0, MAX_ROWS)) {
      const warn = r.delta != null && r.delta < 0 ? "⚠ " : "";
      const baseCell = r.basePct == null ? "—" : fmt(r.basePct);
      lines.push(`| ${warn}${r.path} | ${baseCell} | ${fmt(r.curPct)} |`);
    }
    if (rows.length > MAX_ROWS) {
      lines.push(`| … | | ${rows.length - MAX_ROWS} more unchanged/omitted |`);
    }
  }
  lines.push("");
  lines.push(
    `<sub>Report-only per #27 — no threshold, never fails CI. Baseline: last successful \`ci\` run on \`main\`.</sub>`,
  );
  return lines.join("\n");
}

async function upsertComment({ repo, pr, body }) {
  const gh = (args) =>
    import("node:child_process").then(
      (cp) =>
        new Promise((resolve, reject) => {
          cp.execFile("gh", args, (err, stdout, stderr) =>
            err ? reject(new Error(stderr || err.message)) : resolve(stdout),
          );
        }),
    );
  // --paginate concatenates per-page output, so request one JSON object
  // per line instead of a single outer array (stays parseable past 30
  // comments, the default page size).
  const { stdout } = await import("node:child_process").then(
    (cp) =>
      new Promise((resolve, reject) => {
        cp.execFile(
          "gh",
          [
            "api",
            "--paginate",
            `repos/${repo}/issues/${pr}/comments`,
            "--jq",
            `.[] | {id: .id, mine: (.body | contains(${JSON.stringify(MARKER)}))} | tostring`,
          ],
          (err, out, stderr) =>
            err
              ? reject(new Error(stderr || err.message))
              : resolve({ stdout: out }),
        );
      }),
  );
  const prior = stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .find((c) => c.mine);
  if (prior) {
    await gh([
      "api",
      "--method",
      "PATCH",
      `repos/${repo}/issues/${pr}/comments/${prior.id}`,
      "-f",
      `body=${body}`,
    ]);
    return `updated comment ${prior.id}`;
  }
  await gh([
    "api",
    "--method",
    "POST",
    `repos/${repo}/issues/${pr}/comments`,
    "-f",
    `body=${body}`,
  ]);
  return `created new comment`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.current) {
  console.error(
    "usage: coverage-delta.mjs --current <path> [--baseline <path>] [--pr <n>] [--repo <o/n>]",
  );
  process.exit(2);
}
// A declared baseline file that does not exist (e.g. the workflow's
// download step failed) degrades to totals-only, like no baseline.
function readIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

const baselineJson = args.baseline ? readIfPresent(args.baseline) : null;
const body = `${MARKER}\n${render(readFileSync(args.current, "utf8"), baselineJson)}`;
if (!args.pr) {
  console.log(body);
  process.exit(0);
}
const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
if (!repo) throw new Error("--pr given but no --repo or GITHUB_REPOSITORY");
console.log(await upsertComment({ repo, pr: args.pr, body }));
