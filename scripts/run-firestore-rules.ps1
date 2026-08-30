$ErrorActionPreference = 'Stop'

$localJdk = Join-Path $env:LOCALAPPDATA 'Programs\gp-jdk21\jdk-21.0.11+10'
if (Test-Path (Join-Path $localJdk 'bin\java.exe')) {
  $env:JAVA_HOME = $localJdk
  $env:PATH = (Join-Path $localJdk 'bin') + ';' + $env:PATH
}

$oldErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$versionOutput = (& java -version) 2>&1
$ErrorActionPreference = $oldErrorActionPreference
if (($versionOutput -join "`n") -notmatch 'version "2[1-9]\.') {
  throw "Firebase Firestore Emulator requires Java 21+. Current java -version: $($versionOutput -join ' ')"
}

# A parent shell may set DEBUG for unrelated application logging. firebase-tools
# interprets any DEBUG value as verbose emulator tracing, which obscures rule failures.
$env:DEBUG = ''
npx firebase-tools emulators:exec --only firestore,storage --project demo-gp-local "npm run test:rules"
