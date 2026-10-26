<#
.SYNOPSIS
    Start semua komponen one-day stack: Backend FastAPI, Celery Worker, Celery Beat, Django Dashboard.

.DESCRIPTION
    Script ini otomatis membuka 4 jendela terminal terpisah untuk masing-masing proses.
    Setelah start, script akan memverifikasi semua port sudah listening.

.PARAMETER BackendPath
    Path ke folder backend student-assistant. Default: ..\UINIC\student-assistant\backend

.PARAMETER ApiPort
    Port FastAPI backend. Default: 8022

.PARAMETER DashboardPort
    Port Django dashboard. Default: 8010

.EXAMPLE
    .\start_stack.ps1
    # Start dengan konfigurasi default

.EXAMPLE
    .\start_stack.ps1 -BackendPath "C:\path\to\backend" -ApiPort 9000
    # Start dengan path dan port kustom
#>

param(
    [string]$BackendPath = "..\UINIC\student-assistant\backend",
    [int]$ApiPort = 8022,
    [int]$DashboardPort = 8010,
    [int]$RedisPort = 6379
)

$ErrorActionPreference = "Continue"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendAbs = (Resolve-Path "$RootDir\$BackendPath").Path

function Test-Port {
    param([int]$Port)
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $Port)
        $tcp.Close()
        return $true
    } catch { return $false }
}

function Wait-ForPort {
    param([int]$Port, [string]$Name, [int]$TimeoutSec = 30)
    Write-Host "Menunggu $Name di port $Port..." -ForegroundColor DarkGray
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Port $Port)) {
        if ($sw.Elapsed.TotalSeconds -gt $TimeoutSec) {
            Write-Host "TIMEOUT: $Name tidak merespon di port $Port dalam $TimeoutSec detik" -ForegroundColor Red
            return $false
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "OK: $Name siap di port $Port" -ForegroundColor Green
    return $true
}

function Start-ProcessInNewWindow {
    param(
        [string]$Cmd,
        [string]$Title,
        [string]$WorkingDir = $RootDir
    )
    Write-Host "Membuka: $Title" -ForegroundColor Cyan
    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "title $Title && $Cmd" -WorkingDirectory $WorkingDir
    Start-Sleep -Milliseconds 300
}

function Get-CeleryProcesses {
    <#
      Daftar proses Celery (worker / beat) yang sedang hidup.

      Dicocokkan lewat CommandLine (CIM), bukan judul jendela: proses
      python.exe yang dijalankan dari konsol tidak punya window sendiri,
      jadi MainWindowTitle-nya kosong. Ini alasan yang sama dengan yang
      dipakai stop_stack.ps1.

      Mengembalikan array objek: pid, role ('worker'/'beat'), queues.
    #>
    $rows = @()
    Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object {
            $cmd = $_.CommandLine
            if (-not $cmd) { return }
            if ($cmd -notmatch '-m\s+celery') { return }
            # Jangan hitung "celery ... inspect ..." sebagai worker.
            if ($cmd -match '(?i)\binspect\b') { return }

            $role = if ($cmd -match '(?i)\bbeat\b') { 'beat' } else { 'worker' }

            $queues = @()
            if ($cmd -match '--queues[= ]\s*([^\s"]+)') {
                $queues = $Matches[1] -split ',' | ForEach-Object { $_.Trim() } |
                          Where-Object { $_ }
            }

            $rows += [pscustomobject]@{
                pid    = [int]$_.ProcessId
                role   = $role
                queues = @($queues)
            }
        }
    return $rows
}

function Clear-StaleCeleryPidfiles {
    <#
      Hapus pidfile yang prosesnya sudah tidak ada — sebelum memutuskan
      "sudah running" vs "perlu start".

      Celery **berniat** membersihkan pidfile basi sendiri
      (``Pidfile.remove_if_stale``), tapi pembersihannya bergantung pada
      ``os.kill(pid, 0)`` melempar ``ESRCH``/``EPERM``. Di Windows pid
      yang mati — maupun pid yang tidak pernah ada — justru melempar
      ``errno 22 (EINVAL)``; cabang stale tidak pernah jalan, jadi
      pidfile yang tertinggal (setelah crash atau reboot) terus
      memblokir start dengan "Pidfile already exists" exit 73.

      PID yang tertulis juga bisa sudah **dipakai ulang** oleh proses
      lain setelah reboot, jadi yang dicocokkan bukan sekadar "pid ini
      ada prosesnya" tapi "prosesnya memang celery" — kalau tidak,
      pid hasil reuse membuat pidfile terlihat hidup dan beat tetap
      tidak mau start.
    #>
    param([string]$PidDir)
    if (-not (Test-Path $PidDir)) { return }

    foreach ($f in Get-ChildItem -Path $PidDir -Filter *.pid -ErrorAction SilentlyContinue) {
        $raw = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
        if (-not $raw) { continue }

        $pidValue = 0
        if (-not [int]::TryParse($raw.Trim(), [ref]$pidValue)) {
            Write-Host "Membersihkan pidfile rusak: $($f.Name)" -ForegroundColor Yellow
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
            continue
        }

        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue).CommandLine
        $isCelery = [bool]($cmd -and $cmd -match '-m\s+celery')
        if (-not $isCelery) {
            Write-Host "Membersihkan pidfile basi: $($f.Name) (pid $pidValue bukan proses celery)" -ForegroundColor Yellow
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
        }
    }
}

# ─── Validasi ───────────────────────────────────────────────
if (-not (Test-Path "$BackendAbs\app\main.py")) {
    Write-Host "[ERROR] Backend tidak ditemukan di: $BackendAbs" -ForegroundColor Red
    Write-Host "Gunakan -BackendPath untuk mengarahkan ke folder backend yang benar." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path "$RootDir\.env")) {
    Write-Host "[WARN] File .env tidak ditemukan. Salin dari .env.example dulu." -ForegroundColor Yellow
    Copy-Item "$RootDir\.env.example" "$RootDir\.env" -Force
    Write-Host "File .env contoh sudah disalin. Edit isinya lalu jalankan lagi." -ForegroundColor Yellow
    exit 1
}

Write-Host "========================================" -ForegroundColor White
Write-Host "  one-day Full Stack Starter" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor White
Write-Host "Backend: $BackendAbs"
Write-Host "API Port: $ApiPort"
Write-Host "Dashboard Port: $DashboardPort"
Write-Host "========================================" -ForegroundColor White
Write-Host ""

# ─── 1. Start Backend FastAPI ─────────────────────────────────
$apiReady = Test-Port $ApiPort
if (-not $apiReady) {
    Start-ProcessInNewWindow -Cmd "python -m uvicorn app.main:app --host 127.0.0.1 --port $ApiPort" -Title "FastAPI Backend" -WorkingDir $BackendAbs
    $apiReady = Wait-ForPort -Port $ApiPort -Name "FastAPI" -TimeoutSec 30
} else {
    Write-Host "OK: FastAPI sudah running di port $ApiPort" -ForegroundColor Green
}

# ─── 2. Start Redis (broker Celery) ───────────────────────────
#
# Redis WAJIB hidup: tanpa itu, worker dan beat tidak punya antrean,
# dan API jatuh ke jalur "inline" -- yang membuat transkripsi Whisper
# berjalan di thread API (bukan di worker).
#
# Kalau Redis tidak ada di PATH, script tetap jalan (worker akan
# reconnect sendiri begitu Redis-nya hidup), tapi peringatan dicetak
# supaya masalahnya kelihatan, bukan misterius.
$redisReady = Test-Port $RedisPort
if ($redisReady) {
    Write-Host "OK: Redis sudah running di port $RedisPort" -ForegroundColor Green
} else {
    $redisExe = Get-Command redis-server -ErrorAction SilentlyContinue

    if ($redisExe) {
        Start-ProcessInNewWindow -Cmd "redis-server --port $RedisPort --save `"`" --appendonly no" -Title "Redis Server"
        $redisReady = Wait-ForPort -Port $RedisPort -Name "Redis" -TimeoutSec 15
    } else {
        Write-Host "[WARN] Redis tidak ditemukan di PATH." -ForegroundColor Yellow
        Write-Host "       Worker Celery butuh Redis sebagai broker. Install:" -ForegroundColor Yellow
        Write-Host "       winget install Redis.Redis" -ForegroundColor Yellow
        Write-Host "       Lalu jalankan ulang script ini." -ForegroundColor Yellow
    }
}

# ─── 3. Start Celery Workers (DUA worker) ─────────────────────
#
# Kenapa dua, bukan satu? Pada Windows, --pool=solo berarti satu proses
# menjalankan SATU task pada satu waktu. Kalau satu worker consume
# antrean "reminders" (pengingat, harus berbunyi dalam hitungan detik)
# bersama antrean "reports" (render video, ~9 menit), maka pengingat
# menanti sampai render selesai. Gejalanya: "pengingat telat", tanpa
# jejak di log.
#
# Topologi yang benar:
#   worker utama   -> -Q celery,reminders
#   worker laporan -> -Q reports  (hostname terpisah)
#
# Worker laporan punya hostname sendiri supaya keduanya bisa dibedakan
# di `celery -A ... inspect ping` dan di log.
#
# Catatan %h: di cmd.exe, "%h" TIDAK diekspansi (hanya di file .bat, dan
# di situ ditulis "%%h"). Jadi "%h" di sini diteruskan apa adanya ke
# Celery yang lalu mengekspansi %h -> nama host.
#
# --pidfile dipakai supaya stop_stack.ps1 bisa menghentikan tiap worker
# secara presisi.
#
# **Pidfile basi harus dibersihkan di sini.** Keliru kalau mengandalkan
# Celery: di Windows ``os.kill(pid, 0)`` selalu melempar EINVAL
# (bukan ESRCH), jadi ``remove_if_stale``-nya tidak pernah menghapus
# apa pun — pidfile sisa crash/reboot akan memblokir start dengan
# "Pidfile already exists" (exit 73). Lihat Clear-StaleCeleryPidfiles.
Clear-StaleCeleryPidfiles -PidDir "$BackendAbs\.celery"
#
# **Jangan start worker yang sudah hidup.** Worker Celery yang didaftarkan
# dua kali dengan nama node sama itu masalah nyata, bukan teoritis:
# broadcast (ping/inspect) hanya dijawab salah satu -- sehingga cek
# "worker hidup" bisa 보고 worker yang sudah mati -- dan satu task bisa
# dieksekusi dua kali. Yang terjadi sebelumnya: start_stack.ps1
# dijalankan dua kali tanpa stop, lalu worker menumpuk.
$celeryLive = Get-CeleryProcesses
$workerLive = @($celeryLive | Where-Object { $_.role -eq 'worker' })
$beatLive = @($celeryLive | Where-Object { $_.role -eq 'beat' })

if ($workerLive.Count -gt 0) {
    Write-Host "OK: Celery worker sudah running" -ForegroundColor Green
    foreach ($w in $workerLive) {
        $q = if ($w.queues.Count) { $w.queues -join ',' } else { 'celery' }
        Write-Host ("     PID {0} [{1}]" -f $w.pid, $q) -ForegroundColor DarkGray
    }
    Write-Host "     (tidak memulai worker baru -- jalankan stop_stack.bat dulu kalau memang mau)" -ForegroundColor DarkGray
} else {
    Start-ProcessInNewWindow -Cmd "python -m celery -A app.workers.celery_worker.celery_app worker --pool=solo --loglevel=info --queues celery,reminders --pidfile=.celery/worker.pid" -Title "Celery Worker" -WorkingDir $BackendAbs
    Start-ProcessInNewWindow -Cmd "python -m celery -A app.workers.celery_worker.celery_app worker --pool=solo --loglevel=info --queues reports --hostname celery-reports@%h --pidfile=.celery/worker-reports.pid" -Title "Celery Worker Reports" -WorkingDir $BackendAbs
}

# ─── 4. Start Celery Beat (optional) ─────────────────────────
#
# Beat punya pidfile juga, supaya stop_stack.ps1 bisa menghentikannya
# secara presisi (selaip mencocokkan dengan "beat" bisa ikut menyentuh
# `celery beat` dari instalasi lain).
if ($beatLive.Count -gt 0) {
    Write-Host "OK: Celery Beat sudah running" -ForegroundColor Green
    foreach ($b in $beatLive) {
        Write-Host ("     PID {0}" -f $b.pid) -ForegroundColor DarkGray
    }
} else {
    Start-ProcessInNewWindow -Cmd "python -m celery -A app.workers.celery_worker.celery_app beat --loglevel=info --pidfile=.celery/beat.pid" -Title "Celery Beat" -WorkingDir $BackendAbs
}

# ─── 5. Start Django Dashboard ─────────────────────────────────
$dashboardReady = Test-Port $DashboardPort
if (-not $dashboardReady) {
    # Auto-reload ON (tanpa --noreload) — disengaja.
    # Edit .py -> restart otomatis (~2-5 detik downtime); tanpa autoreload
    # server diam-diam melayani kode lama. Edit .html -> berlaku ~0.5 detik
    # tanpa restart. Autoreloader hanya menambah satu proses parent.
    Start-ProcessInNewWindow -Cmd "python manage.py runserver 127.0.0.1:$DashboardPort" -Title "Django Dashboard" -WorkingDir $RootDir
    $dashboardReady = Wait-ForPort -Port $DashboardPort -Name "Django Dashboard" -TimeoutSec 30
} else {
    Write-Host "OK: Django Dashboard sudah running di port $DashboardPort" -ForegroundColor Green
}

# ─── Summary ─────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor White
Write-Host "  STATUS" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor White
Write-Host "FastAPI Backend (port $ApiPort):    " -NoNewline
Write-Host "$(if($apiReady){'Running ✓'}else{'Failed ✗'})" -ForegroundColor $(if($apiReady){'Green'}else{'Red'})

Write-Host "Redis Broker (port $RedisPort):      " -NoNewline
Write-Host "$(if($redisReady){'Running ✓'}else{'Failed ✗'})" -ForegroundColor $(if($redisReady){'Green'}else{'Red'})

Write-Host "Celery Worker:                      Running (lihat jendela terpisah)" -ForegroundColor Yellow
Write-Host "Celery Beat:                        Running (lihat jendela terpisah)" -ForegroundColor Yellow
Write-Host ""
Write-Host "Preflight (python stack_health.py):" -ForegroundColor Cyan
Write-Host "  Cek manual worker: python stack_health.py" -ForegroundColor DarkGray
Write-Host "  Detail: worker hidup vs sibuk vs mati dibedakan;" -ForegroundColor DarkGray
Write-Host "  'ping' broadcast tidak bisa dilakukan itu, jadi jangan" -ForegroundColor DarkGray
Write-Host "  pakai `celery inspect ping` sebagai satu-satunya bukti." -ForegroundColor DarkGray

Write-Host "Django Dashboard (port $DashboardPort): " -NoNewline
Write-Host "$(if($dashboardReady){'Running ✓'}else{'Failed ✗'})" -ForegroundColor $(if($dashboardReady){'Green'}else{'Red'})

Write-Host ""
Write-Host "Buka browser: http://127.0.0.1:$DashboardPort" -ForegroundColor Cyan

# ─── Optional: Run verification ──────────────────────────────
$choice = Read-Host "Jalankan verifikasi? (y/N)"
if ($choice -match '^[yY]') {
    Write-Host "`nMenjalankan verify_bff.py..." -ForegroundColor Cyan
    Push-Location $RootDir
    python verify_bff.py
    Pop-Location
}

Write-Host "`nSemua proses tetap berjalan di jendela terpisah." -ForegroundColor Yellow
Write-Host "Tekan tombol apa saja untuk keluar..." -ForegroundColor DarkGray
