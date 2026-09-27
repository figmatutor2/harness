#!/usr/bin/env node
// PreToolUse hook (Agent|Task) — 사용자 확인 대기 중에는 작업 에이전트를 부르지 않는다.
// 규칙
//   1) 작업 에이전트(researcher·spec-writer·concept-designer·builder·flow-designer) 호출만 본다. judge 등은 관여하지 않는다.
//   2) runs/ 아래 어떤 실행이든 state.json 의 awaitingReview 가 있으면 막는다 (rules.yaml gates.review_after).
//      해제: 사용자가 진행을 지시한 뒤 'verify.mjs proceed <slug>', 산출물 수정은 'verify.mjs reopen <slug> --from <gate>'.
// 차단: exit 2 + stderr 사유. 통과: exit 0.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const WORK_AGENTS = [
  "researcher",
  "spec-writer",
  "concept-designer",
  "builder",
  "flow-designer",
];

const HARNESS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ROOT = path.resolve(HARNESS_DIR, "..");

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const agent = String(input?.tool_input?.subagent_type ?? "");
if (!WORK_AGENTS.includes(agent)) process.exit(0); // 1)

const RULES = YAML.parse(
  fs.readFileSync(path.join(HARNESS_DIR, "rules.yaml"), "utf8"),
);
const RUNS = path.join(ROOT, RULES.run.runs_dir);
if (!fs.existsSync(RUNS)) process.exit(0);

const waiting = [];
for (const slug of fs.readdirSync(RUNS)) {
  const p = path.join(RUNS, slug, "state.json");
  if (!fs.existsSync(p)) continue;
  try {
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    if (s.awaitingReview) waiting.push(`${slug}(${s.awaitingReview})`);
  } catch {
    // 읽지 못하는 state.json 은 건너뛴다
  }
}

if (waiting.length) {
  process.stderr.write(
    `[harness guard] 사용자 확인 대기 중: ${waiting.join(", ")} — ${agent} 를 부르지 않습니다. 산출물을 보여드리고 진행 지시를 받은 뒤 'verify.mjs proceed <slug>' 하세요 (수정 요청이면 'reopen <slug> --from <gate>').\n`,
  );
  process.exit(2); // 2)
}
process.exit(0);
