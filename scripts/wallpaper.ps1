<#
  glassboard wallpaper control.

  Uses the IDesktopWallpaper COM interface (Windows 8+) rather than the older
  SystemParametersInfo call, because SPI sets ONE image for every monitor.
  We need per-monitor control so the note card only lands on the primary.

  All COM calls happen inside the C# helper: PowerShell re-wraps returned
  interfaces as System.__ComObject and dispatches via IDispatch, which
  IDesktopWallpaper (IUnknown-only) does not implement.

  Actions:
    -Action list                        enumerate monitors (read-only)
    -Action set -Path <img> [-PrimaryOnly]
#>
[CmdletBinding()]
param(
  [ValidateSet('list','set')] [string]$Action = 'list',
  [string]$Path,
  [switch]$PrimaryOnly,
  [ValidateSet('Center','Tile','Stretch','Fit','Fill','Span')] [string]$Position = 'Fill'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
  // Order here MUST match the COM vtable exactly.
  void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID,
                    [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
  [return: MarshalAs(UnmanagedType.LPWStr)]
  string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
  [return: MarshalAs(UnmanagedType.LPWStr)]
  string GetMonitorDevicePathAt(uint monitorIndex);
  uint GetMonitorDevicePathCount();
  RECT GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
  void SetBackgroundColor(uint color);
  uint GetBackgroundColor();
  void SetPosition(int position);
  int GetPosition();
}

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }

public class MonitorInfo {
  public int Index; public string Id;
  public int Left, Top, Width, Height;
  public bool Primary; public string Image;
}

public static class Wallpaper {
  static readonly Guid CLSID = new Guid("C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD");

  static IDesktopWallpaper Create() {
    return (IDesktopWallpaper)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID));
  }

  public static MonitorInfo[] List() {
    var dw = Create();
    var outp = new List<MonitorInfo>();
    uint count = dw.GetMonitorDevicePathCount();
    for (uint i = 0; i < count; i++) {
      string id = dw.GetMonitorDevicePathAt(i);
      if (string.IsNullOrEmpty(id)) continue;   // stale/detached entries come back empty
      RECT r;
      try { r = dw.GetMonitorRECT(id); }
      catch (COMException) { continue; }        // remembered-but-absent monitor
      outp.Add(new MonitorInfo {
        Index = (int)i, Id = id,
        Left = r.Left, Top = r.Top,
        Width = r.Right - r.Left, Height = r.Bottom - r.Top,
        Primary = (r.Left == 0 && r.Top == 0),
        Image = dw.GetWallpaper(id)
      });
    }
    return outp.ToArray();
  }

  public static string[] Set(string fullPath, bool primaryOnly, int position) {
    var dw = Create();
    dw.SetPosition(position);
    var done = new List<string>();
    foreach (var m in List()) {
      if (primaryOnly && !m.Primary) continue;
      dw.SetWallpaper(m.Id, fullPath);
      done.Add(string.Format("set monitor [{0}] {1}x{2} at ({3},{4}) primary={5}",
                             m.Index, m.Width, m.Height, m.Left, m.Top, m.Primary));
    }
    return done.ToArray();
  }
}
'@

switch ($Action) {
  'list' {
    # JSON, not formatted text: the Node side parses this and paths contain
    # backslashes that no regex should have to survive.
    #
    # -InputObject, NOT a pipe. Piping an array unrolls it, so on a
    # single-monitor machine ConvertTo-Json receives one lone object and
    # emits {...} instead of [...] - and the Node side calls .map on an
    # object and dies. Wrapping the pipeline in @() cannot save it, because
    # the unrolling already happened upstream of the @().
    $rows = @([Wallpaper]::List() | Select-Object Index,Width,Height,Left,Top,Primary,Image)
    ConvertTo-Json -InputObject $rows -Depth 3 -Compress
  }
  'set' {
    if (-not $Path) { throw "-Path is required for -Action set" }
    $full = (Resolve-Path -LiteralPath $Path).Path
    $posMap = @{ Center=0; Tile=1; Stretch=2; Fit=3; Fill=4; Span=5 }
    $res = [Wallpaper]::Set($full, [bool]$PrimaryOnly, $posMap[$Position])
    if (-not $res) { throw "No target monitor matched (primary requested but none at origin)" }
    $res
    "image: $full"
  }
}
