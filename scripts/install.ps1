<#
.SYNOPSIS
  DeepSeek Harness Connector — installer for Windows.

.DESCRIPTION
  Installs the connector into a DeepSeek Harness profile with the official `dsh plugin` command,
  then starts the local broker and prints the pairing code for the Chrome extension. Re-running it
  upgrades. -Uninstall reverses it. It never edits DeepSeek Harness's own files: the only change to
  the profile is the dependency `dsh plugin` adds, which `dsh plugin remove` takes away.

  This is an unofficial community project by Corsen AI, not affiliated with DeepSeek.

.PARAMETER Profile
  The DeepSeek Harness profile to install into. Default: web.

.PARAMETER Package
  The companion tarball: a URL or a path to a local .tgz. Default: the tarball of this installer's
  version on the project's GitHub release — the same one the extension's setup card names.

.PARAMETER Uninstall
  Remove the connector from the profile and stop the broker.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Profile headless -Package .\corsen-ai-dsh-browser-connector-0.1.0.tgz
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile = "web",
  [string]$Package = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
# Kept equal to the extension's and the companion's version (a unit test checks the three).
$Version = "0.1.0"
if (-not $Package) {
  $Package = "https://github.com/CorsenAI/deepseek-harness-connector/releases/download/v$Version/corsen-ai-dsh-browser-connector-$Version.tgz"
}
$brokerPort = if ($env:DSH_CONNECTOR_PORT) { [int]$env:DSH_CONNECTOR_PORT } else { 8781 }

function Fail([string]$message) { Write-Error $message; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js is required (22.19 or newer). https://nodejs.org"
}
# No quotes inside the expression: Windows PowerShell strips inner double quotes when it hands a
# string to a native executable, so `split(".")` reaches node as `split(.)` and throws.
# `parseInt` reads the leading integer of "24.12.0" without any quoting at all.
$nodeMajor = [int](node -p 'parseInt(process.versions.node)')
if ($nodeMajor -lt 22) { Fail "Node.js 22.19 or newer is required; found $(node --version)" }

# The executable and its fixed leading arguments are kept apart on purpose. Building one array and
# slicing it with `[1..($n - 1)]` breaks for the one-element case: `1..0` is a descending range in
# PowerShell, so `@("dsh")[1..0]` is `@($null, "dsh")` and dsh receives a garbage first argument.
$dshExe = $null
$dshArgs = @()
if (Get-Command dsh -ErrorAction SilentlyContinue) { $dshExe = "dsh" }
elseif (Get-Command npx -ErrorAction SilentlyContinue) { $dshExe = "npx"; $dshArgs = @("--yes", "@deepseek-ai/dsh") }
else { Fail "DeepSeek Harness (dsh) was not found on PATH. Install it first: npm install -g @deepseek-ai/dsh" }

# `dsh plugin` forwards to pnpm, which DeepSeek Harness itself does not install: a machine with a
# working `dsh` and no pnpm fails inside dsh after the profile has been created. Checked here, before
# anything is created, with the command that fixes it.
if (-not $Uninstall -and -not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Fail "pnpm is required by DeepSeek Harness's plugin command and was not found on PATH. Install it with: npm install -g pnpm"
}

function Invoke-Dsh([string[]]$arguments) {
  # Splat a variable (`@all`), never an expression. `& cmd @($x + $y)` is an array *literal*, which
  # PowerShell binds to a `.ps1` shim as a single `$args[0]`; npm's `dsh.ps1` then hands node one
  # space-joined token — "plugin --profile headless add ..." — and dsh reports `--profile` missing.
  # Only `@variable` is splatting, and it delivers each argument separately to either shim.
  $all = @($dshArgs) + @($arguments)
  & $dshExe @all
}

# Resolve the Harness home exactly as DeepSeek Harness does (`resolveDshHome` in
# @deepseek-ai/dsh-home-paths): a DSH_HOME that is not blank, else ~\.dsh in the user profile — the
# directory Node reports as the home — with a leading ~ expanded and a relative path made absolute
# against this location. `dsh plugin add` installs there; looking anywhere else (an earlier version
# of this script used %LOCALAPPDATA%\dsh) finds nothing on a machine without DSH_HOME.
$osHome = $env:USERPROFILE
if ($env:DSH_HOME -and $env:DSH_HOME.Trim().Length -gt 0) { $homeDir = $env:DSH_HOME }
else { $homeDir = Join-Path $osHome ".dsh" }
if ($homeDir -eq "~") { $homeDir = $osHome }
elseif ($homeDir.StartsWith("~/") -or $homeDir.StartsWith("~\")) { $homeDir = Join-Path $osHome $homeDir.Substring(2) }
$homeDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($homeDir)
$profileDir = Join-Path (Join-Path $homeDir "profiles") $Profile
$connectorDir = Join-Path $homeDir "connector"
$pidFile = Join-Path $connectorDir "broker.pid"

function Stop-Broker {
  if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
      $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -like "node*") {
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped the previous broker (pid $oldPid)."
      }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}

if ($Uninstall) {
  Write-Host "Removing the connector from profile '$Profile'..."
  Invoke-Dsh @("plugin", "--profile", $Profile, "remove", "@corsen-ai/dsh-browser-connector")
  # A failed remove is tolerated, because the package may already be gone, but it is never hidden:
  # a user running uninstall must know whether the plugin is still installed.
  if ($LASTEXITCODE -ne 0) { Write-Warning "dsh plugin remove reported an error; the plugin may still be listed in profile '$Profile'." }
  Stop-Broker
  Write-Host "Connector state (pairing secret, ownership) is kept at $connectorDir so a reinstall"
  Write-Host "does not force every browser to pair again. Delete that directory to remove it."
  exit 0
}

# A URL or a registry name goes to `dsh plugin add` as it is. Absolute-ize a local path: `dsh plugin`
# runs pnpm with cwd = the profile directory, where a relative path means nothing — and pnpm reads a
# bare `dir\file.tgz` as a GitHub shorthand and goes looking for a repository. A path that names
# nothing here is refused now, with a reason.
$isUrl = $Package -match '^https?://'
if (-not $isUrl -and -not $Package.StartsWith('@') -and -not [System.IO.Path]::IsPathRooted($Package)) {
  if (Test-Path -LiteralPath $Package) {
    $Package = (Resolve-Path -LiteralPath $Package).Path
  }
  elseif ($Package -match '\.tgz$' -or $Package -match '[\\/]') {
    Fail "no such file: $Package (a -Package path is read from this directory: $(Get-Location))"
  }
}

# Upstream limitation, DeepSeek Harness 0.1.2-rc.1: `dsh plugin` forwards to pnpm with
# `spawnSync("pnpm", args, { shell: process.platform === "win32" })`, and cmd.exe re-tokenizes the
# joined command line, so an argument containing a space is split into several. A tarball under
# "C:\Users\Jane Doe\..." therefore cannot be passed as-is. The Windows 8.3 short name of the same
# file has no spaces and needs no copy, so it is handed over instead. When short names are disabled
# on the volume the long name comes back unchanged, and the install stops with the reason rather
# than letting pnpm fail on a fragment of the path.
if ((Test-Path -LiteralPath $Package -PathType Leaf) -and ($Package -match ' ')) {
  $short = (New-Object -ComObject Scripting.FileSystemObject).GetFile($Package).ShortPath
  if ($short -match ' ') {
    Fail "The package path contains a space and this volume has 8.3 short names disabled. DeepSeek Harness's 'dsh plugin' cannot receive a spaced path on Windows; move the .tgz to a path without spaces and run again."
  }
  Write-Host "Using the short path form for pnpm, because 'dsh plugin' cannot pass a spaced path on Windows: $short"
  $Package = $short
}
elseif ((Test-Path -LiteralPath $Package -PathType Container) -and ($Package -match ' ')) {
  Fail "A package directory path containing a space cannot be passed to 'dsh plugin' on Windows. Run 'npm pack' in that directory and install the resulting .tgz instead."
}

Write-Host "Installing $Package into DeepSeek Harness profile '$Profile'..."
Invoke-Dsh @("plugin", "--profile", $Profile, "add", $Package)
if ($LASTEXITCODE -ne 0) { Fail "dsh plugin add failed" }

$broker = Join-Path $profileDir "node_modules\@corsen-ai\dsh-browser-connector\lib\broker-main.js"
if (-not (Test-Path $broker)) { Fail "the connector was installed but its broker was not found at $broker" }

New-Item -ItemType Directory -Force -Path $connectorDir | Out-Null
Stop-Broker

# Prove the broker can load before starting it detached: --pairing-code runs the same entry, its
# modules and its credentials, in this console, so a broker that cannot even start says why here
# rather than dying silently in a hidden window. (A detached process cannot have its streams
# captured: Start-Process with a redirect hands the child every inheritable handle, and a caller
# capturing this script's output then waits on the broker for as long as it runs.)
$code = node "$broker" --pairing-code --home "$homeDir" 2>&1
if ($LASTEXITCODE -ne 0) { Fail "the broker cannot start: $code" }

# Start the broker detached so it outlives this shell and any one dsh process.
$proc = Start-Process -FilePath "node" `
  -ArgumentList @("`"$broker`"", "--home", "`"$homeDir`"", "--port", "$brokerPort") `
  -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $proc.Id
Start-Sleep -Seconds 1
if ($proc.HasExited) { Fail "the broker did not stay running; see $(Join-Path $connectorDir 'broker.log')" }

Write-Host ""
Write-Host "Installed. The connector broker is running on 127.0.0.1:$brokerPort."
Write-Host ""
Write-Host "  Pairing code:  $code"
Write-Host ""
Write-Host "Open the DeepSeek Harness Connector panel in Chrome and type that code once."
Write-Host "Restart any DeepSeek Harness that is already running so it loads the connector."
Write-Host ""
Write-Host "To remove: .\install.ps1 -Uninstall -Profile $Profile"
