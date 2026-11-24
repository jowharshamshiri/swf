# The browser suites and the performance benchmark on a Windows guest, in the
# stable browsers people use: Google Chrome and Mozilla Firefox, each installed
# from its publisher's own package (signature checked), Node.js from
# nodejs.org (checksum checked). Playwright drives Chrome as the `chrome`
# channel and Firefox as `moz-firefox` (WebDriver BiDi).
#
# Everything lands in out\: out\conformance (every test per browser, and the
# end-to-end scenarios of section 33.2 gathered per browser) and out\bench (each
# browser's measures, with the environment and the method). Both run even when
# the first fails, and the task fails when either did.
#
# Written for Windows PowerShell 5.1, which is what a guest runs, and in ASCII:
# the guest reads this file as cp1252.
# -Part bench runs the benchmark alone (the browser suites are the default's too).
param(
    [ValidateSet('all', 'bench')]
    [string] $Part = 'all'
)
$ErrorActionPreference = 'Stop'
# No progress records: there is no console, and PowerShell would write them
# into the error stream as CLIXML.
$ProgressPreference = 'SilentlyContinue'

function Say($message) { Write-Host "swf-test: $message" }

if (-not $env:MG_TEST_WORKSPACE) { throw 'swf-test: MG_TEST_WORKSPACE is not set' }
$workspace = $env:MG_TEST_WORKSPACE
$out = Join-Path $workspace 'out'
$downloads = Join-Path $env:TEMP 'swf-downloads'
New-Item -ItemType Directory -Force -Path $out, $downloads | Out-Null

# Fetch a file, retrying a request that got no answer or a server error. A 4xx
# is a URL that will not improve by asking again.
function Get-RemoteFile {
    param([Parameter(Mandatory)] [string] $Uri, [Parameter(Mandatory)] [string] $OutFile)
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 1800 -Uri $Uri -OutFile $OutFile
            return
        } catch {
            $status = $null
            if ($_.Exception.Response) { $status = [int] $_.Exception.Response.StatusCode }
            if ($status -and $status -lt 500) { throw "swf-test: $Uri answered $status" }
            if ($attempt -eq 4) { throw "swf-test: $Uri could not be fetched: $($_.Exception.Message)" }
            Start-Sleep -Seconds (10 * $attempt)
        }
    }
}

# Install an MSI quietly, after checking that its publisher signed it.
function Install-Msi {
    param([Parameter(Mandatory)] [string] $Name, [Parameter(Mandatory)] [string] $Uri, [Parameter(Mandatory)] [string] $Signer)
    $msi = Join-Path $downloads "$Name.msi"
    Say "fetching $Name"
    Get-RemoteFile -Uri $Uri -OutFile $msi
    $signature = Get-AuthenticodeSignature -FilePath $msi
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike "*$Signer*") {
        throw "swf-test: $Name's installer is not signed by $Signer ($($signature.Status): $($signature.SignerCertificate.Subject))"
    }
    Say "installing $Name"
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
        throw "swf-test: $Name's installer exited $($process.ExitCode)"
    }
}

# Run a native command, its output passed through; returns its exit code.
function Invoke-Native {
    param([Parameter(Mandatory)] [string] $Program, [string[]] $Arguments = @())
    $saved = $global:ErrorActionPreference
    $global:ErrorActionPreference = 'Continue'
    try {
        & $Program @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
        return $LASTEXITCODE
    } finally {
        $global:ErrorActionPreference = $saved
    }
}

# Node.js: the newest 24.x for x64, as the repository's .nvmrc asks, checked
# against the release's own checksums.
$major = (Get-Content (Join-Path $workspace '.nvmrc') -Raw).Trim()
$dist = "https://nodejs.org/dist/latest-v$major.x"
$sums = Join-Path $downloads 'SHASUMS256.txt'
Get-RemoteFile -Uri "$dist/SHASUMS256.txt" -OutFile $sums
$entry = Get-Content $sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+(node-v$major\.[0-9.]+-win-x64\.zip)$" } | Select-Object -First 1
if (-not $entry) { throw "swf-test: no Node.js $major for win-x64 is listed in $dist/SHASUMS256.txt" }
$null = $entry -match "^([0-9a-f]{64})\s+(\S+)$"
$expected = $Matches[1]
$zipName = $Matches[2]
$zip = Join-Path $downloads $zipName
Say "fetching $zipName"
Get-RemoteFile -Uri "$dist/$zipName" -OutFile $zip
$actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "swf-test: $zipName has SHA-256 $actual, not $expected" }
Expand-Archive -Path $zip -DestinationPath $downloads -Force
$node = Join-Path $downloads ($zipName -replace '\.zip$', '')
$env:Path = "$node;$env:Path"
Say "node $(& (Join-Path $node 'node.exe') --version)"

Install-Msi -Name 'chrome' -Uri 'https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi' -Signer 'Google LLC'
Install-Msi -Name 'firefox' -Uri 'https://download.mozilla.org/?product=firefox-msi-latest-ssl&os=win64&lang=en-US' -Signer 'Mozilla Corporation'

# The machine the record is made on: Windows build, processor, memory, and each display adapter
# with its driver, as section 26.1 asks a reference machine to be documented.
$os = Get-CimInstance Win32_OperatingSystem
$machine = [ordered]@{
    os = "$($os.Caption) $($os.Version) build $($os.BuildNumber)"
    processor = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
    cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
    memoryBytes = $os.TotalVisibleMemorySize * 1024
    adapters = @(Get-CimInstance Win32_VideoController | ForEach-Object {
        [ordered]@{ name = $_.Name; driver = $_.DriverVersion; driverDate = "$($_.DriverDate)" }
    })
    chrome = (Get-Item 'C:\Program Files\Google\Chrome\Application\chrome.exe').VersionInfo.ProductVersion
    firefox = (Get-Item 'C:\Program Files\Mozilla Firefox\firefox.exe').VersionInfo.ProductVersion
}
$machine | ConvertTo-Json -Depth 4 | Set-Content -Encoding ASCII -Path (Join-Path $out 'machine.json')
Say "machine: $($machine.os); $($machine.processor); $(($machine.adapters | ForEach-Object { $_.name + ' ' + $_.driver }) -join ', ')"

Set-Location $workspace
Say 'installing the locked packages'
$code = Invoke-Native -Program (Join-Path $node 'npm.cmd') -Arguments @('ci', '--no-audit', '--no-fund')
if ($code -ne 0) { throw "swf-test: npm ci exited $code" }

$env:SWF_CHROMIUM_CHANNEL = 'chrome'
$env:SWF_FIREFOX_CHANNEL = 'moz-firefox'
$nodeExe = Join-Path $node 'node.exe'

$conformance = 0
if ($Part -eq 'all') {
    Say 'browser suites, per browser'
    $conformance = Invoke-Native -Program $nodeExe -Arguments @('scripts/conformance.mjs', '--out', (Join-Path $out 'conformance'), '--browsers', 'chromium,firefox')
    Say "conformance exited $conformance"
}

Say 'performance benchmark, one browser at a time'
$bench = Invoke-Native -Program $nodeExe -Arguments @('scripts/bench.mjs', '--out', (Join-Path $out 'bench'), '--browsers', 'chromium,firefox')
Say "benchmark exited $bench"

if ($conformance -ne 0 -or $bench -ne 0) {
    throw "swf-test: conformance exited $conformance, benchmark $bench"
}
