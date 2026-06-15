param(
  [string]$EnvFile = ".env.local.gemini"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (!(Test-Path -LiteralPath $EnvFile)) {
  Write-Error "Missing $EnvFile. Copy .env.local.gemini.example to .env.local.gemini and fill GEMINI_API_KEY."
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

Write-Host "Starting local Gemini backend on port $env:PORT"
node server.js
