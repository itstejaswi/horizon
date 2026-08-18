Add-Type -AssemblyName System.Drawing

# The captures come out of the browser as PNG, which stores a photograph of a
# gradient badly: half a megabyte for a screenshot nobody will download twice.
# Re-encoded here at high quality, with no resizing at all -- every pixel is
# still the one the browser drew.
$QUALITY = 92
$DIR = "C:\Users\tejaswic\dev\horizon\docs\assets"

$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
           Where-Object { $_.MimeType -eq "image/jpeg" }

foreach ($png in Get-ChildItem "$DIR\*.png") {
  $src = New-Object System.Drawing.Bitmap($png.FullName)

  # Drawn onto an opaque surface first: JPEG has no alpha, and a transparent
  # source would otherwise composite against black.
  $flat = New-Object System.Drawing.Bitmap($src.Width, $src.Height,
    [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($flat)
  $g.DrawImageUnscaled($src, 0, 0)
  $g.Dispose()

  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
    [System.Drawing.Imaging.Encoder]::Quality, [long]$QUALITY)

  $target = [IO.Path]::ChangeExtension($png.FullName, ".jpg")
  $flat.Save($target, $encoder, $params)

  $before = $png.Length / 1KB
  $after = (Get-Item $target).Length / 1KB
  Write-Output ("{0,-26} {1,5:N0} KB -> {2,4:N0} KB   {3}x{4}" -f
    $png.Name, $before, $after, $src.Width, $src.Height)

  $params.Dispose(); $flat.Dispose(); $src.Dispose()
  Remove-Item $png.FullName
}
