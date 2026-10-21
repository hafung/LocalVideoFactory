[CmdletBinding()]
param([string]$ModelPath, [string]$ResourceDir, [switch]$Download)
$ErrorActionPreference = 'Stop'
$root = if ($ResourceDir) { [IO.Path]::GetFullPath($ResourceDir) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\resources')) }
$manifest = Get-Content (Join-Path $root 'scene-planner\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($relative in @($manifest.modelFile, $manifest.projectorFile)) {
  $descriptor = $manifest.files | Where-Object { $_.path -eq $relative } | Select-Object -First 1
  if (-not $descriptor) { throw "Missing scene model resource descriptor: $relative" }
  $target = Join-Path $root ('scene-planner\' + $relative)
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  if ($ModelPath -and $relative -eq $manifest.modelFile) {
    $source = [IO.Path]::GetFullPath($ModelPath)
    if ($source -ne [IO.Path]::GetFullPath($target)) { Copy-Item -LiteralPath $source -Destination $target }
  }
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    if (-not $Download) { throw "Qwen3.5 model or vision projector is missing: $relative. Run pnpm setup:scene-model." }
    $filename = [IO.Path]::GetFileName($relative)
    $url = "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/$($manifest.revision)/$($filename)?download=true"
    & curl.exe --fail --location --retry 3 --continue-at - --output "$target.part" $url
    if ($LASTEXITCODE -ne 0) { throw 'Qwen3.5 model download failed; partial download is preserved for resume.' }
    if ((Get-Item -LiteralPath "$target.part").Length -ne $descriptor.size -or
        (Get-FileHash -LiteralPath "$target.part" -Algorithm SHA256).Hash.ToLowerInvariant() -ne $descriptor.sha256) {
      throw "Downloaded model resource failed size/SHA-256 verification: $relative"
    }
    Move-Item -LiteralPath "$target.part" -Destination $target
  }
  if ((Get-Item -LiteralPath $target).Length -ne $descriptor.size -or
    (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $descriptor.sha256) {
    throw 'Qwen3.5 GGUF size or SHA-256 does not match the pinned model. Packaging stopped.'
  }
  Write-Host "Verified portable scene model resource: $target" -ForegroundColor Green
}
