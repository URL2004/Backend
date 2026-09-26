# 표시 척도 후보 (detect-scale-calibration-v1)

2026-09-26. 사장님 지시 "구간 경계 재설정·짧은 글 척도 두 가지를 전부 작업하고 테스트까지"에 따라 두 후보를 **플래그 뒤에 구현**하고 기존 519편 자료로 개발 단계 평가를 했다. 기본은 꺼져 있다. 점수 분포를 올리는 것은 목표가 아니며, 사전 고정한 사람 오탐률(5%) 안에서 AI 검출이 개선되는지가 기준이다.

## 작동 위치와 범위

`lib/detectScaleCalibration.js`는 모델 → 재판정 → 원인 상한 → 통계 보조 → 이력 보정이 끝난 **표시 직전** 점수만 조각 선형 표로 바꾼다.

- `DETECT_SCALE_CALIBRATION_ENABLED=1` 과 `DETECT_SCALE_CALIBRATION_RULES=<규칙 id,…>` 둘 다 있어야 켜진다.
- 규칙 표는 `engine-gpt-prod/models/detect-scale-calibration-v1.json`. `status: rejected_development` 규칙은 id를 적어도 적용되지 않는다.
- 캐시(`detectResultStability`)·`rawProbability`·원글 점수 상한·과금은 바뀌지 않는다. 적용되면 응답·이력·`detect_report.score_outcome` 로그에 닫힌 메타 `scaleCalibration {version, applied, rule, before, after, chars, profile}` 가 붙고 `rawProbability`(엔진 점수)가 함께 나간다.
- 척도가 적용된 요청은 이력 증감 비교(`historyComparison`)를 내보내지 않는다. 원글 점수와 같은 자가 아니기 때문이다.
- 표시 점수가 오르면 원인 수 요건(≥50은 적격 원인 2개)에 못 미쳐 보고서가 "원인 설명이 충분하지 않아요"(partial)로 표시될 수 있다. 이는 의도된 정직한 표시다.

## 개발 단계 평가 (reports/detect-score-copy-20260926/scale-analysis.md)

자료: 2026-09-07 검증 519편의 저장 점수. 이미 보고서에 쓰인 자료라 여기서 고른 임계값은 **개발 단계 추정**이며 출시 판단에는 새 홀드아웃이 필요하다.

| 후보 | 범위 | 50점 이상 사람 오탐 전→후 | AI 검출 전→후 | 페어드 기준 | 고정 오탐 5% |
|---|---|---|---|---|---|
| `short_review_scale` (엔진 18→표시 50) | 300자 미만 · 프로필 general/unknown/review_blog | 0/100 → 4/100 (4.0%, 상한 9.8%) | 0/100 → 74/100 | 미달(오탐 비증가 조건) | 점추정 통과 · 상한 미달 |
| `long_prose_boundary_40` (경계 50→40) | 300자 이상 | 23/160 (14.4%) → 31/160 (19.4%) | 142/159 → 147/159 | 미달 | 미달 (25~60 어느 경계도 5% 이하 없음, 60에서 6.9%·검출 35%) |

- 긴 글의 문제는 경계가 아니라 판별력이다. 현행 50에서도 사람 설명문 오탐이 12/116(10.3%)이고, 경계를 낮추면 오탐만 는다. 이 규칙은 기각 상태로 표에 남긴다.
- 짧은 글은 판별력(AUROC 0.96)이 있는데 척도가 없어 사람 중앙값 5·AI 중앙값 18이 모두 0~20에 몰린다. 18→50 대응은 점추정 오탐 4%지만 100편 표본이라 상한이 9.8%다. 자소서·과제의 300자 미만 발췌는 대조군이 없어 범위 밖이며, 그 프로필은 규칙 범위에서 뺐다.

## 켜기 전에 필요한 것

1. 짧은 글 새 홀드아웃(사람 통제 ≥300편·AI ≥300편, 후기 외 장르 포함)에서 오탐 상한 5% 이하 확인.
2. 켠 뒤 1시간·24시간에 `reports/detect-score-copy-20260926/score-distribution.local.cjs`로 분포·`scaleCalibration` 적용 건수 확인.
3. 롤백은 env 두 개 제거뿐이며 저장된 점수는 소급 변경하지 않는다.
