# 허들링 디자인 하네스

이 폴더는 허들링 앱의 화면을 **P1 리서치 → P2 설계(+화면 목록) → P3 키스크린 시안(+내부 컨펌) → P4 시스템 확장 → P5 유저 플로우 화면** 순서로 만드는 하네스입니다.

## 자연어 요청 라우팅 (필수)

아래와 같은 요청은 슬래시 명령이 없어도 **`run-harness` 스킬을 불러와 그 절차대로** 진행합니다.

- "○○ 화면 하네스 돌려줘 / 디자인 시작해줘 / 만들어줘"
- "○○ 화면 작업 이어서 해줘", "하네스 상태 알려줘"
- "컨펌 받았어", "반려됐어", "approval.md 썼어"

## 파일 역할

| 파일                                   | 역할                                                  | 수정           |
| -------------------------------------- | ----------------------------------------------------- | -------------- |
| `docs/story-service.md`                | 무엇을 위한 일인지 (유저스토리, ★ 어기면 안 되는 것)  | 사람           |
| `docs/story-work.md`                   | 실제로 어떻게 하는지 (①~⑦ 작업 흐름)                  | 사람           |
| `harness/rules.yaml`                   | **규칙 SSOT** — 게이트 판정 기준                      | 사람           |
| `docs/prd.md`, `docs/design.md`        | 제품·디자인 설명 문서                                 | 사람           |
| `harness/scripts/verify.mjs`           | 게이트 판정 스크립트                                  | —              |
| `harness/scripts/save-blocks.mjs`      | 큰 반환 블록을 경로 검사 후 그대로 저장               | —              |
| `harness/scripts/save-export.mjs`      | 에이전트 `use_figma` 기록에서 export 조각을 합쳐 저장 | —              |
| `harness/templates/`                   | Phase 산출물 양식                                     | —              |
| `runs/<slug>/state.json`               | 진행 상태 (재개 기준)                                 | **스크립트만** |
| `runs/<slug>/p3-concept/approval.md`   | 내부 컨펌 결과                                        | **사람만**     |
| `runs/<slug>/p5-flow/verify-report.md` | 최종 검증 리포트                                      | **스크립트만** |
| `harness/guides/figma-design-guide.md` | Figma 제작 가이드 (화면 골격·이름·타이포·색·모서리)   | 사람           |
| `harness/defaults.yaml`                | 정하지 않은 값의 기본값 (`source: 임의` = 확인 대상)  | 사람           |

기준 문서 4개는 `docs/`에 있습니다. 규칙·가이드·에이전트에서 문서 이름만 적힌 곳(`design.md` 위반, `source: design.md`, `story-work.md` ③ 단계 등)은 모두 `docs/` 아래 파일을 가리킵니다.

## 에이전트와 편집 폴더

작업 에이전트는 파일을 직접 쓰지 않고 `=== FILE: … ===` 블록으로 반환하며, 오케스트레이터(메인 세션)가 내용을 고치지 않고 아래 폴더에만 저장합니다.

| 에이전트           | Phase       | 산출물 저장 위치 (오케스트레이터가 저장)                                           |
| ------------------ | ----------- | ---------------------------------------------------------------------------------- |
| `researcher`       | P1          | `runs/<slug>/p1-research/`                                                         |
| `spec-writer`      | P2          | `runs/<slug>/p2-spec/`                                                             |
| `concept-designer` | P3          | `runs/<slug>/p3-concept/` (approval.md 제외) + Figma P3 페이지                     |
| `builder`          | P4          | `runs/<slug>/p4-system/` + Figma P4 시스템 페이지·토큰·컴포넌트                    |
| `flow-designer`    | P5          | `runs/<slug>/p5-flow/` (verify-report.md 제외) + Figma P5 플로우 페이지            |
| `judge`            | 모든 게이트 | 없음 (읽기 + `verify.mjs` 실행 + P3~P5 Figma 지문 대조(digest 모드 `use_figma`)만) |

## 명령

```bash
node harness/scripts/verify.mjs init <slug> --topic "<화면 주제>" --figma <Figma URL>
node harness/scripts/verify.mjs <p1|p2|p3-approval> <slug>
node harness/scripts/verify.mjs <p3|p4|p5> <slug> --figma-digest <지문>   # judge가 Figma에서 받은 지문
node harness/scripts/verify.mjs figma-ids <p3|p4|p5> <slug>               # 지문을 받을 fileKey·프레임 ID
node harness/scripts/save-export.mjs <slug> <agentId>                    # 작업 에이전트 기록에서 export 조각을 합쳐 저장 (P3·P4·P5)
node harness/scripts/verify.mjs status <slug>
node harness/scripts/verify.mjs unblock <slug>   # 사람이 요청할 때만
node harness/scripts/verify.mjs reopen <slug> --from <gate>   # 완료·진행 중 실행을 특정 게이트부터 다시 열기
node harness/scripts/verify.mjs proceed <slug>   # P1·P2·P4 통과 후 사용자 확인 대기 해제 (사용자가 진행을 지시했을 때만)
```

처음 받은 환경에서는 `cd harness && npm install` 을 한 번 실행합니다 (`yaml` 패키지).

## 참고

- 저장 권한은 hook으로 강제됩니다: `.claude/settings.json`(guard-write: runs/ 안은 현재 게이트 폴더만, state.json·verify-report.md·approval.md·서브에이전트 쓰기 차단 / guard-review: 사용자 확인 대기 중 작업 에이전트 호출 차단), `judge` frontmatter(guard-judge-bash: verify.mjs 판정 명령과 digest 모드 `use_figma`만 허용).
- 컨펌 잠금: p3-approval 통과 시 screen-spec·concepts·approval.md 해시가 state.json에 기록됩니다. 승인 뒤 바뀌면 컨펌이 무효(`approval-stale-<n>.md`로 보관)가 되고 P4·P5도 판정하지 않습니다. Bash로 쓰는 파일은 hook이 보지 못하므로 runs/ 에는 Bash로 쓰지 않습니다.

- 상위 폴더의 `CLAUDE.md`(React/Storybook 컴포넌트 규칙)는 코드 구현용입니다. 이 하네스의 산출물은 문서와 Figma이므로 여기서는 이 파일의 규칙이 우선합니다.
- Figma에서 기존 섹션이 있는 페이지의 (0,0)에 `createSection()`을 쓰지 않습니다 (기존 내용이 지워질 수 있음).
