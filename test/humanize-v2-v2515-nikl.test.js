'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const officialApi = require('../engine/koreanQuality/officialApi');
const advisor = require('../engine-gpt-prod/niklAdvisor');

function response(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json)
  };
}

function withKey(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
}

test('표준국어대사전 응답의 배열 sense와 표제어 공백 기호를 정상화한다', async () => {
  let requested = null;
  await withKey('NIKL_STDICT_API_KEY', '0'.repeat(32), async () => {
    const result = await officialApi.lookupStdDict('학술 용어', {
      disableCache: true,
      fetchImpl: async url => {
        requested = new URL(url);
        return response({
          channel: {
            total: 1,
            item: [{
              word: '학술^용어',
              pos: '명사',
              sense: [{ type: '전문어', cat: '언어' }]
            }]
          }
        });
      }
    });
    assert.equal(result.items[0].word, '학술 용어');
    assert.equal(result.items[0].type, '전문어');
    assert.equal(result.items[0].cat, '언어');
    assert.equal(result.cacheHit, false);
  });
  assert.equal(requested.searchParams.get('target'), '1');
  assert.equal(requested.searchParams.get('method'), 'exact');
  assert.equal(requested.searchParams.get('num'), '10');
});

test('우리말샘은 규범정보가 아니라 표제어를 정확 일치로 조회한다', async () => {
  let requested = null;
  await withKey('NIKL_OPENDICT_API_KEY', '1'.repeat(32), async () => {
    const result = await officialApi.lookupOpenDict('내부 성적서', {
      disableCache: true,
      fetchImpl: async url => {
        requested = new URL(url);
        return response({
          channel: {
            total: 1,
            item: {
              word: '내부^성적서',
              sense: {
                target_code: 1234,
                pos: '명사',
                type: '전문어'
              }
            }
          }
        });
      }
    });
    assert.equal(result.items[0].word, '내부 성적서');
    assert.equal(result.items[0].targetCode, '1234');
  });
  assert.equal(requested.searchParams.get('target'), '1');
  assert.equal(requested.searchParams.get('method'), 'exact');
  assert.equal(requested.searchParams.has('norm'), false);
});

test('온용어 공식 return_object/resultlist 응답과 공공누리 유형을 파싱한다', async () => {
  let requested = null;
  await withKey('NIKL_TERM_API_KEY', '2'.repeat(32), async () => {
    const result = await officialApi.lookupTerm('학술 용어', {
      disableCache: true,
      fetchImpl: async url => {
        requested = new URL(url);
        return response({
          channel: {
            total: 2,
            return_object: [{
              returnCode: 1,
              resultlist: [
                {
                  word: '학술^용어',
                  category_main: '인문학',
                  category_sub: '언어학',
                  source: '국립국어원',
                  glossary: '우리말샘',
                  kr_gvrn_lcns_ty: 1
                },
                {
                  word: '비공개^용어',
                  source: '외부',
                  glossary: '제한 자료',
                  kr_gvrn_lcns_ty: 2
                }
              ]
            }]
          }
        });
      }
    });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map(item => item.word), ['학술 용어']);
    assert.equal(result.filteredNonCommercial, 1);
  });
  assert.equal(requested.searchParams.get('num'), '10');
  assert.equal(requested.searchParams.get('sort'), 'wt');
});

test('국립국어원 HTTP 200 오류 응답도 조용한 빈 결과가 아니라 계약 오류로 분리한다', async () => {
  await withKey('NIKL_TERM_API_KEY', '3'.repeat(32), async () => {
    await assert.rejects(
      officialApi.lookupTerm('학술 용어', {
        disableCache: true,
        fetchImpl: async () => response({
          channel: {
            total: 0,
            return_object: [{ returnCode: '020', message: 'Unregistered Authentication Key' }]
          }
        })
      }),
      /api_error_020/
    );
  });
});

test('HTTP 200 API 오류 응답은 캐시하지 않고 다음 요청에서 다시 조회한다', async () => {
  const store = { version: officialApi.VERSION, entries: {} };
  let calls = 0;
  await withKey('NIKL_TERM_API_KEY', '5'.repeat(32), async () => {
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return response({
          channel: {
            return_object: [{ returnCode: '020', message: 'Unregistered Authentication Key' }]
          }
        });
      }
      return response({
        channel: {
          total: 1,
          return_object: [{
            returnCode: 1,
            resultlist: [{ word: '회로^설계', kr_gvrn_lcns_ty: 1 }]
          }]
        }
      });
    };
    await assert.rejects(
      officialApi.lookupTerm('회로 설계', { cacheStore: store, fetchImpl }),
      /api_error_020/
    );
    assert.equal(Object.keys(store.entries).length, 0);
    const result = await officialApi.lookupTerm('회로 설계', { cacheStore: store, fetchImpl });
    assert.equal(calls, 2);
    assert.equal(result.items[0].word, '회로 설계');
    assert.equal(Object.keys(store.entries).length, 1);
  });
});

test('외부 API timeout과 캐시 키는 원문 용어를 노출하지 않는다', async () => {
  const cacheKey = officialApi.hashedCacheKey('stdict', '내부 성적서');
  assert.match(cacheKey, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(cacheKey, /내부|성적서/);

  await withKey('NIKL_STDICT_API_KEY', '4'.repeat(32), async () => {
    await assert.rejects(
      officialApi.lookupStdDict('내부 성적서', {
        disableCache: true,
        timeoutMs: 100,
        fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      }),
      /nikl_api_timeout/
    );
  });
});

test('외부 후보는 문서당 최대 2개이며 인용·개인정보·기관명은 제외한다', () => {
  const source = [
    '김민수 연구원은 “내부 성적서”라고 말했다.',
    '연락처는 010-1234-5678이며 서울시 강남구에 거주한다.',
    '경상국립대학교에서 회로 설계와 공정 조건을 비교했다.'
  ].join(' ');
  const selected = advisor.selectCandidates(source, [
    '김민수',
    '내부 성적서',
    '010-1234-5678',
    '서울시 강남구',
    '경상국립대학교',
    '김민수 연구원',
    '회로 설계',
    '공정 조건'
  ], { max: 2 });
  assert.deepEqual(selected.map(item => item.value).sort(), ['공정 조건', '회로 설계']);
});

test('polish는 쉬운 말 치환 힌트를 받지 않는다', async () => {
  let analysisCalls = 0;
  const context = await advisor.prepareDocumentAdvisor({
    text: '데이터셋을 공개했습니다.',
    documentProfile: { profile: 'long_explainer' },
    requestStrength: 'polish',
    resources: {
      analyzeOfficialQuality() {
        analysisCalls += 1;
        return {
          publicLanguageMatches: [{ term: '데이터셋', alternatives: ['데이터 집합'] }]
        };
      }
    },
    env: {
      GPT_NIKL_LOCAL_RESOURCE_ENABLED: '1',
      GPT_NIKL_EXTERNAL_API_ENABLED: '0'
    }
  });
  assert.equal(analysisCalls, 0);
  assert.equal(advisor.buildPromptHints(context, '데이터셋을 공개했습니다.'), '');
  assert.equal(advisor.compactMeta(context).localResourceEnabled, false);
});

test('외부 API는 문서당 한 번 준비하고 해당 청크에만 비강제 표기 힌트를 준다', async () => {
  const calls = [];
  const fakeApi = {
    getApiStatus() {
      return { keys: { opendict: true, stdict: true, term: true } };
    },
    async lookupCandidate(query, opts) {
      calls.push({ query, providers: opts.providers });
      return {
        query,
        providers: {
          stdict: {
            total: 1,
            cacheHit: calls.length === 1,
            items: [{ word: query }]
          }
        },
        warnings: []
      };
    }
  };
  const context = await advisor.prepareDocumentAdvisor({
    text: '회로 설계를 검토했다. 이어서 공정 조건을 비교했다.',
    protectedTerms: ['회로 설계', '공정 조건'],
    documentProfile: { profile: 'resume_application' },
    includeLocal: false,
    api: fakeApi,
    env: {
      GPT_NIKL_EXTERNAL_API_ENABLED: '1',
      GPT_NIKL_API_LOOKUP_MAX: '99',
      GPT_NIKL_API_PROVIDERS: 'stdict,opendict,term',
      NIKL_API_TIMEOUT_MS: '1200'
    }
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].providers, ['stdict', 'opendict', 'term']);

  const firstHints = advisor.buildPromptHints(context, '회로 설계를 검토했다.');
  assert.match(firstHints, /국립국어원 사전 표기 보조/);
  assert.match(firstHints, /회로 설계/);
  assert.doesNotMatch(firstHints, /공정 조건/);
  assert.doesNotMatch(firstHints, /정의문을 복사하지 말고[\s\S]*뜻풀이:/);

  const meta = advisor.compactMeta(context);
  assert.equal(meta.externalLookupCount, 2);
  assert.equal(meta.externalHitCount, 2);
  assert.equal(meta.externalAppliedCount, 1);
  assert.equal(meta.externalCacheHitCount, 1);
  assert.doesNotMatch(JSON.stringify(meta), /회로 설계|공정 조건/);
});

test('공식 쉬운 말 자료는 일반 독자용 글에만 적용하고 학술문에는 주입하지 않는다', async () => {
  let analysisCalls = 0;
  const resources = {
    analyzeOfficialQuality() {
      analysisCalls += 1;
      return {
        publicLanguageMatches: [{
          term: '데이터셋',
          alternatives: ['데이터 집합']
        }]
      };
    }
  };
  const general = await advisor.prepareDocumentAdvisor({
    text: '데이터셋을 공개했습니다.',
    documentProfile: { profile: 'long_explainer' },
    resources,
    env: {
      GPT_NIKL_LOCAL_RESOURCE_ENABLED: '1',
      GPT_NIKL_EXTERNAL_API_ENABLED: '0'
    }
  });
  const hints = advisor.buildPromptHints(general, '데이터셋을 공개했습니다.');
  assert.match(hints, /데이터 집합/);
  assert.match(hints, /전문 용어·고유명/);

  const academic = await advisor.prepareDocumentAdvisor({
    text: '본 연구는 데이터셋을 분석하였다.',
    documentProfile: { profile: 'academic_paper' },
    resources,
    env: {
      GPT_NIKL_LOCAL_RESOURCE_ENABLED: '1',
      GPT_NIKL_EXTERNAL_API_ENABLED: '0'
    }
  });
  assert.equal(advisor.buildPromptHints(academic, '본 연구는 데이터셋을 분석하였다.'), '');
  assert.equal(analysisCalls, 1);
});

test('공식 용어의 실제 입력 변형도 해당 청크의 쉬운 말 힌트에 연결한다', async () => {
  const context = await advisor.prepareDocumentAdvisor({
    text: '데이터 라벨링 절차를 설명합니다.',
    documentProfile: { profile: 'long_explainer' },
    resources: {
      analyzeOfficialQuality() {
        return {
          publicLanguageMatches: [{
            term: '데이터 레이블러',
            samples: ['데이터 라벨링'],
            alternatives: ['데이터 주석']
          }]
        };
      }
    },
    env: {
      GPT_NIKL_LOCAL_RESOURCE_ENABLED: '1',
      GPT_NIKL_EXTERNAL_API_ENABLED: '0'
    }
  });
  const hints = advisor.buildPromptHints(context, '데이터 라벨링 절차를 설명합니다.');
  assert.match(hints, /데이터 레이블러/u);
  assert.match(hints, /데이터 주석/u);
  assert.equal(advisor.compactMeta(context).localAppliedCount, 1);
});

test('창작문은 외부 플래그가 켜져도 사전 API에 보내지 않는다', async () => {
  let called = 0;
  const context = await advisor.prepareDocumentAdvisor({
    text: '바람의 구조를 따라 마음의 회로를 그렸다.',
    protectedTerms: ['마음의 회로'],
    documentProfile: { profile: 'creative' },
    includeLocal: false,
    api: {
      getApiStatus: () => ({ keys: { stdict: true } }),
      lookupCandidate: async () => {
        called += 1;
        return null;
      }
    },
    env: {
      GPT_NIKL_EXTERNAL_API_ENABLED: '1',
      GPT_NIKL_API_PROVIDERS: 'stdict'
    }
  });
  assert.equal(called, 0);
  assert.equal(advisor.compactMeta(context).externalApiEnabled, false);
});

test('외부 API 실패는 결과 차단 없이 익명 집계만 남긴다', async () => {
  const context = await advisor.prepareDocumentAdvisor({
    text: '회로 설계를 검토했다.',
    protectedTerms: ['회로 설계'],
    documentProfile: { profile: 'resume_application' },
    includeLocal: false,
    api: {
      getApiStatus: () => ({ keys: { stdict: true } }),
      lookupCandidate: async () => {
        throw new Error('nikl_api_timeout');
      }
    },
    env: {
      GPT_NIKL_EXTERNAL_API_ENABLED: '1',
      GPT_NIKL_API_PROVIDERS: 'stdict'
    }
  });
  const meta = advisor.compactMeta(context);
  assert.equal(meta.externalErrorCount, 1);
  assert.equal(meta.externalTimeoutCount, 1);
  assert.equal(advisor.buildPromptHints(context, '회로 설계를 검토했다.'), '');
});
