# setup_scheduler.ps1 - registra (o quita) la tarea periodica del
# Sistema de Informacion Cantares en el Programador de Tareas de Windows.
#
# La tarea corre  data_prep/run_sic.py : clasifica las fotos nuevas, procesa
# las carpetas de entrada y reconstruye el catalogo de documentos.
#
# COMO FUNCIONA:
#   - Se dispara SEMANAL (domingo 12:00). El flujo es bajo, no necesita mas.
#   - Necesita el PC ENCENDIDO. Si estaba apagado a esa hora, corre EN CUANTO
#     lo prendas e inicies sesion (opcion StartWhenAvailable = "ejecutar en
#     cuanto sea posible tras un inicio perdido").
#   - Corre en segundo plano, sin ventana; no interrumpe.
#
#   Registrar (semanal):   powershell -ExecutionPolicy Bypass -File setup_scheduler.ps1
#   Quincenal:             ... -File setup_scheduler.ps1 -Every biweekly
#   Quitar:                ... -File setup_scheduler.ps1 -Remove
#
# NOTA: guardar en ASCII (sin acentos) para PowerShell 5.1.

param(
    [ValidateSet('weekly','biweekly')]
    [string]$Every = 'weekly',
    [switch]$Remove
)

$TaskName = "CantaresSIC"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Tarea '$TaskName' eliminada."
    exit 0
}

$python = (Get-Command python).Source
$script = Join-Path $PSScriptRoot "run_sic.py"
if (-not (Test-Path $script)) { Write-Error "No encuentro run_sic.py junto a este script."; exit 1 }

$weeksInterval = if ($Every -eq 'biweekly') { 2 } else { 1 }

$action  = New-ScheduledTaskAction -Execute $python -Argument ('"{0}"' -f $script)
$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval $weeksInterval -DaysOfWeek Sunday -At ([datetime]"12:00")
# StartWhenAvailable = si se perdio el inicio (PC apagado), corre en cuanto se pueda.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Sistema de Informacion Cantares: clasifica fotos e indexa documentos." -Force | Out-Null

if ($?) {
    $freq = if ($Every -eq 'biweekly') { "cada 2 semanas" } else { "cada semana" }
    Write-Host ("OK - Tarea '{0}' registrada: {1} (domingo 12:00, o al prender el PC si estaba apagado)." -f $TaskName, $freq)
    Write-Host "  Correr ahora (prueba):  schtasks /Run /TN $TaskName"
    Write-Host "  Quitar:                 powershell -File setup_scheduler.ps1 -Remove"
} else {
    Write-Error "No se pudo registrar la tarea."
}
