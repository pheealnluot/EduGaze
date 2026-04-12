$filePath = "public/index.html"
$content = Get-Content $filePath

# 1. Update celebration friend CSS filter (Line 624)
$content[623] = $content[623] -replace 'filter: drop-shadow\(0 20px 40px rgba\(0,0,0,0.4\)\);', 'filter: drop-shadow(5px 0 0 white) drop-shadow(-5px 0 0 white) drop-shadow(0 5px 0 white) drop-shadow(0 -5px 0 white) drop-shadow(0 20px 40px rgba(0,0,0,0.4));'

# 2. Add collection tracking in spawnPeppaFriend (Line 2357)
$content[2356] = $content[2356] -replace 'peppaScore\+\+;', 'peppaScore++; peppaCollectedFriends.push(friendIdx);'

# 3. Reset collected friends in restartPeppaGame (Line 2480)
$content[2479] = $content[2479] + "`n         peppaCollectedFriends = [];"

$content | Set-Content $filePath
