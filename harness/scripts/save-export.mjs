#!/usr/bin/env node
// 작업 에이전트의 기록(jsonl)에서 figma-export.figma.js 조각 결과를 꺼내 합쳐 export 파일로 **그대로** 저장한다.
// 에이전트가 export JSON 을 다시 쳐서 반환하지 않게 하려는 것 (plans/2026-09-27-export-speedup.md A안).
//   node harness/scripts/save-export.mjs <slug> <agentId>
// 규칙
//   1) 기록: ~/.claude/projects/*/*/subagents/agent-<agentId>.jsonl — 없거나 둘 이상이면 종료 코드 2
//   2) export 호출: use_figma 코드가 figma-export.figma.js 와 MODE · FRAME_IDS · PAGE 세 줄만 다르고 나머지는 글자까지 같음. MODE 는 "export"
//   3) 마지막 "export 가 아닌 use_figma 호출"(Figma 를 고쳤을 수 있음) 뒤의 export 호출만 쓴다
//   4) 모든 조각의 FRAME_IDS · fileKey · pages 가 같고 PAGE 0 ~ pages-1 이 모두 있어야 한다. 같은 PAGE 는 마지막 결과. 오류 결과는 무시
//   5) 합치기: { fileKey, frames } — 같은 id 의 프레임은 nodes 를 조각 순서대로 이어 붙인다 (키 순서 그대로)
//   6) 저장 경로: 현재 게이트(p3·p4·p5) 폴더의 rules.yaml figma_check.export_files 파일만
// 종료 코드: 0 저장 · 1 조각 누락·코드 불일치·경로 거부 (아무것도 저장하지 않음) · 2 사용법·기록 없음

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HARNESS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ROOT = path.resolve(HARNESS_DIR, "..");
const RULES = YAML.parse(
  fs.readFileSync(path.join(HARNESS_DIR, "rules.yaml"), "utf8"),
);

const MODE_RE = /^const MODE = .*$/m;
const IDS_RE = /^const FRAME_IDS = .*$/m;
const PAGE_RE = /^const PAGE = .*$/m;
const norm = (s) => String(s).replace(/\r\n/g, "\n").trim();
const blank = (s) =>
  norm(s)
    .replace(MODE_RE, "__MODE__")
    .replace(IDS_RE, "__IDS__")
    .replace(PAGE_RE, "__PAGE__");

// use_figma 코드 → export 호출이면 { ids, page }, 아니면 null
export function parseExportCall(code, template) {
  const c = norm(code);
  if (blank(c) !== blank(template)) return null;
  if (c.match(MODE_RE)?.[0] !== 'const MODE = "export";') return null;
  const ids = c.match(/^const FRAME_IDS = (\[[^\]]*\]);/m)?.[1];
  const page = c.match(/^const PAGE = (\d+);/m)?.[1];
  if (!ids || page === undefined) return null;
  try {
    return { ids: JSON.stringify(JSON.parse(ids)), page: Number(page) };
  } catch {
    return null;
  }
}

// 기록 줄들 → 시간순 use_figma 호출 [{ code, result: { text, isError } | null }]
export function figmaCalls(lines) {
  const calls = [];
  const byId = new Map();
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use" && /use_figma$/.test(b.name ?? "")) {
        const call = { code: b.input?.code ?? "", result: null };
        calls.push(call);
        byId.set(b.id, call);
      } else if (b.type === "tool_result" && byId.has(b.tool_use_id)) {
        const c = b.content;
        const text = Array.isArray(c)
          ? c
              .filter((x) => x.type === "text")
              .map((x) => x.text)
              .join("")
          : String(c ?? "");
        byId.get(b.tool_use_id).result = { text, isError: !!b.is_error };
      }
    }
  }
  return calls;
}

// 규칙 3~5 — 성공하면 { json, pages, nodes }, 실패하면 { error }
export function assemble(calls, template) {
  let start = 0;
  calls.forEach((c, i) => {
    if (!parseExportCall(c.code, template)) start = i + 1;
  });
  const batch = calls
    .slice(start)
    .map((c) => ({ ...c, exp: parseExportCall(c.code, template) }));
  if (!batch.length)
    return {
      error:
        calls.length && start === calls.length
          ? "마지막 Figma 수정(또는 export 가 아닌 호출) 뒤에 export 호출이 없음 — 코드가 figma-export.figma.js 와 세 줄 외에 다르면 export 로 보지 않음"
          : "export 호출이 없음",
    };
  const pieces = new Map();
  let ids = null;
  for (const c of batch) {
    if (ids === null) ids = c.exp.ids;
    if (c.exp.ids !== ids)
      return {
        error: `FRAME_IDS 가 다른 export 호출이 섞여 있음 (${ids} / ${c.exp.ids})`,
      };
    if (!c.result || c.result.isError) continue;
    let r;
    try {
      r = JSON.parse(c.result.text);
    } catch {
      return {
        error: `PAGE ${c.exp.page} 결과가 JSON 이 아님 (응답이 잘렸을 수 있음)`,
      };
    }
    if (r.page !== c.exp.page)
      return { error: `PAGE ${c.exp.page} 호출의 결과 page 가 ${r.page}` };
    pieces.set(c.exp.page, r);
  }
  const all = [...pieces.values()];
  if (!all.length) return { error: "성공한 export 결과가 없음" };
  const { fileKey, pages } = all[0];
  if (all.some((p) => p.fileKey !== fileKey || p.pages !== pages))
    return { error: "조각마다 fileKey 또는 pages 가 다름" };
  const missing = [...Array(pages).keys()].filter((p) => !pieces.has(p));
  if (missing.length)
    return { error: `빠진 조각: PAGE ${missing.join(", ")} (pages=${pages})` };
  const frames = [];
  for (let p = 0; p < pages; p++)
    for (const f of pieces.get(p).frames) {
      const have = frames.find((g) => g.id === f.id);
      if (have) have.nodes.push(...f.nodes);
      else frames.push({ ...f, nodes: [...f.nodes] });
    }
  const expected = JSON.parse(ids);
  const got = frames.map((f) => f.id);
  if (JSON.stringify(got) !== JSON.stringify(expected))
    return { error: `합친 프레임이 FRAME_IDS 와 다름 (${got.join(", ")})` };
  return {
    json: JSON.stringify({ fileKey, frames }),
    pages,
    nodes: frames.reduce((a, f) => a + f.nodes.length, 0),
    frames: frames.length,
  };
}

function findTranscript(agentId) {
  const base = path.join(os.homedir(), ".claude", "projects");
  const hits = [];
  for (const proj of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const pdir = path.join(base, proj);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const sess of fs.readdirSync(pdir)) {
      const f = path.join(pdir, sess, "subagents", `agent-${agentId}.jsonl`);
      if (fs.existsSync(f)) hits.push(f);
    }
  }
  return hits;
}

function main() {
  const [slug, agentId] = process.argv.slice(2);
  const fail = (code, msg) => {
    console.error(msg);
    process.exit(code);
  };
  if (!slug || !agentId || !/^[a-z0-9][a-z0-9-]*$/.test(slug))
    fail(2, "사용법: save-export.mjs <slug> <agentId>");
  const statePath = path.join(ROOT, RULES.run.runs_dir, slug, "state.json");
  if (!fs.existsSync(statePath)) fail(2, `실행이 없어요: runs/${slug}`);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const fc = RULES.figma_check;
  if (state.done || !fc.gates.includes(state.next))
    fail(
      1,
      `❌ 지금 게이트(${state.done ? "완료" : state.next})에는 저장할 export 가 없어요 — 아무것도 저장하지 않았어요`,
    );
  const hits = findTranscript(agentId);
  if (hits.length !== 1)
    fail(
      2,
      hits.length
        ? `기록이 여러 개예요: ${hits.join(", ")}`
        : `기록을 찾지 못했어요: agent-${agentId}.jsonl — 에이전트에게 JSON 블록 반환 방식으로 다시 요청하세요`,
    );
  const template = fs.readFileSync(
    path.join(HARNESS_DIR, "scripts", "figma-export.figma.js"),
    "utf8",
  );
  const lines = fs.readFileSync(hits[0], "utf8").split("\n").filter(Boolean);
  const res = assemble(figmaCalls(lines), template);
  if (res.error) fail(1, `❌ ${res.error} — 아무것도 저장하지 않았어요`);
  const rel = path.join(
    RULES.run.runs_dir,
    slug,
    RULES[state.next].dir,
    fc.export_files[state.next],
  );
  fs.writeFileSync(path.join(ROOT, rel), res.json + "\n");
  console.log(
    `✅ 저장: ${rel} (조각 ${res.pages}개 · 프레임 ${res.frames}개 · 노드 ${res.nodes}개 · ${Buffer.byteLength(res.json)} bytes)`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
