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

function Get-ProcStart {
    # "pid@HH:mm:ss" proses pertama yang CommandLine-nya cocok, atau '-'.
    #
    # Tanpa ini, PASS/FAIL tidak bisa diaudit: auto-start dan intervensi
    # manual sama-sama "port up", tapi timestamp start membuktikan siapa
    # yang kapan menghidupkan apa (26 Okt 2026: PASS ternyata datang
    # setelah restart manual — tanpa audit line itu tidak ketahuan).
    param([string]$Name, [string]$CmdPattern)
    foreach ($p in Get-CimInstance Win32_Process -Filter "Name='$Name'") {
        if ($p.CommandLine -and $p.CommandLine -match $CmdPattern) {
            return ('{0}@{1}' -f $p.ProcessId, ([datetime]$p.CreationDate).ToString('HH:mm:ss'))
        }
    }
    return '-'
}

function Get-StartAudit {
    'START redis={0} beat={1} uvicorn={2} django={3}' -f `
        (Get-ProcStart 'redis-server.exe' '--port'), `
        (Get-ProcStart 'python.exe' '(?i)-m\s+celery.*\bbeat\b'), `
        (Get-ProcStart 'python.exe' 'uvicorn'), `
        (Get-ProcStart 'python.exe' 'runserver')
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$allOk = $false

# Kapan tiap komponen PERTAMA KALI terlihat up — dicatat sekali, lalu
# dicetak sekali di baris verdict (audit line; lihat Get-ProcStart).
$firstUp = @{}
function Set-FirstUp([string]$Key, [bool]$Ok) {
    if ($Ok -and -not $script:firstUp.ContainsKey($Key)) {
        $script:firstUp[$Key] = '{0:HH:mm:ss}' -f (Get-Date)
    }
}

Add-Log (Get-StartAudit)

while ((Get-Date) -lt $deadline) {
    $portState = @{}
    foreach ($p in $ProbePorts) { $portState[$p] = Test-Port $p }
    $beat = Test-Beat
    $django = Test-Django
    $backend = Test-Backend

    foreach ($p in $ProbePorts) { Set-FirstUp "port$p" $portState[$p] }
    Set-FirstUp 'beat' $beat
    Set-FirstUp 'django' $django
    Set-FirstUp 'backend' $backend

    $portsOk = -not ($portState.Values -contains $false)
    if ($portsOk -and $beat -and $django -and $backend) {
        $allOk = $true
        $detail = ($ProbePorts | ForEach-Object { "$_=$(if ($portState[$_]) {'up'} else {'down'})" }) -join ' '
        # first= kapan tiap komponen pertama terlihat up — pemisah otomatis
        # vs intervensi manual (audit; 26 Okt 2026 PASS-nya ternyata berasal
        # dari restart manual, tanpa baris ini tidak ketahuan).
        $first = ($ProbePorts | ForEach-Object { "$_=$(if ($firstUp["port$_"]) {$firstUp["port$_"]} else {'?'})" }) -join ' '
        $first += ' beat={0} django={1} backend={2}' -f `
            $(if ($firstUp['beat']) {$firstUp['beat']} else {'?'}), `
            $(if ($firstUp['django']) {$firstUp['django']} else {'?'}), `
            $(if ($firstUp['backend']) {$firstUp['backend']} else {'?'})
        Add-Log "RESULT=PASS $detail beat=up django=200 backend=up | first=$first"
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

    # Diagnosis penyebab — tanpa ini satu-satunya petunjuk cuma "6379=down",
    # padahal beda antara "redis tidak pernah dibuka" vs "terbuka tapi
    # gantung sebelum bind" (gejala logon 26 Okt 2026) menentukan perbaikan
    # yang berbeda. Runstate 6 = loading, 7 = ready.
    if (-not $portState[6379]) {
        $redisProcs = @(Get-CimInstance Win32_Process -Filter "Name='redis-server.exe'")
        if ($redisProcs.Count -eq 0) {
            Add-Log 'DIAG redis=tidak-pernah-start (start_stack tidak membukanya / redis-server hilang dari PATH)'
        } else {
            foreach ($r in $redisProcs) {
                try {
                    $resp = (Get-Process -Id $r.ProcessId -ErrorAction Stop).Responding
                    $state = if ($resp) {'responding-tapi-port-tidak-listening'} else {'tidak-responding'}
                } catch { $state = '?' }
                Add-Log "DIAG redis gantung: pid $($r.ProcessId) sejak $(([datetime]$r.CreationDate).ToString('HH:mm:ss')) state=$state port=6379-down"
            }
        }
    }
}
