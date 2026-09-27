#!/usr/bin/env node
// PreToolUse hook (judge 에이전트 전용, Bash · use_figma) — judge 는 판정에 필요한 것만 실행할 수 있다.
// Bash 허용:
//   node harness/scripts/verify.mjs <p1|p2|p3-approval|status> <slug>
//   node harness/scripts/verify.mjs <p3|p4|p5> <slug> [--figma-digest <지문>]
//   node harness/scripts/verify.mjs figma-ids <p3|p4|p5> <slug>
//   (앞에 `cd <프로젝트 루트> && ` 가 붙은 형태 포함)
// use_figma 허용: `verify.mjs figma-ids` 가 출력한 digest 코드만 — figma-export.figma.js 와 비교해
//   MODE 줄("digest")과 FRAME_IDS 줄(노드 ID 문자열 배열)만 다르고 나머지는 글자까지 같아야 한다.
// 차단: exit 2 + stderr 사유.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const deny = (msg) => {
  process.stderr.write(`[harness guard] ${msg}\n`);
  process.exit(2);
};

if (String(input?.tool_name ?? "").endsWith("use_figma")) {
  const norm = (s) => s.replace(/\r\n/g, "\n").trim();
  const idsRe = /^const FRAME_IDS = .*$/m;
  const code = norm(String(input?.tool_input?.code ?? ""));
  const idsLine = code.match(idsRe)?.[0] ?? "";
  const src = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "figma-export.figma.js",
    ),
    "utf8",
  );
  const template = norm(
    src
      .replace(/^const MODE = "export";$/m, 'const MODE = "digest";')
      .replace(idsRe, "__IDS__"),
  );
  const ok =
    /^const FRAME_IDS = \[(?:"[A-Za-z0-9:;-]+"(?:,\s*)?)*\];$/.test(idsLine) &&
    code.replace(idsRe, "__IDS__") === template;
  if (!ok)
    deny(
      "judge 의 use_figma 는 `verify.mjs figma-ids <gate> <slug>` 가 출력한 코드를 한 글자도 바꾸지 않고 실행할 때만 쓸 수 있습니다.",
    );
  process.exit(0);
}

const cmd = String(input?.tool_input?.command ?? "").trim();
const pre = String.raw`^(cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*)?node\s+(\S*\/)?harness\/scripts\/verify\.mjs\s+`;
const slug = String.raw`[a-z0-9][a-z0-9-]*`;
const ok = [
  `(p1|p2|p3-approval|status)\\s+${slug}$`,
  `(p3|p4|p5)\\s+${slug}(\\s+--figma-digest\\s+[0-9a-f]{14}-\\d+)?$`,
  `figma-ids\\s+(p3|p4|p5)\\s+${slug}$`,
].some((tail) => new RegExp(pre + tail).test(cmd));
if (!ok)
  deny(
    `judge 는 'node harness/scripts/verify.mjs <gate> <slug> [--figma-digest <지문>]' 와 'verify.mjs figma-ids <gate> <slug>' 만 실행할 수 있습니다. 파일 확인은 Read/Grep 을 쓰세요. (요청: ${cmd.slice(0, 120)})`,
  );
process.exit(0);
