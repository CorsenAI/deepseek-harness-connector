<#
.SYNOPSIS
  Installer acceptance on Windows: fresh install, install over existing, uninstall.

.DESCRIPTION
  Runs the real scripts\install.ps1 against a real dsh on PATH and a throwaway DSH_HOME, then
  reports what actually happened. Every line of output is a fact this script checked, not a claim.
  Exits non-zero when any expectation fails, so CI can gate on it.

  The tarball path may contain spaces; that is one of the things under test (see the upstream
  limitation recorded in docs/COMPATIBILITY.md).

.PARAMETER Tarball
  Path to the connector .tgz.

.PARAMETER DshBin
  Directory containing dsh.cmd / dsh.ps1, prepended to PATH. Optional when dsh is already on PATH.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Tarball,
  [string]$DshBin = ""
)

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$installer = Join-Path $here "..\..\scripts\install.ps1"
if ($DshBin) { $env:PATH = "$DshBin;$env:PATH" }

$env:DSH_HOME = Join-Path $env:TEMP ("dsh-installer-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$env:DSH_CONNECTOR_PORT = if ($env:DSH_CONNECTOR_PORT) { $env:DSH_CONNECTOR_PORT } else { "18781" }
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
$manifest = Join-Path $env:DSH_HOME "profiles\headless\package.json"
$broker = Join-Path $env:DSH_HOME "profiles\headless\node_modules\@corsen-ai\dsh-browser-connector\lib\broker-main.js"
$port = $env:DSH_CONNECTOR_PORT

$script:failures = 0
function Expect([string]$label, $actual, $expected) {
  if ("$actual" -eq "$expected") { Write-Output "ok   ${label}: $actual" }
  else { Write-Output "FAIL ${label}: got '$actual', expected '$expected'"; $script:failures++ }
}
function Bundles { if (Test-Path $manifest) { ((Get-Content $manifest | ConvertFrom-Json).dsh.profile.bundles) -join " " } else { "" } }
function Alive($id) { if ($id -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) { "true" } else { "false" } }
function HttpCode {
  try { (Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -ErrorAction Stop).StatusCode }
  catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { "000" } }
}
function RunInstaller([string[]]$arguments) {
  # Output only. The caller reads $LASTEXITCODE directly; returning it here would append a stray
  # "0" to the captured log, because a function's return value joins its pipeline output.
  & powershell -NoProfile -ExecutionPolicy Bypass -File $installer @arguments 2>&1
}

Write-Output "node: $(node --version)   dsh: $((Get-Command dsh -ErrorAction SilentlyContinue).Source)   home: $env:DSH_HOME"
Write-Output "tarball: $Tarball"
Write-Output ""

Write-Output "=== fresh install ==="
$log1 = RunInstaller @("-Profile", "headless", "-Package", $Tarball)
Expect "install exit code" $LASTEXITCODE 0
$log1 | Select-Object -Last 12 | ForEach-Object { "  | $_" }
Expect "connector bundle registered" ([int]((Bundles) -match "corsen-ai")) 1
Expect "broker.pid written" (Test-Path (Join-Path $env:DSH_HOME "connector\broker.pid")) $true
Expect "credentials.json written" (Test-Path (Join-Path $env:DSH_HOME "connector\credentials.json")) $true
$pid1 = Get-Content (Join-Path $env:DSH_HOME "connector\broker.pid") -ErrorAction SilentlyContinue
Expect "broker process alive" (Alive $pid1) "true"
Expect "broker answers 426 on loopback" (HttpCode) 426
$code1 = if (Test-Path $broker) { (node $broker --pairing-code --home $env:DSH_HOME 2>$null | Select-Object -Last 1) } else { "" }
Expect "pairing code has the expected shape" ([int]("$code1" -match "^[34679ACDEFGHJKMNPQRTUVWXY]{4}(-[34679ACDEFGHJKMNPQRTUVWXY]{4}){4}$")) 1
Write-Output ""

Write-Output "=== install over existing (upgrade path) ==="
$log2 = RunInstaller @("-Profile", "headless", "-Package", $Tarball)
Expect "reinstall exit code" $LASTEXITCODE 0
$log2 | Select-String "Stopped the previous broker" | ForEach-Object { "  | $_" }
$pid2 = Get-Content (Join-Path $env:DSH_HOME "connector\broker.pid") -ErrorAction SilentlyContinue
Expect "previous broker stopped" (Alive $pid1) "false"
Expect "new broker alive" (Alive $pid2) "true"
Expect "exactly one broker on the port" (HttpCode) 426
$code2 = if (Test-Path $broker) { (node $broker --pairing-code --home $env:DSH_HOME 2>$null | Select-Object -Last 1) } else { "" }
Expect "pairing code unchanged across reinstall" $(if ("$code1" -eq "$code2") { "same" } else { "different" }) "same"
Write-Output ""

Write-Output "=== uninstall ==="
$log3 = RunInstaller @("-Uninstall", "-Profile", "headless")
Expect "uninstall exit code" $LASTEXITCODE 0
$log3 | Select-Object -Last 6 | ForEach-Object { "  | $_" }
Expect "connector bundle removed" ([int]((Bundles) -match "corsen-ai")) 0
Expect "dsh base bundles untouched" ([int]((Bundles) -match "deepseek-ai")) 1
Start-Sleep -Seconds 1
Expect "broker stopped" (Alive $pid2) "false"
Expect "credentials kept for re-pair" (Test-Path (Join-Path $env:DSH_HOME "connector\credentials.json")) $true
Write-Output ""

if ($script:failures -eq 0) { Write-Output "all installer expectations met" } else { Write-Output "$($script:failures) installer expectation(s) failed" }
exit $script:failures
