# Evidence-Grounding (RAG 근거보강) — 격식 C등급 카피킬러 50%대 설계

> 목표: **격식 순수추상 글(C등급, 카피킬러 73~94% 고착)** 을 50%대로 내린다.
> 방법: 추상 문단에 **실재하는 공개 사실(통계·연도·기관·법령·사례)** 을 웹검색으로 찾아 **학생 승인 하에 인용**해 L3 문장밀도를 올린다.
> 이건 기존 엔진(보존형 휴머나이저 + 후처리 패스)이 아닌 **새 경로**다. 격식 C등급에서 학생이 켤 때만 돈다.

---

## 0. 왜 이게 유일한 경로인가 (2026-06-10 확정 데이터)

사람 글 9편 카피킬러 실측 + 우리 엔진 결정론 측정으로 확정:

| 구분 | L3 문장밀도(검증가능 구체) | 카피킬러 |
|---|---|---|
| 사람 격식 보고서/칼럼 (한은·경실련·도시 에세이) | 0.17 ~ 0.80 | 0 ~ 2% |
| 우리 C등급 입력·출력 (경영·도시론) | 0.01 ~ 0.08 | 73 ~ 94% |

- 사람과 우리를 가르는 **유일한 지표 = L3 문장밀도** (`registerscore.measureConcreteness`). register/정형성/burstiness 전부 반증됨(경실련 0%가 완전 격식체).
- 사람은 추상 주장글이라도 **4~6문장에 1개꼴로 검증가능 구체**(법명·날짜·기관·인명·수치)를 박는다.
- 엔진의 두 제약(무날조 + 원문보존)을 동시에 지키면 **원문에 없는 L3를 만들 수 없다** → 73% 하드바닥.
- 사람 최저선 L3 ≈ 0.17 → **9K자 글 기준 실재 구체 15~25개** 가 목표.

**제약 완화 지점**: "원문보존"을 깬다. 단 "무날조"는 **절대 유지** — 엔진이 사실을 *생성*하면 날조지만, 웹검색으로 *실재 확인 + 출처 표기 + 학생 승인*한 사실을 인용하는 건 정상적 리서치다.

---

## 1. 경계 정의 (FLOOR)

| | 내용 | 예 |
|---|---|---|
| **허용** | 웹검색으로 **실재 확인**되고 **출처 URL**이 있으며 **학생이 승인**한 공개 사실을, 원문 추상 문장의 근거로 인용 | "보조금이 줄면 부담이 커진다" → "2024년 국고보조금이 평균 OOO만원으로 전년 대비 축소되면서(출처: 환경부)…" |
| **금지** | 검색 결과에 **없는** 사실(=모델 환각) | 검색이 안 가져온 수치·기관을 모델이 지어냄 |
| **금지** | 학생이 **승인 안 한** 사실 | 후보로 제시됐으나 거절된 것 |
| **금지** | 사실로 인해 **원문 논지 방향**이 뒤집힘 | 보강은 근거 추가지 주장 변경이 아님 |

핵심 구분선: **"LLM이 생성" = 금지 / "웹검색 실재확인 + 출처 + 학생승인" = 허용.**

---

## 2. 2-Phase 흐름

```
Phase 1 (제안)  — engine/evidence.js  [신규]
  입력글 → 추상 segment 탐지(surfaceguard) → segment별 주제 키워드
        → 웹검색(web_search 서버툴)으로 실재 공개사실 후보 N개 수집
        → 환각 게이트: 후보 sourceUrl이 실제 검색결과 URL 목록에 있어야 채택
        → {fact, sourceUrl, sourceTitle, segmentIndex} 목록 반환 (휴머나이즈 안 함)
        ↓
  [학생 승인 UI]  — 프론트  [신규]
        후보를 출처 링크와 함께 보여줌 → 학생이 체크박스로 승인/거절/편집
        ↓
Phase 2 (본 실행)  — 기존 runHumanizeChunked 재사용 (거의 무수정)
  승인된 사실 목록 → userNotes/allowedExtra 로 주입
        → chunkNotes 주제매칭 분배(이미 구현됨, topic-matched)
        → evidence 전용 위빙 프롬프트로 추상 문장을 근거로 구체화(1인칭 장면화 아님)
        → measureNovelty/collectFloorViolations: allowed world = 원문 ∪ 승인사실
        → 미승인·환각 사실이 출력에 나오면 novelty critical 로 자동 차단·폴백
```

**Phase 2가 거의 공짜인 이유**: 승인 사실을 `userNotes`로 흘리면 기존 메모 위빙 경로(`chunkNotes` 분배 + `allowedExtra` FLOOR)가 그대로 처리한다. 신규 코드는 **Phase 1 검색기 + evidence 전용 위빙 프롬프트 블록 + 승인 라우트/UI** 뿐.

---

## 3. 환각·정확성·윤리 3중 방어

1. **환각 차단(결정론)**: 모델이 인용한 `sourceUrl`이 `web_search_tool_result` 블록에 실제로 등장한 URL 집합에 없으면 후보 폐기. 모델이 "지어낸 출처"는 통과 못 함.
2. **사실 정확성(인간)**: 모든 후보를 출처 링크와 함께 학생에게 노출 → 학생 검토·승인. 책임이 학생에게 귀속(정상적 글쓰기 리서치).
3. **FLOOR(기존)**: 승인 사실만 `allowedExtra`로 들어감 → `measureNovelty`가 그 사실은 통과시키고, 승인 안 된·환각 사실이 출력에 새로 나오면 novelty로 차단 → repair/raw 폴백. **즉 학생이 승인 안 한 사실은 절대 출고문에 못 나온다.**

추가: `semanticJudge`는 evidence가 원문 논지와 모순되면 added_claim/distortion으로 잡을 수 있음. 승인 사실을 ledger에도 포함해 judge가 "허용된 근거"로 인지하도록 한다(Phase 2 통합 시).

---

## 4. 신규 모듈: engine/evidence.js

- `llmWebSearch({system,user,signal,maxUses})` — API 백엔드 전용. `web_search_20260209` 서버툴 부착, `pause_turn` resume 루프, `web_search_tool_result`에서 실제 URL 수집.
- `collectResultUrls(content)` — 응답 블록에서 검색이 실제 반환한 URL 집합 추출(환각 게이트 기준).
- `suggestEvidenceForSegment(segText, {lang,signal})` — 한 추상 segment에 대해 후보 수집 + 환각 게이트 + 구조화 파싱.
- `suggestEvidence(rawText, {lang,signal,maxSegments})` — 추상 segment 상위 N개에 대해 병렬 수집 → 후보 목록 반환.

**백엔드 제약**: `web_search`는 Anthropic 서버툴이라 **API 키 필수**(claudecode CLI 경로 불가). `process.env.ANTHROPIC_API_KEY` 없으면 명시적 에러. 로컬 claudecode 테스트로는 Phase 1 검증 불가 → API 키 연결 환경에서 테스트.

**모델/비용**: 검색·판단은 `sonnet-4-6`(엔진 기존 티어) 기본, `EVIDENCE_MODEL`로 override. segment당 1콜 + max_uses 5검색. 9K자 글 ≈ 추상 segment 10~14개 → 상한 `EVIDENCE_MAX_SEGMENTS`(기본 12)로 비용 캡.

---

## 4.5 Phase 2 구현 교훈 (2026-06-10, AI학습 보고서 1차 E2E 실측)

**1차 실패: 사실 생존 2/17.** 원인 = 청크 레벨 FLOOR가 "청크 원문 대비 분량"을 재는데, 200자 문단에 사실(~80자)을 위빙하면 필연적으로 분량 초과 → repair가 위반을 고치며 **위빙된 사실을 도로 깎음.** 또한 청크당 4개 배정은 물리적으로 불가능(분량 2~3배 필요).

**수정(핵심 설계 원칙 확정): "승인 사실은 원문의 일부다."**
- 청크 FLOOR 기준 원문 = `청크 ∪ 배정사실`(cRaw), 전체 FLOOR 기준 = `원문 ∪ 승인사실 전체`(textF).
- 효과: ①분량 정책이 사실 포함 길이 기준 → 위빙이 과확장으로 안 찍힘 ②**measureLostFacts가 사실 누락을 위반으로 잡음 = 생존 강제** — repair가 사실을 깎는 게 아니라 되살리는 방향으로 작동 ③폴백 시에도 승인사실 verbatim 덧붙임(무날조).
- 사실 예산 = 청크 크기 비례(250자당 1개, 최대 3). 제목·80자 미만 청크 배정 금지.
- semanticJudge ledger는 원문 기준 유지(닫힌세계는 원문 주장), evidence는 allowedExtra로만.

## 5. Phase 2 통합 (다음 단계, 미구현)

`runHumanizeChunked`에 `evidence` 경로:
1. `evidenceFacts` 파라미터(승인 목록) 추가. 있으면 `userNotes`처럼 `optIn`/`allowedExtra`로 흐름.
2. **prompt.js에 evidence 전용 위빙 블록**(`evidenceKo`) 신설 — 기존 `anchorKo`("실제 겪은 1인칭 경험→장면화")와 분리. evidence는 *3인칭 격식 인용*("원문 추상 문장을 이 검증된 사실·수치·출처로 뒷받침하라; 1인칭 장면화 금지; 한다체 유지"). ★격식 모드에서 anchorKo를 쓰면 evidence를 1인칭 일화로 바꿔 register가 깨짐 — 반드시 분리.
3. measureNovelty allowedExtra에 evidenceFacts 텍스트 포함(이미 동작). semanticJudge ledger에도 추가.
4. 라우트: `POST /evidence-suggest`(Phase 1) → 후보 반환 / 기존 `/analyze`에 `evidenceFacts` 전달(Phase 2).

---

## 6. 검증 계획

1. **결정론 단위**: `collectResultUrls`가 텍스트/검색결과 블록에서 URL을 정확히 뽑는지(픽스처). 환각 게이트가 "결과에 없는 출처" 후보를 거르는지(가짜 후보 주입).
2. **L3 상승 측정(무료)**: Phase 1 후보를 수동으로 원문에 끼운 mock 출력 → `measureConcreteness`로 L3 0.02 → 0.17+ 도달 확인 → `buildSegmentReport` suspect 비율 하락. **카피킬러 쓰기 전 결정론으로 예측.**
3. **카피킬러 실측**: 경영/도시론 글에 evidence 적용 출력 → 카피킬러. 목표 50%대. 사람 데이터(L3 0.17→0~2%)가 근거이나 실측이 판정자.
4. **FLOOR 회귀**: 승인 안 한 사실을 강제로 출력에 주입한 케이스 → novelty critical 차단되는지(eval). 기존 88 케이스 무영향(evidence off 기본).

---

## 7. 미해결·결정 필요

- **출처 표기 형식**: 본문 인용 "(환경부, 2024)" vs 각주 vs 미표기. 과제 제출물이라 인용 형식은 학교 규정 따름 → 학생 선택지로. 미표기 시 표절 우려 → 최소 괄호 출처 권장.
- **검색 신뢰도**: 위키·블로그 저신뢰 출처 필터링(`allowed_domains`/`blocked_domains`로 정부·언론·학술 우선).
- **사실 최신성**: 2025~26 통계는 변동 → "검색일 명시" + 학생 검증 의존.
- **비용**: segment 12개 × (검색 1콜) ≈ 회당 추가 비용. `EVIDENCE_MAX_SEGMENTS`로 캡, API 병렬화로 속도.
