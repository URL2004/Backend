'use strict';

// 정책 팩은 운영 화면에서 즉시 토글하지 않는다. 담당자 검토 후 이 명령으로
// 소스 파일을 갱신하고 코드 리뷰·테스트·배포 기록에 승인을 남긴다.

const fs = require('node:fs');
const path = require('node:path');
const { registrySnapshot, validatePack } = require('../engine-writing-v1/policy/registry');

const ROOT = path.resolve(__dirname, '..');
const PACK_FILES = Object.freeze({
  medical: path.join(ROOT, 'engine-writing-v1', 'policy', 'packs', 'medical.ko.v1.json'),
  legal: path.join(ROOT, 'engine-writing-v1', 'policy', 'packs', 'legal.ko.v1.json'),
  finance: path.join(ROOT, 'engine-writing-v1', 'policy', 'packs', 'finance.ko.v1.json'),
  advertising: path.join(ROOT, 'engine-writing-v1', 'policy', 'packs', 'advertising.ko.v1.json')
});

function parseArgs(argv) {
  const [command = 'validate', domain = '', ...rest] = argv;
  const flags = Object.fromEntries(rest.filter(arg => arg.startsWith('--')).map(arg => {
    const [key, ...value] = arg.slice(2).split('=');
    return [key, value.join('=') || '1'];
  }));
  return { command, domain, flags };
}

function validateRegistry(requireApproved = false) {
  const registry = registrySnapshot();
  const ok = registry.invalidPackIds.length === 0 && (!requireApproved || registry.launchEligible);
  return {
    ok,
    requireApproved,
    version: registry.version,
    launchEligible: registry.launchEligible,
    pendingDomains: registry.pendingDomains,
    invalidPackIds: registry.invalidPackIds,
    packs: registry.packs.map(pack => ({
      domain: pack.domain,
      id: pack.id,
      approved: pack.approved,
      approval: pack.approval,
      reviewedAt: pack.reviewedAt,
      sourceCheckedAt: pack.sourceCheckedAt,
      validation: pack.validation
    }))
  };
}

function approvePack(domain, { owner, approvedAt, reviewedAt, sourceCheckedAt }) {
  const file = PACK_FILES[domain];
  if (!file) throw new Error(`지원하지 않는 정책 도메인입니다: ${domain || '(없음)'}`);
  const reviewer = String(owner || '').trim();
  if (reviewer.length < 3 || reviewer === 'UNASSIGNED') throw new Error('--owner에는 실제 정책 검토 담당자를 입력해야 합니다.');
  const date = String(approvedAt || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('--approved-at은 YYYY-MM-DD 형식이어야 합니다.');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  pack.approved = true;
  pack.reviewedAt = String(reviewedAt || date);
  pack.sourceCheckedAt = String(sourceCheckedAt || pack.sourceCheckedAt || date);
  pack.approval = { status: 'APPROVED', owner: reviewer, approvedAt: date };
  const validation = validatePack(pack);
  if (!validation.valid) throw new Error(`승인 후 정책 팩이 유효하지 않습니다: ${validation.errors.join(', ')}`);
  fs.writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  return { ok: true, domain, file: path.relative(ROOT, file), approval: pack.approval };
}

function revokePack(domain) {
  const file = PACK_FILES[domain];
  if (!file) throw new Error(`지원하지 않는 정책 도메인입니다: ${domain || '(없음)'}`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  pack.approved = false;
  pack.approval = { status: 'PENDING_OWNER_REVIEW', owner: 'UNASSIGNED', approvedAt: null };
  const validation = validatePack(pack);
  if (!validation.valid) throw new Error(`승인 해제 후 정책 팩이 유효하지 않습니다: ${validation.errors.join(', ')}`);
  fs.writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  return { ok: true, domain, file: path.relative(ROOT, file), approval: pack.approval };
}

function main(argv = process.argv.slice(2)) {
  const { command, domain, flags } = parseArgs(argv);
  let result;
  if (command === 'validate') result = validateRegistry(flags['require-approved'] === '1');
  else if (command === 'approve') result = approvePack(domain, {
    owner: flags.owner,
    approvedAt: flags['approved-at'],
    reviewedAt: flags['reviewed-at'],
    sourceCheckedAt: flags['source-checked-at']
  });
  else if (command === 'revoke') result = revokePack(domain);
  else throw new Error('사용법: validate [--require-approved=1] | approve <domain> --owner=<담당자> [--approved-at=YYYY-MM-DD] | revoke <domain>');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok === false) process.exitCode = 2;
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { PACK_FILES, parseArgs, validateRegistry, approvePack, revokePack, main };
