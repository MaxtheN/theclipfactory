# Source setup for Windows 10/11 x64: interactive, opt-in dependency installation; never runs remote scripts.
# Creators who only want to run the app should use the installer instead (see README).
# Run from PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Fail($message) { Write-Host $message -ForegroundColor Red; exit 1 }
function Confirm-Step($question) {
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { return $false }
    $answer = Read-Host "$question [y/N]"
    return $answer -in @('y', 'Y', 'yes')
}
function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "$Command $($Arguments -join ' ') failed ($LASTEXITCODE)." }
}

if ($env:OS -ne 'Windows_NT') { Fail 'This setup script is for Windows. Use scripts/setup-mac.sh or scripts/setup-linux.sh elsewhere.' }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    Fail 'Growth Factory supports Windows on x64 only (not Windows on ARM).'
}

# Python 3.11-3.13, through the py launcher first.
$Python = $null
foreach ($version in '3.12', '3.11', '3.13') {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $found = & py "-$version" -c 'import sys; print(sys.executable)' 2>$null
        if ($LASTEXITCODE -eq 0 -and $found) { $Python = $found.Trim(); break }
    }
}
if (-not $Python) {
    if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Confirm-Step 'Install Python 3.12 with winget?')) {
        Invoke-Checked winget @('install', '--exact', '--id', 'Python.Python.3.12', '--accept-package-agreements')
        Fail 'Python installed. Open a new PowerShell window and rerun this script.'
    }
    Fail 'Python 3.11, 3.12 or 3.13 (x64) is required. Install it from python.org, then rerun.'
}

$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
if (Test-Path '.venv') {
    if (-not (Test-Path $VenvPython)) { Fail '.venv is incomplete; move it aside and rerun setup.' }
    & $VenvPython -c 'import sys; assert sys.version_info[:2] in ((3,11),(3,12),(3,13))'
    if ($LASTEXITCODE -ne 0) { Fail 'Existing .venv must use Python 3.11-3.13; move it aside and rerun.' }
} else {
    Invoke-Checked $Python @('-m', 'venv', '.venv')
}

# Build only if dist is absent or tracked frontend inputs are newer.
$Dist = 'frontend\dist\index.html'
$Stale = -not (Test-Path $Dist)
if (-not $Stale) {
    $built = (Get-Item $Dist).LastWriteTime
    $inputs = @(Get-ChildItem -Recurse -File 'frontend\src') + @(Get-Item 'frontend\package.json', 'frontend\package-lock.json',
        'frontend\index.html', 'frontend\vite.config.ts', 'frontend\tsconfig.json' -ErrorAction SilentlyContinue)
    $Stale = [bool]($inputs | Where-Object { $_.LastWriteTime -gt $built } | Select-Object -First 1)
}
if ($Stale) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Confirm-Step 'Install Node.js LTS with winget to build the frontend?')) {
            Invoke-Checked winget @('install', '--exact', '--id', 'OpenJS.NodeJS.LTS', '--accept-package-agreements')
            Fail 'Node.js installed. Open a new PowerShell window and rerun this script.'
        }
        Fail 'Install Node.js 22.12+ (npm included), then rerun setup.'
    }
    Push-Location frontend
    try { Invoke-Checked npm @('ci'); Invoke-Checked npm @('run', 'build') } finally { Pop-Location }
}
# UI package data is preferred over the repository dist fallback.
New-Item -ItemType Directory -Force 'clip_factory\ui' | Out-Null
Copy-Item -Recurse -Force 'frontend\dist\*' 'clip_factory\ui\'
Invoke-Checked $VenvPython @('-m', 'pip', 'install', '-e', '.[desktop]')

# The app window is Microsoft Edge WebView2 (included in Windows 11).
$client = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$webview = @("HKLM:\SOFTWARE\WOW6432Node\$client", "HKLM:\SOFTWARE\$client", "HKCU:\Software\$client") |
    Where-Object { (Get-ItemProperty $_ -Name pv -ErrorAction SilentlyContinue).pv -notin @($null, '', '0.0.0.0') }
if (-not $webview) {
    Write-Host 'Microsoft Edge WebView2 not found. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ or run with --browser.'
}

# Burned-in captions need FFmpeg built with libass; Gyan's build (winget) includes it.
$captions = $false
if ((Get-Command ffmpeg -ErrorAction SilentlyContinue) -and (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
    $captions = [bool]((& ffmpeg -hide_banner -filters 2>$null) -match ' subtitles ')
}
if (-not $captions) {
    if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Confirm-Step 'Install FFmpeg (Gyan.FFmpeg) with winget for rendering with burned-in captions?')) {
        Invoke-Checked winget @('install', '--exact', '--id', 'Gyan.FFmpeg', '--accept-package-agreements')
    } else {
        Write-Host 'FFmpeg with caption support (libass) not found. Install it with: winget install Gyan.FFmpeg'
    }
}
Write-Host 'Setup complete. Run .venv\Scripts\clip-factory.exe to open Growth Factory (or add --browser to use your browser).'
Write-Host 'Models are not installed by setup. Review licenses and disk space in the app before downloading.'
