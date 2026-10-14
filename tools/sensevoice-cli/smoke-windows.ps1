[CmdletBinding()]
param([string]$BundleDir, [string]$ReportDir)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $BundleDir) { $BundleDir = Join-Path $project 'release-dev\SenseVoice-CLI-0.2.0-win-x64' }
if (-not $ReportDir) { $ReportDir = Join-Path $project '.windows-smoke\sensevoice-phrases' }
[IO.Directory]::CreateDirectory($ReportDir) | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)

function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$WorkingDirectory) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $Exe
  $quoted = foreach ($argument in $Arguments) {
    $escaped = [regex]::Replace($argument, '(\\*)"', { param($m) ($m.Groups[1].Value + $m.Groups[1].Value) + '\"' })
    '"' + ([regex]::Replace($escaped, '(\\+)$', '$1$1')) + '"'
  }
  $info.Arguments = $quoted -join ' '
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = $utf8
  $info.StandardErrorEncoding = $utf8
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  $watch = [Diagnostics.Stopwatch]::StartNew()
  if (-not $process.Start()) { throw 'Could not start standalone EXE.' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'Native CLI timeout.' }
  $watch.Stop()
  $result = [ordered]@{ exitCode = $process.ExitCode; stdout = $stdoutTask.Result; stderr = $stderrTask.Result; wallMs = $watch.ElapsedMilliseconds }
  $process.Dispose()
  return $result
}
function Assert-Ok($Result, [string]$Name) {
  if ($Result.exitCode -ne 0) { throw "$Name failed ($($Result.exitCode)): $($Result.stderr)" }
}
function Normalize([string]$Value) {
  return ([regex]::Replace($Value.Normalize([Text.NormalizationForm]::FormKC), '[\p{P}\p{S}\s]', '')).ToLowerInvariant()
}
function Windows-Path([string]$Value) {
  if ($Value -match '^/mnt/([a-z])/(.*)$') { return $matches[1].ToUpperInvariant() + ':\' + $matches[2].Replace('/', '\') }
  return $Value
}
function Check-Result($Data, [string]$Reference, [bool]$AllowRecognitionDifference = $false) {
  if (-not $AllowRecognitionDifference -and (Normalize $Data.text) -ne (Normalize $Reference)) { throw "Transcript mismatch: $($Data.text)" }
  if ($Data.schemaVersion -ne 1 -or -not $Data.tokens.Count -or -not $Data.subtitles.Count) { throw 'Missing structured result fields.' }
  foreach ($token in $Data.tokens) {
    if ($token.startMs -lt 0 -or $token.endMs -le $token.startMs -or $token.endMs -gt $Data.audio.durationMs) { throw 'Invalid token interval.' }
    if (-not $token.endSource) { throw 'Missing end-time provenance.' }
  }
  $lastEnd = 0
  foreach ($cue in $Data.subtitles) {
    if ($cue.startMs -lt $lastEnd -or $cue.endMs -le $cue.startMs -or $cue.endMs -gt $Data.audio.durationMs) { throw 'Invalid or overlapping SRT interval.' }
    $lastEnd = $cue.endMs
  }
}
function Ass-Time([string]$Value) {
  if ($Value -notmatch '^(\d+):(\d{2}):(\d{2})\.(\d{2})$') { throw 'Invalid ASS timestamp.' }
  return ([long]$matches[1] * 3600000 + [long]$matches[2] * 60000 + [long]$matches[3] * 1000 + [long]$matches[4] * 10)
}
function Check-Ass([string]$Content, $Data) {
  foreach ($header in @('[Script Info]', 'ScriptType: v4.00+', '[V4+ Styles]', '[Events]', 'Style: Default,Microsoft YaHei,')) {
    if (-not $Content.Contains($header)) { throw "Missing ASS header/style: $header" }
  }
  $lines = @($Content -split '\r?\n' | Where-Object { $_.StartsWith('Dialogue: ') })
  if ($lines.Count -ne $Data.subtitles.Count) { throw 'ASS cue count differs from JSON.' }
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $fields = $lines[$i].Substring(10) -split ',', 10
    if ($fields.Count -ne 10 -or $fields[3] -ne 'Default') { throw 'Malformed ASS dialogue.' }
    $begin = Ass-Time $fields[1]; $end = Ass-Time $fields[2]; $cue = $Data.subtitles[$i]
    if ($end -le $begin -or [Math]::Abs($begin - $cue.startMs) -gt 5 -or [Math]::Abs($end - $cue.endMs) -gt 10) { throw 'ASS time differs from acoustic cue.' }
    if ($fields[9] -ne $cue.text) { throw 'ASS text differs from JSON.' }
  }
}
function Codepoints([string]$Value) {
  $output = New-Object 'Collections.Generic.List[string]'
  for ($i = 0; $i -lt $Value.Length; $i++) {
    if ([char]::IsHighSurrogate($Value[$i]) -and $i + 1 -lt $Value.Length -and [char]::IsLowSurrogate($Value[$i + 1])) {
      $output.Add($Value.Substring($i, 2)); $i++
    } else { $output.Add($Value.Substring($i, 1)) }
  }
  return ,($output.ToArray())
}
function Check-Highlights($Data, [string]$Content) {
  $count = 0
  foreach ($cue in $Data.subtitles) {
    $chars = Codepoints $cue.text
    if (-not $cue.words.Count -or -not $cue.highlightUnits.Count) { throw 'Missing word/highlight metadata.' }
    $previousEnd = $cue.startMs; $previousChar = 0
    foreach ($unit in $cue.highlightUnits) {
      if ($unit.startMs -lt $previousEnd -or $unit.endMs -le $unit.startMs -or $unit.endMs -gt $cue.endMs -or
          $unit.startChar -lt $previousChar -or $unit.endChar -le $unit.startChar -or $unit.endChar -gt $chars.Count) { throw 'Invalid highlight range.' }
      $text = ($chars[$unit.startChar..($unit.endChar - 1)]) -join ''
      if ($text -ne $unit.text -or $unit.timingSource -notin @('acoustic-derived','estimated') -or $unit.groupingSource -ne 'rule') { throw 'Highlight provenance/text mismatch.' }
      $previousEnd = $unit.endMs; $previousChar = $unit.endChar; $count++
    }
  }
  if (-not $count -or -not $Content.Contains('{\c&H006DE2FF&}')) { throw 'ASS has no current-group colour.' }
  $previousEnd = 0
  foreach ($line in @($Content -split '\r?\n' | Where-Object { $_.StartsWith('Dialogue: ') })) {
    $fields = $line.Substring(10) -split ',', 10
    $begin = Ass-Time $fields[1]; $end = Ass-Time $fields[2]
    if ($begin -lt $previousEnd -or $end -le $begin) { throw 'Overlapping/empty ASS highlight event.' }
    $previousEnd = $end
  }
}

$exe = Join-Path $BundleDir 'sensevoice-cli.exe'
$checks = @()
$version = Invoke-Native $exe @('--version') $env:TEMP
Assert-Ok $version 'Version check'
$versionData = $version.stdout | ConvertFrom-Json
$ready = Invoke-Native $exe @('--check') $env:TEMP
Assert-Ok $ready 'Model load'
$checks += [ordered]@{ name = 'version'; result = $versionData }
$checks += [ordered]@{ name = 'model-load'; result = ($ready.stdout | ConvertFrom-Json) }

foreach ($report in @('asr-compare\report.json', 'asr-compare-stress\report.json')) {
  $data = Get-Content (Join-Path $project ".windows-smoke\$report") -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($sample in $data.samples) {
    $sampleAss = Join-Path $ReportDir ($sample.id + '.ass')
    $result = Invoke-Native $exe @('-i', (Windows-Path $sample.file), '--ass-output', $sampleAss) $env:TEMP
    Assert-Ok $result $sample.id
    $recognized = $result.stdout | ConvertFrom-Json
    [IO.File]::WriteAllText((Join-Path $ReportDir ($sample.id + '.json')), $result.stdout, $utf8)
    [IO.File]::WriteAllText((Join-Path $ReportDir ($sample.id + '.stderr.txt')), $result.stderr, $utf8)
    # Extreme-noise cases measure recognition quality; functional checks still apply.
    Check-Result $recognized $sample.text ($report -eq 'asr-compare-stress\report.json')
    Check-Ass ([IO.File]::ReadAllText($sampleAss, $utf8)) $recognized
    $checks += [ordered]@{ name = $sample.id; transcriptMatches = ((Normalize $recognized.text) -eq (Normalize $sample.text)); tokenCount = $recognized.tokens.Count;
      cueCount = $recognized.subtitles.Count; assMatchesJson = $true; wallMs = $result.wallMs }
    foreach ($mode in @('word','phrase')) {
      $highlightAss = Join-Path $ReportDir ($sample.id + '-' + $mode + '.ass')
      $highlighted = Invoke-Native $exe @('-i', (Windows-Path $sample.file), '--highlight', $mode, '--ass-output', $highlightAss) $env:TEMP
      Assert-Ok $highlighted ($sample.id + '-' + $mode)
      $highlightData = $highlighted.stdout | ConvertFrom-Json
      Check-Result $highlightData $sample.text ($report -eq 'asr-compare-stress\report.json')
      Check-Highlights $highlightData ([IO.File]::ReadAllText($highlightAss, $utf8))
      if ($highlightData.captionHighlight -ne $mode -or $highlightData.segmenter -ne 'cppjieba-5.6.4') { throw 'Wrong segmentation mode/version.' }
      [IO.File]::WriteAllText((Join-Path $ReportDir ($sample.id + '-' + $mode + '.json')), $highlighted.stdout, $utf8)
      $checks += [ordered]@{ name = $sample.id + '-' + $mode; ok = $true; groups = @($highlightData.subtitles | ForEach-Object { $_.highlightUnits }).Count; wallMs = $highlighted.wallMs }
    }
  }
}

# Relocate the complete package outside the project, under a Unicode/spaced path.
$unicode = [string][char]0x4E2D + [char]0x6587
$external = Join-Path $env:TEMP ('SenseVoice-CLI-' + [guid]::NewGuid().ToString('N'))
$portable = Join-Path $external ($unicode + ' portable tool')
[IO.Directory]::CreateDirectory($portable) | Out-Null
Get-ChildItem -LiteralPath $BundleDir | Copy-Item -Destination $portable -Recurse
$outsideExe = Join-Path $portable 'sensevoice-cli.exe'
$audioInput = Join-Path $external ($unicode + ' audio sample.wav')
Copy-Item (Join-Path $project '.windows-smoke\qwen-engine-adapter.wav') -Destination $audioInput
$audioInputHash = (Get-FileHash -LiteralPath $audioInput -Algorithm SHA256).Hash
$json = Join-Path $external ($unicode + ' result.json')
$srt = Join-Path $external ($unicode + ' captions.srt')
$ass = Join-Path $external ($unicode + ' captions.ass')
$text = Join-Path $external ($unicode + ' transcript.txt')
$result = Invoke-Native $outsideExe @('-i', $audioInput, '-o', $json, '--srt-output', $srt, '--ass-output', $ass, '--text-output', $text) $env:WINDIR
Assert-Ok $result 'Relocated Unicode invocation'
$shortReference = [string][char]0x4F60 + [char]0x597D
$recognized = Get-Content -LiteralPath $json -Raw -Encoding UTF8 | ConvertFrom-Json
Check-Result $recognized $shortReference
if ((Normalize ([IO.File]::ReadAllText($text, $utf8))) -ne $shortReference) { throw 'Wrong text output.' }
if ([IO.File]::ReadAllText($srt, $utf8) -notmatch '-->') { throw 'Missing SRT.' }
Check-Ass ([IO.File]::ReadAllText($ass, $utf8)) $recognized
$pureText = Invoke-Native $outsideExe @('-i', $audioInput, '--format', 'text') $env:TEMP
Assert-Ok $pureText 'Text stdout'
if ((Normalize $pureText.stdout) -ne $shortReference) { throw 'Wrong text stdout.' }
$pureSrt = Invoke-Native $outsideExe @('-i', $audioInput, '--format', 'srt') $env:TEMP
Assert-Ok $pureSrt 'SRT stdout'
if ($pureSrt.stdout -notmatch '-->') { throw 'Wrong SRT stdout.' }
$pureAss = Invoke-Native $outsideExe @('-i', $audioInput, '--format', 'ass') $env:TEMP
Assert-Ok $pureAss 'ASS stdout'
Check-Ass $pureAss.stdout $recognized
$selectedAss = Join-Path $external 'selected.ass'
$assFile = Invoke-Native $outsideExe @('-i', $audioInput, '--format', 'ass', '-o', $selectedAss) $env:TEMP
Assert-Ok $assFile 'ASS selected file'
if ($assFile.stdout) { throw 'ASS file output leaked to stdout.' }
Check-Ass ([IO.File]::ReadAllText($selectedAss, $utf8)) $recognized
$checks += [ordered]@{ name = 'relocated-unicode-four-formats'; ok = $true; externalDirectory = $external }
$userDictionary = Join-Path $external ($unicode + ' terms.txt')
[IO.File]::WriteAllText($userDictionary, ($shortReference + ' 100000 n'), $utf8)
$outsideHighlight = Invoke-Native $outsideExe @('-i', $audioInput, '--highlight', 'phrase', '--user-dict', $userDictionary, '--ass-output', $ass) $env:WINDIR
Assert-Ok $outsideHighlight 'Relocated phrase/custom dictionary'
$outsideData = $outsideHighlight.stdout | ConvertFrom-Json
Check-Highlights $outsideData ([IO.File]::ReadAllText($ass, $utf8))
if ($outsideData.subtitles[0].words[0].text -ne $shortReference) { throw 'Custom dictionary word missing.' }
$dictionaryHash = (Get-FileHash -LiteralPath $userDictionary -Algorithm SHA256).Hash
$dictOverwrite = Invoke-Native $outsideExe @('-i', $audioInput, '--user-dict', $userDictionary, '-o', $userDictionary) $env:TEMP
if ($dictOverwrite.exitCode -ne 1 -or (Get-FileHash -LiteralPath $userDictionary -Algorithm SHA256).Hash -ne $dictionaryHash) { throw 'Dictionary overwrite protection failed.' }
[IO.File]::WriteAllText($userDictionary, ($shortReference + ' bad n'), $utf8)
$badDictionary = Invoke-Native $outsideExe @('-i', $audioInput, '--user-dict', $userDictionary) $env:TEMP
if ($badDictionary.exitCode -ne 1) { throw 'Invalid dictionary did not fail cleanly.' }
$badHighlight = Invoke-Native $outsideExe @('-i', $audioInput, '--highlight', 'bad') $env:TEMP
if ($badHighlight.exitCode -ne 2) { throw 'Invalid highlight mode exit code was not 2.' }
$checks += [ordered]@{ name = 'relocated-phrase-unicode-dictionary-errors'; ok = $true }

# Validate the exported file with a real libass renderer; FFmpeg is test-only.
$ffmpeg = Join-Path $project 'resources\ffmpeg\ffmpeg.exe'
$render = Invoke-Native $ffmpeg @('-hide_banner', '-v', 'info', '-f', 'lavfi', '-i',
  'color=c=black:s=1920x1080:r=25', '-vf', 'setpts=PTS+1/TB,ass=preset-clean-phrase.ass',
  '-frames:v', '2', '-f', 'null', '-') $ReportDir
Assert-Ok $render 'ASS libass rendering'
if ($render.stderr -notmatch 'Added subtitle file:.*events') { throw 'Renderer did not parse ASS events.' }
[IO.File]::WriteAllText((Join-Path $ReportDir 'ass-render.stderr.txt'), $render.stderr, $utf8)
$checks += [ordered]@{ name = 'ass-libass-render'; ok = $true }

$badArgs = Invoke-Native $outsideExe @('--threads', '4oops', '-i', $audioInput) $env:TEMP
if ($badArgs.exitCode -ne 2) { throw 'Argument error exit code was not 2.' }
$badInput = Invoke-Native $outsideExe @('-i', (Join-Path $external 'missing.wav')) $env:TEMP
if ($badInput.exitCode -ne 1) { throw 'Missing input exit code was not 1.' }
$overwrite = Invoke-Native $outsideExe @('-i', $audioInput, '-o', $audioInput) $env:TEMP
if ($overwrite.exitCode -ne 1 -or (Get-FileHash -LiteralPath $audioInput -Algorithm SHA256).Hash -ne $audioInputHash) { throw 'Input overwrite protection failed.' }
$assOverwrite = Invoke-Native $outsideExe @('-i', $audioInput, '--ass-output', $audioInput) $env:TEMP
if ($assOverwrite.exitCode -ne 1 -or (Get-FileHash -LiteralPath $audioInput -Algorithm SHA256).Hash -ne $audioInputHash) { throw 'ASS input overwrite protection failed.' }
$dll = Join-Path $portable 'sherpa-onnx-c-api.dll'
Move-Item -LiteralPath $dll -Destination ($dll + '.test-disabled')
try {
  $missingDll = Invoke-Native $outsideExe @('--check') $env:TEMP
  if ($missingDll.exitCode -ne 1) { throw 'Missing runtime exit code was not 1.' }
} finally { Move-Item -LiteralPath ($dll + '.test-disabled') -Destination $dll }
$checks += [ordered]@{ name = 'argument-input-overwrite-missing-runtime-errors'; ok = $true }

$build = Get-Content (Join-Path $BundleDir 'build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in $build.originalProjectHashes.PSObject.Properties) {
  $hash = (Get-FileHash -LiteralPath (Join-Path $project $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $entry.Value) { throw "Existing project changed: $($entry.Name)" }
}
$modelRoot = Join-Path $project 'resources\models\sensevoice-small'
foreach ($entry in $build.modelManifest.files.PSObject.Properties) {
  $hash = (Get-FileHash -LiteralPath (Join-Path $modelRoot $entry.Value.path) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $entry.Value.sha256) { throw 'Original model changed.' }
}
$report = [ordered]@{ ok = $true; date = [DateTime]::UtcNow.ToString('o'); platform = 'Windows x64 native';
  runtime = $versionData; originalProjectUnchanged = $true; checks = $checks; relocatedPackage = $portable }
$reportPath = Join-Path $ReportDir 'report.json'
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 12), $utf8)
Write-Output ($report | ConvertTo-Json -Depth 12)
