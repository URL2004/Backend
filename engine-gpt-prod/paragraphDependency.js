'use strict';

// Local discourse edges, independent of sentence count and target paragraph
// count. A link is not permission to move sentences or cross a title/quote.
function dependentBoundary(previous, next) {
  const left=String(previous||'').trim(),right=String(next||'').trim();
  if (/^(?:둘은|이\s*둘은|두\s*대상은|이들은)\s/u.test(right)
      && /(?:[가-힣]{2,}(?:와|과)\s|서로|둘|두\s*가지)/u.test(left)) return 'paired_referent';
  if (/(?:원천|원인|이유|요인)(?:이다|입니다)[.!?]?$/u.test(left)
      && /(?:만큼|경우|때)/u.test(right)
      && /(?:수\s*있|때문)/u.test(right)) {
    const terms=(left.match(/[가-힣]{2,}/gu)||[]).map(w=>w.replace(/(?:은|는|이|가|을|를|의)$/u,''));
    if(terms.some(w=>w.length>=2&&right.includes(w)))return 'claim_example';
  }
  if (/(?:것처럼|듯이)[.!?]$/u.test(right)
      && !/(?:이다|있다|했다|한다|된다|합니다|습니다)[.!?]$/u.test(right)) return 'analogy_tail';
  return '';
}

function definitionSubject(value) {
  const text=String(value||'').trim().replace(/^(?:특히|또한|먼저)\s+/u,'');
  const match=/^([가-힣][가-힣 ·-]{1,34}?)(?:에서는|에서|이란|란|은|는)\s/u.exec(text);
  return match?.[1].replace(/\s/gu,'')||'';
}
function definitionBoundaryScores(sentences,profileName) {
  if(profileName!=='long_explainer')return [];
  const subjects=sentences.map(definitionSubject);
  if(subjects.filter(Boolean).length<3)return [];
  return subjects.map((right,index)=>{
    const left=subjects[index-1];
    if(!left||!right)return 0;
    return left.endsWith(right)||right.endsWith(left)?-160:45;
  });
}
module.exports={dependentBoundary,definitionSubject,definitionBoundaryScores};
