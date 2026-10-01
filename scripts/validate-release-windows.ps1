[CmdletBinding()]
param(
  [string]$NodePath = 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe',
  [switch]$Package,
  [switch]$PackagedSmoke,
  [switch]$VerifyFrames,
  [switch]$SkipRegression
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$smoke = Join-Path $root '.windows-smoke'
& (Join-Path $PSScriptRoot 'import-qwen-engine.ps1') -SourceDir (Join-Path $root '.windows-engine-build\bundle')
if (-not $SkipRegression) {
  foreach ($directory in @('dist', 'dist-electron')) {
    $target = Join-Path $smoke $directory
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    Copy-Item (Join-Path $root $directory) $target -Recurse
  }
  Copy-Item (Join-Path $PSScriptRoot 'smoke-preview-export.mjs') (Join-Path $smoke 'scripts\smoke-preview-export.mjs') -Force
  & $NodePath (Join-Path $smoke 'scripts\smoke-preview-export.mjs') (Join-Path $root 'resources') (Join-Path $smoke 'preview-export-regression')
  if ($LASTEXITCODE -ne 0) { throw 'Preview/audio/speed/export regression failed.' }
}
if ($VerifyFrames) {
  & $NodePath (Join-Path $PSScriptRoot 'check-speed-frames.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Video speed frame comparison failed.' }
}
if ($Package) {
  & (Join-Path $PSScriptRoot 'build-portable-windows.ps1') -NodePath $NodePath -PnpmCliPath (Join-Path $root '.windows-tools\node_modules\.pnpm\pnpm@10.33.0\node_modules\pnpm\bin\pnpm.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Portable packaging failed.' }
}
if ($PackagedSmoke) {
  $packageRoot = Get-ChildItem (Join-Path $root 'release-dev') -Directory -Filter 'VoxWeave-Portable-*-x64' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  $env:VOXWEAVE_COMPOSITION_SMOKE_CLONE_REFERENCE = Join-Path $root 'demo-voice-clone.wav'
  $env:VOXWEAVE_COMPOSITION_SMOKE_RATE = '2'
  $env:VOXWEAVE_ARTIFACT_SMOKE_DIR = Join-Path $smoke 'packaged-artifacts'
  & (Join-Path $PSScriptRoot 'smoke-packaged-windows.ps1') -PackageDir $packageRoot -ResultPath (Join-Path $smoke 'shared-codec-packaged.json') -WithExport
  if ($LASTEXITCODE -ne 0) { throw 'Packaged smoke failed.' }
  $report = Get-Content (Join-Path $smoke 'shared-codec-packaged.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($report.artifactResults.Count -ne 4 -or -not $report.clonedVoice) { throw 'Packaged clone/artifact exports were not verified.' }
  foreach ($artifact in $report.artifactResults) {
    if ((Get-Item $artifact.outputPath).Length -le 0) { throw "Empty artifact: $($artifact.kind)" }
    if ($artifact.kind -match 'mp3$') {
      $metadata = & (Join-Path $packageRoot 'resources\ffmpeg\ffprobe.exe') -v error -show_entries format=duration -of json $artifact.outputPath | ConvertFrom-Json
      if ([Math]::Abs([double]$metadata.format.duration * 1000 - $report.durationMs) -gt 180) { throw 'Packaged MP3 speed/duration mismatch.' }
    }
  }
  $models = Join-Path $packageRoot 'resources\models'
  if ((Test-Path (Join-Path $models 'qwen3-tts-1.7b-base\speech_tokenizer\model.safetensors')) -or
      (Test-Path (Join-Path $models 'qwen3-tts-1.7b-customvoice\speech_tokenizer\model.safetensors')) -or
      -not (Test-Path (Join-Path $models 'qwen3-tts-tokenizer\model.safetensors'))) { throw 'Packaged codec was not deduplicated.' }
  Write-Host 'Packaged shared codec, 1.7B clone, 2x preview/MP4/MP3 and subtitle exports passed.' -ForegroundColor Green
  'VOXWEAVE_COMPOSITION_SMOKE_CLONE_REFERENCE', 'VOXWEAVE_COMPOSITION_SMOKE_RATE', 'VOXWEAVE_ARTIFACT_SMOKE_DIR' | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }

}
