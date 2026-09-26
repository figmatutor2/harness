# 허들링 디자인 하네스

이 폴더는 허들링 앱의 화면을 **P1 리서치 → P2 설계 → P3 시안(+내부 컨펌) → P4 제작·검증** 순서로 만드는 하네스입니다.

## 자연어 요청 라우팅 (필수)

아래와 같은 요청은 슬래시 명령이 없어도 **`run-harness` 스킬을 불러와 그 절차대로** 진행합니다.

- "○○ 화면 하네스 돌려줘 / 디자인 시작해줘 / 만들어줘"
- "○○ 화면 작업 이어서 해줘", "하네스 상태 알려줘"
- "컨펌 받았어", "반려됐어", "approval.md 썼어"

## 파일 역할

| 파일                                    | 역할                                                 | 수정           |
| --------------------------------------- | ---------------------------------------------------- | -------------- |
| `story-service.md`                      | 무엇을 위한 일인지 (유저스토리, ★ 어기면 안 되는 것) | 사람           |
| `story-work.md`                         | 실제로 어떻게 하는지 (①~⑦ 작업 흐름)                 | 사람           |
| `harness/rules.yaml`                    | **규칙 SSOT** — 게이트 판정 기준                     | 사람           |
| `prd.md`, `design.md`                   | 제품·디자인 설명 문서                                | 사람           |
| `harness/scripts/verify.mjs`            | 게이트 판정 스크립트                                 | —              |
| `harness/templates/`                    | Phase 산출물 양식                                    | —              |
| `runs/<slug>/state.json`                | 진행 상태 (재개 기준)                                | **스크립트만** |
| `runs/<slug>/p3-concept/approval.md`    | 내부 컨펌 결과                                       | **사람만**     |
| `runs/<slug>/p4-build/verify-report.md` | 최종 검증 리포트                                     | **스크립트만** |
| `harness/guides/figma-design-guide.md`  | Figma 제작 가이드 (화면 골격·이름·타이포·색·모서리)  | 사람           |
| `harness/defaults.yaml`                 | 정하지 않은 값의 기본값 (`source: 임의` = 확인 대상) | 사람           |

## 에이전트와 편집 폴더

작업 에이전트는 파일을 직접 쓰지 않고 `=== FILE: … ===` 블록으로 반환하며, 오케스트레이터(메인 세션)가 내용을 고치지 않고 아래 폴더에만 저장합니다.

| 에이전트           | Phase       | 산출물 저장 위치 (오케스트레이터가 저장)                                        |
| ------------------ | ----------- | ------------------------------------------------------------------------------- |
| `researcher`       | P1          | `runs/<slug>/p1-research/`                                                      |
| `spec-writer`      | P2          | `runs/<slug>/p2-spec/`                                                          |
| `concept-designer` | P3          | `runs/<slug>/p3-concept/` (approval.md 제외) + Figma P3 페이지                  |
| `builder`          | P4          | `runs/<slug>/p4-build/` (verify-report.md 제외) + Figma P4 페이지·토큰·컴포넌트 |
| `judge`            | 모든 게이트 | 없음 (읽기 + `verify.mjs` 실행만)                                               |

## 명령

```bash
node harness/scripts/verify.mjs init <slug> --topic "<화면 주제>" --figma <Figma URL>
node harness/scripts/verify.mjs <p1|p2|p3|p3-approval|p4> <slug>
node harness/scripts/verify.mjs status <slug>
node harness/scripts/verify.mjs unblock <slug>   # 사람이 요청할 때만
```

처음 받은 환경에서는 `cd harness && npm install` 을 한 번 실행합니다 (`yaml` 패키지).

## 참고

- 상위 폴더의 `CLAUDE.md`(React/Storybook 컴포넌트 규칙)는 코드 구현용입니다. 이 하네스의 산출물은 문서와 Figma이므로 여기서는 이 파일의 규칙이 우선합니다.
- Figma에서 기존 섹션이 있는 페이지의 (0,0)에 `createSection()`을 쓰지 않습니다 (기존 내용이 지워질 수 있음).
