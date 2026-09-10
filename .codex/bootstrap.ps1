#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [string]$WorkerUser = 'samuel',
    [switch]$RunTests,
    [switch]$VerifyOnly,
    [switch]$SkipCodexUpdate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$CodexInstallerUrl = 'https://chatgpt.com/codex/install.sh'
$DotNetInstallerUrl = 'https://dot.net/v1/dotnet-install.sh'
$DotNetInstallDir = '/usr/local/share/dotnet'
$DotNetSymlink = '/usr/local/bin/dotnet'

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory
    )

    $oldLocation = $null
    try {
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
            $oldLocation = Get-Location
            Set-Location -LiteralPath $WorkingDirectory
        }

        & $File @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $($LASTEXITCODE): $File $($Arguments -join ' ')"
        }
    }
    finally {
        if ($null -ne $oldLocation) {
            Set-Location -LiteralPath $oldLocation
        }
    }
}

function Get-EffectiveUid {
    $uidText = (& id -u 2>$null | Out-String).Trim()
    $uid = 0
    if (-not [int]::TryParse($uidText, [ref]$uid)) {
        throw 'Unable to determine the effective Linux user ID.'
    }

    return $uid
}

function Test-IsRoot {
    return (Get-EffectiveUid) -eq 0
}

function Get-UserHome {
    param([Parameter(Mandatory)][string]$UserName)

    $entry = (& getent passwd $UserName 2>$null | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($entry)) {
        throw "Linux user '$UserName' does not exist."
    }

    $parts = $entry.Split(':')
    if ($parts.Count -lt 6 -or [string]::IsNullOrWhiteSpace($parts[5])) {
        throw "Unable to determine the home directory for '$UserName'."
    }

    return $parts[5]
}

function Invoke-Root {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$Arguments = @()
    )

    if (Test-IsRoot) {
        Invoke-Native -File $File -Arguments $Arguments
        return
    }

    if (-not (Get-Command sudo -ErrorAction SilentlyContinue)) {
        throw 'Root privileges are required to install system packages. Run as root or install sudo.'
    }

    Invoke-Native -File 'sudo' -Arguments (@($File) + $Arguments)
}

function Invoke-AsWorker {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory,
        [switch]$CaptureOutput
    )

    $currentUser = (& id -un | Out-String).Trim()
    $workerHome = Get-UserHome -UserName $WorkerUser
    $workerPath = "$workerHome/.local/bin:$workerHome/bin:/usr/local/bin:/usr/bin:/bin"
    $commandFile = $File
    $commandArgs = $Arguments

    if ($currentUser -ne $WorkerUser) {
        if (-not (Test-IsRoot)) {
            throw "Cannot run worker commands as '$WorkerUser' from '$currentUser'."
        }

        $commandFile = 'runuser'
        $commandArgs = @('-u', $WorkerUser, '--', 'env', "HOME=$workerHome", "PATH=$workerPath", $File) + $Arguments
    }

    $oldLocation = $null
    try {
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
            $oldLocation = Get-Location
            Set-Location -LiteralPath $WorkingDirectory
        }

        if ($CaptureOutput) {
            $output = (& $commandFile @commandArgs 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) {
                throw "Command failed with exit code $($LASTEXITCODE): $File $($Arguments -join ' ')"
            }

            return $output
        }

        & $commandFile @commandArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $($LASTEXITCODE): $File $($Arguments -join ' ')"
        }
    }
    finally {
        if ($null -ne $oldLocation) {
            Set-Location -LiteralPath $oldLocation
        }
    }
}

function Test-AsWorkerCommand {
    param([Parameter(Mandatory)][string]$Name)

    $currentUser = (& id -un | Out-String).Trim()
    $workerHome = Get-UserHome -UserName $WorkerUser
    $workerPath = "$workerHome/.local/bin:$workerHome/bin:/usr/local/bin:/usr/bin:/bin"
    $probe = "command -v -- '$Name' >/dev/null 2>&1"

    if ($currentUser -eq $WorkerUser) {
        & env "HOME=$workerHome" "PATH=$workerPath" sh -lc $probe
        return $LASTEXITCODE -eq 0
    }

    if (-not (Test-IsRoot)) {
        return $false
    }

    & runuser -u $WorkerUser -- env "HOME=$workerHome" "PATH=$workerPath" sh -lc $probe
    return $LASTEXITCODE -eq 0
}

function Read-OsRelease {
    $path = '/etc/os-release'
    if (-not (Test-Path -LiteralPath $path)) {
        throw 'This bootstrap supports Linux workers and requires /etc/os-release.'
    }

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $path) {
        if ($line -match '^(?<key>[A-Z0-9_]+)=(?<value>.*)$') {
            $values[$Matches.key] = $Matches.value.Trim().Trim('"').Trim("'")
        }
    }

    return $values
}

function Ensure-AptPackages {
    param([string[]]$Packages)

    if ($null -eq $Packages -or $Packages.Count -eq 0) {
        return
    }

    Write-Step "Ensuring Debian packages: $($Packages -join ', ')"
    Invoke-Root -File 'apt-get' -Arguments @('update')
    Invoke-Root -File 'apt-get' -Arguments (@('install', '-y') + $Packages)
}

function Ensure-ExactDotNetSdk {
    param([Parameter(Mandatory)][string]$Version)

    $installed = @()
    if (Get-Command dotnet -ErrorAction SilentlyContinue) {
        $installed = @((& dotnet --list-sdks 2>$null) | ForEach-Object {
            if ($_ -match '^(?<version>\S+)\s') { $Matches.version }
        })
    }

    if ($installed -contains $Version) {
        Write-Host "    .NET SDK $Version already installed."
        return
    }

    if ($VerifyOnly) {
        throw ".NET SDK $Version is required but is not installed."
    }

    Write-Step "Installing exact .NET SDK $Version from global.json"
    $installer = Join-Path ([System.IO.Path]::GetTempPath()) "dotnet-install-$([Guid]::NewGuid().ToString('N')).sh"
    try {
        Invoke-Native -File 'curl' -Arguments @('-fsSL', $DotNetInstallerUrl, '-o', $installer)
        Invoke-Root -File 'mkdir' -Arguments @('-p', $DotNetInstallDir)
        Invoke-Root -File 'bash' -Arguments @($installer, '--version', $Version, '--install-dir', $DotNetInstallDir, '--no-path')
        Invoke-Root -File 'ln' -Arguments @('-sfn', "$DotNetInstallDir/dotnet", $DotNetSymlink)
    }
    finally {
        Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    }

    $versions = @((& $DotNetSymlink --list-sdks 2>$null) | ForEach-Object {
        if ($_ -match '^(?<version>\S+)\s') { $Matches.version }
    })
    if ($versions -notcontains $Version) {
        throw ".NET SDK $Version was installed but could not be verified."
    }
}

function Ensure-CodexCli {
    $codexExists = Test-AsWorkerCommand -Name 'codex'
    if ($VerifyOnly) {
        if (-not $codexExists) {
            throw "Codex CLI is required but is not installed for '$WorkerUser'."
        }

        return
    }

    $shouldInstall = (-not $codexExists) -or
        ([bool]$config.dependencies.codexCli.updateOnBootstrap -and -not $SkipCodexUpdate)
    if (-not $shouldInstall) {
        Write-Host '    Codex CLI already installed; update skipped.'
        return
    }

    Write-Step $(if ($codexExists) { 'Updating Codex CLI' } else { 'Installing Codex CLI' })
    $installer = Join-Path ([System.IO.Path]::GetTempPath()) "codex-install-$([Guid]::NewGuid().ToString('N')).sh"
    try {
        Invoke-Native -File 'curl' -Arguments @('-fsSL', $CodexInstallerUrl, '-o', $installer)
        Invoke-Root -File 'chmod' -Arguments @('0755', $installer)
        Invoke-AsWorker -File 'sh' -Arguments @($installer)
    }
    finally {
        Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-AsWorkerCommand -Name 'codex')) {
        throw "Codex installer completed, but codex is not available for '$WorkerUser'."
    }
}

function Invoke-ConfiguredCommands {
    param(
        [Parameter(Mandatory)]$Commands,
        [Parameter(Mandatory)][string]$RepositoryRoot
    )

    foreach ($command in @($Commands)) {
        $file = [string]$command.file
        $args = @($command.args | ForEach-Object { [string]$_ })
        Write-Step "$file $($args -join ' ')"
        Invoke-AsWorker -File $file -Arguments $args -WorkingDirectory $RepositoryRoot
    }
}

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$configPath = Join-Path $PSScriptRoot 'worker.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Worker configuration not found: $configPath"
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ([int]$config.schemaVersion -ne 1) {
    throw "Unsupported worker.json schemaVersion '$($config.schemaVersion)'."
}

$os = Read-OsRelease
if ($os['ID'] -ne [string]$config.platform.os) {
    throw "This worker expects '$($config.platform.os)', but /etc/os-release reports '$($os['ID'])'."
}

$actualMajor = ([string]$os['VERSION_ID']).Split('.')[0]
if ($actualMajor -ne [string]$config.platform.majorVersion) {
    throw "This worker expects $($config.platform.os) $($config.platform.majorVersion), but VERSION_ID is '$($os['VERSION_ID'])'."
}

$workerHome = Get-UserHome -UserName $WorkerUser
Write-Host ''
Write-Host "$($config.name) Codex worker bootstrap" -ForegroundColor Green
Write-Host "  Repository : $repositoryRoot"
Write-Host "  Worker user: $WorkerUser ($workerHome)"
Write-Host "  OS         : $($os['PRETTY_NAME'])"
Write-Host "  Mode       : $(if ($VerifyOnly) { 'verify only' } else { 'ensure desired state' })"
Write-Host ''

if (-not $VerifyOnly) {
    Ensure-AptPackages -Packages @($config.dependencies.aptPackages | ForEach-Object { [string]$_ })
}

if ($config.dependencies.PSObject.Properties.Name -contains 'dotnet') {
    $globalJsonPath = Join-Path $repositoryRoot ([string]$config.dependencies.dotnet.globalJson)
    if (-not (Test-Path -LiteralPath $globalJsonPath)) {
        throw "Configured global.json was not found: $globalJsonPath"
    }

    $globalJson = Get-Content -LiteralPath $globalJsonPath -Raw | ConvertFrom-Json
    $requiredSdk = [string]$globalJson.sdk.version
    if ([string]::IsNullOrWhiteSpace($requiredSdk)) {
        throw "No sdk.version was found in $globalJsonPath."
    }

    Ensure-ExactDotNetSdk -Version $requiredSdk
}

Ensure-CodexCli

Write-Host ''
Write-Host 'Verified toolchain:' -ForegroundColor Green
foreach ($tool in @($config.dependencies.requiredCommands)) {
    $file = [string]$tool.file
    if (-not (Test-AsWorkerCommand -Name $file)) {
        throw "Required command '$file' is not available for '$WorkerUser'."
    }

    $args = @($tool.versionArgs | ForEach-Object { [string]$_ })
    $version = Invoke-AsWorker -File $file -Arguments $args -CaptureOutput
    Write-Host "  $($file): $version"
}

if (-not $VerifyOnly) {
    Invoke-ConfiguredCommands -Commands $config.commands.bootstrap -RepositoryRoot $repositoryRoot
    if ($RunTests) {
        Invoke-ConfiguredCommands -Commands $config.commands.test -RepositoryRoot $repositoryRoot
    }
}

try {
    Invoke-AsWorker -File 'codex' -Arguments @('login', 'status') -CaptureOutput | Out-Null
    Write-Host 'CODEX_WORKER_STATUS=ready'
}
catch {
    Write-Host "Run this once as '$WorkerUser': codex login --device-auth" -ForegroundColor Yellow
    Write-Host 'CODEX_WORKER_STATUS=ready-needs-codex-auth'
}

if (-not $VerifyOnly -and -not $RunTests) {
    Write-Host 'Tests were not run. Use -RunTests to include the configured test suite.'
}
