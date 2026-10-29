[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$ProjectDir,
  [string]$ResourceDir,
  [string]$ReleaseDir,
  [string]$NodePath = $env:npm_node_execpath,
  [string]$PnpmCliPath = $env:npm_execpath
)
$ErrorActionPreference = 'Stop'

function Get-InstallerSha256([string]$File) {
  # Nested Windows PowerShell can inherit a PowerShell 7 module path in CI.
  # Use .NET directly so hashing does not depend on Get-FileHash discovery.
  $stream = [IO.File]::OpenRead($File)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

if ($env:OS -ne 'Windows_NT') { throw 'Windows installer packaging requires Windows Node/pnpm.' }
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$project = if ($ProjectDir) { [IO.Path]::GetFullPath($ProjectDir) } else { $sourceRoot }
$sourceResources = if ($ResourceDir) { [IO.Path]::GetFullPath($ResourceDir) } else { Join-Path $project 'resources' }
$node = $NodePath
$pnpm = $PnpmCliPath
if (-not $node -or -not $pnpm) { throw 'Run through pnpm package:win:installer.' }
$stage = Join-Path $project ('.windows-stage-installer-' + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $stage 'electron-builder.json'
$resourceRoot = Join-Path $stage 'resources'
$package = Get-Content (Join-Path $project 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$output = if ($ReleaseDir) { [IO.Path]::GetFullPath($ReleaseDir) } else { Join-Path $project 'release' }
$installer = Join-Path $output "VoxWeave-Setup-$($package.version)-x64.exe"
if (Test-Path -LiteralPath $installer) { throw "Installer already exists: $installer. Bump the version or move the existing release." }
Push-Location $project
$previousPath = $env:PATH
$previous7zFilter = $env:ELECTRON_BUILDER_7Z_FILTER
try {
  # Nsis7z must be able to decode PE files in the generated archive.
  $env:ELECTRON_BUILDER_7Z_FILTER = 'BCJ'
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  $shim = "@echo off`r`n`"$node`" `"$pnpm`" %*`r`n"
  [IO.File]::WriteAllText((Join-Path $stage 'pnpm.cmd'), $shim, [Text.Encoding]::ASCII)
  $env:PATH = "$stage;$(Split-Path -Parent $node);$previousPath"
  if (-not $SkipBuild) {
    & $node $pnpm run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
  }
  & $node (Join-Path $PSScriptRoot 'create-model-downloads.mjs') $sourceResources $project
  if ($LASTEXITCODE -ne 0) { throw 'Model download catalog generation failed.' }
  New-Item -ItemType Directory -Force -Path $resourceRoot | Out-Null
  foreach ($folder in @('engine', 'ffmpeg', 'browser', 'cli')) {
    Copy-Item -LiteralPath (Join-Path $sourceResources $folder) -Destination $resourceRoot -Recurse
  }
  $semantic = Join-Path $resourceRoot 'semantic'
  New-Item -ItemType Directory -Force -Path $semantic | Out-Null
  foreach ($item in @('runtime', 'manifest.json', 'LLAMA-LICENSE.txt', 'QWEN-LICENSE.txt')) {
    Copy-Item -LiteralPath (Join-Path $sourceResources "semantic\$item") -Destination $semantic -Recurse
  }
  Copy-Item -LiteralPath (Join-Path $sourceResources 'model-downloads.json') -Destination $resourceRoot
  $engineInfo = Get-Content (Join-Path $resourceRoot 'engine\build-info.json') -Raw | ConvertFrom-Json
  if (-not $engineInfo.sharedSpeechTokenizer) { throw 'Qwen engine must support the shared speech tokenizer.' }
  & $node (Join-Path $PSScriptRoot 'verify-offline-resources.mjs') --root $resourceRoot --runtime-only --write-manifest
  if ($LASTEXITCODE -ne 0) { throw 'Installer runtime verification failed.' }
  $package.build.extraResources = @(@{ from = $resourceRoot; to = '.'; filter = @('**/*') })
  $package.build.directories.output = $output
  if ($env:LOCALAPPDATA) {
    $electronVersion = (Get-Content (Join-Path $project 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version
    $electronCache = Join-Path $env:LOCALAPPDATA 'electron\Cache'
    if (Test-Path -LiteralPath $electronCache -PathType Container) {
      $electronArchive = Get-ChildItem -LiteralPath $electronCache -Recurse -File -Filter "electron-v$electronVersion-win32-x64.zip" | Select-Object -First 1
      if ($electronArchive) {
        $package.build | Add-Member -NotePropertyName electronDist -NotePropertyValue $electronArchive.FullName -Force
        Write-Host "Reusing cached Electron archive: $($electronArchive.FullName)"
      }
    }
  }
  [IO.File]::WriteAllText($configPath, ($package.build | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
  & $node (Join-Path $project 'node_modules\electron-builder\out\cli\cli.js') --win nsis --x64 --publish never --config $configPath
  if ($LASTEXITCODE -ne 0) { throw 'NSIS installer build failed.' }
  & $node (Join-Path $PSScriptRoot 'verify-offline-resources.mjs') --root (Join-Path $output 'win-unpacked\resources') --runtime-only
  if ($LASTEXITCODE -ne 0) { throw 'Packaged installer runtime verification failed.' }
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'NSIS installer output is missing.' }
  if ((Get-Item -LiteralPath $installer).Length -ge 2GB) { throw 'Installer exceeds the GitHub release asset size limit.' }
  $hash = Get-InstallerSha256 $installer
  Set-Content -LiteralPath "$installer.sha256" -Value "$hash  $([IO.Path]::GetFileName($installer))" -Encoding ASCII
  Write-Host "Installer with first-launch model downloads: $installer" -ForegroundColor Green
} finally {
  $env:PATH = $previousPath
  $env:ELECTRON_BUILDER_7Z_FILTER = $previous7zFilter
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  Pop-Location
}
