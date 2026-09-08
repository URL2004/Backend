# 감지 기록의 휴머나이징 전후 비교

`historyComparison`은 같은 서비스에서 측정한 원글·결과의 문체 점수 비교다. 인간 작성 여부, 외부 AI 검사율, 표절률의 정답으로 사용하지 않는다. `rawProbability`와 화면에 전달하는 `probability`는 독립 필드로 유지한다.

정확한 휴머나이징 이력의 최소 길이는 **바깥 공백을 제거한 원문 100자이며 내부 공백은 포함**한다. 공백 제거·NFKC 정규화는 본문 일치와 hash 비교에 사용하며, 정규화 뒤 100자 미만이라는 이유로 유효한 정확 HMAC 이력을 제외하지 않는다. 실제 원문이 100자 미만이거나 정규화 본문이 비면 보정하지 않는다. 근사 일치의 정규화 길이·문장 수·유사도·편집거리 기준과 출처 검증은 그대로 유지한다.

`lib/detectHistoryComparison.js`는 `humanize-comparison-v1`의 닫힌 스키마와 점수 범위, delta·상태·보정 적용 여부의 일관성을 검증한다. `sourceProbability: null`은 비교할 원글 점수가 없음을 뜻한다. 문자열 점수, 새 필드, 모순된 변화량은 허용하지 않는다.

`historyComparisonProof`는 기존 `OPENAI_SAFETY_SALT`를 사용하는 HMAC-SHA256 문자열이다. 비교 전용 버전, UID, 요청 원문 exact UTF-8 해시, 공개점수, 키를 정렬한 전체 비교 객체에 결합한다. `/detect-report`와 `/analyze`가 최종 공개점수 확정 뒤 발급한다. `/analyze`의 기존 입력 전처리와 별개로 proof는 브라우저가 백업 시 보내는 요청 원문에 결합한다. 키가 없으면 proof는 null이며 일반 결과 전달은 유지된다.

브라우저는 비교 객체와 proof를 그대로 `/history/backup`에 보내고, 일시 실패 시 같은 requestId와 함께 로컬 대기열에 보존한다. 서버는 UID·원문·점수·객체가 모두 검증된 비교만 저장한다. 검증 실패 시 비교를 제외하고 일반 기록 저장은 계속한다. 검증에 성공하면 `rawProbability`는 서명된 비교값을 사용한다. proof 자체는 저장하지 않는다.

비교 proof는 해석 evidence proof와 별개다. 비교 proof만으로 문장 근거를 생성하거나 `savedBy: server`, `serverTrusted: true`, 휴머나이징 이력 무결성을 부여하지 않는다. 백업의 provenance는 `client_backup_api`, `serverTrusted: false`로 남는다. 기존 v3/v4 보정 메타는 `sourceProbability`와 `sourceCapApplied`를 허용하되 점수 0–100, 유사도·길이비·factor 0–1의 유한 수를 검증한다.

검증: `node --test test/detect-history-comparison.test.js test/client-write-api.test.js test/detect-analyze-contract.test.js test/detect-report-failure-policy.test.js`. 외부 모델·실제 Firebase를 호출하지 않으며 HTTP 테스트는 루프백과 합성 자료만 사용한다.
