param(
  [ValidateSet('Ensure', 'Status', 'Stop', 'Remove')][string]$Action = 'Ensure',
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$taskName = 'Draw studio Local Canvas'
$sourceSignature = 'Draw studio local canvas service v1'
$projectRoot = (Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).ProviderPath
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

if (-not $NodePath) {
  if (Test-Path -LiteralPath 'E:\node.exe' -PathType Leaf) { $NodePath = 'E:\node.exe' }
  else {
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodePath = $nodeCommand.Source }
  }
}

if ($NodePath -and (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  $NodePath = (Resolve-Path -LiteralPath $NodePath).ProviderPath
  # Resolve junctions so task ownership and saved process identity use one path.
  $resolvedRoot = & $NodePath (Join-Path $projectRoot 'scripts\local-supervisor.cjs') --print-root $projectRoot
  if ($LASTEXITCODE -ne 0 -or -not $resolvedRoot) { throw 'Cannot resolve the Draw studio project directory.' }
  $projectRoot = [string]$resolvedRoot
} elseif ($Action -eq 'Ensure') {
  throw 'Node.js is missing. Provide a stable Node.js path with -NodePath.'
}

$wrapperPath = Join-Path $projectRoot 'scripts\run-local-service.ps1'
$supervisorPath = Join-Path $projectRoot 'scripts\local-supervisor.cjs'
$vitePath = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
$cacheDirectory = Join-Path $projectRoot '.cache'
$statusPath = Join-Path $cacheDirectory 'local-service-status.json'
$disabledPath = Join-Path $cacheDirectory 'local-service.disabled'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory ($taskName + '.lnk')
$taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $wrapperPath + '" -NodePath "' + $NodePath + '"'

if (-not ('DrawStudioCommandLine' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DrawStudioCommandLine {
  [DllImport("shell32.dll", SetLastError = true)]
  static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Parse(string command) {
    int count;
    IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) { return new string[0]; }
    try {
      string[] arguments = new string[count];
      for (int index = 0; index < count; index++) {
        arguments[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * IntPtr.Size));
      }
      return arguments;
    } finally { LocalFree(memory); }
  }
}
'@
}

function Get-OwnedTask {
  $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $task) { return $null }
  [xml]$definition = Export-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
  $namespace = New-Object Xml.XmlNamespaceManager($definition.NameTable)
  $namespace.AddNamespace('task', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
  $source = $definition.SelectSingleNode('/task:Task/task:RegistrationInfo/task:Source', $namespace)
  $exec = $definition.SelectSingleNode('/task:Task/task:Actions/task:Exec', $namespace)
  $taskUser = $definition.SelectSingleNode('/task:Task/task:Principals/task:Principal/task:UserId', $namespace)
  $taskCommand = $exec.SelectSingleNode('task:Command', $namespace).InnerText
  $savedArguments = $exec.SelectSingleNode('task:Arguments', $namespace).InnerText
  $arguments = [DrawStudioCommandLine]::Parse('powershell.exe ' + $savedArguments)
  $fileIndex = [Array]::IndexOf($arguments, '-File')
  if (-not $source -or $source.InnerText -ne $sourceSignature -or
      $taskCommand -ine $powerShellPath -or $fileIndex -lt 0 -or
      ($fileIndex + 1) -ge $arguments.Length -or $arguments[$fileIndex + 1] -ine $wrapperPath -or
      -not $taskUser -or $taskUser.InnerText -ne $userSid) {
    throw 'A different scheduled task already uses the Draw studio Local Canvas name. It was left unchanged.'
  }
  return $task
}

function Get-OwnedShortcut {
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { return $null }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $arguments = [DrawStudioCommandLine]::Parse('powershell.exe ' + $shortcut.Arguments)
  $fileIndex = [Array]::IndexOf($arguments, '-File')
  if ($shortcut.Description -ne $sourceSignature -or $shortcut.TargetPath -ine $powerShellPath -or
      $fileIndex -lt 0 -or ($fileIndex + 1) -ge $arguments.Length -or
      $arguments[$fileIndex + 1] -ine $wrapperPath) {
    throw 'A different startup shortcut already uses the Draw studio Local Canvas name. It was left unchanged.'
  }
  return $shortcut
}

function Read-ManagedStatus {
  if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { return $null }
  try {
    $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    if ($status.root -ine $projectRoot) { return $null }
    return $status
  } catch { return $null }
}

function Get-ManagedNodeProcess([object]$ProcessId, [string]$ExpectedScript) {
  if (-not $ProcessId -or [long]$ProcessId -le 0) { return $null }
  $process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [long]$ProcessId) -ErrorAction SilentlyContinue
  if (-not $process -or $process.Name -ine 'node.exe' -or -not $process.CommandLine) { return $null }
  $arguments = [DrawStudioCommandLine]::Parse($process.CommandLine)
  # This service invokes Node with its script as the first argument; no fuzzy command matching.
  if ($arguments.Length -lt 2 -or $arguments[1] -ine $ExpectedScript) { return $null }
  if ($ExpectedScript -ieq $vitePath) {
    $expectedArguments = @('preview', '--host', '127.0.0.1', '--port', '1420', '--strictPort')
    if ($arguments.Length -ne (2 + $expectedArguments.Length)) { return $null }
    for ($index = 0; $index -lt $expectedArguments.Length; $index++) {
      if ($arguments[$index + 2] -cne $expectedArguments[$index]) { return $null }
    }
  }
  return $process
}

function Test-AccessDenied([object]$Record) {
  $exception = $Record.Exception
  while ($exception) {
    if ($exception -is [UnauthorizedAccessException] -or $exception.HResult -eq -2147024891) { return $true }
    $exception = $exception.InnerException
  }
  return ($Record.FullyQualifiedErrorId -match 'AccessDenied|UnauthorizedAccess|0x80070005')
}

function Start-DetachedWrapper {
  # Winmgmt creates this process outside the calling terminal/Codex process tree.
  $startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
  $startup.ShowWindow = 0
  $command = '"' + $powerShellPath + '" ' + $taskArguments
  $created = ([wmiclass]'Win32_Process').Create($command, $projectRoot, $startup)
  if ($created.ReturnValue -ne 0) { throw ('Unable to start the independent local canvas service. Windows error ' + $created.ReturnValue + '.') }
}

function Get-ServiceReport([string]$RequestedAction, [string]$FallbackReason = '') {
  $task = Get-OwnedTask
  $shortcut = Get-OwnedShortcut
  $status = Read-ManagedStatus
  $supervisor = $null
  $server = $null
  if ($status) {
    $supervisor = Get-ManagedNodeProcess $status.supervisorPid $supervisorPath
    if ($status.ownsServer) { $server = Get-ManagedNodeProcess $status.serverPid $vitePath }
  }
  $mode = 'none'
  if ($task) { $mode = 'scheduled-task' }
  elseif ($shortcut) { $mode = 'user-startup' }
  [ordered]@{
    action = $RequestedAction
    taskName = $taskName
    root = $projectRoot
    url = 'http://127.0.0.1:1420/'
    mode = $mode
    disabled = (Test-Path -LiteralPath $disabledPath)
    taskState = $(if ($task) { [string]$task.State } else { $null })
    taskEnabled = $(if ($task) { [bool]$task.Settings.Enabled } else { $false })
    supervisorPid = $(if ($supervisor) { [long]$supervisor.ProcessId } else { $null })
    serverPid = $(if ($server) { [long]$server.ProcessId } elseif ($status -and -not $status.ownsServer) { $status.serverPid } else { $null })
    ownsServer = [bool]($status -and $status.ownsServer -and $server)
    phase = $(if ($status) { $status.phase } else { 'not-started' })
    updatedAt = $(if ($status) { $status.updatedAt } else { $null })
    fallbackReason = $(if ($FallbackReason) { $FallbackReason } else { $null })
  } | ConvertTo-Json -Depth 5
}

if ($Action -eq 'Status') { Get-ServiceReport 'Status'; exit 0 }

if ($Action -eq 'Stop' -or $Action -eq 'Remove') {
  # Ownership is verified before altering registration or stopping any process.
  $task = Get-OwnedTask
  $shortcut = Get-OwnedShortcut
  $status = Read-ManagedStatus
  New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
  [IO.File]::WriteAllText($disabledPath, [DateTime]::UtcNow.ToString('o'))
  if ($task) {
    Disable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
    Stop-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
  }
  if ($status) {
    $supervisor = Get-ManagedNodeProcess $status.supervisorPid $supervisorPath
    if ($supervisor) { Stop-Process -Id $supervisor.ProcessId -ErrorAction SilentlyContinue }
    if ($status.ownsServer) {
      $server = Get-ManagedNodeProcess $status.serverPid $vitePath
      if ($server) { Stop-Process -Id $server.ProcessId -ErrorAction SilentlyContinue }
    }
  }
  if ($Action -eq 'Remove') {
    if ($task) { Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false }
    if ($shortcut) { Remove-Item -LiteralPath $shortcutPath }
  }
  Get-ServiceReport $Action
  exit 0
}

foreach ($requiredFile in @((Join-Path $projectRoot 'dist\index.html'), $vitePath, $supervisorPath, $wrapperPath)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw ('Required local canvas file is missing: ' + $requiredFile) }
}

$existingTask = Get-OwnedTask
$existingShortcut = Get-OwnedShortcut
New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
if (Test-Path -LiteralPath $disabledPath) { Remove-Item -LiteralPath $disabledPath }

$escape = { param([string]$Value) [Security.SecurityElement]::Escape($Value) }
$escapedSid = & $escape $userSid
$escapedSource = & $escape $sourceSignature
$escapedCommand = & $escape $powerShellPath
$escapedArguments = & $escape $taskArguments
$escapedWorkingDirectory = & $escape $projectRoot
$boundary = [DateTime]::Now.AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
$taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Keep the local Draw studio canvas available independently of Codex.</Description><Source>$escapedSource</Source></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$escapedSid</UserId></LogonTrigger>
    <TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>$boundary</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="CurrentUser"><UserId>$escapedSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>
  <Actions Context="CurrentUser"><Exec><Command>$escapedCommand</Command><Arguments>$escapedArguments</Arguments><WorkingDirectory>$escapedWorkingDirectory</WorkingDirectory></Exec></Actions>
</Task>
"@

$fallbackReason = ''
try {
  Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $taskXml -Force -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
  # Replace an earlier owned fallback only after scheduled launch succeeds.
  if ($existingShortcut) { Remove-Item -LiteralPath $shortcutPath }
} catch {
  if (-not (Test-AccessDenied $_) -or $existingTask) { throw }
  $fallbackReason = 'Windows denied normal-user task registration; using the current user Startup folder and a detached Windows launcher.'
  New-Item -ItemType Directory -Path $startupDirectory -Force | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $powerShellPath
  $shortcut.Arguments = $taskArguments
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = $sourceSignature
  $shortcut.Save()
  Start-DetachedWrapper
}

# Give the detached service a bounded chance to publish its initial status.
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  $status = Read-ManagedStatus
  if ($status -and (Get-ManagedNodeProcess $status.supervisorPid $supervisorPath)) { break }
  Start-Sleep -Milliseconds 100
}
Get-ServiceReport 'Ensure' $fallbackReason
