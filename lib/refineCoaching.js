'use strict';

// Optional author follow-ups, independent of surfaceguard's abstractness score.
// A definition without dates or numbers is not an incomplete personal story.
const { splitParagraphsForRefine } = require('../engine/surfaceguard');
const PROTECTED = /실험\s*목적|연구\s*목적|관련\s*이론|이론적?\s*배경|배경\s*이론|참고\s*문헌|참고\s*자료|이론|정의|개념|준비물|유의\s*사항|안전\s*수칙|실험\s*방법|연구\s*방법|목차|^(?:purpose|objectives?|theory|background|references|methods?)$/i;
const RESULTS = /결과|고찰|논의|느낀\s*점|후기|경험|회고|results?|discussion|reflection/i;
const PERSONAL = /자기소개서|지원\s*동기|성장\s*과정|나의\s*경험|나의\s*회고/;
const LIVED = /(?:나는|저는|내가|제가|우리[는가]?|직접|당시|처음에는|실험\s*중|실습\s*중|진행\s*중|작업\s*중)|(?:겪었|해\s*봤|해봤|시도했|점검했|점검해야\s*했|확인했|확인하였|관찰했|관찰하였|어려웠|당황했|느꼈|배웠)/;
const ISSUE = /예상과\s*다르|예상(?:한|했던).{0,12}(?:다르|달랐)|잘못|오류|실패|어려[웠움워]|문제|혼동|혼란|점검|고장|늦어|늦었/;

function headingRole(line) {
  const clean = line.trim().replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '');
  const label = clean.replace(/^(?:chapter\s*\d+[.:]?|제\s*\d+\s*장|\d+[.)]|[ⅠⅡⅢⅣⅤⅥ]+[.)]?)\s*/i, '').trim();
  if (!label || clean.length > 85 || /[。.!?]$|다$/.test(label)) return null;
  const marked = /^(?:#{1,6}\s|chapter\s*\d|제\s*\d+\s*장|\d+[.)]|[ⅠⅡⅢⅣⅤⅥ])/i.test(line.trim());
  if (!marked && !PROTECTED.test(label) && !RESULTS.test(label) && !PERSONAL.test(label)) return null;
  return { label, protected: PROTECTED.test(label), result: RESULTS.test(label), personal: PERSONAL.test(label) };
}

function coachingFor(text, { result, personal }) {
  if (/^(?:본|이번)\s*(?:실험|연구)의?\s*목적/.test(text) || /이해하고자\s*(?:한다|하였다)/.test(text)) return null;
  const lived = LIVED.test(text);
  if (!lived && !personal) return null;
  // Procedural instructions and textbook examples are not observations by the author.
  if (!lived && /예를\s*들|가정하|가정해|해야\s*한다|하도록\s*한다/.test(text)) return null;
  const issue = ISSUE.test(text);
  if (issue && /배선|연결|회로|선택선|클럭|LED/i.test(text)) return {
    rank: 100, title: '회로를 점검했던 과정을 알려주세요',
    question: '당시 출력은 어떻게 나왔고, 어떤 연결이나 입력을 확인했나요?',
    placeholder: '기억나는 출력 상태나 확인했던 연결을 적어주세요.'
  };
  if (issue) return {
    rank: 90, title: '어려움을 겪었던 순간을 알려주세요',
    question: '어떤 점이 예상과 달랐나요? 그때 직접 확인하거나 시도한 일이 있다면 알려주세요.',
    placeholder: '당시 상황과 내가 확인하거나 시도한 일 중 기억나는 내용을 적어주세요.'
  };
  if (/선택했|선택하였|결정했|결정하였|바꾸었|바꿨|수정했|수정하였/.test(text)) return {
    rank: 80, title: '그렇게 결정한 이유를 알려주세요',
    question: '어떤 상황에서 그 선택을 했나요? 판단에 영향을 준 점 하나를 알려주세요.',
    placeholder: '선택 당시의 상황이나 판단 이유를 적어주세요.'
  };
  if ((result || /실험|실습|관찰|측정/.test(text)) && /확인했|확인하였|관찰했|관찰하였|나타났|나타났다|측정했/.test(text)) return {
    rank: 70, title: '직접 확인한 결과를 알려주세요',
    question: '어떤 조건에서 무엇이 달라지는 것을 확인했나요? 기억나는 관찰 한 가지를 알려주세요.',
    placeholder: '직접 확인한 조건이나 변화 중 기억나는 내용을 적어주세요.'
  };
  if (/느꼈|배웠|깨달|경험했|겪었|성장|성실|협력|꾸준/.test(text)) return {
    rank: 50, title: '그 생각으로 이어진 상황을 알려주세요',
    question: '이 생각과 연결되는 실제 상황이 있나요? 그때 직접 한 일 하나를 알려주세요.',
    placeholder: '기억나는 상황과 직접 한 일을 적어주세요. 떠오르지 않으면 건너뛰어도 괜찮아요.'
  };
  return null;
}

function selectRefineTargets(outputText, { refinedIndices = [], creditForLength = () => 0 } = {}) {
  const paragraphs = splitParagraphsForRefine(outputText);
  const excluded = new Set(refinedIndices);
  const personal = PERSONAL.test(outputText.slice(0, 400));
  let section = { label: '', protected: false, result: false, personal };
  const candidates = [];
  paragraphs.forEach((p, index) => {
    const lines = p.text.trim().split('\n');
    let bodyStart = 0;
    for (const line of lines) {
      const role = headingRole(line);
      if (!role) break;
      // Unlabelled subsections inherit a protected parent (e.g. Theory > Sensor).
      const major = /^(?:#{1,2}\s|chapter\s*\d|제\s*\d+\s*장)/i.test(line.trim());
      section = { ...role, protected: role.protected || (!major && !role.result && section.protected), personal: personal || role.personal };
      bodyStart++;
    }
    const body = lines.slice(bodyStart).join('\n').trim();
    if (section.protected || excluded.has(index) || body.length < 40) return;
    const coaching = coachingFor(body, section);
    if (!coaching) return;
    // Show the relevant sentence, not the paragraph's generic opening.
    const sentences = body.match(/[^.!?。]+[.!?。]*/g) || [body];
    const anchor = (sentences.find(s => ISSUE.test(s) && LIVED.test(s)) || sentences.find(s => LIVED.test(s)) || body).trim();
    candidates.push({ index, kind: 'experience_followup', snippet: anchor.replace(/\s+/g, ' ').slice(0, 180),
      credit: creditForLength(p.text.trim().length),
      coaching: { version: 1, section: section.label, title: coaching.title, question: coaching.question, placeholder: coaching.placeholder },
      rank: coaching.rank });
  });
  // One focused question per result. Never fill a quota with irrelevant paragraphs.
  return candidates.sort((a, b) => b.rank - a.rank || a.index - b.index).slice(0, 1)
    .map(({ rank, ...target }) => target);
}

module.exports = { selectRefineTargets };
