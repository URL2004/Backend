param(
  [string]$EnvFile = ".env.local.gemini"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (!(Test-Path -LiteralPath $EnvFile)) {
  $fallbackEnv = Join-Path (Split-Path -Parent $root) "Backend\.env.local.gemini"
  if (Test-Path -LiteralPath $fallbackEnv) {
    $EnvFile = $fallbackEnv
  } else {
    Write-Error "Missing $EnvFile. Copy .env.local.gemini.example to .env.local.gemini and fill GEMINI_API_KEY."
  }
}

Get-Content -LiteralPath $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (!$line -or $line.StartsWith("#")) { return }
  $idx = $line.IndexOf("=")
  if ($idx -lt 0) { return }
  $key = $line.Substring(0, $idx).Trim()
  $value = $line.Substring($idx + 1).Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  [Environment]::SetEnvironmentVariable($key, $value, "Process")
}

$env:LLM_BACKEND = "gemini"
$env:LLM_CLAUDE_FALLBACK = "0"
$env:LLM_SHADOW_MODE = "0"
$env:LLM_SHADOW_RATE = "0"
$env:GEMINI_ALLOW_CLAUDE_SHADOW = "0"
if ($env:GEMINI_EXPLICIT_CACHE_FORCE_OFF -ne "1") {
  $env:GEMINI_EXPLICIT_CACHE = "1"
}
if (!$env:GEMINI_CACHE_TTL) {
  $env:GEMINI_CACHE_TTL = "3600s"
}
if (!$env:GEMINI_EXPLICIT_CACHE_MIN_CHARS -or $env:GEMINI_EXPLICIT_CACHE_MIN_CHARS -eq "6000") {
  $env:GEMINI_EXPLICIT_CACHE_MIN_CHARS = "2500"
}
if (!$env:GEMINI_CACHE_PERSIST) {
  $env:GEMINI_CACHE_PERSIST = "1"
}

Write-Host "Starting local Gemini backend on port $env:PORT"
node server.js
