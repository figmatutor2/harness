#!/usr/bin/env node
// PreToolUse hook (judge 에이전트 전용, Bash · use_figma) — judge 는 판정에 필요한 것만 실행할 수 있다.
// Bash 허용:
//   node harness/scripts/verify.mjs <p1|p2|p3-approval|status> <slug>
//   node harness/scripts/verify.mjs <p3|p4|p5> <slug> [--figma-digest <지문>]
//   node harness/scripts/verify.mjs figma-ids <p3|p4|p5> <slug>
//   (앞에 `cd <프로젝트 루트> && ` 가 붙은 형태 포함)
// use_figma 허용: figma-export.figma.js 를 MODE = "digest" 로 실행하는 코드만 (Figma 읽기 전용 대조)
// 차단: exit 2 + stderr 사유.

import fs from "node:fs";

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
  const code = String(input?.tool_input?.code ?? "");
  if (!/const\s+MODE\s*=\s*["']digest["']/.test(code))
    deny(
      'judge 의 use_figma 는 harness/scripts/figma-export.figma.js 를 MODE = "digest" 로 실행할 때만 쓸 수 있습니다.',
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
