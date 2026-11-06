# Shared release helpers. Compatible with Windows PowerShell 5.1 and PowerShell 7.
function Assert-ReleaseVersion {
    param([string]$Version, [string]$CurrentVersion)
    if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Version must be X.Y.Z (for example 0.1.1).' }
    foreach ($part in $Version.Split('.')) { if ([long]$part -gt 65535) { throw 'Version components must be between 0 and 65535.' } }
    if ($Version -eq '0.0.0') { throw 'Version 0.0.0 cannot be published.' }
    if ($CurrentVersion -and ([version]$Version -lt [version]$CurrentVersion)) { throw 'Release version cannot be older than package.json.' }
}

function Get-ReleaseRepository {
    param([string]$Origin)
    if ($Origin -match '^https://github\.com/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$' -or
        $Origin -match '^git@github\.com:([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9_.-]+?)(?:\.git)?$' -or
        $Origin -match '^ssh://git@github\.com/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$') {
        if ($Matches[2] -in @('.', '..')) { throw 'Invalid GitHub repository.' }
        return "$($Matches[1])/$($Matches[2])"
    }
    throw 'origin must be a github.com HTTPS or SSH repository URL without embedded credentials.'
}

function Get-ReleaseProxy {
    foreach ($name in @('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($value) { return $value }
    }
    if ($env:OS -ne 'Windows_NT') { return '' }
    $network = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if (-not $network.ProxyEnable -or -not $network.ProxyServer) { return '' }
    $proxy = [string]$network.ProxyServer
    if ($proxy.Contains('=')) {
        $map = @{}
        foreach ($entry in $proxy.Split(';')) { $pair = $entry -split '=', 2; if ($pair.Count -eq 2) { $map[$pair[0].Trim()] = $pair[1].Trim() } }
        $proxy = if ($map['https']) { $map['https'] } else { $map['http'] }
    }
    if ($proxy -and $proxy -notmatch '^\w+://') { $proxy = 'http://' + $proxy }
    return $proxy
}

function Invoke-ReleaseGit {
    param([string]$Root, [string[]]$Arguments, [string]$Proxy = '', [switch]$AllowFailure)
    # Use process-local git config, so proxy credentials never become command arguments.
    $saved = @{}
    $count = 0
    if ($env:GIT_CONFIG_COUNT) { $count = [int]$env:GIT_CONFIG_COUNT }
    $changes = @{ GIT_CONFIG_COUNT = [string]($count + 1); "GIT_CONFIG_KEY_$count" = 'http.version'; "GIT_CONFIG_VALUE_$count" = 'HTTP/1.1'; GIT_TERMINAL_PROMPT = '0' }
    if ($Proxy) {
        $changes.GIT_CONFIG_COUNT = [string]($count + 2)
        $changes["GIT_CONFIG_KEY_$($count + 1)"] = 'http.proxy'
        $changes["GIT_CONFIG_VALUE_$($count + 1)"] = $Proxy
    }
    try {
        foreach ($name in $changes.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, $changes[$name], 'Process') }
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $output = @(& git -C $Root @Arguments 2>&1); $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previousPreference }
        if ($code -ne 0 -and -not $AllowFailure) { throw "Git command failed ($($Arguments[0])). Check authentication, branch permissions, and remote changes." }
        return [pscustomobject]@{ code = $code; text = ($output -join "`n").Trim() }
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
}

function New-ReleaseContext {
    param([string]$Root, [string]$Repository, [string]$Proxy)
    $token = $env:GH_TOKEN
    if (-not $token) { $token = $env:GITHUB_TOKEN }
    if (-not $token) {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $lines = @('protocol=https', 'host=github.com', '') | & git -C $Root -c credential.interactive=never credential fill 2>$null; $code = $LASTEXITCODE }
        finally { $ErrorActionPreference = $previousPreference }
        if ($code -eq 0) {
            foreach ($line in $lines) { if ($line.StartsWith('password=')) { $token = $line.Substring(9) } }
        }
        $lines = $null
    }
    if (-not $token) { throw 'GitHub authentication unavailable. Configure Git Credential Manager or GH_TOKEN (Contents: write).' }
    return [pscustomobject]@{
        repository = $Repository; proxy = $Proxy
        headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'TabAgent-release'; Authorization = "Bearer $token"; 'X-GitHub-Api-Version' = '2022-11-28' }
    }
}

function Invoke-ReleaseApi {
    param($Context, [string]$Method = 'Get', [string]$Path, $Body, [string]$AssetFile, [switch]$Upload, [switch]$AllowNotFound)
    if ($Path -match '^/|\.\.|://') { throw 'Invalid GitHub API path.' }
    $hostName = if ($Upload) { 'uploads.github.com' } else { 'api.github.com' }
    $request = @{ Uri = "https://$hostName/repos/$($Context.repository)/$Path".TrimEnd('/'); Method = $Method; Headers = $Context.headers; TimeoutSec = 120; MaximumRedirection = 0; ErrorAction = 'Stop' }
    if ($Context.proxy) { $request.Proxy = $Context.proxy }
    if ($AssetFile) { $request.InFile = $AssetFile; $request.ContentType = 'application/octet-stream' }
    elseif ($null -ne $Body) { $request.ContentType = 'application/json; charset=utf-8'; $request.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20)) }
    try { return Invoke-RestMethod @request }
    catch {
        $response = $_.Exception.PSObject.Properties['Response']
        $code = if ($response -and $response.Value) { [int]$response.Value.StatusCode } else { 0 }
        if ($AllowNotFound -and $code -eq 404) { return $null }
        throw "GitHub $Method request failed (HTTP $code). Check access/network; an interrupted upload can be resumed."
    }
}

function Get-ReleaseByTag {
    param($Context, [string]$Tag)
    $release = Invoke-ReleaseApi -Context $Context -Path "releases/tags/$([Uri]::EscapeDataString($Tag))" -AllowNotFound
    if ($release) { return $release }
    # Drafts are not always returned by the tag endpoint.
    for ($page = 1; $page -le 100; $page++) {
        $releases = @(Invoke-ReleaseApi -Context $Context -Path "releases?per_page=100&page=$page")
        $match = @($releases | Where-Object { $_.tag_name -eq $Tag })
        if ($match.Count -gt 1) { throw 'Multiple releases use this tag; resolve them on GitHub first.' }
        if ($match.Count -eq 1) { return $match[0] }
        if ($releases.Count -lt 100) { return $null }
    }
    throw 'Release listing exceeded the supported page count.'
}

function Get-ReleaseTagCommit {
    param($Context, [string]$Tag)
    $ref = Invoke-ReleaseApi -Context $Context -Path "git/ref/tags/$([Uri]::EscapeDataString($Tag))" -AllowNotFound
    if (-not $ref) { return '' }
    $target = $ref.object
    for ($depth = 0; $depth -lt 5 -and $target.type -eq 'tag'; $depth++) {
        $target = (Invoke-ReleaseApi -Context $Context -Path "git/tags/$($target.sha)").object
    }
    if ($target.type -ne 'commit') { throw 'Release tag does not resolve to a commit.' }
    return [string]$target.sha
}

function Assert-ReleaseAssetSet {
    param([string]$Root, [string]$Version, $Assets)
    Assert-ReleaseVersion $Version
    $expected = @("tabagent-$Version-chrome.zip", "tabagent-$Version-edge.zip", "tabagent-$Version-firefox.zip", 'INSTALL.txt', 'SHA256SUMS.txt')
    if (@($Assets).Count -ne 5 -or @(Compare-Object $expected @($Assets.name)).Count -ne 0) { throw 'Expected exactly three browser ZIPs, INSTALL.txt and SHA256SUMS.txt.' }
    $output = [IO.Path]::GetFullPath((Join-Path $Root '.output')) + [IO.Path]::DirectorySeparatorChar
    foreach ($asset in $Assets) {
        $file = [IO.Path]::GetFullPath($asset.path)
        if (-not $file.StartsWith($output, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($file) -cne $asset.name) { throw 'Release asset path is outside the build output.' }
        $item = Get-Item -LiteralPath $file -ErrorAction Stop
        $cursor = $item
        while ($cursor -and $cursor.FullName.StartsWith($output.TrimEnd([IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
            if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release assets cannot use symlinks or junctions.' }
            $cursor = if ($cursor -is [IO.DirectoryInfo]) { $cursor.Parent } else { $cursor.Directory }
        }
        if ($item.PSIsContainer -or $asset.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $item.Length -ne $asset.size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $asset.sha256) { throw 'Release asset does not match its checksum.' }
    }
}

function Assert-RemoteReleaseAssets {
    param($RemoteAssets, $Assets)
    if (@($RemoteAssets).Count -ne @($Assets).Count) { throw 'Remote release has missing or unexpected attachments.' }
    foreach ($asset in $Assets) {
        $remote = @($RemoteAssets | Where-Object { $_.name -ceq $asset.name })
        if ($remote.Count -ne 1 -or $remote[0].state -ne 'uploaded' -or $remote[0].size -ne $asset.size -or $remote[0].digest -ne "sha256:$($asset.sha256)") { throw "Remote checksum mismatch: $($asset.name)" }
    }
}

function Assert-ReleaseDraft {
    param($Draft, [string]$Tag, [string]$Commit, [switch]$Stable)
    if (-not $Draft.draft -or $Draft.tag_name -ne $Tag) { throw 'Release is no longer the expected draft; no further changes were made.' }
    if ($Draft.target_commitish -ne $Commit) { throw 'Draft source commit changed.' }
    if ([bool]$Draft.prerelease -eq [bool]$Stable) { throw 'Draft stability differs; resume with the same -Stable option.' }
}

function Publish-ReleaseAssets {
    param($Context, [string]$Root, [string]$Version, [string]$Commit, $Assets, [string]$Notes, [switch]$Stable, [switch]$Resume)
    Assert-ReleaseAssetSet -Root $Root -Version $Version -Assets $Assets
    $tag = "v$Version"
    if ((Get-ReleaseTagCommit $Context $tag) -ne $Commit) { throw 'Remote tag does not match the packaged commit.' }
    $release = Get-ReleaseByTag $Context $tag
    if ($release -and -not $release.draft) { throw 'This version is already published. Use a new version; published assets are never overwritten.' }
    if ($release -and -not $Resume) { throw 'An existing draft was found. Use -Resume for the same commit.' }
    if ($release -and $release.target_commitish -ne $Commit) { throw 'Draft source commit differs from the packaged commit.' }
    if ($release -and [bool]$release.prerelease -eq [bool]$Stable) { throw 'Draft stability differs; resume with the same -Stable option.' }
    if (-not $release) {
        $title = "TabAgent $tag"; if (-not $Stable) { $title += ' Preview' }
        $release = Invoke-ReleaseApi -Context $Context -Method Post -Path 'releases' -Body @{ tag_name = $tag; target_commitish = $Commit; name = $title; body = $Notes; draft = $true; prerelease = -not [bool]$Stable }
    }
    Assert-ReleaseDraft -Draft $release -Tag $tag -Commit $Commit -Stable:$Stable
    $remoteAssets = @(Invoke-ReleaseApi -Context $Context -Path "releases/$($release.id)/assets?per_page=100")
    if (@($remoteAssets | Where-Object { $_.name -cnotin $Assets.name }).Count) { throw 'Draft contains unexpected attachments; nothing was overwritten.' }
    foreach ($asset in $Assets) {
        $existing = @($remoteAssets | Where-Object { $_.name -ceq $asset.name })
        if ($existing.Count -gt 1) { throw 'Draft has duplicate attachment names.' }
        if ($existing.Count -eq 1) {
            if ($existing[0].state -eq 'starter') {
                # GitHub can leave an empty draft asset after a failed upload.
                Assert-ReleaseDraft -Draft (Invoke-ReleaseApi -Context $Context -Path "releases/$($release.id)") -Tag $tag -Commit $Commit -Stable:$Stable
                Invoke-ReleaseApi -Context $Context -Method Delete -Path "releases/assets/$($existing[0].id)" | Out-Null
            } else {
                Assert-RemoteReleaseAssets -RemoteAssets $existing -Assets @($asset)
                Write-Host "Already uploaded: $($asset.name)"
                continue
            }
        }
        Write-Host "Uploading: $($asset.name)"
        Assert-ReleaseDraft -Draft (Invoke-ReleaseApi -Context $Context -Path "releases/$($release.id)") -Tag $tag -Commit $Commit -Stable:$Stable
        $uploaded = Invoke-ReleaseApi -Context $Context -Method Post -Upload -Path "releases/$($release.id)/assets?name=$([Uri]::EscapeDataString($asset.name))" -AssetFile $asset.path
        Assert-RemoteReleaseAssets -RemoteAssets @($uploaded) -Assets @($asset)
    }
    $draft = Invoke-ReleaseApi -Context $Context -Path "releases/$($release.id)"
    Assert-ReleaseDraft -Draft $draft -Tag $tag -Commit $Commit -Stable:$Stable
    Assert-RemoteReleaseAssets -RemoteAssets $draft.assets -Assets $Assets
    if ((Get-ReleaseTagCommit $Context $tag) -ne $Commit) { throw 'Tag changed while uploading; draft was not published.' }
    $latest = if ($Stable) { 'true' } else { 'false' }
    Invoke-ReleaseApi -Context $Context -Method Patch -Path "releases/$($release.id)" -Body @{ draft = $false; prerelease = -not [bool]$Stable; make_latest = $latest } | Out-Null
    $published = Invoke-ReleaseApi -Context $Context -Path "releases/$($release.id)"
    if ($published.draft) { throw 'Release is still a draft.' }
    if ($published.tag_name -ne $tag -or $published.target_commitish -ne $Commit -or [bool]$published.prerelease -eq [bool]$Stable) { throw 'Published release metadata changed; check GitHub before retrying.' }
    Assert-RemoteReleaseAssets -RemoteAssets $published.assets -Assets $Assets
    return $published
}
