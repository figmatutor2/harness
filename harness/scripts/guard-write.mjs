#!/usr/bin/env node
// PreToolUse hook (Write|Edit|MultiEdit) — 하네스 산출물 저장 권한을 강제한다.
// 규칙
//   1) runs/ 밖의 경로는 관여하지 않는다 (하네스 유지보수 편집 허용).
//   2) 서브에이전트(agent_type 있음)는 runs/ 아래에 쓰지 않는다 — 산출물은 반환 블록으로 넘긴다.
//   3) state.json · verify-report.md(스크립트 전용), approval.md(사람 전용)는 쓰지 않는다.
//   4) runs/<slug>/ 안에서는 state.json 의 next 게이트 폴더에만 쓴다.
// 차단: exit 2 + stderr 사유. 통과: exit 0.
// 한계: Bash 로 파일을 쓰는 경우(python, sed 등)는 이 hook 이 보지 못한다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HARNESS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ROOT = path.resolve(HARNESS_DIR, "..");

const deny = (msg) => {
  process.stderr.write(`[harness guard] ${msg}\n`);
  process.exit(2);
};

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0); // 입력을 읽지 못하면 관여하지 않는다
}

const filePath =
  input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
if (!filePath) process.exit(0);

const RULES = YAML.parse(
  fs.readFileSync(path.join(HARNESS_DIR, "rules.yaml"), "utf8"),
);
const RUNS = path.join(ROOT, RULES.run.runs_dir);
const abs = path.resolve(input.cwd ?? ROOT, filePath);
const rel = path.relative(RUNS, abs);
if (rel.startsWith("..") || path.isAbsolute(rel)) process.exit(0); // 1)

if (input.agent_type)
  deny(
    `서브에이전트(${input.agent_type})는 runs/ 에 파일을 쓰지 않습니다. 산출물은 === FILE: … === 블록으로 반환하세요.`,
  ); // 2)

const base = path.basename(abs);
if (
  base === "state.json" ||
  base === (RULES.p5?.report_file ?? "verify-report.md")
)
  deny(`${base} 은(는) 검증 스크립트만 씁니다.`); // 3)
if (base === "approval.md")
  deny(
    "approval.md 는 사람이 직접 작성합니다 (하네스의 유일한 사람 승인 지점).",
  ); // 3)

const [slug, phaseDir] = rel.split(path.sep);
const statePath = path.join(RUNS, slug, "state.json");
if (!fs.existsSync(statePath))
  deny(
    `runs/${slug} 에 state.json 이 없습니다. verify.mjs init 으로 실행을 먼저 만드세요.`,
  );
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (state.done)
  deny(
    `runs/${slug} 은(는) 완료된 실행입니다. 다시 작업하려면 verify.mjs reopen 을 먼저 실행하세요.`,
  );
const allowed = state.next === "p3-approval" ? null : RULES[state.next]?.dir;
if (!allowed)
  deny(
    `지금 게이트(${state.next})에서는 runs/${slug} 에 저장할 산출물이 없습니다.`,
  );
if (phaseDir !== allowed)
  deny(
    `지금 게이트는 ${state.next} 입니다. runs/${slug}/${allowed}/ 에만 저장할 수 있습니다 (요청: ${phaseDir}/).`,
  ); // 4)

process.exit(0);
