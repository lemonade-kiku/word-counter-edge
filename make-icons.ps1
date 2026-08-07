# Generate extension icons (16 / 48 / 128) - blue circle with white "字"
Add-Type -AssemblyName System.Drawing
$dir = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

foreach ($s in 16, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 26, 115, 232))
    $circle = New-Object System.Drawing.RectangleF(0.5, 0.5, ($s - 1), ($s - 1))
    $g.FillEllipse($brush, $circle)

    $font = New-Object System.Drawing.Font('Microsoft YaHei', [Math]::Round($s * 0.62), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = 'Center'
    $sf.LineAlignment = 'Center'
    $textRect = New-Object System.Drawing.RectangleF(0, (-$s * 0.06), $s, $s)
    $g.DrawString([char]0x5B57, $font, [System.Drawing.Brushes]::White, $textRect, $sf)

    $sf.Dispose()
    $font.Dispose()
    $brush.Dispose()
    $g.Dispose()
    $bmp.Save((Join-Path $dir "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

Write-Output 'Icons generated:'
Get-ChildItem $dir | Select-Object Name, Length
