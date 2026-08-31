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

# Firebase CLI는 DEBUG가 설정된 환경에서 실행 자식의 전체 환경을 출력한다. 규칙 테스트에는
# 운영 비밀이 필요하지 않으므로 디버그 플래그와 민감 이름의 환경변수를 이 프로세스에서 제거한다.
$env:DEBUG = $null
Get-ChildItem Env: | Where-Object {
  $_.Name -match '(?i)(SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY)'
} | ForEach-Object {
  Remove-Item -LiteralPath ("Env:" + $_.Name) -ErrorAction SilentlyContinue
}

npx firebase-tools emulators:exec --only firestore,storage --project demo-gp-local "npm run test:rules"
if ($LASTEXITCODE -ne 0) {
  Write-Error "Firebase rules test failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}
