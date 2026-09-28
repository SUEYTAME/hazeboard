# Generates the tray icon. Kept as a script rather than a checked-in binary so
# the icon is reproducible and tweakable alongside the rest of the design.
param([string]$OutDir)
Add-Type -AssemblyName System.Drawing
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [int]($size * 0.10)
  $r   = [int]($size * 0.24)
  $w   = $size - ($pad * 2)

  # Rounded-rect path (the "card")
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $gp.AddArc($pad, $pad, $d, $d, 180, 90)
  $gp.AddArc($pad + $w - $d, $pad, $d, $d, 270, 90)
  $gp.AddArc($pad + $w - $d, $pad + $w - $d, $d, $d, 0, 90)
  $gp.AddArc($pad, $pad + $w - $d, $d, $d, 90, 90)
  $gp.CloseFigure()

  # Frosted fill + warm amber hairline, matching the on-screen card.
  $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(95, 255, 250, 244))
  $g.FillPath($fill, $gp)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(235, 255, 186, 122)), ([single]($size * 0.055))
  $g.DrawPath($pen, $gp)

  # Two "note" lines
  # Amber, not white: the fill is translucent, so white lines disappear on a
  # light taskbar. Amber reads against both light and dark.
  $line = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(240, 240, 158, 92)), ([single]($size * 0.075))
  $line.StartCap = 'Round'; $line.EndCap = 'Round'
  $x1 = $pad + [int]($w * 0.22); $x2 = $pad + [int]($w * 0.78)
  $g.DrawLine($line, $x1, $pad + [int]($w * 0.38), $x2, $pad + [int]($w * 0.38))
  $g.DrawLine($line, $x1, $pad + [int]($w * 0.62), $pad + [int]($w * 0.60), $pad + [int]($w * 0.62))

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $gp.Dispose()
  "wrote $path ($size x $size)"
}

New-Icon 32 (Join-Path $OutDir 'tray.png')
New-Icon 64 (Join-Path $OutDir 'tray@2x.png')
New-Icon 256 (Join-Path $OutDir 'icon.png')
