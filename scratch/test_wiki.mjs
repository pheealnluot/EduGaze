// Built-in fetch used

async function testSearch(query) {
    const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=600&format=json&origin=*`;
    console.log(`Testing query: ${query}`);
    const resp = await fetch(apiUrl);
    const data = await resp.json();
    const pages = data?.query?.pages;
    if (!pages) {
        console.log("No pages found.");
        return;
    }

    const candidates = Object.values(pages).map(p => {
        const ii = p?.imageinfo?.[0];
        if (!ii) return null;
        return {
            title: p.title,
            mime: ii.mime,
            thumburl: ii.thumburl,
            width: ii.width
        };
    }).filter(Boolean);

    console.log(`Found ${candidates.length} candidates:`);
    candidates.forEach((c, i) => {
        console.log(`${i+1}. ${c.title} (${c.mime}) - ${c.width}px`);
        console.log(`   URL: ${c.thumburl}`);
    });
}

testSearch("ruler");
