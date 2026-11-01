# Courier command-line tool — installer for Windows.
#
#   irm https://github.com/ah-yu/courier.dev/raw/main/install.ps1 | iex
#
# What it does: downloads the windows build, checks it against the release manifest, installs it as
# %LOCALAPPDATA%\Courier\bin\courier-cli.exe, and adds that folder to your user PATH once. Running it
# again is safe: it replaces the file and leaves the PATH alone.
#
# Environment:
#   COURIER_CLI_RELEASE_URL  another download base (a mirror, or one fixed release)
#   COURIER_CLI_BIN_DIR      install somewhere other than %LOCALAPPDATA%\Courier\bin
#   COURIER_CLI_NO_PATH      set to 1 to skip the PATH change
$ErrorActionPreference = "Stop"

$base = if ($env:COURIER_CLI_RELEASE_URL) { $env:COURIER_CLI_RELEASE_URL } else { "https://github.com/ah-yu/courier.dev/releases/latest/download" }
$binDir = if ($env:COURIER_CLI_BIN_DIR) { $env:COURIER_CLI_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Courier\bin" }
$asset = "courier-cli-win-x64.exe"
$target = Join-Path $binDir "courier-cli.exe"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("courier-cli-" + [guid]::NewGuid().ToString("n") + ".exe")

Write-Host "Downloading $asset..."
Invoke-WebRequest -Uri "$base/$asset" -OutFile $tmp -UseBasicParsing

$manifestPath = "$tmp.manifest.json"
try {
    Invoke-WebRequest -Uri "$base/courier-cli-manifest.json" -OutFile $manifestPath -UseBasicParsing
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $expected = $manifest.assets.'win-x64'.sha256
    if ($expected) {
        $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected.ToLowerInvariant()) {
            Remove-Item -Force $tmp -ErrorAction SilentlyContinue
            throw "the download does not match the release checksum"
        }
    }
} catch {
    if ($_.Exception.Message -like "*checksum*") { throw }
    Write-Host "warning: could not check the release checksum"
} finally {
    Remove-Item -Force $manifestPath -ErrorAction SilentlyContinue
}

Move-Item -Force $tmp $target
Write-Host "Installed $target"

if ($env:COURIER_CLI_NO_PATH -ne "1") {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { $userPath = "" }
    $entries = @($userPath -split ";" | Where-Object { $_ })
    if ($entries -notcontains $binDir) {
        $newPath = if ($entries.Count -gt 0) { ($entries + $binDir) -join ";" } else { $binDir }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Host "Added $binDir to your PATH (open a new terminal to pick it up)."
    }
}

& $target version
if ($LASTEXITCODE -ne 0) { Write-Host "warning: the installed file did not run" }
