#!/usr/bin/env node
// 에이전트 반환 텍스트에서 `=== FILE: <경로> ===` … `=== END FILE ===` 블록을 뽑아 **내용 그대로** 저장한다.
// 반환이 커서 Write 도구로 옮기기 어려울 때 오케스트레이터가 쓴다. guard-write.mjs 와 같은 경로 규칙을 적용한다.
//   node harness/scripts/save-blocks.mjs <slug> <반환 텍스트 파일>
// 종료 코드: 0 전부 저장 · 1 거부된 블록 있음(아무것도 저장하지 않음) · 2 사용법 오류

import fs from "node:fs";
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

const [slug, src] = process.argv.slice(2);
if (!slug || !src || !fs.existsSync(src)) {
  console.error("사용법: save-blocks.mjs <slug> <반환 텍스트 파일>");
  process.exit(2);
}
const runRel = path.join(RULES.run.runs_dir, slug);
const statePath = path.join(ROOT, runRel, "state.json");
if (!fs.existsSync(statePath)) {
  console.error(`실행이 없어요: ${runRel}`);
  process.exit(2);
}
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const allowedDir =
  state.done || state.next === "p3-approval" ? null : RULES[state.next]?.dir;
const forbidden = new Set([
  "state.json",
  "approval.md",
  RULES.p5?.report_file ?? "verify-report.md",
]);

const text = fs.readFileSync(src, "utf8");
const blocks = [
  ...text.matchAll(/^=== FILE: (\S+) ===\n([\s\S]*?)\n=== END FILE ===/gm),
];
if (!blocks.length) {
  console.error("반환 블록이 없어요.");
  process.exit(1);
}

const plan = [];
const rejected = [];
for (const [, p, body] of blocks) {
  const norm = path.normalize(p);
  const dir = path.dirname(norm);
  const name = path.basename(norm);
  const why = !allowedDir
    ? `지금 게이트(${state.done ? "완료" : state.next})에는 저장할 산출물이 없음`
    : dir !== path.join(runRel, allowedDir)
      ? `현재 게이트 폴더(${path.join(runRel, allowedDir)}/) 밖`
      : forbidden.has(name)
        ? `${name} 은(는) 저장 금지`
        : null;
  if (why) rejected.push(`${p} — ${why}`);
  else {
    if (name.endsWith(".json")) JSON.parse(body); // 형식만 확인 (내용은 바꾸지 않음)
    plan.push([path.join(ROOT, norm), body, p]);
  }
}
if (rejected.length) {
  console.error(
    "❌ 거부된 블록이 있어 아무것도 저장하지 않았어요:\n" +
      rejected.map((r) => `   - ${r}`).join("\n"),
  );
  process.exit(1);
}
for (const [abs, body, p] of plan) {
  fs.writeFileSync(abs, body + "\n");
  console.log(`✅ 저장: ${p} (${Buffer.byteLength(body)} bytes)`);
}
