# kinoko's installer for Windows: kinoko.exe from GitHub Releases, checked against the release's
# SHA256SUMS, into %LOCALAPPDATA%\kinoko\bin, added to your user PATH when it is not there.
#
#   irm https://raw.githubusercontent.com/LaraGuardiola/kinoko/main/install.ps1 | iex
#
# $env:KINOKO_VERSION = "v0.2.0"   a given release (default: the latest)
# $env:KINOKO_INSTALL_DIR = "..."  where kinoko.exe goes
# On Linux and macOS: install.sh.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest very slow

$repo = 'LaraGuardiola/kinoko'
$version = if ($env:KINOKO_VERSION) { $env:KINOKO_VERSION } else { 'latest' }
$dir = if ($env:KINOKO_INSTALL_DIR) { $env:KINOKO_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'kinoko\bin' }
$asset = 'kinoko-windows-x64.exe' # Windows on ARM runs it too

# Where the files are: a release on GitHub, or KINOKO_DOWNLOAD_URL (a mirror, a test).
$base = if ($env:KINOKO_DOWNLOAD_URL) { $env:KINOKO_DOWNLOAD_URL }
        elseif ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" }
        else { "https://github.com/$repo/releases/download/$version" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("kinoko-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  Write-Host "Downloading $asset ($version)..."
  Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp 'kinoko.exe') -UseBasicParsing
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS') -UseBasicParsing

  $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match (' ' + [regex]::Escape($asset) + '$') } | Select-Object -First 1
  if (-not $line) { throw "kinoko: $asset is not in the release's checksums" }
  $want = ($line -split '\s+')[0].ToLower()
  $got = (Get-FileHash (Join-Path $tmp 'kinoko.exe') -Algorithm SHA256).Hash.ToLower()
  if ($want -ne $got) { throw 'kinoko: the download does not match its checksum: not installed' }

  New-Item -ItemType Directory -Force $dir | Out-Null
  $exe = Join-Path $dir 'kinoko.exe'
  try {
    Move-Item -Force (Join-Path $tmp 'kinoko.exe') $exe
  } catch {
    throw "kinoko: could not replace $exe (is kinoko running? close it and try again)"
  }
  Write-Host "Installed $(& $exe --version) to $exe"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# On the user's PATH (once): new terminals find it; this one too, from now on.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = if ($userPath) { $userPath -split ';' } else { @() }
if ($parts -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';').Trim(';'), 'User')
  $env:Path = "$env:Path;$dir"
  Write-Host "Added $dir to your PATH."
}
Write-Host 'Run: kinoko'
