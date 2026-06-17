param(
  [string]$Service = $(if ($env:RENDER_SERVICE_ID) { $env:RENDER_SERVICE_ID } else { "srv-d6pl9qlm5p6s73fmh280" }),
  [int]$Limit = 200,
  [string]$Text = "llm.usage",
  [switch]$Json
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command render -ErrorAction SilentlyContinue)) {
  throw "Render CLI is not installed or not available on PATH."
}

$lines = render logs --resources $Service --text $Text --limit $Limit --direction backward --output text
$usage = @()

foreach ($line in $lines) {
  if ($line -notmatch "\{.*\}$") { continue }
  try {
    $m = $Matches[0] | ConvertFrom-Json
    if ($null -eq $m.cacheReadTokens -or $null -eq $m.cacheCreateTokens) { continue }
    $usage += [pscustomobject]@{
      ts = [string]$m.ts
      path = [string]$m.path
      task = if ($m.task) { [string]$m.task } else { "unspecified" }
      phase = if ($m.phase) { [string]$m.phase } else { "unspecified" }
      mode = if ($m.mode) { [string]$m.mode } else { "" }
      toolName = if ($m.toolName) { [string]$m.toolName } else { "" }
      cacheEligible = [bool]$m.cacheEligible
      cachePrefixHash = if ($m.cachePrefixHash) { [string]$m.cachePrefixHash } else { "" }
      input = [int]$m.inputTokens
      create = [int]$m.cacheCreateTokens
      read = [int]$m.cacheReadTokens
      output = [int]$m.outputTokens
      model = [string]$m.model
    }
  } catch {
    continue
  }
}

function Sum-Field($Rows, $Field) {
  $sum = ($Rows | Measure-Object $Field -Sum).Sum
  if ($null -eq $sum) { return 0 }
  return [int64]$sum
}

function Group-Summary($Rows, $Name) {
  $groups = $Rows | Group-Object $Name
  foreach ($group in $groups) {
    $g = $group.Group
    [pscustomobject]@{
      key = $group.Name
      calls = $g.Count
      hits = ($g | Where-Object { $_.read -gt 0 } | Measure-Object).Count
      writes = ($g | Where-Object { $_.create -gt 0 } | Measure-Object).Count
      zero = ($g | Where-Object { $_.read -eq 0 -and $_.create -eq 0 } | Measure-Object).Count
      eligibleZero = ($g | Where-Object { $_.cacheEligible -and $_.read -eq 0 -and $_.create -eq 0 } | Measure-Object).Count
      inputTokens = Sum-Field $g "input"
      cacheCreateTokens = Sum-Field $g "create"
      cacheReadTokens = Sum-Field $g "read"
      outputTokens = Sum-Field $g "output"
    }
  }
}

$summary = [pscustomobject]@{
  service = $Service
  sampledLogLines = $lines.Count
  parsedUsageEvents = $usage.Count
  firstTs = if ($usage.Count) { ($usage | Sort-Object ts | Select-Object -First 1).ts } else { $null }
  lastTs = if ($usage.Count) { ($usage | Sort-Object ts | Select-Object -Last 1).ts } else { $null }
  hitEvents = ($usage | Where-Object { $_.read -gt 0 } | Measure-Object).Count
  writeEvents = ($usage | Where-Object { $_.create -gt 0 } | Measure-Object).Count
  zeroCacheEvents = ($usage | Where-Object { $_.read -eq 0 -and $_.create -eq 0 } | Measure-Object).Count
  eligibleZeroCacheEvents = ($usage | Where-Object { $_.cacheEligible -and $_.read -eq 0 -and $_.create -eq 0 } | Measure-Object).Count
  inputTokens = Sum-Field $usage "input"
  cacheCreateTokens = Sum-Field $usage "create"
  cacheReadTokens = Sum-Field $usage "read"
  outputTokens = Sum-Field $usage "output"
  byPath = @(Group-Summary $usage "path")
  byTask = @(Group-Summary $usage "task")
  byPhase = @(Group-Summary $usage "phase")
}

if ($Json) {
  $summary | ConvertTo-Json -Depth 6
  exit
}

"Claude cache log summary"
"service: $($summary.service)"
"events: $($summary.parsedUsageEvents) / sampled lines: $($summary.sampledLogLines)"
"range UTC: $($summary.firstTs) - $($summary.lastTs)"
"hits: $($summary.hitEvents), writes: $($summary.writeEvents), zero: $($summary.zeroCacheEvents), eligible zero: $($summary.eligibleZeroCacheEvents)"
"tokens: input=$($summary.inputTokens), create=$($summary.cacheCreateTokens), read=$($summary.cacheReadTokens), output=$($summary.outputTokens)"
""
"By phase"
$summary.byPhase | Sort-Object key | Format-Table -AutoSize
""
"By task"
$summary.byTask | Sort-Object key | Format-Table -AutoSize
""
"By path"
$summary.byPath | Sort-Object key | Format-Table -AutoSize
