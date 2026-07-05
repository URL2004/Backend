'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const target = path.join(root, '.python-packages');
const marker = path.join(target, '.layout-nlp-installed');

if (process.env.LAYOUT_NLP_AUTO_INSTALL === '0') {
  console.log('[layout-nlp] skipped by LAYOUT_NLP_AUTO_INSTALL=0');
  process.exit(0);
}

const python = pickPython();
if (!python) {
  console.log('[layout-nlp] python not found; optional NLP packages skipped');
  process.exit(0);
}

try { fs.mkdirSync(target, { recursive: true }); } catch {}

const required = ['kss', 'kiwipiepy'];
const optional = process.env.LAYOUT_NLP_INSTALL_PYKOSPACING === '0'
  ? []
  : [
      {
        label: 'pykospacing',
        specs: [
          'pykospacing',
          'git+https://github.com/haven-jeon/PyKoSpacing.git'
        ]
      }
    ];

let installedAny = false;
for (const pkg of required) {
  const ok = installPackage(python, pkg, true);
  installedAny = installedAny || ok;
}
for (const pkg of optional) {
  const ok = installPackageGroup(python, pkg.label, pkg.specs, false);
  installedAny = installedAny || ok;
}

if (installedAny) {
  try { fs.writeFileSync(marker, new Date().toISOString() + '\n'); } catch {}
}
process.exit(0);

function pickPython() {
  const candidates = [
    process.env.LAYOUT_NLP_PYTHON,
    process.env.PYTHON,
    'python3',
    'python',
    process.platform === 'win32' ? 'py' : ''
  ].filter(Boolean);
  for (const command of candidates) {
    const args = command === 'py' ? ['-3', '--version'] : ['--version'];
    const res = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
    if (res.status === 0) return command;
  }
  return '';
}

function installPackage(command, pkg, important) {
  const pyArgs = command === 'py' ? ['-3', '-m'] : ['-m'];
  const args = [
    ...pyArgs,
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-cache-dir',
    '--target',
    target,
    pkg
  ];
  console.log(`[layout-nlp] installing ${pkg} into ${target}`);
  const res = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: Number(process.env.LAYOUT_NLP_INSTALL_TIMEOUT_MS || 180000)
  });
  if (res.status === 0) {
    console.log(`[layout-nlp] installed ${pkg}`);
    return true;
  }
  const reason = (res.stderr || res.stdout || '').split(/\r?\n/).slice(-8).join('\n');
  console.log(`[layout-nlp] ${important ? 'required' : 'optional'} package ${pkg} not installed: ${reason}`);
  return false;
}

function installPackageGroup(command, label, specs, important) {
  for (const spec of specs) {
    const ok = installPackage(command, spec, important);
    if (ok) {
      console.log(`[layout-nlp] installed ${label} via ${spec}`);
      return true;
    }
  }
  return false;
}
