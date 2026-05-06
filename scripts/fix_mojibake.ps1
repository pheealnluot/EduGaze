$filePath = "d:\Dropbox\Dropbox\CNS\COding\EduGaze\public\js\app.js"
$content = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)

# Fix mojibake sequences
$content = $content -replace [regex]::Escape("Ã¢ÂÂ­ Skip to Quiz"), "⏭ Skip to Quiz"
$content = $content -replace [regex]::Escape("Ã¢ÂÂ³ Please waitÃ¢â‚¬Â¦"), "⏳ Please wait…"
$content = $content -replace [regex]::Escape("Ã¢ÂÂ³ FinalisingÃ¢â‚¬Â¦"), "⏳ Finalising…"
$content = $content -replace [regex]::Escape("Ã¢Å¡Â  Generation failed Ã¢â‚¬â€ Cancel"), "⚠ Generation failed — Cancel"
$content = $content -replace [regex]::Escape("Ã¢Å`"â€¢ Cancel"), "✕ Cancel"
$content = $content -replace [regex]::Escape("Generating questionsÃ¢â‚¬Â¦"), "Generating questions…"
$content = $content -replace [regex]::Escape("Video unavailable Ã¢â‚¬â€ please try another URL"), "Video unavailable — please try another URL"
$content = $content -replace [regex]::Escape("Ã¢Å¡Â  Could not detect a YouTube video or image URL."), "⚠ Could not detect a YouTube video or image URL."
$content = $content -replace [regex]::Escape("Ã¢Å`"â€œ YouTube video detected"), "✔ YouTube video detected"
$content = $content -replace [regex]::Escape("Ã¢Å`"â€œ Image URL detected Ã¢â‚¬â€ will show alongside questions."), "✔ Image URL detected — will show alongside questions."
$content = $content -replace [regex]::Escape("Ã¢Å¡Â  Please paste a valid YouTube or image URL first."), "⚠ Please paste a valid YouTube or image URL first."
$content = $content -replace [regex]::Escape("Ã°Å¸â€`"Â¼"), "🗼"
$content = $content -replace [regex]::Escape("YouTube Ã¢â‚¬â€ ID:"), "YouTube — ID:"
$content = $content -replace [regex]::Escape("Ã¢â‚¬Â¦"), "…"

[System.IO.File]::WriteAllText($filePath, $content, [System.Text.Encoding]::UTF8)
Write-Host "Done fixing mojibake in app.js"
