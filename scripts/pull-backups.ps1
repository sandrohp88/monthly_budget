<#
Pull the nightly SQLite backups off LXC 125 (budget) to an off-box folder,
so a dead container/disk doesn't take the app AND all 14 days of backups
with it.

No secrets in this file - it relies on the `pve7050` ssh alias from
~/.ssh/config (key auth), the same transport scripts/redeploy.py uses.
Safe to re-run: only fetches files not already present at the destination,
then prunes local copies older than -KeepDays (default 60 - deliberately
longer than the server's 14-day retention).

Schedule on the workstation (one-time):
  schtasks /Create /TN "MonthlyBudget backup pull" /TR "pwsh -NoProfile -File E:\code\monthly_budget\scripts\pull-backups.ps1" /SC DAILY /ST 07:00
Run manually any time:
  pwsh -NoProfile -File scripts/pull-backups.ps1
#>
param(
  [string]$Destination = "Z:\backups\monthly-budget",
  [int]$KeepDays = 60
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $Destination)) {
  New-Item -ItemType Directory -Force $Destination | Out-Null
}

$remote = ssh pve7050 "pct exec 125 -- ls -1 /opt/budget/backups"
if ($LASTEXITCODE -ne 0) { throw "Could not list backups on LXC 125 (ssh pve7050)" }
$files = @($remote -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^budget-.*\.db$' })

$new = 0
foreach ($f in $files) {
  $dest = Join-Path $Destination $f
  if (Test-Path $dest) { continue }
  # Backups live inside the container; hop them out via the pve host.
  ssh pve7050 "pct pull 125 /opt/budget/backups/$f /tmp/$f"
  if ($LASTEXITCODE -ne 0) { throw "pct pull failed for $f" }
  scp "pve7050:/tmp/$f" $dest
  if ($LASTEXITCODE -ne 0) { throw "scp failed for $f" }
  ssh pve7050 "rm -f /tmp/$f" | Out-Null
  $new++
}

$cutoff = (Get-Date).AddDays(-$KeepDays)
Get-ChildItem $Destination -Filter "budget-*.db" |
  Where-Object { $_.LastWriteTime -lt $cutoff } |
  Remove-Item -Force -Confirm:$false

"$(Get-Date -Format s) pulled $new new backup(s), $($files.Count) on server" |
  Tee-Object -FilePath (Join-Path $Destination "pull-log.txt") -Append
