const { coreRules } = require('./common/core');
const { conflictPolicy } = require('./common/conflictPolicy');
const { outputRules } = require('./common/output');
const { protectedTermsBlock, protectedTermsData } = require('./guards/protectedTerms');

const genres = {
  academic_assignment: require('./genres/academicAssignment'),
  report_technical: require('./genres/technicalReport'),
  field_blog: require('./genres/fieldBlog'),
  column_opinion: require('./genres/columnOpinion'),
  thesis_research: require('./genres/thesisResearch'),
  resume_sop: require('./genres/selfIntro')
};

const risks = {
  lowRiskSource: require('./risks/lowRiskSource'),
  abstractSource: require('./risks/abstractSource'),
  factDenseSource: require('./risks/factDenseSource'),
  structureCritical: require('./risks/structureCritical'),
  highProxySurface: require('./risks/highProxySurface')
};

function riskTypes(ctx) {
  const route = ctx.route?.mode || '';
  const flags = new Set(ctx.riskFlags || []);
  const out = [];
  if (route === 'minimal_cleanup') out.push('lowRiskSource');
  if (route === 'limited_preserve' || flags.has('abstract_source') || flags.has('low_anchor_density')) out.push('abstractSource');
  if (flags.has('fact_dense')) out.push('factDenseSource');
  if (flags.has('structure_dense')) out.push('structureCritical');
  if (flags.has('proxy_high')) out.push('highProxySurface');
  return out.length ? out : ['lowRiskSource'];
}

function selectPromptModules(ctx = {}) {
  const genreKey = ctx.genre || 'academic_assignment';
  return [
    'common/core',
    'common/conflictPolicy',
    `genres/${genreKey}`,
    ...riskTypes(ctx).map(k => `risks/${k}`),
    'guards/protectedTerms',
    'common/output'
  ];
}

function buildPrompt(ctx = {}) {
  const modules = [];
  const blocks = [];
  const add = (name, block) => {
    if (!block) return;
    modules.push(name);
    blocks.push(block);
  };

  add('common/core', coreRules(ctx));
  add('common/conflictPolicy', conflictPolicy(ctx));

  const genreKey = ctx.genre || 'academic_assignment';
  const genre = genres[genreKey] || genres.academic_assignment;
  add(`genres/${genreKey}`, genre.build(ctx));

  for (const riskKey of riskTypes(ctx)) {
    const mod = risks[riskKey];
    if (mod) add(`risks/${riskKey}`, mod.build(ctx));
  }

  add('guards/protectedTerms', protectedTermsBlock(ctx.protectedTerms || []));
  add('common/output', outputRules(ctx));

  return {
    stable: blocks.filter(Boolean).join('\n\n'),
    volatile: protectedTermsData(ctx.protectedTerms || []),
    text: blocks.filter(Boolean).join('\n\n'),
    modules,
    meta: {
      promptVersion: 'humanize-lab-test-prompt-v2-no-intent',
      modules
    }
  };
}

module.exports = {
  buildPrompt,
  selectPromptModules
};
