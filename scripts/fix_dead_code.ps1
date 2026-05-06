$file = 'public\js\app.js'
$lines = Get-Content $file
# Delete lines 7652..7829 (0-indexed: 7651..7828)
# These are: _fitTextToBox duplicate comment + old _compQuizSelectAnswer
# Keep: lines 0..7650 (= 7651 lines) + lines 7829..end
$keep = @($lines[0..7650]) + @($lines[7829..($lines.Length - 1)])
[System.IO.File]::WriteAllLines((Resolve-Path $file), $keep)
Write-Output "Done. New line count: $($keep.Length)"
