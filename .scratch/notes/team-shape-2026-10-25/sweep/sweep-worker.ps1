param(
  [Parameter(Mandatory = $true)][string]$Worktree,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [Parameter(Mandatory = $true)][string]$ConfigsJson
)

$ErrorActionPreference = 'Continue'
$env:Path = 'D:\Software\node-v24.22.1-win-x64;' + $env:Path
$env:NODE_OPTIONS = '--import=file:///D:/code/pitchcraft/.scratch/tracking-data/winpath-hook.mjs'
$probe = 'D:\code\pitchcraft\.scratch\notes\team-shape-2026-10-25\ha-probe.mjs'
$wt = (Resolve-Path $Worktree).Path
$lib = Join-Path $wt 'engine\src\lib.rs'
$wslDir = '/mnt/d/' + (Split-Path $wt -Leaf)
$configs = Get-Content $ConfigsJson -Raw | ConvertFrom-Json

New-Item -ItemType Directory -Force (Split-Path $OutFile) | Out-Null
Set-Content $OutFile "worker=$(Split-Path $wt -Leaf) start=$(Get-Date -Format o)"

# base = clean HEAD version of lib.rs
$base = (git -C $wt show HEAD:engine/src/lib.rs | Out-String) -replace "`r`n", "`n"
if (-not $base -or $base.Length -lt 1000) { Write-Host "BASE READ FAILED for $wt"; exit 1 }

function Patch([string]$text, [string]$pattern, [string]$replacement) {
    $out = [regex]::Replace($text, $pattern, $replacement)
    if ($out -eq $text) { Write-Host "PATCH MISS: $pattern" }
    return $out
}

$rows = @()
foreach ($c in $configs) {
    $t = $base
    $t = Patch $t 'const BASE_SHOT_TENDENCY: f64 = -[0-9.]+;' ('const BASE_SHOT_TENDENCY: f64 = ' + ('{0:F2}' -f $c.shot) + ';')
    $t = Patch $t 'const BASE_DEF_TACKLE: f64 = -[0-9.]+;' ('const BASE_DEF_TACKLE: f64 = ' + ('{0:F2}' -f $c.tackle) + ';')
    $t = Patch $t 'const BASE_DEF_FOUL: f64 = -[0-9.]+;' ('const BASE_DEF_FOUL: f64 = ' + ('{0:F2}' -f $c.foul) + ';')
    $t = Patch $t 'const OPEN_PRESS_STOP_DIST: f64 = [0-9.]+;' ('const OPEN_PRESS_STOP_DIST: f64 = ' + ('{0:F3}' -f $c.stop) + ';')
    $t = Patch $t 'const OPEN_PRESS_N: usize = [0-9]+;' ('const OPEN_PRESS_N: usize = ' + [int]$c.n + ';')
    if ($c.eng) { $t = Patch $t 'const OPEN_PLAY_SHOT_ENGAGE_SHIFT: f64 = -[0-9.]+;' ('const OPEN_PLAY_SHOT_ENGAGE_SHIFT: f64 = ' + ('{0:F2}' -f $c.eng) + ';') }
    if ($c.near) { $t = Patch $t 'const SHOT_PRESSURE_NEAR_M: f64 = [0-9.]+;' ('const SHOT_PRESSURE_NEAR_M: f64 = ' + ('{0:F1}' -f $c.near) + ';') }
    if ($c.second) { $t = Patch $t 'const SHOT_PRESSURE_SECOND_M: f64 = [0-9.]+;' ('const SHOT_PRESSURE_SECOND_M: f64 = ' + ('{0:F1}' -f $c.second) + ';') }
    [IO.File]::WriteAllText($lib, $t, (New-Object System.Text.UTF8Encoding($false)))
    wsl.exe -d Ubuntu-24.04 -- bash -lc "export PATH=`$HOME/.cargo/bin:`$PATH; cd ${wslDir}/engine && touch src/lib.rs && cargo build --target wasm32-unknown-unknown --release 2>&1 | grep -E '^(error|    Finished)' | tail -1 && cp target/wasm32-unknown-unknown/release/fm_engine.wasm ../viewer/engine.wasm" 2>&1 | Out-Null
    $lines = & node $probe "$wt\viewer\engine.wasm" 401 120 2>&1 | Select-String -Pattern '^(shot|goal|tackle|foul|pass):' | ForEach-Object { $_.Line.Trim() }
    $vals = @()
    foreach ($ln in $lines) { if ($ln -match 'per-game ([0-9.]+)/([0-9.]+)') { $vals += ([double]$Matches[1] + [double]$Matches[2]) } }
    while ($vals.Count -lt 5) { $vals += 0 }
    $label = 'shot={0:F2} tackle={1:F2} foul={2:F2} stop={3:F3} n={4}' -f $c.shot, $c.tackle, $c.foul, $c.stop, [int]$c.n
    if ($c.eng) { $label += (' eng={0:F2}' -f $c.eng) }
    $row = $label + (' :: shots={0:F2} goals={1:F2} tackles={2:F2} fouls={3:F2} passes={4:F0}' -f $vals[0], $vals[1], $vals[2], $vals[3], $vals[4])
    Add-Content $OutFile $row
    Write-Host $row
}
Add-Content $OutFile "DONE $(Get-Date -Format o)"
Write-Host "SWEEP DONE $wt"
