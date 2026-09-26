# 과제 도메인 독립 분류기 (assignment-classifier-v1)

2026-09-27. 사장님 지시 "사람 모집 없이 엔진 개선안을 찾고 할 수 있는 것은 전부" 에 따른 두 번째 엔진 후보. 첫 번째는 프롬프트 v9c(`engine-gpt-prod/prompts/detect.js`).

## 무엇인가

`lib/detectStyleClassifier.js`(문자 2~4-gram TF-IDF 로지스틱, Platt 보정)로 학습한 모델 `engine-gpt-prod/models/korean-assignment-classifier-v1.json`을 `lib/detectAssignmentClassifier.js`가 감지 파이프라인의 **통계 보조 뒤, 표시 직전**에 적용한다. 분류기 점수가 임계(기본 50) 이상이면 표시 점수를 50~74 구간으로만 올리고, 절대 내리지 않으며 74를 넘기지 않는다. 문장별 원인은 만들지 않으므로 보고서는 "문체 통계가 반영된 점수" 설명(부분 설명)을 쓴다.

- 켜기: `DETECT_ASSIGNMENT_CLASSIFIER_ENABLED=1`(기본 OFF). 임계는 `DETECT_ASSIGNMENT_CLASSIFIER_THRESHOLD`(30~95, 기본 50).
- 캐시 변형 키에 플래그·버전·임계가 들어가 상태가 섞이지 않는다. 응답·이력·로그의 `statisticalSupport`는 `version: assignment-classifier-v1, basis: independent_statistics, originalScore, score, classifierScore, threshold`로 닫힌 형태로 정화된다.
- 범위: 100~20,000자, 한글 비율 ≥ 50%, 인용·표·코드 보호 구간이 없는 문서. 프로필 제한은 없다(아래 교차 도메인 결과 근거).

## 학습 자료

- 사람: 국립국어원 글쓰기 채점 말뭉치 development 분할 대학생 논술 과제 300편(작성자 300명, 로컬 평가 승인 문서 언어정보과-1498). 원문·식별 정보는 모델에 포함되지 않는다.
- AI: 같은 지시문으로 gpt-6-luna/gpt-6-sol이 쓴 일반형("어시스턴트가 과제 답안을 써 준다") 293편.
- 학습 절차: `detectStyleClassifier.train` (가족 단위 3-fold 교차 검증으로 λ 선택, 별도 보정군에서 Platt).

## 평가 (홀드아웃 전)

| 자료 | AUROC | 50점 기준 사람 오탐 | AI 검출 |
|---|---|---|---|
| 개발군: NIKL validation 분할 사람 120(문단 발췌 40 포함) + 신중형 GPT-6 AI 118 | 1.00 | 0/120 | 118/118 (발췌 38/38) |
| 교차 도메인: 2026-09-07 검증 519편(KLUE 설명문·학생 글·NSMC 후기·gpt-5.6 AI) | 0.957 | 0/259 | 100/256 (설명문 83/116, 과제 8/19, 후기 1/97) |

운영 통계 모델(KLUE 학습 `korean-style-statistics-v1`)도 같은 개발군에서 AUROC 0.989였다. 차이는 (1) 과제 발췌를 포함한 짧은 글에서도 작동하고 (2) 임계 50에서 교차 도메인 오탐이 0이라는 점이다. 옛 세대 AI(gpt-5.6)에는 검출 39~51%로 낮다.

## 켜기 전에 필요한 것

1. 홀드아웃(NIKL holdout_candidate 사람 139 + GPT-6 AI 137, 신중형·일반형 반반)에서 프롬프트 v9c와 함께 1회 평가 — 결과는 `reports/detect-engine-improve-20260927/엔진-개선-실측-20260927.md`.
2. 자소서·후기·설명문 사람 글에 대한 별도 확인(교차 도메인 519편이 1차 근거, 운영 프로필별 재확인 필요).
3. 켠 뒤 1시간·24시간에 `statisticalSupport.version=assignment-classifier-v1` 적용률·프로필 분포·전후 점수 확인. 롤백은 env 제거.
