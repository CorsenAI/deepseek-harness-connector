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

Write-Output "=== install over existing (upgrade path), the tarball given as a relative path ==="
# A user types the file name as it sits in front of them. `dsh plugin` runs pnpm in the profile
# directory, where that name means nothing — and pnpm reads a bare `dir\file.tgz` as a GitHub
# shorthand; the installer must hand pnpm an absolute path (a regression seen on 2026-09-12).
Push-Location (Split-Path -Parent $Tarball)
$log2 = RunInstaller @("-Profile", "headless", "-Package", (Split-Path -Leaf $Tarball))
$reinstallExit = $LASTEXITCODE
Pop-Location
Expect "reinstall exit code" $reinstallExit 0
Expect "no git resolution attempted" ([int](($log2 | Out-String) -match "GIT_RESOLVE")) 0
$log2 | Select-String "Stopped the previous broker" | ForEach-Object { "  | $_" }
$pid2 = Get-Content (Join-Path $env:DSH_HOME "connector\broker.pid") -ErrorAction SilentlyContinue
Expect "previous broker stopped" (Alive $pid1) "false"
Expect "new broker alive" (Alive $pid2) "true"
Expect "exactly one broker on the port" (HttpCode) 426
$code2 = if (Test-Path $broker) { (node $broker --pairing-code --home $env:DSH_HOME 2>$null | Select-Object -Last 1) } else { "" }
Expect "pairing code unchanged across reinstall" $(if ("$code1" -eq "$code2") { "same" } else { "different" }) "same"
Write-Output ""

Write-Output "=== a package path that names nothing ==="
$log4 = RunInstaller @("-Profile", "headless", "-Package", "nowhere\missing.tgz")
Expect "refused before pnpm runs" $LASTEXITCODE 1
Expect "the reason names the file" ([int](($log4 | Out-String) -match "no such file: nowhere\\missing.tgz")) 1
Expect "the broker from the previous install is untouched" (Alive $pid2) "true"
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

Write-Output "=== install from the release URL (a loopback stand-in for github.com, with its redirect) ==="
# The setup card and the installer's default name the companion by its GitHub release URL, which
# `dsh plugin add` hands to pnpm; github.com answers with a redirect to its asset store. The stand-in
# in tarball-server.mjs plays both hops on loopback, so this is the real `dsh` installing from a URL.
$urlPort = [int]$port + 100
$tag = "v" + (([System.IO.Path]::GetFileNameWithoutExtension($Tarball)) -replace '^.*-', '')
$serverOut = Join-Path $env:DSH_HOME "tarball-server.log"
# Start-Process joins -ArgumentList with spaces and quotes nothing, and the tarball path has a space
# in it on purpose (that is one of the things this suite tests): each path is quoted here.
$server = Start-Process -FilePath node -ArgumentList @("`"$(Join-Path $here 'tarball-server.mjs')`"", "`"$Tarball`"", "$urlPort", $tag) -PassThru -WindowStyle Hidden -RedirectStandardOutput $serverOut -RedirectStandardError (Join-Path $env:DSH_HOME "tarball-server.err")
$listening = $false
for ($i = 0; $i -lt 50 -and -not $listening; $i++) {
  Start-Sleep -Milliseconds 200
  if ((Test-Path $serverOut) -and ((Get-Content $serverOut -ErrorAction SilentlyContinue) -match '^listening')) { $listening = $true }
}
Expect "release stand-in listening" $listening "True"
$url = "http://127.0.0.1:$urlPort/releases/download/$tag/$(Split-Path -Leaf $Tarball)"
$log6 = RunInstaller @("-Profile", "headless", "-Package", $url)
Expect "install exit code from the release URL" $LASTEXITCODE "0"
($log6 | Select-Object -Last 3) | ForEach-Object { "  | $_" }
Expect "broker present after the URL install" (Test-Path $broker) "True"
$dependency = (Get-Content $manifest | ConvertFrom-Json).dependencies.'@corsen-ai/dsh-browser-connector'
Expect "the profile records the URL as the dependency" $dependency $url
Write-Output ("  | stand-in served: " + ((Get-Content $serverOut -ErrorAction SilentlyContinue | Where-Object { $_ -match '^GET ' }) -join ' '))
$pidUrl = Get-Content (Join-Path $env:DSH_HOME "connector\broker.pid") -ErrorAction SilentlyContinue
$null = RunInstaller @("-Uninstall", "-Profile", "headless")
Expect "uninstall exit code after the URL install" $LASTEXITCODE "0"
Start-Sleep -Seconds 1
Expect "broker stopped after the URL install" (Alive $pidUrl) "false"
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
Write-Output ""

Write-Output "=== the default home: DSH_HOME unset ==="
# What a user's machine looks like: no DSH_HOME, so DeepSeek Harness uses ~\.dsh in the user
# profile, the directory Node reports as the home. USERPROFILE is pointed at a scratch directory so
# this never touches the real profile. Until 2026-11-05 the installer looked in %LOCALAPPDATA%\dsh
# and failed here; every earlier lane had set DSH_HOME.
$osHome = Join-Path $env:TEMP ("dsh-installer-home-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $osHome | Out-Null
$savedHome = $env:DSH_HOME
$savedProfile = $env:USERPROFILE
Remove-Item Env:DSH_HOME
$env:USERPROFILE = $osHome
$defaultHome = Join-Path $osHome ".dsh"
$log5 = RunInstaller @("-Profile", "headless", "-Package", $Tarball)
Expect "install exit code with DSH_HOME unset" $LASTEXITCODE 0
$log5 | Select-Object -Last 4 | ForEach-Object { "  | $_" }
Expect "installed under ~\.dsh, where dsh plugin add puts it" (Test-Path (Join-Path $defaultHome "profiles\headless\node_modules\@corsen-ai\dsh-browser-connector\lib\broker-main.js")) $true
Expect "connector state under ~\.dsh" (Test-Path (Join-Path $defaultHome "connector\credentials.json")) $true
$pid3 = Get-Content (Join-Path $defaultHome "connector\broker.pid") -ErrorAction SilentlyContinue
Expect "broker alive for the default home" (Alive $pid3) "true"
$log6 = RunInstaller @("-Uninstall", "-Profile", "headless")
Expect "uninstall exit code with DSH_HOME unset" $LASTEXITCODE 0
Start-Sleep -Seconds 1
Expect "broker for the default home stopped" (Alive $pid3) "false"
$env:USERPROFILE = $savedProfile
$env:DSH_HOME = $savedHome
Remove-Item -Recurse -Force $osHome -ErrorAction SilentlyContinue
Write-Output ""

if ($script:failures -eq 0) { Write-Output "all installer expectations met" } else { Write-Output "$($script:failures) installer expectation(s) failed" }
exit $script:failures
