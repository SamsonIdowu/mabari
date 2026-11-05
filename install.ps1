# SPDX-License-Identifier: Apache-2.0
#
# Installs Mabari on Windows.
#
#   irm https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.ps1))) -Docker
#
# Without -Docker it puts mabari.exe in %LOCALAPPDATA%\Programs\Mabari and adds that folder to
# your PATH: the release build when one is published, otherwise one built from source (which needs
# git, Go 1.27+ and Node 22+). With -Docker it runs Mabari in Docker Desktop, built from source.
param(
  [switch]$Docker,
  [string]$BinDir = (Join-Path $env:LOCALAPPDATA 'Programs\Mabari'),
  [string]$SrcDir = (Join-Path $HOME '.mabari\src'),
  [string]$Ref = 'main',
  [switch]$FromSource,
  [switch]$Service
)

$ErrorActionPreference = 'Stop'
$Repo = 'SamsonIdowu/mabari'
$Url = "https://github.com/$Repo"

function Say($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "Error: $text" -ForegroundColor Red; exit 1 }
function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function VersionNumber($text) {
  if ($text -match '(\d+)\.(\d+)') { return [int]$Matches[1] * 1000 + [int]$Matches[2] }
  return 0
}

function Get-Source {
  if (-not (Have git)) { Fail 'git is needed. Install it from https://git-scm.com, then run this again.' }
  if (Test-Path (Join-Path $SrcDir '.git')) {
    Say "Updating the source in $SrcDir"
    git -C $SrcDir fetch --depth 1 origin $Ref
    git -C $SrcDir checkout -q FETCH_HEAD
  } else {
    Say "Downloading the source to $SrcDir"
    New-Item -ItemType Directory -Force -Path (Split-Path $SrcDir) | Out-Null
    git clone --depth 1 --branch $Ref "$Url.git" $SrcDir
  }
  if ($LASTEXITCODE -ne 0) { Fail 'Could not get the source.' }
}

function Install-Docker {
  if (-not (Have docker)) { Fail 'Docker Desktop is needed: https://www.docker.com/products/docker-desktop/' }
  docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { Fail "Docker Compose v2 is needed (the 'docker compose' command)." }
  Get-Source
  $key = Join-Path $SrcDir 'deploy\docker\mabari_master_key'
  if (-not (Test-Path $key)) {
    Say "Making the master key that seals Mabari's stored keys"
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [IO.File]::WriteAllText($key, [Convert]::ToBase64String($bytes) + "`n")
    Write-Host "    Kept in $key. Without it, the stored keys can't be read."
  }
  Say 'Building and starting Mabari in Docker (the first build takes a few minutes)'
  Push-Location $SrcDir
  try {
    $env:MABARI_VERSION = (git describe --tags --always 2>$null)
    docker compose -f deploy/docker/compose.yaml up -d --build
    if ($LASTEXITCODE -ne 0) { Fail 'Docker Compose could not start Mabari.' }
  } finally { Pop-Location }
  Say 'Mabari is running at http://localhost:4317'
  Write-Host "    Stop it:    docker compose -f $SrcDir\deploy\docker\compose.yaml down"
  Write-Host '    Update it:  run this installer again'
}

function Get-Release($target) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
  try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
  } catch { return $false }
  $tag = $release.tag_name
  if (-not $tag) { return $false }
  $version = $tag.TrimStart('v')
  $name = "mabari_${version}_windows_$arch.zip"
  $work = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    Say "Downloading Mabari $tag for windows/$arch"
    Invoke-WebRequest "$Url/releases/download/$tag/$name" -OutFile (Join-Path $work $name) -UseBasicParsing
    try {
      Invoke-WebRequest "$Url/releases/download/$tag/checksums.txt" -OutFile (Join-Path $work 'checksums.txt') -UseBasicParsing
      $expected = (Select-String -Path (Join-Path $work 'checksums.txt') -Pattern " $([regex]::Escape($name))$").Line.Split(' ')[0]
      $actual = (Get-FileHash (Join-Path $work $name) -Algorithm SHA256).Hash.ToLower()
      if ($expected -ne $actual) { Fail "The download doesn't match checksums.txt." }
    } catch [System.Net.WebException] { }
    Expand-Archive (Join-Path $work $name) -DestinationPath $work -Force
    Copy-Item (Join-Path $work 'mabari.exe') $target -Force
    return $true
  } catch {
    return $false
  } finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Build-FromSource($target) {
  if (-not (Have go)) { Fail 'Go 1.27 or later is needed to build Mabari: https://go.dev/dl/' }
  if ((VersionNumber (go env GOVERSION)) -lt 1027) { Fail "Go 1.27 or later is needed; you have $(go env GOVERSION)." }
  if (-not (Have node)) { Fail "Node 22 or later is needed to build Mabari's web app: https://nodejs.org/" }
  if ((VersionNumber (node --version)) -lt 22000) { Fail "Node 22 or later is needed; you have $(node --version)." }
  Get-Source
  Say 'Building the web app'
  Push-Location (Join-Path $SrcDir 'web')
  try {
    if (Have pnpm) { pnpm install --frozen-lockfile; pnpm build }
    else { npx --yes pnpm@10 install --frozen-lockfile; npx --yes pnpm@10 build }
    if ($LASTEXITCODE -ne 0) { Fail 'The web app did not build.' }
  } finally { Pop-Location }
  Say 'Building mabari.exe'
  Push-Location $SrcDir
  try {
    $version = (git describe --tags --always 2>$null)
    if (-not $version) { $version = 'dev' }
    $env:CGO_ENABLED = '0'
    go build -tags embedweb -trimpath -ldflags "-s -w -X main.version=$version" -o $target ./cmd/mabari
    if ($LASTEXITCODE -ne 0) { Fail 'mabari.exe did not build.' }
  } finally { Pop-Location }
}

function Install-Binary {
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $target = Join-Path $BinDir 'mabari.exe'
  $staged = "$target.new"
  if ($FromSource -or -not (Get-Release $staged)) {
    if (-not $FromSource) { Say 'No release build to download, so building from source' }
    Build-FromSource $staged
  }
  Move-Item $staged $target -Force
  Say "Installed $target"
  $path = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($path -split ';') -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable('Path', "$path;$BinDir", 'User')
    Write-Host "    Added $BinDir to your PATH. Open a new terminal to use it."
  }
  if ($Service) { & $target service install }
  else {
    Write-Host '    Start it:            mabari, then open http://localhost:4317'
    Write-Host '    Start it at login:   mabari service install'
  }
}

if ($Docker) { Install-Docker } else { Install-Binary }
