# Build and inspect release packages. Compatible with Windows PowerShell 5.1+.
# Dot-source this file; it does not run a build or publish anything on import.

function Assert-ReleaseBuildPath {
    param([string]$Path, [string]$Boundary, [switch]$AllowEqual)
    $full = [System.IO.Path]::GetFullPath($Path)
    $base = [System.IO.Path]::GetFullPath($Boundary).TrimEnd([char[]]@('\', '/'))
    $equal = $full.TrimEnd([char[]]@('\', '/')).Equals($base, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not ($AllowEqual -and $equal) -and -not $full.StartsWith($base + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release output must stay inside its expected directory.'
    }
    $cursor = $full
    while ($cursor.Length -ge $base.Length) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Release paths must not contain symbolic links or junctions.'
            }
        }
        if ($cursor.Equals($base, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = [System.IO.Path]::GetDirectoryName($cursor)
        if (-not $cursor) { break }
    }
    return $full
}

function Get-ReleaseBuildFiles {
    param([string]$Directory)
    $queue = [System.Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($Directory)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        foreach ($item in @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Compiled output must not contain symbolic links or junctions.'
            }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
            else { Write-Output $item }
        }
    }
}

function Get-ReleaseBuildCommands {
    param([string]$Script, [object]$Scripts, [string[]]$Stack = @())
    if ($Stack.Count -gt 16 -or [string]::IsNullOrWhiteSpace($Script)) { throw 'Invalid or recursive package test script.' }
    foreach ($commandPart in ($Script -split '\s*&&\s*')) {
        $command = $commandPart.Trim()
        if ($command -match '^npm run ([a-zA-Z0-9:_-]+)$') {
            $name = $Matches[1]
            $property = $Scripts.PSObject.Properties[$name]
            if (-not $property -or $Stack -contains $name) { throw "Missing or recursive npm script: $name" }
            Get-ReleaseBuildCommands -Script $property.Value -Scripts $Scripts -Stack @($Stack + $name)
        } elseif ($command -eq 'tsc --noEmit' -or $command -eq 'wxt build' -or $command -match '^node tests/[a-z0-9-]+\.mjs$') {
            Write-Output $command
        } else {
            throw "Unsupported release check: $command. Update the release check allowlist before publishing."
        }
    }
}

function Invoke-ReleaseBuildNode {
    param([string]$NodePath, [string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    try {
        # PS 5.1 treats redirected native stderr as ErrorRecord objects. Preserve
        # the native exit code without turning harmless compiler warnings fatal.
        $ErrorActionPreference = 'Continue'
        & $NodePath @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($code -ne 0) { throw "Release command failed (exit $code): node $($Arguments -join ' ')" }
}

function Get-ReleaseBuildStreamHash {
    param([System.IO.Stream]$Stream)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Get-ReleaseBuildAsset {
    param([string]$Path)
    $file = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($file.PSIsContainer -or ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Release assets must be regular files.' }
    return [pscustomobject]@{
        name = $file.Name
        path = $file.FullName
        size = [long]$file.Length
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    }
}

function Test-ReleaseBuildArchive {
    param([string]$ArchivePath, [string]$BuildDirectory, [string]$Version, [string]$Browser)
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    $buildRoot = [System.IO.Path]::GetFullPath($BuildDirectory).TrimEnd([char[]]@('\', '/'))
    $expected = [System.Collections.Generic.Dictionary[string, System.IO.FileInfo]]::new([System.StringComparer]::Ordinal)
    foreach ($file in @(Get-ReleaseBuildFiles -Directory $buildRoot)) {
        $name = $file.FullName.Substring($buildRoot.Length + 1).Replace('\', '/')
        $expected.Add($name, $file)
    }
    if ($expected.Count -eq 0) { throw "No compiled files found for $Browser." }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            $parts = $name.TrimEnd('/').Split('/')
            if (-not $name -or $name.StartsWith('/') -or $name.Contains('\') -or $name.Contains(':') -or $parts -contains '..' -or $parts -contains '.' -or $parts -contains '') {
                throw "Unsafe ZIP entry in $Browser package."
            }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'ZIP entries must not be symbolic links.' }
            foreach ($part in $parts) {
                if ($part -in @('.git', 'node_modules', 'tests', 'scripts', 'unslop') -or $part.StartsWith('.env', [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw 'Development or environment files must not be shipped in extension packages.'
                }
            }
            if ($name -match '\.(map|log|ps1|cmd|bat|py|ts|tsx|pem|key)$') { throw 'Unexpected development file in extension package.' }
            if ($name.EndsWith('/')) { continue }
            if (-not $seen.Add($name)) { throw 'Duplicate ZIP entry.' }
            if (-not $expected.ContainsKey($name)) { throw "Unexpected file in $Browser package: $name" }
            if ($entry.Length -ne $expected[$name].Length) { throw "ZIP size differs from compiled output: $name" }
            $stream = $entry.Open()
            try { $zipHash = Get-ReleaseBuildStreamHash -Stream $stream }
            finally { $stream.Dispose() }
            $fileHash = (Get-FileHash -LiteralPath $expected[$name].FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
            if ($zipHash -ne $fileHash) { throw "ZIP content differs from compiled output: $name" }
        }
        if ($seen.Count -ne $expected.Count) { throw "Missing compiled files in $Browser package." }
        foreach ($required in @('manifest.json', 'options.html', 'sidepanel.html', 'pdf-reader.html', 'background.js', 'content-scripts/content.js', 'icon.svg', 'pdfjs/pdf.worker.mjs', 'pdfjs/LICENSE', 'pdfjs/standard_fonts/LICENSE_FOXIT', 'pdfjs/standard_fonts/LICENSE_LIBERATION')) {
            if (-not $seen.Contains($required)) { throw "Required release file missing: $required" }
        }
        foreach ($pattern in @('pdfjs/cmaps/*', 'chunks/*.js', 'assets/*.css')) {
            if (@($seen | Where-Object { $_ -like $pattern }).Count -eq 0) { throw "Required bundled resources missing: $pattern" }
        }
        $reader = [System.IO.StreamReader]::new($archive.GetEntry('manifest.json').Open(), [System.Text.Encoding]::UTF8)
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop }
        finally { $reader.Dispose() }
        $manifestVersion = if ($Browser -eq 'firefox') { 2 } else { 3 }
        if ($manifest.name -ne 'TabAgent' -or $manifest.version -ne $Version -or $manifest.manifest_version -ne $manifestVersion) {
            throw "Wrong name/version/manifest version in $Browser package."
        }
        if (-not $manifest.icons) { throw 'Extension icons are missing from the manifest.' }
        foreach ($icon in $manifest.icons.PSObject.Properties) {
            if (-not $seen.Contains([string]$icon.Value)) { throw 'An icon referenced by the manifest is missing.' }
        }
        Write-Host ("[release] Verified {0}: {1} compiled files" -f $Browser, $seen.Count)
    } finally { $archive.Dispose() }
}

function Test-ReleaseAssets {
    param([Parameter(Mandatory = $true)][object[]]$Assets, [string]$Directory)
    if ($Assets.Count -eq 0) { throw 'Release assets are missing.' }
    $names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($asset in $Assets) {
        if (-not $asset.name -or -not $asset.path -or $asset.sha256 -notmatch '^[a-f0-9]{64}$' -or $asset.size -lt 0 -or -not [System.IO.Path]::IsPathRooted([string]$asset.path)) {
            throw 'Invalid release asset metadata.'
        }
        if (-not $names.Add([string]$asset.name) -or [System.IO.Path]::GetFileName([string]$asset.path) -cne [string]$asset.name) { throw 'Duplicate or mismatched release asset name.' }
        if ($Directory) {
            $full = Assert-ReleaseBuildPath -Path $asset.path -Boundary $Directory
            if ([System.IO.Path]::GetDirectoryName($full) -ne [System.IO.Path]::GetFullPath($Directory).TrimEnd([char[]]@('\', '/'))) { throw 'Release assets must be direct children of the package directory.' }
        }
        $actual = Get-ReleaseBuildAsset -Path $asset.path
        if ($actual.size -ne $asset.size -or $actual.sha256 -ne $asset.sha256) { throw "Release asset changed or is incomplete: $($asset.name)" }
    }
    return $true
}

function Invoke-ReleaseBuild {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$OutputDir,
        [switch]$Quick
    )
    $ErrorActionPreference = 'Stop'
    if (-not [System.IO.Path]::IsPathRooted($Root) -or -not [System.IO.Path]::IsPathRooted($OutputDir)) { throw 'Root and OutputDir must be absolute paths.' }
    if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Release version must be X.Y.Z.' }
    foreach ($number in $Version.Split('.')) { if ([decimal]$number -gt 65535) { throw 'Each extension version component must be at most 65535.' } }
    $projectRoot = (Get-Item -LiteralPath $Root -Force).FullName
    $outputRoot = Assert-ReleaseBuildPath -Path (Join-Path $projectRoot '.output') -Boundary $projectRoot
    $destination = Assert-ReleaseBuildPath -Path $OutputDir -Boundary $outputRoot
    if (-not [System.IO.Path]::IsPathRooted($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'An absolute Node.js executable path is required.' }
    $package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($package.name -ne 'tabagent' -or $package.version -ne $Version) { throw 'Requested version must match package.json before building.' }
    if ($Quick) { $commands = @('tsc --noEmit', 'node tests/service-settings-unit.mjs', 'node tests/model-catalog-unit.mjs', 'node tests/connection-library-unit.mjs') }
    else { $commands = @(Get-ReleaseBuildCommands -Script $package.scripts.test -Scripts $package.scripts -Stack @('test')) }
    $oldPath = $env:PATH
    Push-Location -LiteralPath $projectRoot
    try {
        $env:PATH = (Split-Path -Parent $NodePath) + [System.IO.Path]::PathSeparator + $oldPath
        for ($index = 0; $index -lt $commands.Count; $index++) {
            $command = $commands[$index]
            Write-Host ("[release] Check {0}/{1}: {2}" -f ($index + 1), $commands.Count, $command)
            if ($command -eq 'tsc --noEmit') { $arguments = @('node_modules/typescript/bin/tsc', '--noEmit') }
            elseif ($command -eq 'wxt build') { $arguments = @('node_modules/wxt/bin/wxt.mjs', 'build', '--level', 'warn') }
            else { $arguments = @($command.Substring(5)) }
            Invoke-ReleaseBuildNode -NodePath $NodePath -Arguments $arguments
        }
        $sources = @()
        foreach ($browser in @('chrome', 'edge', 'firefox')) {
            Write-Host "[release] Build and package $browser"
            Invoke-ReleaseBuildNode -NodePath $NodePath -Arguments @('node_modules/wxt/bin/wxt.mjs', 'zip', '-b', $browser, '--level', 'warn')
            $manifestKind = if ($browser -eq 'firefox') { 'mv2' } else { 'mv3' }
            $buildDirectory = Assert-ReleaseBuildPath -Path (Join-Path $outputRoot "$browser-$manifestKind") -Boundary $outputRoot
            $archivePath = Assert-ReleaseBuildPath -Path (Join-Path $outputRoot "tabagent-$Version-$browser.zip") -Boundary $outputRoot
            Test-ReleaseBuildArchive -ArchivePath $archivePath -BuildDirectory $buildDirectory -Version $Version -Browser $browser
            $sources += $archivePath
        }
        # Only create/replace the five declared artifacts. Do not recursively
        # clean user directories or copy WXT's extra source archive.
        $destination = Assert-ReleaseBuildPath -Path $destination -Boundary $outputRoot
        [void][System.IO.Directory]::CreateDirectory($destination)
        $assets = @()
        foreach ($source in $sources) {
            $target = Assert-ReleaseBuildPath -Path (Join-Path $destination ([System.IO.Path]::GetFileName($source))) -Boundary $destination
            Copy-Item -LiteralPath $source -Destination $target -Force
            $assets += Get-ReleaseBuildAsset -Path $target
        }
        $install = @"
TabAgent v$Version

Chrome / Brave and other Chromium browsers
Extract tabagent-$Version-chrome.zip to a permanent folder.
Open chrome://extensions, enable Developer mode, choose Load unpacked,
and select the extracted folder containing manifest.json.

Edge
Extract tabagent-$Version-edge.zip. Open edge://extensions, enable
Developer mode, and load the extracted extension folder.

Firefox - unsigned temporary test package
Extract tabagent-$Version-firefox.zip. Open
about:debugging#/runtime/this-firefox, choose Load Temporary Add-on,
and select manifest.json. Reload it after restarting Firefox.
This is not a signed package for permanent installation.

Updating an unpacked development installation
Replace the contents of the original extension folder with the package
for the same browser, then click Reload on the extensions page.
Keep the original folder and do not remove the extension first; changing
folders or removing it can lose access to its existing configuration.

First use
Open TabAgent settings. Select a model service, enter its API key and a
model that supports tool calling, test the connection, then save.
Your selected model provider may charge for API usage.
Image analysis additionally requires an image-capable model and must
be enabled in settings.

Limits
Chrome / Edge can read online text PDFs (up to 20 MB and 300 pages).
Scanned, password-protected and local PDFs are not supported for full
text reading. Firefox's built-in PDF viewer is not supported for this.
Search engines must be reachable on your network. Browser internal pages
cannot be read. Page changes require confirmation in operation mode.

SHA256SUMS.txt contains SHA-256 checksums for the three ZIPs and this file.
"@
        $installPath = Assert-ReleaseBuildPath -Path (Join-Path $destination 'INSTALL.txt') -Boundary $destination
        [System.IO.File]::WriteAllText($installPath, $install.Replace("`r`n", "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
        $assets += Get-ReleaseBuildAsset -Path $installPath
        $checksumLines = @($assets | ForEach-Object { "$($_.sha256)  $($_.name)" })
        $checksumPath = Assert-ReleaseBuildPath -Path (Join-Path $destination 'SHA256SUMS.txt') -Boundary $destination
        [System.IO.File]::WriteAllText($checksumPath, ($checksumLines -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
        $assets += Get-ReleaseBuildAsset -Path $checksumPath
        [void](Test-ReleaseAssets -Assets $assets -Directory $destination)
        $checks = if ($Quick) { 'quick' } else { 'full' }
        return [pscustomobject]@{ version = $Version; checks = $checks; assets = @($assets); directory = $destination }
    } finally {
        $env:PATH = $oldPath
        Pop-Location
    }
}
