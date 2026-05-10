
# patch_topic_field.ps1
# Replaces the simple qs-find-topic text input with an enhanced combobox
# that has a clear button and persistent keyword dropdown list.

$filePath = "public\index.html"
$content = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)

$em_dash = [char]0x2014
$ellipsis = [char]0x2026

$old = @"
<div style="display:flex;align-items:center;gap:8px;background:#1e293b;border-radius:0.85rem;border:1.5px solid rgba(139,92,246,0.2);padding:6px 10px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.8;">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input type="text" id="qs-find-topic" placeholder="Topic or keyword (optional) $em_dash e.g. space, ocean, rainforest$ellipsis"
                  style="flex:1;background:transparent;border:none;outline:none;font-size:0.72rem;font-weight:600;color:#e2e8f0;"
                  autocomplete="off" spellcheck="false">
              </div>
"@

# Normalize line endings
$old = $old.Replace("`r`n", "`r`n").TrimEnd()

Write-Host "Old found: $($content.Contains($old))"

# If not found try with `n only
if (-not $content.Contains($old)) {
  $old2 = $old.Replace("`r`n", "`n")
  Write-Host "Old (LF) found: $($content.Contains($old2))"
}
