[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ModelRoot,

    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$repositoryPrefix = $repositoryRoot.TrimEnd('\') + '\'

function Resolve-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Path))
}

function Test-ContainedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Candidate
    )
    $rootWithSeparator = $Root.TrimEnd('\') + '\'
    return $Candidate.Equals($Root, [System.StringComparison]::OrdinalIgnoreCase) -or
        $Candidate.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RelativeAssetPath {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Root
    )
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value.Trim() -ne $Value) {
        throw "$Label must be a trimmed non-empty string."
    }
    $normalized = $Value.Replace('/', '\')
    if ([System.IO.Path]::IsPathRooted($normalized) -or $normalized.Split('\') -contains '..') {
        throw "$Label must be a relative path without traversal."
    }
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $Root $normalized))
    if (-not (Test-ContainedPath -Root $Root -Candidate $candidate)) {
        throw "$Label escapes the model root."
    }
    return $normalized.Replace('\', '/')
}

$resolvedRoot = (Resolve-Path -LiteralPath (Resolve-AbsolutePath $ModelRoot) -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    throw "Live2D model root does not exist: $resolvedRoot"
}

$modelFiles = @(Get-ChildItem -LiteralPath $resolvedRoot -Filter '*.model3.json' -File)
if ($modelFiles.Count -ne 1) {
    throw "Expected exactly one .model3.json in $resolvedRoot, found $($modelFiles.Count)."
}
$modelFile = $modelFiles[0]
$model3 = Get-Content -Raw -LiteralPath $modelFile.FullName | ConvertFrom-Json
if ($model3.Version -ne 3) { throw 'Live2D model3.json Version must be 3.' }
if ($null -eq $model3.FileReferences) { throw 'Live2D model3.json is missing FileReferences.' }

$assetPaths = [System.Collections.Generic.List[string]]::new()
$mocPath = Get-RelativeAssetPath -Value $model3.FileReferences.Moc -Label 'FileReferences.Moc' -Root $resolvedRoot
$assetPaths.Add($mocPath)

foreach ($texture in @($model3.FileReferences.Textures)) {
    $path = Get-RelativeAssetPath -Value $texture -Label 'FileReferences.Textures entry' -Root $resolvedRoot
    if (-not $path.EndsWith('.png', [System.StringComparison]::OrdinalIgnoreCase)) { throw "Texture must be PNG: $path" }
    $assetPaths.Add($path)
}

foreach ($property in @('Physics', 'Pose', 'UserData', 'DisplayInfo')) {
    $value = $model3.FileReferences.$property
    if ($null -ne $value) {
        $assetPaths.Add((Get-RelativeAssetPath -Value $value -Label "FileReferences.$property" -Root $resolvedRoot))
    }
}

$motionGroups = @{}
if ($null -ne $model3.FileReferences.Motions) {
    foreach ($property in $model3.FileReferences.Motions.PSObject.Properties) {
        $motionGroups[$property.Name] = @()
        foreach ($motion in @($property.Value)) {
            $motionPath = Get-RelativeAssetPath -Value $motion.File -Label "Motion $($property.Name)" -Root $resolvedRoot
            if (-not $motionPath.EndsWith('.motion3.json', [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Motion must use .motion3.json: $motionPath"
            }
            $motionGroups[$property.Name] += $motionPath
            $assetPaths.Add($motionPath)
        }
    }
}

$uniqueAssetPaths = @($assetPaths | Sort-Object -Unique)
$missingAssets = @($uniqueAssetPaths | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $resolvedRoot $_) -PathType Leaf)
    })

$displayInfoPath = $model3.FileReferences.DisplayInfo
$parameters = @()
if ($null -ne $displayInfoPath) {
    $displayInfoFile = Join-Path $resolvedRoot (Get-RelativeAssetPath -Value $displayInfoPath -Label 'FileReferences.DisplayInfo' -Root $resolvedRoot)
    if (Test-Path -LiteralPath $displayInfoFile -PathType Leaf) {
        $displayInfo = Get-Content -Raw -LiteralPath $displayInfoFile | ConvertFrom-Json
        if ($displayInfo.Version -ne 3) { throw 'Live2D cdi3.json Version must be 3.' }
        $parameters = @($displayInfo.Parameters | ForEach-Object { [string]$_.Id } | Where-Object { $_ })
    }
}

$requiredParameters = @(
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
    'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamArmLA', 'ParamArmRA', 'ParamArmLB', 'ParamArmRB'
)
$missingParameters = @($requiredParameters | Where-Object { $parameters -notcontains $_ })
$mocBytes = [System.IO.File]::ReadAllBytes((Join-Path $resolvedRoot $mocPath))
$moc3HeaderValid = $mocBytes.Length -ge 4 -and
    $mocBytes[0] -eq 0x4d -and $mocBytes[1] -eq 0x4f -and $mocBytes[2] -eq 0x43 -and $mocBytes[3] -eq 0x33

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $modelName = [System.IO.Path]::GetFileNameWithoutExtension([System.IO.Path]::GetFileNameWithoutExtension($modelFile.Name))
    $OutputPath = Join-Path $repositoryRoot "scratch\live2d-samples\$modelName\audit.json"
}
$resolvedOutput = Resolve-AbsolutePath $OutputPath
if (-not (Test-ContainedPath -Root (Join-Path $repositoryRoot 'scratch') -Candidate $resolvedOutput)) {
    throw 'Audit output must stay inside the ignored scratch directory.'
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedOutput) | Out-Null

$audit = [ordered]@{
    schema = 'rayure.live2d.model-audit.v1'
    sourceType = 'external-or-ignored-live2d-model'
    modelId = $modelFile.BaseName -replace '\.model3$'
    sourceRoot = $resolvedRoot
    model3 = $modelFile.Name
    moc3HeaderValid = $moc3HeaderValid
    assetCount = $uniqueAssetPaths.Count
    missingAssets = $missingAssets
    motionGroups = $motionGroups
    parameterCount = $parameters.Count
    requiredParameters = $requiredParameters
    missingParameters = $missingParameters
    publishBoundary = 'scratch-or-external-only; never copy to public, dist, Git, or release assets'
    generatedAt = [DateTime]::UtcNow.ToString('o')
}
$audit | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedOutput -Encoding UTF8

if (-not $moc3HeaderValid) { throw 'MOC3 header is invalid.' }
if ($missingAssets.Count -gt 0) { throw "Live2D model is missing assets:`n$($missingAssets -join "`n")" }
if ($missingParameters.Count -gt 0) { throw "Live2D model is missing standard parameters:`n$($missingParameters -join ', ')" }

Write-Host "[Rayure] Live2D model audit passed: $($modelFile.Name)"
Write-Host "[Rayure] Assets: $($uniqueAssetPaths.Count); parameters: $($parameters.Count); standard rig: complete"
Write-Host "[Rayure] Audit: $resolvedOutput"
