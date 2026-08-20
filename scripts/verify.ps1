[CmdletBinding()]
param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $scriptRoot '..')).Path

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action
    )

    Write-Host "[Rayure] $Label"
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

Push-Location -LiteralPath $repositoryRoot
try {
    if (-not $SkipInstall) {
        Invoke-Checked 'Validating locked dependencies' { pnpm install --frozen-lockfile }
    }
    Invoke-Checked 'Running tests' { pnpm test }
    Invoke-Checked 'Running TypeScript checks' { pnpm typecheck }
    Invoke-Checked 'Building Wallpaper Engine web project' { pnpm build }
    Invoke-Checked 'Auditing production dependencies' { pnpm audit --prod --audit-level high }

    $runtimeRoots = @(
        (Join-Path $repositoryRoot 'apps'),
        (Join-Path $repositoryRoot 'packages')
    )
    $airiMatches = & rg -n -i --glob 'src/**' 'airi|@proj-airi' @runtimeRoots 2>$null
    if ($LASTEXITCODE -eq 0) {
        throw "AIRI runtime coupling was found:`n$($airiMatches -join "`n")"
    }
    if ($LASTEXITCODE -gt 1) {
        throw "AIRI boundary scan failed with exit code $LASTEXITCODE"
    }

    $distRoot = Join-Path $repositoryRoot 'apps\wallpaper\dist'
    $distIndex = Join-Path $distRoot 'index.html'
    $distProject = Join-Path $distRoot 'project.json'
    if (-not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
        throw 'Wallpaper build did not produce dist/index.html'
    }
    if (-not (Test-Path -LiteralPath $distProject -PathType Leaf)) {
        throw 'Wallpaper build did not produce dist/project.json'
    }

    try {
        $project = Get-Content -Raw -LiteralPath $distProject | ConvertFrom-Json
    }
    catch {
        throw "Wallpaper project.json is invalid JSON: $($_.Exception.Message)"
    }
    if ($project.type -ne 'web' -or $project.file -ne 'index.html') {
        throw 'Wallpaper project.json must declare type=web and file=index.html'
    }
    $expectedProperties = @('accentcolor', 'companionport', 'modelscale', 'showstatus')
    $actualProperties = @($project.general.properties.PSObject.Properties.Name)
    if (($actualProperties -join ',') -ne ($expectedProperties -join ',')) {
        throw "Wallpaper project properties changed unexpectedly: $($actualProperties -join ', ')"
    }

    $indexContent = Get-Content -Raw -LiteralPath $distIndex
    if ($indexContent -match '(?:src|href)="https?://') {
        throw 'Wallpaper index contains a remote script or stylesheet reference'
    }

    $privateExtensions = @('.vrm', '.pmx', '.pmd', '.fbx', '.vmd', '.vrma', '.blend')
    $privateAssets = Get-ChildItem -LiteralPath $distRoot -Recurse -File |
        Where-Object { $privateExtensions -contains $_.Extension.ToLowerInvariant() }
    if ($privateAssets) {
        throw "Private/model assets entered the wallpaper build:`n$($privateAssets.FullName -join "`n")"
    }

    if ($indexContent -notmatch 'assets/index-') {
        throw 'Wallpaper index does not reference its local bundled assets'
    }

    $wasmAssets = @(Get-ChildItem -LiteralPath $distRoot -Recurse -File -Filter '*.wasm')
    if ($wasmAssets.Count -lt 1) {
        throw 'Wallpaper build did not include the local PMX parser WASM asset'
    }

    $privateMarkers = @(
        'StereoModelPlugin',
        '2086 原神3d模型',
        '胡桃（仅本地开发测试）',
        'hutao-dev',
        'D:\CodingProjects'
    )
    $textArtifacts = Get-ChildItem -LiteralPath $distRoot -Recurse -File |
        Where-Object { @('.css', '.html', '.js', '.json') -contains $_.Extension.ToLowerInvariant() }
    foreach ($artifact in $textArtifacts) {
        $artifactContent = Get-Content -Raw -LiteralPath $artifact.FullName
        foreach ($marker in $privateMarkers) {
            if ($artifactContent.Contains($marker)) {
                throw "Private development marker entered the wallpaper build: $marker in $($artifact.FullName)"
            }
        }
    }

    $trackedLocalConfig = @(& git ls-files -- 'rayure.local.json')
    if ($LASTEXITCODE -ne 0) {
        throw "Git local-config check failed with exit code $LASTEXITCODE"
    }
    if ($trackedLocalConfig.Count -gt 0) {
        throw 'rayure.local.json must never be tracked by Git'
    }

    Write-Host '[Rayure] Verification passed.'
}
finally {
    Pop-Location
}
