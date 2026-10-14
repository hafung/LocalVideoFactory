[CmdletBinding()]
param(
  [string]$ResourceDir,
  [string]$ModelPath,
  [string]$ArchivePath,
  [switch]$RuntimeOnly
)

$ErrorActionPreference = 'Stop'
$ResourceDir = if ($ResourceDir) { [IO.Path]::GetFullPath($ResourceDir) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\resources\semantic')) }
$modelName = 'Qwen3-Embedding-0.6B-Q8_0.gguf'
$modelUrl = "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/$modelName"
$modelHash = '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439'
$archiveName = 'llama-b11039-bin-win-cpu-x64.zip'
$archiveUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b11039/$archiveName"
$archiveHash = '3fcc2bdc6864ed14740ac47257c90e3ebbc4b6cccf9ae954ffe35741528e8ed9'
$modelDir = Join-Path $ResourceDir 'model'
$runtimeDir = Join-Path $ResourceDir 'runtime'
$destinationModel = Join-Path $modelDir $modelName
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('voxweave-semantic-' + [guid]::NewGuid().ToString('N'))

function Assert-Hash([string]$Path, [string]$Expected) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing file: $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) { throw "SHA-256 mismatch: $Path (expected $Expected, got $actual)" }
}

New-Item -ItemType Directory -Force -Path $ResourceDir, $modelDir, $runtimeDir, $temporary | Out-Null
try {
  if (-not $RuntimeOnly -and -not (Test-Path -LiteralPath $destinationModel -PathType Leaf)) {
    $sourceModel = if ($ModelPath) { $ModelPath } else { Join-Path $temporary $modelName }
    if (-not $ModelPath) { Invoke-WebRequest -Uri $modelUrl -OutFile $sourceModel }
    Assert-Hash $sourceModel $modelHash
    Copy-Item -LiteralPath $sourceModel -Destination $destinationModel
  }
  if (-not $RuntimeOnly) { Assert-Hash $destinationModel $modelHash }

  if (-not (Test-Path -LiteralPath (Join-Path $runtimeDir 'llama-server.exe') -PathType Leaf)) {
    $sourceArchive = if ($ArchivePath) { $ArchivePath } else { Join-Path $temporary $archiveName }
    if (-not $ArchivePath) { Invoke-WebRequest -Uri $archiveUrl -OutFile $sourceArchive }
    Assert-Hash $sourceArchive $archiveHash
    Expand-Archive -LiteralPath $sourceArchive -DestinationPath $runtimeDir -Force
  }
  foreach ($name in @('llama-server.exe', 'llama-server-impl.dll', 'llama-common.dll', 'llama.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-x64.dll', 'libomp.dll', 'LICENSE-LLVM-OpenMP')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeDir $name) -PathType Leaf)) { throw "Runtime file is missing: $name" }
  }
  $descriptors = @(
    Get-ChildItem -LiteralPath $runtimeDir -File | ForEach-Object {
      [ordered]@{ path = "runtime/$($_.Name)"; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
  ) + @(
    [ordered]@{ path = 'LLAMA-LICENSE.txt'; sha256 = (Get-FileHash -LiteralPath (Join-Path $ResourceDir 'LLAMA-LICENSE.txt') -Algorithm SHA256).Hash.ToLowerInvariant() },
    [ordered]@{ path = 'QWEN-LICENSE.txt'; sha256 = (Get-FileHash -LiteralPath (Join-Path $ResourceDir 'QWEN-LICENSE.txt') -Algorithm SHA256).Hash.ToLowerInvariant() }
  )
  if (-not $RuntimeOnly) { $descriptors += [ordered]@{ path = "model/$modelName"; sha256 = $modelHash } }
  $manifest = [ordered]@{
    model = 'Qwen3-Embedding-0.6B-GGUF Q8_0'
    modelSource = $modelUrl
    modelSha256 = $modelHash
    runtime = 'llama.cpp b11039 Windows x64 CPU'
    runtimeSource = $archiveUrl
    runtimeArchiveSha256 = $archiveHash
    files = $descriptors
  }
  $json = ($manifest | ConvertTo-Json -Depth 6).Replace("`r`n", "`n")
  [IO.File]::WriteAllText((Join-Path $ResourceDir 'manifest.json'), "$json`n", [Text.UTF8Encoding]::new($false))
  Write-Host "Local CPU semantic model ready in $ResourceDir" -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
