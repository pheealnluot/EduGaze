$file = (Resolve-Path 'public\js\app.js').Path
$enc = [System.Text.Encoding]::GetEncoding('ISO-8859-1')
$bytes = [System.IO.File]::ReadAllBytes($file)
$text = $enc.GetString($bytes)

$pattern = [regex]"aBarHint\.textContent = '[^']*';"
$newText = $pattern.Replace($text, "aBarHint.textContent = '>> HOVER TO READ <<';")

$newBytes = $enc.GetBytes($newText)
[System.IO.File]::WriteAllBytes($file, $newBytes)
Write-Output "Done."
