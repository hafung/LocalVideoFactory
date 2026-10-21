[CmdletBinding()]
param(
  [string]$NodePath,
  [string]$PnpmCliPath,
  [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this script in Windows PowerShell.' }
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stageRoot = Join-Path $sourceRoot '.windows-stage-local'
if (-not $NodePath) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  $nodeCandidates = @(
    $(if ($nodeCommand) { $nodeCommand.Source }),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),
    (Join-Path $env:SystemDrive ('Users\' + $env:USERNAME + '\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
  )
  $NodePath = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Install Windows Node.js 22+ or pass -NodePath <node.exe>.' }
if (-not $PnpmCliPath) {
  $candidates = @(
    $env:npm_execpath,
    (Join-Path (Split-Path -Parent $NodePath) 'node_modules\pnpm\bin\pnpm.cjs'),
    (Join-Path (Split-Path -Parent (Split-Path -Parent $NodePath)) 'node_modules\pnpm\bin\pnpm.cjs'),
    (Join-Path $sourceRoot '.windows-smoke\.windows-tools\pnpm\bin\pnpm.cjs')
  )
  $pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if ($pnpmCommand) { $candidates += Join-Path (Split-Path -Parent $pnpmCommand.Source) 'node_modules\pnpm\bin\pnpm.cjs' }
  $PnpmCliPath = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) -and $_ -match 'pnpm\.(cjs|js)$' } | Select-Object -First 1
}
if (-not $PnpmCliPath -or -not (Test-Path -LiteralPath $PnpmCliPath -PathType Leaf)) {
  throw 'Windows pnpm CLI not found. Install pnpm or pass -PnpmCliPath <pnpm.cjs>.'
}
$NodePath = [IO.Path]::GetFullPath($NodePath)
$PnpmCliPath = [IO.Path]::GetFullPath($PnpmCliPath)
$previousPath = $env:PATH
$previousResourceRoot = $env:VOXWEAVE_RESOURCE_ROOT
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
$previousDevUrl = $env:VITE_DEV_SERVER_URL
$shimDir = Join-Path ([IO.Path]::GetTempPath()) ('voxweave-local-' + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Force -Path $stageRoot, $shimDir | Out-Null
  $shim = "@echo off`r`n`"$NodePath`" `"$PnpmCliPath`" %*`r`n"
  [IO.File]::WriteAllText((Join-Path $shimDir 'pnpm.cmd'), $shim, [Text.Encoding]::ASCII)
  $env:PATH = "$shimDir;$(Split-Path -Parent $NodePath);$previousPath"
  # Keep Windows dependencies separate from the WSL node_modules. Reuse them on subsequent runs.
  foreach ($item in @('src', 'electron', 'shared', 'cli', 'scripts', 'build')) {
    $destination = Join-Path $stageRoot $item
    if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
    Copy-Item -LiteralPath (Join-Path $sourceRoot $item) -Destination $stageRoot -Recurse -Force
  }
  foreach ($item in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.electron.json', 'vite.config.ts', 'index.html', 'LICENSE', 'LICENSES.md')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $item) -Destination $stageRoot -Force
  }
  Push-Location $stageRoot
  try {
    & $NodePath $PnpmCliPath install --frozen-lockfile --offline
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'Windows dependencies are not all cached; downloading missing packages.'
      & $NodePath $PnpmCliPath install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { throw "Windows dependency installation failed ($LASTEXITCODE)." }
    }
    & $NodePath $PnpmCliPath run build
    if ($LASTEXITCODE -ne 0) { throw "Local production build failed ($LASTEXITCODE)." }
    $env:VOXWEAVE_RESOURCE_ROOT = Join-Path $sourceRoot 'resources'
    Remove-Item Env:ELECTRON_RUN_AS_NODE, Env:VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue
    Write-Host "Local app: $stageRoot" -ForegroundColor Green
    Write-Host "Shared models and engines: $env:VOXWEAVE_RESOURCE_ROOT" -ForegroundColor Green
    if (-not $PrepareOnly) {
      & $NodePath (Join-Path $stageRoot 'node_modules\electron\cli.js') '.'
      if ($LASTEXITCODE -ne 0) { throw "Local app exited with code $LASTEXITCODE." }
    }
  } finally { Pop-Location }
} finally {
  $env:PATH = $previousPath
  $env:VOXWEAVE_RESOURCE_ROOT = $previousResourceRoot
  $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
  $env:VITE_DEV_SERVER_URL = $previousDevUrl
  if (Test-Path -LiteralPath $shimDir) { Remove-Item -LiteralPath $shimDir -Recurse -Force }
}
