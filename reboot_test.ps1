<#
  Pantau stack otomatis setelah boot — hasil ditulis ke file supaya
  bisa dibaca setelah sesi Claude-nya mati oleh reboot.

  Dipanggil dari shortcut di folder Startup ("Uji Reboot Auto-Start"),
  jadi pollingnya dimulai pada waktu yang sama dengan start_stack.ps1
  dari shortcut "OneDay Stack".

  Verdict:
    PASS = port 6379/8010/8022 listening, beat jalan, Django balas 200,
           backend balas (200/401) — semua dalam TimeoutSec.
    FAIL = ada komponen yang belum siap dalam TimeoutSec; rinciannya
           ditulis per komponen supaya jelas siapa yang tersangkut.
#>
param(
    [string]$LogFile = 'C:\Users\Pongo\one-day\reboot_test.log',
    [int[]]$ProbePorts = @(6379, 8010, 8022),
    [int]$TimeoutSec = 300
)

$ErrorActionPreference = 'SilentlyContinue'

function Add-Log([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
Add-Log ('=== mulai pantau; boot terakhir {0} ===' -f $boot.ToString('yyyy-MM-dd HH:mm:ss'))

function Test-Port([int]$Port) {
    try {
        $t = New-Object System.Net.Sockets.TcpClient
        $t.Connect('127.0.0.1', $Port)
        $t.Close()
        return $true
    } catch { return $false }
}

function Test-Beat {
    foreach ($p in Get-CimInstance Win32_Process -Filter "Name='python.exe'") {
        if ($p.CommandLine -match '-m\s+celery' -and $p.CommandLine -match '(?i)\bbeat\b') {
            return $true
        }
    }
    return $false
}

function Test-Django {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8010/' -UseBasicParsing -TimeoutSec 5
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Test-Backend {
    # 401 juga berarti "hidup": endpoint butuh auth, server menjawab.
    try {
        $req = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:8022/api/v1/rag/formats')
        $req.Timeout = 5000
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch [System.Net.WebException] {
        return [bool]$_.Exception.Response
    } catch {
        return $false
    }
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$allOk = $false

while ((Get-Date) -lt $deadline) {
    $portState = @{}
    foreach ($p in $ProbePorts) { $portState[$p] = Test-Port $p }
    $beat = Test-Beat
    $django = Test-Django
    $backend = Test-Backend

    $portsOk = -not ($portState.Values -contains $false)
    if ($portsOk -and $beat -and $django -and $backend) {
        $allOk = $true
        $detail = ($ProbePorts | ForEach-Object { "$_=$(if ($portState[$_]) {'up'} else {'down'})" }) -join ' '
        Add-Log "RESULT=PASS $detail beat=up django=200 backend=up"
        break
    }

    Start-Sleep -Seconds 5
}

if (-not $allOk) {
    $portState = @{}
    foreach ($p in $ProbePorts) { $portState[$p] = Test-Port $p }
    $detail = ($ProbePorts | ForEach-Object { "$_=$(if ($portState[$_]) {'up'} else {'down'})" }) -join ' '
    Add-Log ("RESULT=FAIL setelah {0}s; {1} beat={2} django={3} backend={4}" -f `
        $TimeoutSec, $detail, `
        $(if (Test-Beat) {'up'} else {'down'}), `
        $(if (Test-Django) {'up'} else {'down'}), `
        $(if (Test-Backend) {'up'} else {'down'}))
}
