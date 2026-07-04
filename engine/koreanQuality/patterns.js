'use strict';

const SEVERITY_WEIGHTS = {
  S1: 3.0,
  S2: 1.8,
  S3: 0.8
};

const DEFAULT_THRESHOLDS = {
  warningDelta: 0.03,
  repairDelta: 0.07,
  promptHintsMax: 8
};

const TRANSLATIONESE_PATTERNS = [
  {
    id: 'through_overuse',
    category: 'translationese',
    severity: 'S1',
    label: '번역투 "~를 통해" 반복',
    re: /(?:을|를)\s*통해(?:서)?/g,
    advice: '"~로", "~하면서", 직접 동사 표현으로 풀어 쓴다.'
  },
  {
    id: 'about_overuse',
    category: 'translationese',
    severity: 'S2',
    label: '번역투 "~에 대해/관해" 반복',
    re: /(?:에\s*대해(?:서)?|에\s*관해(?:서)?)/g,
    advice: '문장 주어와 목적어를 직접 세워 설명한다.'
  },
  {
    id: 'related_to_formula',
    category: 'translationese',
    severity: 'S2',
    label: '"~와 관련하여"식 연결',
    re: /(?:와|과)\s*관련(?:하여|해|된|해서)/g,
    advice: '관련 대상을 명사구로 압축하거나 구체 동사로 연결한다.'
  },
  {
    id: 'based_on_formula',
    category: 'translationese',
    severity: 'S2',
    label: '"~에 기반하여"식 표현',
    re: /에\s*기반(?:하여|해|한|한다|합니다)/g,
    advice: '"~을 바탕으로", "~을 근거로"처럼 장르에 맞게 낮춘다.'
  },
  {
    id: 'have_formula',
    category: 'translationese',
    severity: 'S2',
    label: '"가지고 있다"식 보유 표현',
    re: /가지고\s*있(?:다|습니다|으며|고|는|어|게)/g,
    advice: '"있다", "갖췄다", "보인다" 등 문맥 동사로 바꾼다.'
  },
  {
    id: 'passive_double',
    category: 'translationese',
    severity: 'S1',
    label: '이중 피동/수동 표현',
    re: /(?:되어진|되어지는|되어졌다|되어졌|되어집니다|되어진다)/g,
    advice: '"된다", "이루어진다" 또는 능동문으로 정리한다.'
  },
  {
    id: 'by_passive',
    category: 'translationese',
    severity: 'S2',
    label: '"~에 의해" 수동 구조',
    re: /에\s*의해(?:서)?/g,
    advice: '행위 주체를 주어로 세워 능동문에 가깝게 고친다.'
  },
  {
    id: 'can_formula',
    category: 'translationese',
    severity: 'S3',
    label: '"~할 수 있다" 반복',
    re: /[가-힣A-Za-z0-9]+\s*할\s*수\s*있(?:다|습니다|으며|고|는|게|도록|었다|었다고)/g,
    advice: '가능 표현이 꼭 필요하지 않으면 직접 서술로 낮춘다.'
  },
  {
    id: 'for_formula',
    category: 'translationese',
    severity: 'S3',
    label: '"~을 위해" 반복',
    re: /(?:을|를)\s*위해(?:서)?/g,
    advice: '목적절을 줄이고 동작을 직접 연결한다.'
  },
  {
    id: 'point_formula',
    category: 'translationese',
    severity: 'S2',
    label: '"~라는 점에서" 정형 표현',
    re: /라는\s*점(?:에서|은|이|도)/g,
    advice: '판단 근거를 짧은 절로 직접 말한다.'
  },
  {
    id: 'will_formula',
    category: 'translationese',
    severity: 'S3',
    label: '"~것이다/것입니다" 반복',
    re: /것(?:이다|입니다|으로\s*보인다|으로\s*생각한다)/g,
    advice: '불필요한 예측형 종결은 현재형 판단으로 줄인다.'
  }
];

const GPT_STYLE_PATTERNS = [
  {
    id: 'formulaic_transition',
    category: 'gpt_style',
    severity: 'S2',
    label: '정형 접속어/마무리 표현 반복',
    re: /(?:결국|이처럼|무엇보다|한편|나아가|더욱이|다만|즉|따라서|결론적으로)/g,
    advice: '접속어를 줄이고 앞뒤 문장의 의미 연결로 자연스럽게 잇는다.'
  },
  {
    id: 'abstract_modifier',
    category: 'gpt_style',
    severity: 'S2',
    label: '추상적 수식어 과다',
    re: /(?:핵심|중요한|의미\s*있는|전략적|효율적|체계적|긍정적|전반적|실질적|구체적|복합적|지속적|안정적|효과적)/g,
    advice: '추상 평가어보다 실제 상태, 행위, 결과를 써서 구체화한다.'
  },
  {
    id: 'rhetorical_polish',
    category: 'gpt_style',
    severity: 'S1',
    label: '칼럼식/문학적 수사 표현',
    re: /(?:비로소|한층|자리매김|떠받치|무너지는\s*것은|눈길을\s*끌|같은\s*맥락이다|방향을\s*가리킨다|판을\s*깔아준다|가지를\s*뻗어)/g,
    advice: '수사 표현을 낮추고 원문 정보 역할에 맞는 담백한 문장으로 둔다.'
  },
  {
    id: 'stock_closing',
    category: 'gpt_style',
    severity: 'S2',
    label: 'AI식 상투적 결론',
    re: /(?:한\s*걸음씩\s*나아가고자\s*한다|시사한다|의의가\s*있다|필요성이\s*크다|중요하다고\s*볼\s*수\s*있다|충분한\s*(?:이유|가치)가\s*있다)/g,
    advice: '결론은 원문 결론의 범위 안에서 짧고 직접적으로 닫는다.'
  },
  {
    id: 'three_part_list',
    category: 'gpt_style',
    severity: 'S3',
    label: '삼단 나열식 문장',
    re: /[가-힣A-Za-z0-9]+(?:과|와|,)\s*[가-힣A-Za-z0-9]+(?:과|와|,)\s*[가-힣A-Za-z0-9]+(?:을|를|이|가|도|까지)/g,
    advice: '나열을 모두 정리하려 하지 말고 필요한 항목만 자연스럽게 남긴다.'
  }
];

const GRAMMAR_PATTERNS = [
  {
    id: 'dangling_connector_end',
    category: 'grammar',
    severity: 'S1',
    hard: true,
    label: '접속어미로 끊긴 문장',
    re: /(?:며|으며|고|지만|는데|면서|거나|하여|해서|하되|및)\s*$/gm,
    advice: '끊긴 문장은 앞뒤 절을 복원해 완결된 문장으로 만든다.'
  },
  {
    id: 'orphan_connector_after_period',
    category: 'grammar',
    severity: 'S1',
    hard: true,
    label: '문장 뒤 고립된 접속 구조',
    re: /다\.\s*(?:있으며|그리고|또한|때문에|따라서|그러나)\b/g,
    advice: '접속어가 독립 문장처럼 남지 않게 앞뒤 문장을 다시 연결한다.'
  },
  {
    id: 'connector_comma_fragment',
    category: 'grammar',
    severity: 'S2',
    hard: false,
    label: '접속어미 뒤 쉼표 파편',
    re: /(?:며|으며|고|지만|는데|면서|하여|해서),/g,
    advice: '쉼표로 억지 연결하지 말고 절 경계를 문맥에 맞게 정리한다.'
  },
  {
    id: 'orphan_and',
    category: 'grammar',
    severity: 'S1',
    hard: true,
    label: '문장 첫머리 고립 "및"',
    re: /(?:^|[.!?]\s*)및\s+/gm,
    advice: '"및"으로 시작하는 파편은 앞 문장에 붙이거나 구체 동사로 바꾼다.'
  },
  {
    id: 'excess_blank_lines',
    category: 'grammar',
    severity: 'S3',
    hard: false,
    label: '과도한 빈 줄',
    re: /\n{4,}/g,
    advice: '불필요한 빈 줄을 줄여 완성된 문단 흐름을 유지한다.'
  }
];

module.exports = {
  SEVERITY_WEIGHTS,
  DEFAULT_THRESHOLDS,
  TRANSLATIONESE_PATTERNS,
  GPT_STYLE_PATTERNS,
  GRAMMAR_PATTERNS
};
