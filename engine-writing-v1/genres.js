'use strict';

const SECTION_LABELS = Object.freeze({
  essentials: { label: '기본 정보', description: '무엇을 왜 쓰는지 먼저 알려주세요.' },
  details: { label: '구체적인 내용', description: '글의 근거가 될 실제 정보와 행동을 적어주세요.' },
  reflection: { label: '평가와 마무리', description: '느낀 점, 결과, 독자가 할 행동을 정리해요.' }
});

function field(key, label, section, categories, options = {}) {
  return Object.freeze({
    key,
    label,
    section,
    categories: Array.isArray(categories) ? categories : [categories],
    type: options.type || 'textarea',
    rows: options.rows || (options.type === 'text' ? 1 : 3),
    maxLength: options.maxLength || (options.type === 'text' ? 240 : 1200),
    importance: options.importance || 'helpful',
    placeholder: options.placeholder || '',
    help: options.help || '',
    examples: options.examples || [],
    options: options.options || []
  });
}

const GENRES = Object.freeze({
  resume: Object.freeze({
    label: '자기소개서',
    description: '문항과 실제 경험을 연결해 지원서 답변을 만들어요.',
    documentProfile: 'resume_application',
    basicStyle: 'report',
    register: "종결체는 '-습니다'로 통일하고 1인칭은 '저'를 쓴다.",
    defaultTarget: 400,
    maxFeasible: 1400,
    subtypes: [
      ['motivation', '지원동기'], ['competency', '직무 역량'], ['collaboration', '협업·갈등'],
      ['challenge', '도전·문제 해결'], ['values', '성장 과정·가치관'],
      ['future', '입사 후 포부'], ['free', '자유 문항']
    ],
    fields: [
      field('prompt', '자기소개서 문항', 'essentials', 'prompt', {
        importance: 'core', rows: 2, placeholder: '예: 공동의 목표를 위해 협업한 경험을 600자 이내로 작성해 주세요.',
        help: '문항을 그대로 붙여 넣으면 묻는 내용과 글자 수 조건을 함께 확인해요.'
      }),
      field('company', '지원 회사·기관', 'essentials', 'context', { type: 'text', placeholder: '예: 지원할 회사명', importance: 'optional' }),
      field('role', '지원 직무', 'essentials', 'context', { type: 'text', placeholder: '예: 서비스 기획 인턴', importance: 'helpful' }),
      field('situation', '당시 상황', 'details', 'situation', {
        placeholder: '언제, 어디에서, 누구와 어떤 일을 했는지 적어주세요.', importance: 'helpful'
      }),
      field('goal', '해결해야 했던 목표·문제', 'details', 'situation', {
        placeholder: '예: 일정이 밀린 4명 팀 프로젝트를 마감일까지 제출해야 했어요.', importance: 'helpful'
      }),
      field('personalActions', '내가 직접 한 행동', 'details', 'action', {
        importance: 'core', placeholder: '내가 직접 판단하고 실행한 행동을 순서대로 적어주세요.',
        help: '팀 전체 행동이 아니라 본인이 직접 한 행동을 구분해 주세요.'
      }),
      field('teamActions', '팀 전체가 한 행동', 'details', 'team_action', {
        placeholder: '팀이 함께 한 일은 여기에 따로 적어주세요.', importance: 'optional'
      }),
      field('result', '확인 가능한 결과', 'reflection', 'outcome', {
        placeholder: '수치가 없어도 제출 완료, 일정 단축, 피드백처럼 확인 가능한 변화를 적을 수 있어요.', importance: 'helpful'
      }),
      field('learning', '배운 점과 직무 연결', 'reflection', 'reflection', {
        placeholder: '이 경험에서 실제로 배운 점과 지원 직무에서 어떻게 활용할지 적어주세요.', importance: 'helpful'
      }),
      field('preserve', '바꾸면 안 되는 표현·사실', 'reflection', 'constraint', {
        placeholder: '고유명사, 정확한 역할명 등 그대로 유지할 내용을 적어주세요.', importance: 'optional'
      })
    ],
    readiness: {
      default: [['prompt'], ['action'], ['outcome', 'reflection']],
      future: [['prompt'], ['context'], ['reflection']],
      motivation: [['prompt'], ['context'], ['action', 'reflection']]
    }
  }),

  review_blog: Object.freeze({
    label: '블로그·후기',
    description: '직접 방문·사용한 정보와 평가만으로 후기를 만들어요.',
    documentProfile: 'review_blog',
    basicStyle: 'blog',
    register: "종결체는 '-해요'를 기본으로 자연스럽게 쓴다.",
    defaultTarget: 370,
    maxFeasible: 2200,
    subtypes: [
      ['place_visit', '장소 방문'], ['product_use', '상품 사용'], ['service_use', '서비스 이용'],
      ['event_trip', '행사·전시·여행'], ['other', '기타 경험']
    ],
    fields: [
      field('subject', '무엇을 어디서 이용했나요?', 'essentials', 'subject', {
        importance: 'core', rows: 2, placeholder: '예: 원종동의 카페를 방문했어요.',
        help: '정확한 상호가 기억나지 않으면 지역과 장소 종류만 적어도 돼요.'
      }),
      field('timing', '방문·사용 시점', 'essentials', 'transaction', { type: 'text', placeholder: '예: 2026년 8월 토요일 오후', importance: 'optional' }),
      field('companions', '함께한 사람·인원', 'essentials', 'transaction', { type: 'text', placeholder: '예: 친구 1명과 방문', importance: 'optional' }),
      field('items', '주문·구매·이용한 항목', 'details', 'experience', {
        placeholder: '메뉴, 상품명, 이용한 서비스처럼 직접 선택한 내용을 적어주세요.', importance: 'helpful'
      }),
      field('spending', '가격·총 지출', 'details', 'transaction', {
        placeholder: '예: 총 30,000원 결제. 항목별 가격을 알면 함께 적어주세요.', importance: 'helpful'
      }),
      field('observations', '직접 확인한 정보', 'details', 'experience', {
        placeholder: '위치, 대기, 좌석, 시설, 서비스처럼 직접 확인한 것만 적어주세요.', importance: 'core'
      }),
      field('sequence', '인상 깊었던 장면·이용 순서', 'details', 'experience', {
        placeholder: '기억나는 순서가 있을 때만 적어주세요.', importance: 'optional'
      }),
      field('impressions', '직접 느낀 점·장단점', 'reflection', 'evaluation', {
        importance: 'core', placeholder: '맛, 사용감, 분위기, 장점과 아쉬움을 실제 느낀 범위에서 적어주세요.'
      }),
      field('recommendation', '추천 대상·재방문 의사', 'reflection', 'evaluation', {
        placeholder: '누구에게 맞는지, 다시 이용할 생각이 있는지 적어주세요.', importance: 'optional'
      }),
      field('sponsorship', '제공·협찬 여부', 'reflection', 'disclosure', {
        type: 'select', importance: 'helpful', options: [
          ['', '선택해 주세요'], ['self_paid', '직접 결제했어요'], ['provided', '상품·서비스를 제공받았어요'],
          ['sponsored', '광고비를 받았어요'], ['unknown', '확실하지 않아요']
        ], help: '대가를 받은 글은 결과에 고지 문구를 포함해야 해요.'
      })
    ],
    readiness: { default: [['subject'], ['experience'], ['evaluation']] }
  }),

  marketing: Object.freeze({
    label: '상품·서비스 소개',
    description: '검증된 기능과 조건만으로 소개 문구를 만들어요.',
    documentProfile: 'marketing',
    basicStyle: 'blog',
    register: "종결체는 '-해요'와 명사형을 자연스럽게 섞는다.",
    defaultTarget: 440,
    maxFeasible: 1800,
    subtypes: [
      ['product_page', '상세페이지 소개'], ['landing', '랜딩페이지 문구'], ['social', 'SNS 게시글'],
      ['service', '서비스 소개'], ['release', '출시·업데이트 안내']
    ],
    fields: [
      field('product', '상품·서비스명과 한 문장 정의', 'essentials', 'product', {
        importance: 'core', rows: 2, placeholder: '예: 클래스체크 — 소규모 학원용 출결 기록 웹 서비스'
      }),
      field('audience', '주요 고객과 사용 상황', 'essentials', 'audience', {
        importance: 'core', placeholder: '누가 어떤 상황에서 사용하는지 적어주세요.'
      }),
      field('problem', '해결하려는 문제', 'essentials', 'problem', {
        placeholder: '고객이 실제로 겪는 문제만 적어주세요.', importance: 'helpful'
      }),
      field('features', '실제로 제공하는 기능·구성', 'details', 'feature', {
        importance: 'core', placeholder: '현재 제공되는 기능을 항목별로 적어주세요.'
      }),
      field('process', '사용 방식과 제공 범위', 'details', 'feature', {
        placeholder: '가입부터 이용까지의 실제 흐름과 제공 범위를 적어주세요.', importance: 'helpful'
      }),
      field('evidence', '검증된 근거·수치·출처', 'details', 'evidence', {
        placeholder: '수치, 인증, 조사 결과는 출처와 함께 적어주세요. 없으면 비워도 돼요.', importance: 'helpful'
      }),
      field('pricing', '가격·기간·이용 조건', 'details', 'terms', {
        placeholder: '현재 확인된 가격, 계약 기간, 적용 조건을 적어주세요.', importance: 'optional'
      }),
      field('limitations', '한계·주의사항', 'reflection', 'terms', {
        placeholder: '지원하지 않는 기능이나 이용 전 알아야 할 조건을 적어주세요.', importance: 'helpful'
      }),
      field('cta', '독자에게 원하는 행동', 'reflection', 'action', {
        type: 'text', placeholder: '예: 무료 체험 신청, 문의, 다운로드', importance: 'helpful'
      }),
      field('industry', '업종·규제 가능 분야', 'reflection', 'policy', {
        type: 'text', placeholder: '예: 교육, 의료, 금융, 법률, 일반 쇼핑', importance: 'helpful',
        help: '의료·법률·금융 관련 표현은 별도 정책 검사를 거쳐요.'
      })
    ],
    readiness: { default: [['product'], ['audience', 'problem'], ['feature']] }
  }),

  general: Object.freeze({
    label: '일반 글',
    description: '안내, 이메일, 설명, 의견 등 목적에 맞게 정리해요.',
    documentProfile: 'general',
    basicStyle: 'report',
    register: "종결체는 '-습니다'를 기본으로 한다.",
    defaultTarget: 230,
    maxFeasible: 2200,
    subtypes: [
      ['notice', '안내문'], ['email', '이메일·메시지'], ['explanation', '설명문'],
      ['opinion', '의견문'], ['proposal', '제안서'], ['summary', '요약문'], ['other', '기타']
    ],
    fields: [
      field('purpose', '글의 목적', 'essentials', 'purpose', {
        importance: 'core', rows: 2, placeholder: '예: 동아리 신입 부원에게 첫 모임을 안내하려고 해요.'
      }),
      field('audience', '읽는 사람', 'essentials', 'audience', { type: 'text', placeholder: '예: 동아리 신입 부원', importance: 'helpful' }),
      field('keyMessage', '가장 먼저 전달할 핵심 메시지', 'essentials', 'message', {
        importance: 'core', placeholder: '독자가 글을 읽고 반드시 알아야 할 한 가지를 적어주세요.'
      }),
      field('mustInclude', '반드시 포함할 사실', 'details', 'evidence', {
        placeholder: '확인된 내용만 항목별로 적어주세요.', importance: 'helpful'
      }),
      field('dateTime', '날짜·시간', 'details', 'logistics', { type: 'text', placeholder: '예: 2026년 9월 3일 오후 6시 30분', importance: 'optional' }),
      field('place', '장소', 'details', 'logistics', { type: 'text', placeholder: '예: 학생회관 201호', importance: 'optional' }),
      field('participants', '대상·참여자', 'details', 'logistics', { type: 'text', placeholder: '예: 신입 부원 전원', importance: 'optional' }),
      field('readerAction', '독자가 해야 할 행동', 'details', 'action', {
        placeholder: '신청, 준비물, 회신처럼 실제 필요한 행동을 적어주세요.', importance: 'helpful'
      }),
      field('deadline', '마감·기한', 'details', 'logistics', { type: 'text', placeholder: '예: 9월 1일까지 참석 여부 회신', importance: 'optional' }),
      field('source', '근거 자료·요약할 원문', 'details', ['source', 'evidence'], {
        placeholder: '설명문이나 요약문이라면 근거가 되는 원문을 붙여주세요.', importance: 'helpful', maxLength: 4000, rows: 5
      }),
      field('stance', '내 의견·판단', 'reflection', 'stance', {
        placeholder: '의견문이라면 주장과 이유를 직접 적어주세요.', importance: 'helpful'
      }),
      field('closing', '원하는 마무리', 'reflection', 'action', {
        type: 'text', placeholder: '예: 참석 부탁, 문의 방법, 핵심 내용 재강조', importance: 'optional'
      })
    ],
    readiness: {
      default: [['purpose'], ['message', 'evidence']],
      notice: [['purpose'], ['message', 'evidence'], ['logistics', 'action']],
      email: [['purpose'], ['message', 'evidence']],
      explanation: [['message'], ['evidence', 'source']],
      opinion: [['stance'], ['evidence', 'message']],
      proposal: [['purpose'], ['message', 'action'], ['evidence', 'logistics']],
      summary: [['source']]
    }
  })
});

function publicGenreConfig() {
  return Object.fromEntries(Object.entries(GENRES).map(([key, genre]) => [key, {
    label: genre.label,
    description: genre.description,
    documentProfile: genre.documentProfile,
    basicStyle: genre.basicStyle,
    defaultTarget: genre.defaultTarget,
    subtypes: genre.subtypes.map(([value, label]) => ({ value, label })),
    sections: SECTION_LABELS,
    fields: genre.fields
  }]));
}

function normalizeGenre(value) {
  const key = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(GENRES, key) ? key : 'general';
}

function normalizeSubtype(genreKey, value) {
  const genre = GENRES[normalizeGenre(genreKey)];
  const candidate = String(value || '').trim();
  return genre.subtypes.some(([key]) => key === candidate) ? candidate : genre.subtypes[0][0];
}

module.exports = { SECTION_LABELS, GENRES, publicGenreConfig, normalizeGenre, normalizeSubtype };
