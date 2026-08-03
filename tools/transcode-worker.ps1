[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,

  [string]$FfmpegPath = "",

  [string]$ResultPath = ""
)

$ErrorActionPreference = "Stop"
$ExpectedKind = "qianchuan-owned-master-transcode-v1"
$ExpectedMaterialWorkflowKind = "qianchuan-local-material-analysis-v1"
$ResultKind = "qianchuan-owned-master-transcode-result-v1"

function Write-ResultFile {
  param([object]$Payload, [string]$Path)
  $json = $Payload | ConvertTo-Json -Depth 8
  Set-Content -LiteralPath $Path -Value $json -Encoding utf8
}

function Find-ArgumentValue {
  param([object[]]$Arguments, [string]$Flag)
  $index = [Array]::IndexOf($Arguments, $Flag)
  if ($index -lt 0 -or $index + 1 -ge $Arguments.Count) { return $null }
  return [string]$Arguments[$index + 1]
}

function Assert-ExactArguments {
  param([string[]]$Actual, [string[]]$Expected, [string]$Operation)
  if ($Actual.Count -ne $Expected.Count) { throw "$Operation arguments do not match the fixed template." }
  for ($index = 0; $index -lt $Expected.Count; $index += 1) {
    if ($Actual[$index] -cne $Expected[$index]) { throw "$Operation arguments do not match the fixed template." }
  }
}

function Assert-SafeArguments {
  param([object]$Task)
  $arguments = @($Task.ffmpegArguments | ForEach-Object { [string]$_ })
  if ($arguments.Count -lt 10) { throw "Task arguments are incomplete." }

  $allowedFlags = @(
    "-hide_banner", "-n", "-i", "-map", "-map_metadata", "-map_chapters",
    "-c:v", "-preset", "-crf", "-b:v", "-pix_fmt", "-vf", "-r",
    "-c:a", "-b:a", "-ar", "-movflags", "-vn", "-ac"
  )
  foreach ($argument in $arguments) {
    if ($argument.StartsWith("-") -and -not $allowedFlags.Contains($argument)) {
      throw "Unsupported task argument: $argument"
    }
  }
  if (-not $arguments.Contains("-n") -or $arguments.Contains("-y")) { throw "The worker requires no-overwrite mode." }
  if ((Find-ArgumentValue $arguments "-map_metadata") -ne "0") { throw "Input metadata must be preserved." }
  if ((Find-ArgumentValue $arguments "-map_chapters") -ne "0") { throw "Input chapters must be preserved." }
  if ((Find-ArgumentValue $arguments "-i") -ne [string]$Task.sourcePath) { throw "The input path does not match the task manifest." }
  if ([string]$arguments[-1] -ne [string]$Task.outputPath) { throw "The output path does not match the task manifest." }

  if ($arguments.Contains("-metadata") -or $arguments.Contains("-filter_complex")) {
    throw "The task contains a blocked metadata or complex-filter argument."
  }
  $operation = if ($Task.operation) { [string]$Task.operation } else { "standardize_video" }
  if ($operation -eq "extract_audio") {
    $expectedArguments = @(
      "-hide_banner", "-n", "-i", [string]$Task.sourcePath,
      "-map", "0:a:0", "-map_metadata", "0", "-map_chapters", "0",
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      [string]$Task.outputPath
    )
    Assert-ExactArguments $arguments $expectedArguments "Audio extraction"
    if (-not $arguments.Contains("-vn")) { throw "Audio extraction must disable video output." }
    if ((Find-ArgumentValue $arguments "-map") -ne "0:a:0") { throw "Audio extraction must map the first audio stream." }
    if ((Find-ArgumentValue $arguments "-ac") -ne "1") { throw "Audio extraction must use mono audio." }
    if ((Find-ArgumentValue $arguments "-ar") -ne "16000") { throw "Audio extraction must use a 16 kHz sample rate." }
    if ((Find-ArgumentValue $arguments "-c:a") -ne "pcm_s16le") { throw "Audio extraction must use PCM 16-bit audio." }
    if ([IO.Path]::GetExtension([string]$Task.outputPath).ToLowerInvariant() -ne ".wav") { throw "Audio extraction output must be a WAV file." }
    foreach ($blockedFlag in @("-c:v", "-vf", "-filter_complex", "-metadata")) {
      if ($arguments.Contains($blockedFlag)) { throw "Audio extraction contains a blocked video or metadata-writing flag." }
    }
  } elseif ($operation -eq "standardize_video") {
    $filter = Find-ArgumentValue $arguments "-vf"
    $allowedScaleFilters = @(
      "scale=if(gte(iw\,ih)\,min(1920\,iw)\,min(1080\,iw)):-2",
      "scale=if(gte(iw\,ih)\,min(1280\,iw)\,min(720\,iw)):-2",
      "scale=if(gte(iw\,ih)\,min(854\,iw)\,min(480\,iw)):-2"
    )
    if ($null -ne $filter -and -not $allowedScaleFilters.Contains($filter)) {
      throw "Only aspect-ratio-preserving scale filters are allowed."
    }
  } else {
    throw "Unsupported task operation: $operation"
  }
  return $arguments
}

$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$manifest = Get-Content -LiteralPath $resolvedManifest -Raw -Encoding utf8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.kind -ne $ExpectedKind) { throw "Unsupported task manifest version." }
if ($manifest.workflowKind -and $manifest.workflowKind -ne $ExpectedMaterialWorkflowKind) { throw "Unsupported material workflow kind." }
if ($manifest.authorization.confirmed -ne $true) { throw "The manifest is missing the owned-or-authorized-source confirmation." }
if ($manifest.processing.remoteUpload -ne $false) { throw "Remote-upload tasks are not accepted." }
if ($manifest.processing.preserveMetadata -ne $true -or $manifest.processing.preserveChapters -ne $true) {
  throw "The task manifest must preserve metadata and chapters."
}

if (-not $FfmpegPath) { $FfmpegPath = [string]$manifest.processing.ffmpegExecutable }
if (-not $FfmpegPath) { $FfmpegPath = "ffmpeg" }
$ffmpegLeaf = [IO.Path]::GetFileName($FfmpegPath).ToLowerInvariant()
if ($ffmpegLeaf -ne "ffmpeg" -and $ffmpegLeaf -ne "ffmpeg.exe") { throw "FfmpegPath must point to ffmpeg or ffmpeg.exe." }
if ($FfmpegPath.Contains("\") -or $FfmpegPath.Contains("/")) {
  if (-not (Test-Path -LiteralPath $FfmpegPath -PathType Leaf)) { throw "FFmpeg was not found: $FfmpegPath" }
} elseif (-not (Get-Command $FfmpegPath -ErrorAction SilentlyContinue)) {
  throw "FFmpeg was not found. Install it or use -FfmpegPath to specify ffmpeg.exe."
}

if (-not $ResultPath) { $ResultPath = [IO.Path]::ChangeExtension($resolvedManifest, ".results.json") }
$resultDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($ResultPath))
if (-not (Test-Path -LiteralPath $resultDirectory)) { New-Item -ItemType Directory -Path $resultDirectory | Out-Null }

$taskResults = [System.Collections.Generic.List[object]]::new()
$tasks = @($manifest.tasks)
Write-Host "Owned-master local media processing: $($tasks.Count) task(s)"
Write-Host "No uploads, no overwrite, and metadata/chapters are preserved."

for ($index = 0; $index -lt $tasks.Count; $index += 1) {
  $task = $tasks[$index]
  $startedAt = (Get-Date).ToUniversalTime().ToString("o")
  Write-Host "[$($index + 1)/$($tasks.Count)] $($task.source.name)"
  try {
    $arguments = Assert-SafeArguments $task
    $sourcePath = [IO.Path]::GetFullPath([string]$task.sourcePath)
    $outputPath = [IO.Path]::GetFullPath([string]$task.outputPath)
    if ($sourcePath -eq $outputPath) { throw "Output path cannot be the same as the source path." }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Owned source file was not found: $sourcePath" }
    if (Test-Path -LiteralPath $outputPath) { throw "Output already exists; the worker will not overwrite it: $outputPath" }
    $outputDirectory = Split-Path -Parent $outputPath
    if (-not (Test-Path -LiteralPath $outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory | Out-Null }

    & $FfmpegPath @arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "FFmpeg exit code: $exitCode" }
    if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) { throw "FFmpeg did not create the expected output file." }
    $taskResults.Add([pscustomobject]@{
      id = [string]$task.id
      status = "completed"
      exitCode = 0
      outputPath = $outputPath
      failureReason = ""
      startedAt = $startedAt
      finishedAt = (Get-Date).ToUniversalTime().ToString("o")
    })
    Write-Host "Completed: $outputPath" -ForegroundColor Green
  } catch {
    $taskResults.Add([pscustomobject]@{
      id = [string]$task.id
      status = "failed"
      exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { -1 }
      outputPath = [string]$task.outputPath
      failureReason = $_.Exception.Message
      startedAt = $startedAt
      finishedAt = (Get-Date).ToUniversalTime().ToString("o")
    })
    Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red
  }

  $partialResult = [pscustomobject]@{
    schemaVersion = 1
    kind = $ResultKind
    manifestId = [string]$manifest.manifestId
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    tasks = $taskResults
  }
  Write-ResultFile $partialResult $ResultPath
}

$completed = @($taskResults | Where-Object { $_.status -eq "completed" }).Count
$failed = @($taskResults | Where-Object { $_.status -eq "failed" }).Count
Write-Host "Finished: $completed completed, $failed failed"
Write-Host "Result file: $ResultPath"
if ($failed -gt 0) { exit 2 }
