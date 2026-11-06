param(
    [string]$Version,
    [string]$NotesFile,
    [switch]$Quick,
    [switch]$Stable,
    [switch]$PackageOnly,
    [switch]$Check,
    [switch]$Resume,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
# npm started from pwsh can pass PS7 module paths to Windows PowerShell 5.1.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-core.ps1')
. (Join-Path $PSScriptRoot 'release-build.ps1')

if ($Help) {
    Write-Host @'
TabAgent release (Windows PowerShell 5.1+ / PowerShell 7)

  .\release.cmd 0.1.1                     Full checks, package and publish preview
  .\release.cmd 0.1.1 -Quick              Types + core unit checks, then publish
  .\release.cmd 0.1.1 -NotesFile notes.md  Use Markdown change notes
  .\release.cmd 0.1.1 -Stable             Publish a stable release
  .\release.cmd 0.1.1 -Check              Read-only configuration/remote check
  .\release.cmd 0.1.1 -Resume             Resume the exact prepared commit/assets
  .\release.cmd -PackageOnly -Quick      Local packages only; no GitHub access

Commit feature changes first. A new version updates package.json/package-lock.json
and creates a version commit/tag automatically. Existing published versions are
never replaced. Downloads are prepared in .output/releases/<version>.
'@
    exit 0
}

$context = $null
$releaseLock = $null
$versionBackups = @{}
$versionHashes = @{}
$versionStaged = $false
$prepared = $false
$oldLocation = Get-Location
try {
    Set-Location -LiteralPath $Root
    if (($PackageOnly -and ($Resume -or $Check -or $Stable)) -or ($Resume -and $Check)) { throw 'These release modes cannot be combined.' }
    $packageFile = Join-Path $Root 'package.json'
    $package = [IO.File]::ReadAllText($packageFile) | ConvertFrom-Json
    $currentVersion = [string]$package.version
    if ($PackageOnly) {
        if ($Version -and $Version -ne $currentVersion) { throw '-PackageOnly uses the current package.json version.' }
        $Version = $currentVersion
    } elseif (-not $Version) {
        if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) { throw 'Specify -Version X.Y.Z, or use -Help.' }
        $current = [version]$currentVersion
        $suggestion = "$($current.Major).$($current.Minor).$($current.Build + 1)"
        $Version = Read-Host "Release version [$suggestion]"
        if (-not $Version) { $Version = $suggestion }
    }
    Assert-ReleaseVersion -Version $Version -CurrentVersion $currentVersion
    $tag = "v$Version"
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { '' }
    if (-not $nodePath -and $env:USERPROFILE) {
        $candidate = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $nodePath = $candidate }
    }
    if (-not $nodePath) { throw 'Node.js 22.18+ is required.' }
    $runtimeVersion = (& $nodePath -p 'process.versions.node').Trim()
    if ([version]$runtimeVersion -lt [version]'22.18.0') { throw 'Node.js 22.18+ is required.' }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules/wxt/bin/wxt.mjs'))) { throw 'Install dependencies with npm ci before releasing.' }
    if ($NotesFile) {
        $NotesFile = (Resolve-Path -LiteralPath $NotesFile -ErrorAction Stop).Path
        if (-not (Test-Path -LiteralPath $NotesFile -PathType Leaf)) { throw 'NotesFile must be a Markdown file.' }
    }
    $proxy = Get-ReleaseProxy
    if (-not $Check) {
        $gitLockPath = (Invoke-ReleaseGit $Root @('rev-parse', '--git-path', 'tabagent-release.lock')).text
        if (-not [IO.Path]::IsPathRooted($gitLockPath)) { $gitLockPath = Join-Path $Root $gitLockPath }
        $releaseLock = [IO.File]::Open($gitLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }

    if ($PackageOnly) {
        $directory = Join-Path $Root ".output/packages/$Version"
        $built = Invoke-ReleaseBuild -Root $Root -NodePath $nodePath -Version $Version -OutputDir $directory -Quick:$Quick
        Assert-ReleaseAssetSet -Root $Root -Version $Version -Assets $built.assets
        Write-Host "Local packages ready: $directory"
    } else {
        $dirty = (Invoke-ReleaseGit $Root @('status', '--porcelain', '--untracked-files=normal')).text
        if ($dirty -and -not $Check) { throw 'Commit or stash your changes before publishing (including untracked files). The script commits only the version bump.' }
        $branch = (Invoke-ReleaseGit $Root @('symbolic-ref', '--short', 'HEAD')).text
        $head = (Invoke-ReleaseGit $Root @('rev-parse', 'HEAD')).text
        $origin = (Invoke-ReleaseGit $Root @('remote', 'get-url', 'origin')).text
        $repository = Get-ReleaseRepository $origin
        $context = New-ReleaseContext -Root $Root -Repository $repository -Proxy $proxy
        $repoInfo = Invoke-ReleaseApi -Context $context -Path ''
        if ($repoInfo.full_name -ine $repository) { throw 'GitHub repository does not match origin.' }
        if ($repoInfo.permissions -and -not $repoInfo.permissions.push) { throw 'This GitHub credential does not have repository write access.' }
        $existing = Get-ReleaseByTag $context $tag
        if ($existing -and -not $existing.draft) { throw 'This version is already published. Choose a higher version.' }
        if ($existing -and -not $Resume) { throw 'A draft already exists. Use -Resume with its exact commit.' }
        $remoteCommit = Get-ReleaseTagCommit $context $tag
        if ($remoteCommit -and (-not $Resume -or $remoteCommit -ne $head)) { throw 'The remote tag already exists. Use -Resume only for the same commit.' }
        $localTag = Invoke-ReleaseGit $Root @('rev-parse', '--verify', "refs/tags/$tag^{}") -AllowFailure
        if ($localTag.code -eq 0 -and (-not $Resume -or $localTag.text -ne $head)) { throw 'The local tag already exists. Use a new version or resume the same commit.' }
        $directory = Join-Path $Root ".output/releases/$Version"
        $manifestFile = Join-Path $directory 'release-manifest.json'
        Write-Host "Repository: $repository | branch: $branch | version: $Version"
        if ($Check) {
            if ($dirty) { Write-Host 'Working tree has changes; commit them before publishing.' }
            Write-Host 'Read-only preflight passed. No version, tag, or release was changed.'
        } else {
            if ($Resume) {
                if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) { throw 'Prepared release metadata is missing. Keep .output/releases/<version> when resuming.' }
                $manifest = [IO.File]::ReadAllText($manifestFile) | ConvertFrom-Json
                if ($manifest.version -ne $Version -or $manifest.commit -ne $head -or $currentVersion -ne $Version -or [bool]$manifest.stable -ne [bool]$Stable -or $manifest.repository -ine $repository) { throw 'Prepared release does not match this commit, version, repository, or stability.' }
                Assert-ReleaseAssetSet -Root $Root -Version $Version -Assets $manifest.assets
                Test-ReleaseAssets -Assets $manifest.assets -Directory $directory | Out-Null
                $prepared = $true
            } else {
                if ($Version -ne $currentVersion) {
                    foreach ($name in @('package.json', 'package-lock.json')) { $versionBackups[$name] = [IO.File]::ReadAllBytes((Join-Path $Root $name)) }
                    & $nodePath (Join-Path $PSScriptRoot 'release-version.mjs') $Root $Version
                    if ($LASTEXITCODE -ne 0) { throw 'Could not update the package version.' }
                    foreach ($name in $versionBackups.Keys) { $versionHashes[$name] = (Get-FileHash -LiteralPath (Join-Path $Root $name) -Algorithm SHA256).Hash }
                }
                $built = Invoke-ReleaseBuild -Root $Root -NodePath $nodePath -Version $Version -OutputDir $directory -Quick:$Quick
                Assert-ReleaseAssetSet -Root $Root -Version $Version -Assets $built.assets
                # Refuse to commit an edit made while checks/builds were running.
                if ((Invoke-ReleaseGit $Root @('rev-parse', 'HEAD')).text -ne $head -or (Invoke-ReleaseGit $Root @('symbolic-ref', '--short', 'HEAD')).text -ne $branch) { throw 'HEAD or branch changed while building.' }
                if ((Invoke-ReleaseGit $Root @('diff', '--cached', '--name-only')).text) { throw 'The Git index changed while building. Nothing was committed.' }
                $changedFiles = (Invoke-ReleaseGit $Root @('diff', '--name-only', 'HEAD', '--')).text -split "`n"
                if (@($changedFiles | Where-Object { $_ -and $_ -notin $versionBackups.Keys }).Count -or (Invoke-ReleaseGit $Root @('ls-files', '--others', '--exclude-standard')).text) { throw 'Source files changed while building. Nothing was committed.' }
                foreach ($name in $versionHashes.Keys) { if ((Get-FileHash -LiteralPath (Join-Path $Root $name)).Hash -ne $versionHashes[$name]) { throw 'Version files changed while building.' } }
                if ($NotesFile) { $changes = [IO.File]::ReadAllText($NotesFile) }
                else {
                    $previousTag = Invoke-ReleaseGit $Root @('describe', '--tags', '--abbrev=0') -AllowFailure
                    $range = if ($previousTag.code -eq 0) { "$($previousTag.text)..HEAD" } else { 'HEAD' }
                    $changes = (Invoke-ReleaseGit $Root @('log', '-20', '--pretty=format:- %s', $range, '--')).text
                    if (-not $changes) { $changes = '- Maintenance and packaging update.' }
                }
                $checks = if ($Quick) { 'Quick: type checking and core unit tests; full browser regression was not run.' } else { 'Full project regression and type checking passed.' }
                $notes = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'release-notes.template.md')).Replace('{{VERSION}}', $Version).Replace('{{CHANGES}}', $changes).Replace('{{CHECKS}}', $checks)
                if ($versionBackups.Count) {
                    $versionStaged = $true
                    $previousHead = $head
                    Invoke-ReleaseGit $Root @('commit', '--only', '-m', "Release v$Version", '--', 'package.json', 'package-lock.json') | Out-Null
                    $head = (Invoke-ReleaseGit $Root @('rev-parse', 'HEAD')).text
                    if ((Invoke-ReleaseGit $Root @('rev-parse', 'HEAD^')).text -ne $previousHead) { throw 'The source commit changed during the version commit.' }
                    $committedFiles = (Invoke-ReleaseGit $Root @('diff', '--name-only', $previousHead, $head, '--')).text -split "`n"
                    if (@($committedFiles | Where-Object { $_ -and $_ -notin $versionBackups.Keys }).Count) { throw 'The version commit changed source files. No tag was pushed.' }
                    foreach ($name in $versionHashes.Keys) { if ((Get-FileHash -LiteralPath (Join-Path $Root $name)).Hash -ne $versionHashes[$name]) { throw 'The version files changed during commit. No tag was pushed.' } }
                }
                $manifest = [pscustomobject]@{ version = $Version; commit = $head; repository = $repository; stable = [bool]$Stable; checks = $built.checks; assets = $built.assets; notes = $notes }
                [IO.File]::WriteAllText($manifestFile, ($manifest | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
                $prepared = $true
            }
            if ((Invoke-ReleaseGit $Root @('status', '--porcelain', '--untracked-files=normal')).text) { throw 'Working tree changed; release stopped before pushing.' }
            if ((Invoke-ReleaseGit $Root @('rev-parse', 'HEAD')).text -ne $manifest.commit -or (Invoke-ReleaseGit $Root @('symbolic-ref', '--short', 'HEAD')).text -ne $branch) { throw 'HEAD or branch changed; release stopped before pushing.' }
            $localTag = Invoke-ReleaseGit $Root @('rev-parse', '--verify', "refs/tags/$tag^{}") -AllowFailure
            if ($localTag.code -ne 0) { Invoke-ReleaseGit $Root @('tag', '-a', $tag, '-m', "TabAgent $tag", $manifest.commit) | Out-Null }
            elseif ($localTag.text -ne $manifest.commit) { throw 'Local tag differs from packaged commit.' }
            Write-Host 'Pushing branch and tag...'
            Invoke-ReleaseGit -Root $Root -Arguments @('push', '--atomic', 'origin', "$($manifest.commit):refs/heads/$branch", "refs/tags/$tag") -Proxy $proxy | Out-Null
            $published = Publish-ReleaseAssets -Context $context -Root $Root -Version $Version -Commit $manifest.commit -Assets $manifest.assets -Notes $manifest.notes -Stable:$Stable -Resume:$Resume
            Write-Host "Published and verified: $($published.html_url)"
        }
    }
} catch {
    if (-not $versionStaged) {
        foreach ($name in $versionHashes.Keys) {
            $file = Join-Path $Root $name
            if ((Get-FileHash -LiteralPath $file -ErrorAction SilentlyContinue).Hash -eq $versionHashes[$name]) { [IO.File]::WriteAllBytes($file, $versionBackups[$name]) }
        }
    }
    Write-Host ("Release stopped: " + $_.Exception.Message) -ForegroundColor Red
    if ($prepared) { Write-Host "Check GitHub, then resume the same source/assets with: .\release.cmd $Version -Resume$(if ($Stable) { ' -Stable' })" }
    elseif ($versionStaged) { Write-Host 'The version changes remain staged or committed. Resolve the Git error before retrying.' }
    exit 1
} finally {
    if ($context) { $context.headers.Clear() }
    if ($releaseLock) { $releaseLock.Dispose() }
    Set-Location -LiteralPath $oldLocation.Path
}
