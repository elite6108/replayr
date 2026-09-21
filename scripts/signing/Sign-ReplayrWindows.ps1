#Requires -Version 5.1
<#
  Authenticode-sign Replayr Windows release PE files with Azure Artifact Signing.

  Does not touch Tauri updater .sig files, runtime source, or capture/media code.
  Does not persist Azure client secrets. Uses Azure CLI / DefaultAzureCredential.

  Examples:
    .\scripts\signing\Sign-ReplayrWindows.ps1 -CheckOnly
    .\scripts\signing\Sign-ReplayrWindows.ps1 -File path\to\replay.exe
    .\scripts\signing\Sign-ReplayrWindows.ps1 -Inner
    .\scripts\signing\Sign-ReplayrWindows.ps1 -Installer
#>
[CmdletBinding(DefaultParameterSetName = "CheckOnly")]
param(
  [Parameter(ParameterSetName = "CheckOnly")]
  [switch] $CheckOnly,

  [Parameter(ParameterSetName = "File", Mandatory = $true)]
  [string] $File,

  [Parameter(ParameterSetName = "Inner")]
  [switch] $Inner,

  [Parameter(ParameterSetName = "Installer")]
  [switch] $Installer,

  [Parameter(ParameterSetName = "All")]
  [switch] $All,

  [string] $DlibPath = $env:AZURE_CODE_SIGNING_DLIB,
  [string] $SignToolPath,
  [string] $MetadataPath,
  [switch] $SkipRoleCheck,
  [int] $TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if (-not $MetadataPath) {
  $MetadataPath = Join-Path $PSScriptRoot "metadata.json"
}

$TimestampUrl = "http://timestamp.acs.microsoft.com"
$RequiredRoles = @(
  "Artifact Signing Certificate Profile Signer",
  "Trusted Signing Certificate Profile Signer"
)

function Find-SignTool {
  if ($SignToolPath -and (Test-Path -LiteralPath $SignToolPath)) {
    return (Resolve-Path -LiteralPath $SignToolPath).Path
  }
  $candidates = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe",
    "${env:ProgramFiles(x86)}\Windows Kits\10\App Certification Kit\signtool.exe"
  )
  $kitRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
  if (Test-Path $kitRoot) {
    Get-ChildItem $kitRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object {
        $candidates += (Join-Path $_.FullName "x64\signtool.exe")
      }
  }
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return $path
    }
  }
  $where = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($where) { return $where.Source }
  throw "SignTool not found. Install the Windows 10/11 SDK (Signing Tools)."
}

function Find-Dlib {
  if ($DlibPath -and (Test-Path -LiteralPath $DlibPath)) {
    return (Resolve-Path -LiteralPath $DlibPath).Path
  }
  $localDlib = Join-Path $PSScriptRoot "tools\Microsoft.Trusted.Signing.Client\bin\x64\Azure.CodeSigning.Dlib.dll"
  if (Test-Path -LiteralPath $localDlib) {
    return (Resolve-Path -LiteralPath $localDlib).Path
  }
  $roots = @(
    "$env:USERPROFILE\.nuget\packages\microsoft.trusted.signing.client",
    "$env:USERPROFILE\.nuget\packages\azure.codesigning.dlib",
    "${env:ProgramFiles}\Microsoft Trusted Signing Client Tools",
    "${env:ProgramFiles(x86)}\Microsoft Trusted Signing Client Tools"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    $hit = Get-ChildItem $root -Recurse -Filter "Azure.CodeSigning.Dlib.dll" -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\(x64|win-x64)\\' -or $_.Directory.Name -eq "x64" } |
      Select-Object -First 1
    if (-not $hit) {
      $hit = Get-ChildItem $root -Recurse -Filter "Azure.CodeSigning.Dlib.dll" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    }
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Find-AzCli {
  $cmds = @(
    "az",
    "${env:ProgramFiles}\Microsoft SDKs\Azure\CLI2\wbin\az.cmd",
    "${env:LOCALAPPDATA}\Programs\Azure CLI\wbin\az.cmd"
  )
  foreach ($cmd in $cmds) {
    if ($cmd -eq "az") {
      $found = Get-Command az -ErrorAction SilentlyContinue
      if ($found) { return $found.Source }
      continue
    }
    if (Test-Path -LiteralPath $cmd) { return $cmd }
  }
  return $null
}

function Get-ReleaseRoots {
  $roots = New-Object System.Collections.Generic.List[string]
  $repoRelease = Join-Path $Root "src-tauri\target\release"
  if (Test-Path $repoRelease) { $roots.Add($repoRelease) | Out-Null }
  if ($env:CARGO_TARGET_DIR) {
    $cargoRelease = Join-Path $env:CARGO_TARGET_DIR "release"
    if (Test-Path $cargoRelease) { $roots.Add($cargoRelease) | Out-Null }
  }
  $sandbox = Join-Path $env:LOCALAPPDATA "Temp\cursor-sandbox-cache"
  if (Test-Path $sandbox) {
    Get-ChildItem $sandbox -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $path = Join-Path $_.FullName "cargo-target\release"
      if (Test-Path $path) { $roots.Add($path) | Out-Null }
    }
  }
  return $roots
}

function Get-ShippedInnerBinaries {
  # Product PE files that go into the NSIS payload. Bench/dev exes stay unsigned.
  $files = New-Object System.Collections.Generic.List[string]
  foreach ($root in Get-ReleaseRoots) {
    foreach ($name in @("replay.exe", "Replayr.exe")) {
      $path = Join-Path $root $name
      if (Test-Path -LiteralPath $path) { $files.Add((Resolve-Path $path).Path) | Out-Null }
    }
  }
  return $files | Select-Object -Unique
}

function Get-InstallerBinaries {
  $files = New-Object System.Collections.Generic.List[string]
  $version = "0.1.52"
  $tauriConf = Join-Path $Root "src-tauri\tauri.conf.json"
  if (Test-Path $tauriConf) {
    $parsed = Get-Content $tauriConf -Raw | ConvertFrom-Json
    if ($parsed.version) { $version = [string]$parsed.version }
  }
  foreach ($root in Get-ReleaseRoots) {
    $nsis = Join-Path $root "bundle\nsis"
    if (-not (Test-Path $nsis)) { continue }
    Get-ChildItem $nsis -File -Filter "*-setup.exe" | ForEach-Object {
      if ($_.Name -like "*$version*") {
        $files.Add($_.FullName) | Out-Null
      }
    }
  }
  $staged = Join-Path $Root "web\public\releases\Replayr.exe"
  if (Test-Path $staged) { $files.Add((Resolve-Path $staged).Path) | Out-Null }
  return $files | Select-Object -Unique
}

function Test-SignerRole {
  $az = Find-AzCli
  if (-not $az) {
    return [pscustomobject]@{
      Ok = $false
      Reason = "Azure CLI is not installed. Install it, run 'az login', then re-check Artifact Signing Certificate Profile Signer."
      Account = $null
      Roles = @()
    }
  }
  $accountJson = & $az account show --output json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $accountJson) {
    return [pscustomobject]@{
      Ok = $false
      Reason = "Azure CLI is not logged in. Run 'az login' with the identity that has Artifact Signing Certificate Profile Signer."
      Account = $null
      Roles = @()
    }
  }
  $account = $accountJson | ConvertFrom-Json
  $assignee = $account.user.name
  $oid = & $az ad signed-in-user show --query id --output tsv 2>$null
  if ($oid) { $assignee = $oid.Trim() }
  $assignmentsJson = & $az role assignment list --assignee $assignee --all --output json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $assignmentsJson) {
    return [pscustomobject]@{
      Ok = $false
      Reason = "Could not list role assignments for $($account.user.name). Confirm Artifact Signing Certificate Profile Signer is granted."
      Account = $account
      Roles = @()
    }
  }
  $assignments = $assignmentsJson | ConvertFrom-Json
  $names = @($assignments | ForEach-Object { $_.roleDefinitionName } | Sort-Object -Unique)
  $matched = $names | Where-Object { $RequiredRoles -contains $_ }
  if (-not $matched) {
    return [pscustomobject]@{
      Ok = $false
      Reason = "Logged-in identity '$($account.user.name)' does not have Artifact Signing Certificate Profile Signer (or Trusted Signing Certificate Profile Signer). Stop. Do not work around this."
      Account = $account
      Roles = $names
    }
  }
  return [pscustomobject]@{
    Ok = $true
    Reason = "Identity '$($account.user.name)' has: $($matched -join ', ')"
    Account = $account
    Roles = $names
  }
}

function Invoke-AuthenticodeSign {
  param([string] $Target)
  if (-not (Test-Path -LiteralPath $Target)) {
    throw "File not found: $Target"
  }
  if ($Target -like "*.sig") {
    throw "Refusing to Authenticode-sign updater artifact: $Target"
  }
  $signtool = Find-SignTool
  $dlib = Find-Dlib
  if (-not $dlib) {
    throw "Azure.CodeSigning.Dlib.dll not found. Install NuGet package Microsoft.Trusted.Signing.Client and set AZURE_CODE_SIGNING_DLIB."
  }
  if (-not (Test-Path -LiteralPath $MetadataPath)) {
    throw "Missing signing metadata: $MetadataPath"
  }
  $meta = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
  if (-not $meta.Endpoint -or -not $meta.CodeSigningAccountName -or -not $meta.CertificateProfileName) {
    throw "metadata.json must include Endpoint, CodeSigningAccountName, and CertificateProfileName only."
  }
  if ($meta.CertificateThumbprint -or $meta.Thumbprint -or $meta.SerialNumber) {
    throw "Do not put certificate thumbprint or serial number in metadata.json. Azure Artifact Signing issues the short-lived cert."
  }

  $size = (Get-Item -LiteralPath $Target).Length
  $az = Find-AzCli
  if ($az) {
    $azDir = Split-Path -Parent $az
    if ($env:PATH -notlike "*${azDir}*") {
      $env:PATH = "$azDir;$env:PATH"
    }
    Write-Host "  Azure CLI $az (on PATH for Dlib AzureCliCredential)"
  } else {
    Write-Host "  Azure CLI not found on this machine; Dlib AzureCliCredential will fail."
  }
  Write-Host "Signing $Target"
  Write-Host "  SignTool  $signtool"
  Write-Host "  Dlib      $dlib"
  Write-Host "  Metadata  $MetadataPath"
  Write-Host "  Size      $size bytes"
  Write-Host "  Timeout   ${TimeoutSeconds}s"
  Write-Host "  Started   $(Get-Date -Format o)"
  $started = Get-Date
  $argList = @(
    "sign", "/v", "/debug", "/fd", "SHA256", "/td", "SHA256",
    "/tr", $TimestampUrl,
    "/dlib", "`"$dlib`"",
    "/dmdf", "`"$MetadataPath`"",
    "`"$Target`""
  )
  $proc = Start-Process -FilePath $signtool -ArgumentList $argList -NoNewWindow -PassThru
  if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
    $elapsed = [int]((Get-Date) - $started).TotalSeconds
    try { $proc.Kill() } catch {}
    throw "SignTool timed out after ${elapsed}s while signing $Target (size $size). Azure request may have been submitted. Do not retry in a loop."
  }
  $proc.Refresh()
  $elapsed = [int]((Get-Date) - $started).TotalSeconds
  $exitCode = $proc.ExitCode
  Write-Host "  Finished  $(Get-Date -Format o) elapsed=${elapsed}s exit=$exitCode"
  if ($null -eq $exitCode) {
    Write-Host "  Start-Process did not report ExitCode; continuing to SignTool verify."
  } elseif ($exitCode -ne 0) {
    throw "SignTool sign failed for $Target (exit $exitCode, elapsed ${elapsed}s, size $size)"
  }
  Write-Host "Verifying $Target"
  & $signtool verify /pa /v $Target
  if ($LASTEXITCODE -ne 0) {
    throw "SignTool verify failed for $Target (exit $LASTEXITCODE)"
  }
}

function Show-Prereqs {
  $signtool = $null
  $signtoolError = $null
  try { $signtool = Find-SignTool } catch { $signtoolError = $_.Exception.Message }
  $dlib = Find-Dlib
  $az = Find-AzCli
  $role = if ($SkipRoleCheck) { $null } else { Test-SignerRole }

  Write-Host "SignTool:     $(if ($signtool) { $signtool } else { $signtoolError })"
  Write-Host "Dlib:         $(if ($dlib) { $dlib } else { 'MISSING - install Microsoft.Trusted.Signing.Client (Azure.CodeSigning.Dlib.dll)' })"
  Write-Host "Metadata:     $MetadataPath"
  Write-Host "Azure CLI:    $(if ($az) { $az } else { 'MISSING' })"
  if ($role) {
    Write-Host "Signer role:  $(if ($role.Ok) { $role.Reason } else { $role.Reason })"
    if ($role.Roles -and $role.Roles.Count) {
      Write-Host "Other roles:  $($role.Roles -join '; ')"
    }
  }

  Write-Host ""
  Write-Host "Shipped Windows PE (inner):"
  $inner = @(Get-ShippedInnerBinaries)
  if ($inner.Count -eq 0) { Write-Host "  (none found; run npm run tauri:build)" }
  else { $inner | ForEach-Object { Write-Host "  $_" } }
  Write-Host "Shipped Windows PE (installer):"
  $setups = @(Get-InstallerBinaries)
  if ($setups.Count -eq 0) { Write-Host "  (none found)" }
  else { $setups | ForEach-Object { Write-Host "  $_" } }
  Write-Host "Not shipped (do not sign for release): compose_nv12.exe, preview_encode_bench.exe, replay_lib.dll, *.pdb"

  return [pscustomobject]@{
    SignTool = $signtool
    Dlib = $dlib
    Az = $az
    Role = $role
  }
}

$prereq = Show-Prereqs
if ($CheckOnly) { return }

if (-not $SkipRoleCheck) {
  if (-not $prereq.Role -or -not $prereq.Role.Ok) {
    Write-Error ($prereq.Role.Reason)
    exit 2
  }
}

$targets = @()
switch ($PSCmdlet.ParameterSetName) {
  "File" { $targets = @((Resolve-Path -LiteralPath $File).Path) }
  "Inner" { $targets = @(Get-ShippedInnerBinaries) }
  "Installer" { $targets = @(Get-InstallerBinaries) }
  "All" {
    $targets = @()
    $targets += Get-ShippedInnerBinaries
    Write-Host "Inner binaries signed next. Re-run 'npx tauri bundle --bundles nsis' after this if the NSIS payload must include the signed Replayr.exe, then run -Installer."
    $targets += Get-InstallerBinaries
  }
}

if ($targets.Count -eq 0) {
  throw "No binaries to sign."
}

foreach ($target in $targets) {
  Invoke-AuthenticodeSign -Target $target
}
