param([string]$RepositoryRoot, [string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# Unexpected network or Git calls fail closed, even if production code changes.
function Invoke-RestMethod { throw 'Test attempted a real HTTP request.' }
function Invoke-WebRequest { throw 'Test attempted a real HTTP request.' }
function git { throw 'Test attempted a real Git or credential request.' }
. (Join-Path $RepositoryRoot 'scripts/release-core.ps1')

$script:Checks = 0
function Check([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
    $script:Checks++
}
function Throws([scriptblock]$Action, [string]$Message) {
    $thrown = $false
    try { & $Action | Out-Null } catch { $thrown = $true }
    Check $thrown $Message
}
function Case([string]$Name, [scriptblock]$Action) {
    try { & $Action; Write-Host "PASS $Name" } catch { throw "${Name}: $($_.Exception.Message)" }
}

$script:Version = '0.1.1'
$script:Commit = 'a' * 40
$script:OtherCommit = 'b' * 40
$script:Context = [pscustomobject]@{ repository = 'fixture/TabAgent'; proxy = ''; headers = @{ Authorization = 'Bearer fixture-token-never-real' } }
$artifactRoot = Join-Path $FixtureRoot '.output/releases/0.1.1'
[IO.Directory]::CreateDirectory($artifactRoot) | Out-Null
$script:Assets = @()
foreach ($name in @('tabagent-0.1.1-chrome.zip', 'tabagent-0.1.1-edge.zip', 'tabagent-0.1.1-firefox.zip', 'INSTALL.txt', 'SHA256SUMS.txt')) {
    $file = Join-Path $artifactRoot $name
    [IO.File]::WriteAllText($file, "Release-state-machine fixture: $name", [Text.UTF8Encoding]::new($false))
    $script:Assets += [pscustomobject]@{ name = $name; path = $file; size = (Get-Item -LiteralPath $file).Length; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}
function Clone-Assets { return ($script:Assets | ConvertTo-Json -Depth 8 | ConvertFrom-Json) }

Case 'version format, Chrome limits and monotonic upgrade' {
    Assert-ReleaseVersion -Version '0.1.1' -CurrentVersion '0.1.0'
    Assert-ReleaseVersion -Version '1.0.0' -CurrentVersion '0.99.65535'
    Assert-ReleaseVersion -Version '0.1.1' -CurrentVersion '0.1.1'
    foreach ($invalid in @('', 'v0.1.1', '0.01.1', '0.1.1-beta', '0.1', '0.1.1.1', '0.0.0', '65536.1.1', '0.1.1;echo secret', '999999999999999999999.1.1')) {
        Throws { Assert-ReleaseVersion -Version $invalid } "reject invalid version: $invalid"
    }
    Throws { Assert-ReleaseVersion -Version '0.1.0' -CurrentVersion '0.1.1' } 'reject downgrade'
}
Case 'origin identity accepts GitHub only, without embedded credentials' {
    foreach ($origin in @('https://github.com/fixture/TabAgent.git', 'https://github.com/fixture/TabAgent', 'git@github.com:fixture/TabAgent.git', 'ssh://git@github.com/fixture/TabAgent.git')) {
        Check ((Get-ReleaseRepository -Origin $origin) -ceq 'fixture/TabAgent') 'normalize supported GitHub origins'
    }
    foreach ($origin in @('https://github.com.evil.invalid/fixture/TabAgent', 'https://evil.invalid/fixture/TabAgent', 'https://secret@github.com/fixture/TabAgent', 'https://github.com/fixture/TabAgent?secret=value', 'https://github.com/fixture/TabAgent#secret', 'http://github.com/fixture/TabAgent', 'https://github.com/fixture/..', 'git@evil.invalid:fixture/TabAgent.git')) {
        Throws { Get-ReleaseRepository -Origin $origin } 'reject hostile or credential-bearing origin'
    }
}
Case 'API transport fixes host, blocks redirect and redacts failure messages' {
    $script:Request = $null
    function Invoke-RestMethod { $script:Request = $args; return [pscustomobject]@{ ok = $true } }
    Invoke-ReleaseApi -Context $script:Context -Path 'releases' | Out-Null
    # PowerShell passes splatted named parameters to the function via $args.
    $flat = $script:Request -join '|'
    Check ($flat.Contains('https://api.github.com/repos/fixture/TabAgent/releases')) 'fixed API host'
    Check ($flat.Contains('-MaximumRedirection:|0')) 'credentials cannot follow a redirect'
    Invoke-ReleaseApi -Context $script:Context -Method Post -Upload -Path 'releases/41/assets?name=fixture.zip' -AssetFile $script:Assets[0].path | Out-Null
    $flat = $script:Request -join '|'
    Check ($flat.Contains('https://uploads.github.com/repos/fixture/TabAgent/releases/41/assets?name=fixture.zip')) 'fixed upload host'
    Check ($flat.Contains('-MaximumRedirection:|0')) 'uploads cannot redirect credentials'
    foreach ($route in @('https://evil.invalid/', '//evil.invalid/', '../other', 'git/../other')) {
        $script:Request = $null
        Throws { Invoke-ReleaseApi -Context $script:Context -Path $route } 'reject arbitrary API destination'
        Check ($null -eq $script:Request) 'invalid route never reaches HTTP transport'
    }
    function Invoke-RestMethod { throw 'transport exposes fixture-token-never-real' }
    $message = ''
    try { Invoke-ReleaseApi -Context $script:Context -Path 'releases' } catch { $message = $_.Exception.Message }
    Check ($message -and -not $message.Contains('fixture-token-never-real')) 'HTTP failure hides authentication values'
    Check ($message -like 'GitHub Get request failed (HTTP 0)*') 'transport exception without HTTP response is handled safely'
    $script:HttpFailure = [Exception]::new('HTTP detail may contain fixture-token-never-real')
    Add-Member -InputObject $script:HttpFailure -NotePropertyName Response -NotePropertyValue ([pscustomobject]@{ StatusCode = 404 })
    function Invoke-RestMethod { throw $script:HttpFailure }
    Check ($null -eq (Invoke-ReleaseApi -Context $script:Context -Path 'releases/tags/missing' -AllowNotFound)) 'explicit not-found lookup returns null'
    Throws { Invoke-ReleaseApi -Context $script:Context -Path 'releases/tags/missing' } 'ordinary 404 is not silently ignored'
    $script:HttpFailure.Response.StatusCode = 403
    Throws { Invoke-ReleaseApi -Context $script:Context -Path 'releases/tags/missing' -AllowNotFound } 'authorization errors cannot be treated as not-found'
}
Case 'local assets are exact, untampered and contained in output' {
    Assert-ReleaseAssetSet -Root $FixtureRoot -Version $script:Version -Assets $script:Assets
    $copy = @(Clone-Assets); $copy[0].sha256 = '0' * 64
    Throws { Assert-ReleaseAssetSet -Root $FixtureRoot -Version $script:Version -Assets $copy } 'reject corrupted checksum'
    $copy = @(Clone-Assets); $copy[0].size++
    Throws { Assert-ReleaseAssetSet -Root $FixtureRoot -Version $script:Version -Assets $copy } 'reject corrupted size'
    $copy = @(Clone-Assets); $copy[0].name = $copy[1].name
    Throws { Assert-ReleaseAssetSet -Root $FixtureRoot -Version $script:Version -Assets $copy } 'reject duplicate names'
    $sibling = Join-Path $FixtureRoot '.output-private'
    [IO.Directory]::CreateDirectory($sibling) | Out-Null
    $outside = Join-Path $sibling $script:Assets[0].name
    [IO.File]::Copy($script:Assets[0].path, $outside)
    $copy = @(Clone-Assets); $copy[0].path = $outside
    Throws { Assert-ReleaseAssetSet -Root $FixtureRoot -Version $script:Version -Assets $copy } 'same-prefix sibling is outside output'
    $copy[0].path = Join-Path $artifactRoot '../../../.output-private/tabagent-0.1.1-chrome.zip'
    Throws { Assert-ReleaseAssetSet -Root $FixtureRoot -Version $script:Version -Assets $copy } 'normalized traversal is rejected'
    $junction = Join-Path $FixtureRoot '.output/linked'
    New-Item -ItemType Junction -Path $junction -Value $sibling | Out-Null
    $copy[0].path = Join-Path $junction $script:Assets[0].name
    Throws { Assert-ReleaseAssetSet -Root $FixtureRoot -Version $script:Version -Assets $copy } 'junction cannot escape output containment'
}

function New-RemoteAsset($Asset, [long]$Id = 100) {
    return [pscustomobject]@{ id = $Id; name = $Asset.name; size = $Asset.size; digest = "sha256:$($Asset.sha256)"; state = 'uploaded'; browser_download_url = "https://github.com/fixture/TabAgent/releases/download/v0.1.1/$($Asset.name)" }
}
function New-Draft {
    return [pscustomobject]@{ id = 41; tag_name = "v$script:Version"; target_commitish = $script:Commit; draft = $true; prerelease = $true; assets = @(); html_url = 'https://github.com/fixture/TabAgent/releases/tag/v0.1.1' }
}
function Reset-State {
    $script:State = @{ release = $null; events = [Collections.Generic.List[object]]::new(); tagCommit = $script:Commit; annotated = $false; hideDraft = $false; failUploadAt = 0; uploads = 0; publishAfterUpload = 0; sourceChangeAfterUpload = 0; stabilityChangeAfterUpload = 0; tagChangeAfterUpload = 0; missingAfterUpload = 0; corruptUploadAt = 0; publishOnAssetList = $false; stableRequested = $null }
}
function Invoke-ReleaseApi {
    param($Context, [string]$Method = 'Get', [string]$Path, $Body, [string]$AssetFile, [switch]$Upload, [switch]$AllowNotFound)
    $script:State.events.Add([pscustomobject]@{ method = $Method; path = $Path; upload = [bool]$Upload })
    if ($Path -eq "git/ref/tags/v$script:Version") {
        $kind = if ($script:State.annotated) { 'tag' } else { 'commit' }
        return [pscustomobject]@{ object = [pscustomobject]@{ type = $kind; sha = $script:State.tagCommit } }
    }
    if ($Path.StartsWith('git/tags/')) { return [pscustomobject]@{ object = [pscustomobject]@{ type = 'commit'; sha = $script:State.tagCommit } } }
    if ($Path -eq "releases/tags/v$script:Version") { if ($script:State.hideDraft) { return $null }; return $script:State.release }
    if ($Path.StartsWith('releases?')) { if ($script:State.release) { return @($script:State.release) }; return @() }
    if ($Path -eq 'releases' -and $Method -eq 'Post') {
        Check ($Body.draft -and $Body.target_commitish -eq $script:Commit -and $Body.tag_name -eq "v$script:Version") 'creation is a draft at exact source'
        $script:State.release = New-Draft
        $script:State.release.prerelease = $Body.prerelease
        return $script:State.release
    }
    if ($Path -eq 'releases/41/assets?per_page=100') {
        if ($script:State.publishOnAssetList) { $script:State.release.draft = $false }
        return @($script:State.release.assets)
    }
    if ($Method -eq 'Delete' -and $Path.StartsWith('releases/assets/')) {
        $id = [long]($Path.Split('/')[-1])
        $script:State.release.assets = @($script:State.release.assets | Where-Object { $_.id -ne $id })
        return $null
    }
    if ($Method -eq 'Post' -and $Upload) {
        $script:State.uploads++
        if ($script:State.uploads -eq $script:State.failUploadAt) { throw 'Simulated upload interruption.' }
        $local = @($script:Assets | Where-Object { $_.path -eq $AssetFile })
        Check ($local.Count -eq 1) 'only reviewed local attachment is uploaded'
        $remote = New-RemoteAsset $local[0] (100 + $script:State.uploads)
        $script:State.release.assets += $remote
        if ($script:State.uploads -eq $script:State.publishAfterUpload) { $script:State.release.draft = $false }
        if ($script:State.uploads -eq $script:State.sourceChangeAfterUpload) { $script:State.release.target_commitish = $script:OtherCommit }
        if ($script:State.uploads -eq $script:State.stabilityChangeAfterUpload) { $script:State.release.prerelease = -not $script:State.release.prerelease }
        if ($script:State.uploads -eq $script:State.tagChangeAfterUpload) { $script:State.tagCommit = $script:OtherCommit }
        if ($script:State.uploads -eq $script:State.missingAfterUpload) { $script:State.release.assets = @($script:State.release.assets | Select-Object -Skip 1) }
        if ($script:State.uploads -eq $script:State.corruptUploadAt) { $remote.digest = 'sha256:' + ('0' * 64) }
        return $remote
    }
    if ($Path -eq 'releases/41' -and $Method -eq 'Patch') {
        Check (@($script:State.release.assets).Count -eq 5) 'all attachments precede publication'
        Assert-RemoteReleaseAssets -RemoteAssets $script:State.release.assets -Assets $script:Assets
        $script:State.release.draft = $Body.draft
        $script:State.release.prerelease = $Body.prerelease
        $script:State.stableRequested = $Body.make_latest
        return $script:State.release
    }
    if ($Path -eq 'releases/41') { return $script:State.release }
    throw "Unexpected fake API request: $Method $Path"
}
function Publish-Fixture([switch]$Resume, [switch]$Stable) {
    return Publish-ReleaseAssets -Context $script:Context -Root $FixtureRoot -Version $script:Version -Commit $script:Commit -Assets $script:Assets -Notes 'Fixture release notes' -Resume:$Resume -Stable:$Stable
}
function Mutations { return ,@($script:State.events | Where-Object { $_.method -ne 'Get' }) }
function Publish-Count { return @($script:State.events | Where-Object { $_.method -eq 'Patch' }).Count }

Case 'first publication verifies all attachments before promoting the draft' {
    Reset-State
    $script:State.annotated = $true
    $published = Publish-Fixture
    Check (-not $published.draft -and $published.prerelease) 'default release is preview'
    Check ($script:State.uploads -eq 5 -and (Publish-Count) -eq 1) 'all attachments uploaded exactly once'
    Check ($script:State.stableRequested -eq 'false') 'preview cannot become latest stable'
}
Case 'stable mode is explicit' {
    Reset-State
    $published = Publish-Fixture -Stable
    Check (-not $published.prerelease -and $script:State.stableRequested -eq 'true') 'stable is explicitly marked latest'
}
Case 'published versions and wrong source tags are immutable' {
    Reset-State; $script:State.release = New-Draft; $script:State.release.draft = $false
    Throws { Publish-Fixture -Resume } 'published release is refused even with resume'
    Check ((Mutations).Count -eq 0) 'published release untouched'
    Reset-State; $script:State.tagCommit = $script:OtherCommit
    Throws { Publish-Fixture } 'wrong source tag refused'
    Check ((Mutations).Count -eq 0) 'wrong source tag produces no mutation'
}
Case 'only an explicit same-source same-stability draft can resume' {
    Reset-State; $script:State.release = New-Draft
    Throws { Publish-Fixture } 'existing draft requires resume'
    Check ((Mutations).Count -eq 0) 'draft untouched without resume'
    foreach ($target in @($script:OtherCommit, 'main')) {
        $script:State.release.target_commitish = $target
        Throws { Publish-Fixture -Resume } 'mismatched or unpinned draft source refused'
        Check ((Mutations).Count -eq 0) 'wrong draft source untouched'
    }
    Reset-State; $script:State.release = New-Draft
    Throws { Publish-Fixture -Resume -Stable } 'stability change refused during resume'
}
Case 'resume finds drafts, keeps matching assets, cleans only partial starter assets' {
    Reset-State; $script:State.release = New-Draft; $script:State.hideDraft = $true
    $complete = New-RemoteAsset $script:Assets[0] 77
    $starter = New-RemoteAsset $script:Assets[1] 78; $starter.state = 'starter'; $starter.size = 0; $starter.digest = ''
    $script:State.release.assets = @($complete, $starter)
    Publish-Fixture -Resume | Out-Null
    Check ($script:State.uploads -eq 4) 'verified existing attachment was not reuploaded'
    $deletes = @($script:State.events | Where-Object { $_.method -eq 'Delete' })
    Check ($deletes.Count -eq 1 -and $deletes[0].path -eq 'releases/assets/78') 'only partial draft attachment is deleted'
}
Case 'mismatched and unexpected remote attachments stop before mutation' {
    Reset-State; $script:State.release = New-Draft
    $wrong = New-RemoteAsset $script:Assets[0]; $wrong.digest = 'sha256:' + ('0' * 64)
    $script:State.release.assets = @($wrong)
    Throws { Publish-Fixture -Resume } 'remote checksum mismatch refuses overwrite'
    Check ((Mutations).Count -eq 0) 'mismatched attachment untouched'
    Reset-State; $script:State.release = New-Draft
    $extra = New-RemoteAsset $script:Assets[0]; $extra.name = 'unrelated.zip'
    $script:State.release.assets = @($extra)
    Throws { Publish-Fixture -Resume } 'unexpected attachment refused'
    Check ((Mutations).Count -eq 0) 'unrelated attachment untouched'
    Reset-State; $script:State.release = New-Draft
    $script:State.release.assets = @((New-RemoteAsset $script:Assets[0] 77), (New-RemoteAsset $script:Assets[0] 78))
    Throws { Publish-Fixture -Resume } 'duplicate remote attachments refused'
    Check ((Mutations).Count -eq 0) 'duplicate attachments untouched'
}
Case 'interrupted uploads keep a resumable draft and never publish' {
    Reset-State; $script:State.failUploadAt = 2
    Throws { Publish-Fixture } 'simulated upload fails'
    Check ($script:State.release.draft -and (Publish-Count) -eq 0) 'failure leaves draft unpublished'
    Check (@($script:State.release.assets).Count -eq 1) 'successfully uploaded asset is retained'
    $script:State.failUploadAt = 0
    Publish-Fixture -Resume | Out-Null
    Check (-not $script:State.release.draft -and (Publish-Count) -eq 1) 'retry resumes and publishes'
}
Case 'concurrent draft publication or source edits stop the next upload' {
    foreach ($flag in @('publishAfterUpload', 'sourceChangeAfterUpload', 'stabilityChangeAfterUpload')) {
        Reset-State; $script:State[$flag] = 1
        Throws { Publish-Fixture } 'concurrent draft change refused'
        Check ($script:State.uploads -eq 1 -and (Publish-Count) -eq 0) 'no follow-up write after observed draft change'
    }
}
Case 'a starter attachment is never deleted after concurrent publication' {
    Reset-State; $script:State.release = New-Draft; $script:State.publishOnAssetList = $true
    $starter = New-RemoteAsset $script:Assets[0] 78; $starter.state = 'starter'; $starter.size = 0; $starter.digest = ''
    $script:State.release.assets = @($starter)
    Throws { Publish-Fixture -Resume } 'concurrent publication blocks starter cleanup'
    Check ((Mutations).Count -eq 0) 'no DELETE or POST touches the now-published release'
}
Case 'a corrupt upload response stops immediately and cannot publish' {
    Reset-State; $script:State.corruptUploadAt = 1
    Throws { Publish-Fixture } 'upload digest is checked immediately'
    Check ($script:State.uploads -eq 1 -and (Publish-Count) -eq 0 -and $script:State.release.draft) 'no further upload or publication follows corrupted data'
}
Case 'missing attachments and moved tags block final publication' {
    Reset-State; $script:State.missingAfterUpload = 5
    Throws { Publish-Fixture } 'missing remote asset refused'
    Check ((Publish-Count) -eq 0) 'no publish with missing attachments'
    Reset-State; $script:State.tagChangeAfterUpload = 5
    Throws { Publish-Fixture } 'tag moved during upload refused'
    Check ((Publish-Count) -eq 0) 'no publish against moved tag'
}

Write-Host "Release workflow checks passed ($script:Checks assertions; no real GitHub, credentials, or builds)."
