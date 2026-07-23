param(
  [string]$Service = $(if ($env:RENDER_SERVICE_ID) { $env:RENDER_SERVICE_ID } else { "srv-d6pl9qlm5p6s73fmh280" }),
  [int]$Limit = 1000,
  [string]$Text = "gpt_prod.usage",
  [string]$InputPath = "",
  [switch]$Json
)

$ErrorActionPreference = "Stop"

if ($InputPath) {
  if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "Input log file was not found: $InputPath"
  }
  $lines = @(Get-Content -LiteralPath $InputPath)
  $source = (Resolve-Path -LiteralPath $InputPath).Path
} else {
  if (-not (Get-Command render -ErrorAction SilentlyContinue)) {
    throw "Render CLI is not installed or not available on PATH. Pass -InputPath to analyze an exported log file."
  }
  $ErrorActionPreference = "Continue"
  try {
    $renderOutput = @(render logs --resources $Service --text $Text --limit $Limit --direction backward --output text 2>&1)
    $renderExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = "Stop"
  }
  if ($renderExitCode -ne 0) {
    $detail = ($renderOutput | Select-Object -First 8) -join [Environment]::NewLine
    throw "Render log query failed with exit code $renderExitCode.`n$detail"
  }
  $lines = $renderOutput
  $source = "render:$Service"
}

$usage = @()

foreach ($line in $lines) {
  if ($line -notmatch "\{.*\}$") { continue }
  try {
    $m = $Matches[0] | ConvertFrom-Json
    if ($m.event -ne "gpt_prod.usage") { continue }
    if ($null -eq $m.inputTokens -or $null -eq $m.cachedInputTokens) { continue }
    $inputTokens = [int64]$m.inputTokens
    $cachedInputTokens = [int64]$m.cachedInputTokens
    $cacheKey = if ($m.promptCacheKey) { [string]$m.promptCacheKey } else { "(disabled)" }
    $sizeEligible = if ($null -ne $m.promptCacheSizeEligible) {
      [bool]$m.promptCacheSizeEligible
    } else {
      $inputTokens -ge 1024
    }
    $cacheRead = if ($null -ne $m.promptCacheRead) {
      [bool]$m.promptCacheRead
    } else {
      $cachedInputTokens -gt 0
    }
    $sizedMiss = if ($null -ne $m.promptCacheSizedMiss) {
      [bool]$m.promptCacheSizedMiss
    } else {
      $cacheKey -ne "(disabled)" -and $sizeEligible -and -not $cacheRead
    }
    $usage += [pscustomobject]@{
      ts = [string]$m.ts
      path = if ($m.path) { [string]$m.path } else { "" }
      task = if ($m.task) { [string]$m.task } else { "unknown" }
      phase = if ($m.phase) { [string]$m.phase } else { "main" }
      mode = if ($m.mode) { [string]$m.mode } else { "" }
      model = if ($m.model) { [string]$m.model } else { "unknown" }
      cacheKey = $cacheKey
      input = $inputTokens
      cached = $cachedInputTokens
      cacheWrite = if ($null -ne $m.cacheWriteTokens) { [int64]$m.cacheWriteTokens } else { 0 }
      uncached = if ($null -ne $m.uncachedInputTokens) {
        [int64]$m.uncachedInputTokens
      } else {
        [Math]::Max(0, $inputTokens - $cachedInputTokens)
      }
      output = if ($null -ne $m.outputTokens) { [int64]$m.outputTokens } else { 0 }
      reasoning = if ($null -ne $m.reasoningTokens) { [int64]$m.reasoningTokens } else { 0 }
      sizeEligible = $sizeEligible
      read = $cacheRead
      sizedMiss = $sizedMiss
      estimatedUsd = if ($null -ne $m.estimatedUsd) { [double]$m.estimatedUsd } else { 0 }
      elapsedMs = if ($null -ne $m.elapsedMs) { [double]$m.elapsedMs } else { 0 }
    }
  } catch {
    continue
  }
}

function Sum-Field($Rows, $Field) {
  $sum = ($Rows | Measure-Object $Field -Sum).Sum
  if ($null -eq $sum) { return 0 }
  return [double]$sum
}

function Rate($Numerator, $Denominator) {
  if (-not $Denominator) { return 0 }
  return [Math]::Round(([double]$Numerator / [double]$Denominator), 4)
}

function Group-Summary($Rows, $Name) {
  $groups = $Rows | Group-Object $Name
  foreach ($group in $groups) {
    $g = $group.Group
    $input = Sum-Field $g "input"
    $cached = Sum-Field $g "cached"
    $eligible = ($g | Where-Object { $_.sizeEligible } | Measure-Object).Count
    $reads = ($g | Where-Object { $_.read } | Measure-Object).Count
    $sizedMisses = ($g | Where-Object { $_.sizedMiss } | Measure-Object).Count
    $minuteBuckets = @($g |
      Where-Object { $_.ts } |
      Group-Object {
        try { ([DateTimeOffset]::Parse($_.ts)).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm") }
        catch { "(invalid)" }
      })
    $peakRpm = if ($minuteBuckets.Count) {
      [int](($minuteBuckets | Measure-Object Count -Maximum).Maximum)
    } else {
      0
    }
    [pscustomobject]@{
      key = if ($group.Name) { $group.Name } else { "(empty)" }
      calls = $g.Count
      sizeEligible = $eligible
      reads = $reads
      sizedMisses = $sizedMisses
      peakRpm = $peakRpm
      over15Rpm = $peakRpm -gt 15
      eventHitRate = Rate $reads $g.Count
      tokenHitRate = Rate $cached $input
      inputTokens = [int64]$input
      cachedTokens = [int64]$cached
      cacheWriteTokens = [int64](Sum-Field $g "cacheWrite")
      outputTokens = [int64](Sum-Field $g "output")
      reasoningTokens = [int64](Sum-Field $g "reasoning")
      estimatedUsd = [Math]::Round((Sum-Field $g "estimatedUsd"), 4)
      avgElapsedMs = if ($g.Count) { [Math]::Round((Sum-Field $g "elapsedMs") / $g.Count) } else { 0 }
    }
  }
}

$inputTotal = Sum-Field $usage "input"
$cachedTotal = Sum-Field $usage "cached"
$readEvents = ($usage | Where-Object { $_.read } | Measure-Object).Count
$eligibleEvents = ($usage | Where-Object { $_.sizeEligible } | Measure-Object).Count
$sizedMissEvents = ($usage | Where-Object { $_.sizedMiss } | Measure-Object).Count

$summary = [pscustomobject]@{
  source = $source
  service = $Service
  sampledLogLines = $lines.Count
  parsedUsageEvents = $usage.Count
  firstTs = if ($usage.Count) { ($usage | Sort-Object ts | Select-Object -First 1).ts } else { $null }
  lastTs = if ($usage.Count) { ($usage | Sort-Object ts | Select-Object -Last 1).ts } else { $null }
  sizeEligibleEvents = $eligibleEvents
  cacheReadEvents = $readEvents
  sizedMissEvents = $sizedMissEvents
  eventHitRate = Rate $readEvents $usage.Count
  tokenHitRate = Rate $cachedTotal $inputTotal
  inputTokens = [int64]$inputTotal
  cachedTokens = [int64]$cachedTotal
  cacheWriteTokens = [int64](Sum-Field $usage "cacheWrite")
  uncachedTokens = [int64](Sum-Field $usage "uncached")
  outputTokens = [int64](Sum-Field $usage "output")
  reasoningTokens = [int64](Sum-Field $usage "reasoning")
  estimatedUsd = [Math]::Round((Sum-Field $usage "estimatedUsd"), 4)
  byTask = @(Group-Summary $usage "task")
  byPhase = @(Group-Summary $usage "phase")
  byModel = @(Group-Summary $usage "model")
  byCacheKey = @(Group-Summary $usage "cacheKey")
}

if ($Json) {
  $summary | ConvertTo-Json -Depth 7
  exit
}

"GPT prompt cache log summary"
"source: $($summary.source)"
"events: $($summary.parsedUsageEvents) / sampled lines: $($summary.sampledLogLines)"
"range UTC: $($summary.firstTs) - $($summary.lastTs)"
"eligible: $($summary.sizeEligibleEvents), reads: $($summary.cacheReadEvents), sized misses: $($summary.sizedMissEvents)"
"hit rates: events=$($summary.eventHitRate), tokens=$($summary.tokenHitRate)"
"tokens: input=$($summary.inputTokens), cached=$($summary.cachedTokens), write=$($summary.cacheWriteTokens), output=$($summary.outputTokens), reasoning=$($summary.reasoningTokens)"
"estimated cost: `$$($summary.estimatedUsd)"
""
"By model"
$summary.byModel | Sort-Object inputTokens -Descending | Format-Table -AutoSize
""
"By task"
$summary.byTask | Sort-Object inputTokens -Descending | Format-Table -AutoSize
""
"By phase"
$summary.byPhase | Sort-Object inputTokens -Descending | Format-Table -AutoSize
""
"Top cache keys by input tokens"
$summary.byCacheKey | Sort-Object inputTokens -Descending | Select-Object -First 20 | Format-Table -AutoSize
