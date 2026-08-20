[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AssetRoot,
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $scriptRoot '..')).Path

function Resolve-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'Path must not be empty.'
    }
    return [System.IO.Path]::GetFullPath($Path)
}

$assetRootPath = Resolve-AbsolutePath $AssetRoot
if (-not (Test-Path -LiteralPath $assetRootPath -PathType Container)) {
    throw "Hu Tao asset directory does not exist: $assetRootPath"
}

$resolvedAssetRoot = (Resolve-Path -LiteralPath $assetRootPath).Path
$repositoryPrefix = $repositoryRoot.TrimEnd('\') + '\'
if ($resolvedAssetRoot.StartsWith($repositoryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The debug source must remain outside the Rayure repository.'
}

$pmxPath = Join-Path $resolvedAssetRoot '胡桃.pmx'
$licensePath = Join-Path $resolvedAssetRoot 'readme【一定要看】.txt'
foreach ($requiredPath in @($pmxPath, $licensePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required Hu Tao source file is missing: $requiredPath"
    }
}

$licenseText = Get-Content -Raw -LiteralPath $licensePath
$configTarget = if ($ConfigPath) {
    Resolve-AbsolutePath $ConfigPath
} else {
    Join-Path $repositoryRoot 'rayure.local.json'
}
$debugDirectory = Join-Path $repositoryRoot 'scratch\live2d-hutao-debug'
New-Item -ItemType Directory -Force -Path $debugDirectory | Out-Null

$audit = [ordered]@{
    schema = 'rayure.live2d.debug-audit.v1'
    sourceType = 'external-pmx-reference'
    nativeCubismConversion = 'not-performed'
    nativeCubismConversionReason = 'PMX is a 3D mesh/rig source; a native Cubism model requires authored layered 2D art and Cubism model data.'
    sourceRoot = $resolvedAssetRoot
    sourcePmx = (Resolve-Path -LiteralPath $pmxPath).Path
    privateOnly = $true
    distributable = $false
    licenseSignals = [ordered]@{
        forbidsRedistribution = $licenseText.Contains('请勿二次配布')
        forbidsCommercialUse = $licenseText.Contains('请勿用于商业用途')
    }
    repositoryCopy = $false
    generatedNativeModel = $false
}
$auditPath = Join-Path $debugDirectory 'asset-audit.json'
$audit | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $auditPath -Encoding utf8

$config = [ordered]@{
    model = [ordered]@{
        id = 'hutao-debug-pmx'
        displayName = 'External PMX reference (debug only)'
        format = 'pmx'
        path = (Resolve-Path -LiteralPath $pmxPath).Path
    }
}
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configTarget -Encoding utf8

Write-Host '[Rayure] Prepared a local-only external PMX reference.'
Write-Host "[Rayure] Config: $configTarget"
Write-Host "[Rayure] Audit:  $auditPath"
Write-Host '[Rayure] Native .moc3/.model3.json conversion was not attempted; use ?live2dDebug=1 for the parameter probe.'
