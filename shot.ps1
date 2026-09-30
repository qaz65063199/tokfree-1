Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'TokFree' }
if ($p) {
  [Win]::ShowWindow($p.MainWindowHandle, 3) | Out-Null
  [Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 900
  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
  $bmp.Save('C:\Users\a4449\Desktop\tokfree\shell_shot3.png')
  Write-Output 'SAVED'
} else { Write-Output 'TOKFREE_NOT_FOUND' }
