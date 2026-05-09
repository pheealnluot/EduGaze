const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const GEMINI_MODEL = 'gemini-2.5-flash';

function _removeOverlapping(boxes, maxCount, iouThreshold = 0.15) {
  if (boxes.length <= 1) return boxes.slice(0, maxCount);
  const accepted = [boxes[0]];
  for (let i = 1; i < boxes.length && accepted.length < maxCount; i++) {
    const b = boxes[i]; let overlaps = false;
    for (const a of accepted) {
      const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
      const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
      const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const union = a.w * a.h + b.w * b.h - interArea;
      const iou = union > 0 ? interArea / union : 0;
      const cxA = a.x + a.w/2, cyA = a.y + a.h/2, cxB = b.x + b.w/2, cyB = b.y + b.h/2;
      if (iou > iouThreshold || Math.sqrt((cxA-cxB)**2+(cyA-cyB)**2) < 0.18) { overlaps = true; break; }
    }
    if (!overlaps) accepted.push(b);
  }
  return accepted;
}

exports.spotCharGenerate = onRequest(
  { secrets: [geminiApiKey], cors: true, invoker: 'public', timeoutSeconds: 120, memory: '512MiB', region: 'us-central1' },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.set('Access-Control-Allow-Methods','POST'); res.set('Access-Control-Allow-Headers','Content-Type'); return res.status(204).send(''); }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const apiKey = geminiApiKey.value();
    if (!apiKey) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const GEMINI_IMAGE_GEN_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${apiKey}`;


    const { theme: rawTheme, scene: rawScene, otherCount = 10, findCount = 1, bgStyle = 'kids', describeVisually = false, describeSceneVisually = false } = req.body || {};
    if (!rawTheme || !rawScene) return res.status(400).json({ error: 'theme and scene are required' });

    let theme = rawTheme, scene = rawScene;

    // Optional: translate franchise names to visual descriptions
    const _translateVisual = async (name, type) => {
      const typePrompt = type === 'character'
        ? 'Convert this franchise/character name into a VISUAL-ONLY description.\nDescribe ONLY what the character(s) LOOK like: body shape, clothing, colours, accessories, distinctive features.'
        : 'Convert this world/location name into a VISUAL-ONLY environment description.\nDescribe ONLY what the place LOOKS like: architecture, landscape, colours, lighting, atmosphere, key visual elements.';
      try {
        console.log(`[SpotChar] Translating ${type}: "${name}"`);
        const resp = await fetch(GEMINI_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text:
              `You are a visual description translator for an AI image generator.\n${typePrompt}\nDO NOT mention the franchise name, studio, or any copyrighted terms.\nKeep it concise (1-2 sentences max).\n\nName: "${name}"\n\nVisual description:`
            }] }],
            generationConfig: { maxOutputTokens: 150, temperature: 0.2 },
          }),
        });
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text && text.length > 10) { console.log(`[SpotChar] ✅ ${type} translated to: "${text}"`); return text; }
      } catch (e) { console.warn(`[SpotChar] ${type} translation failed: ${e.message}`); }
      return null;
    };

    const [translatedTheme, translatedScene] = await Promise.all([
      describeVisually ? _translateVisual(rawTheme, 'character') : Promise.resolve(null),
      describeSceneVisually ? _translateVisual(rawScene, 'scene') : Promise.resolve(null),
    ]);
    if (translatedTheme) theme = translatedTheme;
    if (translatedScene) scene = translatedScene;

    const bgCount = Math.min(Math.max(parseInt(otherCount) || 10, 2), 50);
    const findN = Math.min(Math.max(parseInt(findCount) || 1, 1), 5);


    // Background art style mapping
    const BG_STYLES = {
      wally: {
        prefix: 'CLASSIC "WHERE\'S WALLY / WHERE\'S WALDO" STYLE ILLUSTRATION — ',
        suffix: 'Art style: dense, meticulously detailed hand-drawn crowd illustration exactly like Martin Handford\'s Where\'s Wally books. Overhead or slightly elevated viewpoint over a massive, packed crowd scene. Hundreds of tiny characters fill every inch of the image with no empty space. Bold, flat colours with strong black outlines; cheerful, holiday-fair atmosphere; lots of props, stalls, tents, and activities. The target character(s) must blend into the busy crowd but still be findable. Flat 2-D graphic novel quality.',
      },
      realistic: {
        prefix: 'FULLY PHOTOREALISTIC — ',
        suffix: 'Art style: EVERYTHING in this image must be STRICTLY HYPER-REALISTIC — rendered as a high-resolution photograph or cinematic 3D render. This includes the background, environment, AND all characters (both background and target). Use cinematic lighting, volumetric fog, ray-traced global illumination, physical depth of field (bokeh), real-world textures (skin, fur, fabric, brick, glass, wood, leaves, water reflections), atmospheric perspective, and natural shadows. Characters must look like real animals, real people, or physically plausible 3D-rendered creatures — NOT cartoons, NOT illustrations, NOT anime. The entire scene should look like a high-end nature documentary, wildlife photography, or cinematic CGI film frame. NO cartoon outlines, NO flat colours, NO cel-shading, NO illustrated style anywhere in the image.',
      },
      stylistic: {
        prefix: 'BOLD STYLISTIC DIGITAL ILLUSTRATION — ',
        suffix: 'Art style: modern stylistic concept art with a strong graphic design sensibility. Vibrant, curated colour palette (teals, deep purples, warm golds); sweeping compositional shapes; semi-flat characters with expressive silhouettes and subtle gradients. Inspired by award-winning children\'s book covers and animated film concept art. Clean, intentional design language. Highly decorative and visually striking.',
      },
      comic: {
        prefix: 'BOLD AMERICAN COMIC BOOK STYLE — ',
        suffix: 'Art style: classic superhero comic-book panel art. Strong, dynamic ink outlines with Ben-Day dot shading and halftone textures. Bold primary colours: red, blue, yellow, green. Dramatic low-angle or dynamic perspective; action lines and energy bursts. Inspired by classic Marvel/DC golden-age comic books. High contrast; no gradients; print-style flat ink look.',
      },
      kids: {
        prefix: 'JOYFUL CHILDREN\'S PICTURE-BOOK ILLUSTRATION — ',
        suffix: 'Art style: warm, friendly children\'s picture-book style. Soft, rounded character designs with expressive faces and chunky proportions suitable for young children. Pastel-leaning palette with bright accent colours; gentle textures like coloured pencil or watercolour washes. Inviting, non-threatening, joyful atmosphere — every detail should make a child smile.',
      },
      scene: {
        prefix: `ART STYLE OF "${scene}" — `,
        suffix: `Art style: Replicate the EXACT visual art style, colour palette, line work, textures, and rendering technique of "${scene}". Study what "${scene}" looks like in its original media and MATCH that style precisely. The entire image — background, environment, AND all characters — must look like it belongs in the world of "${scene}". Match the original art direction as faithfully as possible.`,
      },
      character: {
        prefix: `ART STYLE OF "${theme}" — `,
        suffix: `Art style: Replicate the EXACT visual art style, colour palette, line work, textures, and rendering technique of "${theme}"'s original media. Study what "${theme}" looks like in its source cartoon, anime, film, book, or game and MATCH that style precisely for the ENTIRE image. The entire image — background, environment, AND all characters — must look like it belongs in the world of "${theme}". Match the original art direction as faithfully as possible.`,
      },
    };
    const styleKey = (typeof bgStyle === 'string' && BG_STYLES[bgStyle]) ? bgStyle : 'kids';
    const styleData = BG_STYLES[styleKey];

    console.log(`[SpotChar] Model: FREE (Gemini Flash Image) | Style: ${styleKey}`);

    const styleQuality = {
      realistic: 'CRITICAL: The ENTIRE image — background AND all characters — must be STRICTLY PHOTOREALISTIC. No cartoons, no illustrations, no anime. Everything must look like a real photograph or cinematic 3D render.',
      stylistic: 'Bold graphic design aesthetic throughout — intentional composition, curated colour palette, expressive silhouettes.',
      comic: 'Classic comic-book art throughout — bold ink outlines, halftone shading, flat primary colours.',
      wally: 'Dense hand-drawn crowd illustration style throughout — hundreds of tiny characters, bold flat colours, packed with meticulous detail.',
      kids: "Warm children's picture-book illustration throughout — soft rounded characters, pastel palette, colourful, crowded, joyful and inviting.",
      scene: `The ENTIRE image must faithfully replicate the art style of "${scene}".`,
      character: `The ENTIRE image must faithfully replicate the art style of "${theme}"'s original media.`,
    }[styleKey] || 'High detail, colourful, crowded, joyful.';

    const positionZones = [
      { label: 'LEFT third (x ≈ 15–30%)' }, { label: 'CENTRE (x ≈ 45–55%)' },
      { label: 'RIGHT third (x ≈ 70–85%)' }, { label: 'UPPER-LEFT (x ≈ 20–35%, y ≈ 20–40%)' },
      { label: 'LOWER-RIGHT (x ≈ 65–80%, y ≈ 60–80%)' },
    ];
    const positionList = Array.from({length: findN}, (_, i) =>
      `  Character ${i+1}: place in the ${positionZones[i % positionZones.length].label}`
    ).join('\n');

    const imagePrompt =
      `${styleData.suffix}\n${styleData.prefix}` +
      `HORIZONTAL WIDESCREEN LANDSCAPE IMAGE ONLY — 16:9 aspect ratio like a cinema screen. DO NOT generate a portrait or square image under any circumstances. ` +
      `Draw an original, richly detailed background scene set in the world of "${scene}". ` +
      `Fill this scene with ${bgCount} unique original characters whose visual design fits the world of "${scene}" — each clearly different from one another, no two alike. ` +
      `ABSOLUTE RULE: NONE of these ${bgCount} background characters may look like, resemble, or be confused with "${theme}". ` +
      `Background characters must be COMPLETELY DIFFERENT species/types/shapes from "${theme}" — for example if "${theme}" is a butterfly, do NOT draw ANY other butterflies, moths, or winged insects anywhere in the scene. ` +
      `CRITICALLY IMPORTANT: draw EXACTLY ${findN} — and ABSOLUTELY NO MORE THAN ${findN} — CHARACTER(S) inspired by "${theme}". ` +
      `COUNT CAREFULLY: the total number of "${theme}"-like characters in the ENTIRE image must be PRECISELY ${findN}. ` +
      `If you draw even one extra, the image is WRONG. Do NOT sneak extra "${theme}" characters into the background, edges, or sky. ` +
      `SPREAD THEM FAR APART across the scene — they must NOT be near each other or in the same area.\n` +
      `Place them at these SPECIFIC positions (mandatory):\n${positionList}\n` +
      `NO-OVERLAP RULE: Each "${theme}" character must be in a COMPLETELY DIFFERENT region of the image. ` +
      `The distance between any two "${theme}" characters must be at least 25% of the image width. ` +
      `They must NEVER be adjacent, clustered, or within the same quadrant of the image. ` +
      `If you are placing 3 characters, one goes LEFT, one goes CENTRE, one goes RIGHT — no exceptions.\n` +
      `These "${theme}"-inspired characters MUST:\n` +
      `- Be clearly recognisable and visible to a 9-year-old child\n` +
      `- Be at least medium-sized (not tiny or partially hidden)\n` +
      `- Look NOTICEABLY different in colour, shape, or costume from the "${scene}" background characters\n` +
      `- NOT be obscured, blended into backgrounds, or hidden behind objects\n` +
      `- Be placed in the FOREGROUND or MID-GROUND of the scene, NOT far in the background\n` +
      `- Be ENTIRELY AND COMPLETELY INSIDE the image — NO character body parts cropped by the frame edge\n` +
      `- Be placed at least 15% away from ALL four edges of the image (top, bottom, left, right)\n` +
      `- NEVER be placed in a corner or along any image border\n` +
      `- NEVER overlap or touch another "${theme}" character — keep at least 20% image-width apart\n` +
      `Keep the top-left 15% of the image free of any "${theme}"-inspired characters (reserved for UI). ` +
      `No text, no labels, no watermarks.\n` +
      `After generating the image, output a JSON array describing where you placed each "${theme}" character. ` +
      `Use the format: [{"box_2d":[ymin, xmin, ymax, xmax], "label":"${theme}"}] ` +
      `where each value is an integer from 0 to 1000 (0 = top/left edge, 1000 = bottom/right edge). ` +
      `The box should tightly enclose each character from head to feet.\n` +
      `${styleQuality}`;

    console.log(`[SpotChar] Generating: ${findN}x "${theme}" in "${scene}" + ${bgCount} bg chars (style: ${styleKey})`);

    const _buildProhibitedMsg = (rawReason) => {
      const tips = [
        `"${rawTheme}" or "${rawScene}" may reference a copyrighted character or brand name`,
        `The combination may depict real-world people, celebrities, or public figures`,
        `The prompt may contain content perceived as violent, sexual, or unsafe for children`,
        `Named franchises (Disney, Peppa Pig, etc.) are often blocked — try describing the visual style instead`,
      ];
      return `❌ Blocked by AI content filter for Theme: "${rawTheme}" / Scene: "${rawScene}".\nReason code: ${rawReason}.\nCommon causes:\n` +
        tips.map((t, i) => `  ${i+1}. ${t}`).join('\n');
    };

    let imageBase64 = null, mimeType = 'image/png', bboxes = [];
    try {
      // ── Gemini 3.1 Flash Image 🍌 — /generateContent endpoint ──────────
      const imgResp = await fetch(GEMINI_IMAGE_GEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: imagePrompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE', 'TEXT'],
            imageConfig: { aspectRatio: '16:9' },
          },
        }),
      });
      const imgData = await imgResp.json();
      if (!imgResp.ok) {
        const errMsg = imgData?.error?.message || 'Image generation failed';
        return res.status(502).json({ error: errMsg.includes('PROHIBITED') ? _buildProhibitedMsg(errMsg) : errMsg });
      }
      const parts = imgData?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
      if (!imgPart) {
        const textPart = parts.find(p => p.text);
        const finishReason = imgData?.candidates?.[0]?.finishReason || '';
        const rawReason = textPart?.text || finishReason || 'No image returned';
        const isBlocked = rawReason.includes('PROHIBITED') || finishReason === 'SAFETY' || finishReason === 'OTHER';
        const reason = isBlocked ? _buildProhibitedMsg(rawReason) : rawReason;
        return res.status(502).json({ error: isBlocked ? reason : `Image not generated: ${reason}. Try different theme/scene names.` });
      }
      imageBase64 = imgPart.inlineData.data;
      mimeType = imgPart.inlineData.mimeType || 'image/png';
      console.log(`[SpotChar] ✅ Gemini Flash Image generated (${Math.round(imageBase64.length/1024)}KB)`);

      // Try to extract bboxes from generation text
      const genTextPart = parts.find(p => p.text);
      if (genTextPart?.text) {
        console.log(`[SpotChar] Generation text: ${genTextPart.text.slice(0, 300)}`);
        const cleanGenText = genTextPart.text.replace(/```(?:json)?\s*/gi, '').trim();
        const genArrMatch = cleanGenText.match(/\[[\s\S]*?\]/);
        if (genArrMatch) {
          try {
            const genParsed = JSON.parse(genArrMatch[0]);
            const MARGIN = 0.12;
            const genBboxes = genParsed
              .filter(b => Array.isArray(b.box_2d) && b.box_2d.length >= 4)
              .map(b => {
                const [ymin, xmin, ymax, xmax] = b.box_2d;
                const x = xmin/1000, y = ymin/1000;
                const w = Math.max(0.05, Math.min(0.45, (xmax-xmin)/1000));
                const h = Math.max(0.05, Math.min(0.45, (ymax-ymin)/1000));
                let cx = Math.max(MARGIN, Math.min(1-MARGIN, x+w/2));
                let cy = Math.max(MARGIN, Math.min(1-MARGIN, y+h/2));
                return { x: Math.max(0.01, Math.min(1-w-0.01, cx-w/2)), y: Math.max(0.01, Math.min(1-h-0.01, cy-h/2)), w, h, cx, cy };
              })
              .filter(b => b.cx >= MARGIN && b.cx <= 1-MARGIN && b.cy >= MARGIN && b.cy <= 1-MARGIN)
              .slice(0, findN)
              .map(({ x, y, w, h }) => ({ x, y, w, h }));
            if (genBboxes.length > 0) {
              bboxes = genBboxes;
              console.log(`[SpotChar] ✅ Extracted ${bboxes.length} bbox(es) from generation text`);
            }
          } catch (e) { console.warn(`[SpotChar] Failed to parse generation bbox JSON:`, e.message); }
        }
      }
    } catch (err) {
      return res.status(502).json({ error: `Image generation failed: ${err.message}` });
    }

    // Step 2: Vision-based bbox locator (fallback)
    if (bboxes.length > 0) {
      console.log(`[SpotChar] Skipping vision — ${bboxes.length} bbox(es) already extracted`);
    } else {
      try {
        const visionPrompt =
          `Look carefully at this image. It is a "Spot the Character" game scene.\n` +
          `It should contain ${findN} character(s) visually inspired by "${theme}".\n\n` +
          `STEP 1 — Think about what a "${theme}"-inspired character looks LIKE visually:\n` +
          `Consider distinctive features: body shape, colours, markings, clothing, size.\n` +
          `Do NOT report buildings, props, signs, windows, or background scenery — only living character bodies.\n\n` +
          `STEP 2 — Find and locate each "${theme}"-inspired character you can CLEARLY SEE.\n` +
          `For each one, return a bounding box as [ymin, xmin, ymax, xmax] where each value is\n` +
          `an integer from 0 to 1000 (0 = top/left edge, 1000 = bottom/right edge).\n` +
          `Also include a "confidence" score from 0.0 to 1.0.\n\n` +
          `ANTI-HALLUCINATION RULES:\n` +
          `- You MUST be at least 75% certain that each character truly matches "${theme}"\n` +
          `- Report FEWER characters rather than hallucinate extras — return [] rather than a wrong detection\n` +
          `- Maximum ${findN} character(s). Only include entries with confidence >= 0.75\n\n` +
          `Return ONLY a JSON array:\n[{"box_2d":[ymin, xmin, ymax, xmax],"label":"${theme}","confidence":0.9}]`;

        const vResp = await fetch(GEMINI_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(45000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [
              { inlineData: { mimeType, data: imageBase64 } },
              { text: visionPrompt },
            ]}],
            generationConfig: { thinkingConfig: { thinkingBudget: 4096 }, maxOutputTokens: 1024 },
          }),
        });
        const vData = await vResp.json();
        const rawText = (vData?.candidates?.[0]?.content?.parts || [])
          .filter(p => p.text && !p.thought).map(p => p.text).join('');
        console.log(`[SpotChar] Vision raw: ${rawText.slice(0, 300)}`);
        const arrMatch = rawText.match(/\[[\s\S]*?\]/);
        if (arrMatch) {
          const parsed = JSON.parse(arrMatch[0]);
          const MARGIN = 0.12, CONFIDENCE_MIN = 0.75;
          const converted = parsed
            .filter(b => Array.isArray(b.box_2d) && b.box_2d.length >= 4 && (typeof b.confidence !== 'number' || b.confidence >= CONFIDENCE_MIN))
            .map(b => {
              const [ymin, xmin, ymax, xmax] = b.box_2d;
              const x = xmin/1000, y = ymin/1000, w = (xmax-xmin)/1000, h = (ymax-ymin)/1000;
              return { x, y, w, h, cx: x+w/2, cy: y+h/2, confidence: b.confidence };
            });
          const normalised = converted.map(b => {
            let { cx, cy, w, h } = b;
            cx = Math.max(MARGIN, Math.min(1-MARGIN, cx));
            cy = Math.max(MARGIN, Math.min(1-MARGIN, cy));
            w = Math.max(0.05, Math.min(0.45, w));
            h = Math.max(0.05, Math.min(0.45, h));
            const x = Math.max(0.01, Math.min(1-w-0.01, cx-w/2));
            const y = Math.max(0.01, Math.min(1-h-0.01, cy-h/2));
            return { x, y, w, h, cx, cy };
          });
          const safeBoxes = normalised
            .filter(b => b.cx >= MARGIN && b.cx <= 1-MARGIN && b.cy >= MARGIN && b.cy <= 1-MARGIN)
            .map(({ x, y, w, h }) => ({ x, y, w, h }));
          bboxes = _removeOverlapping(safeBoxes, findN);
          console.log(`[SpotChar] ✅ Found ${bboxes.length} bbox(es) via vision`);
        }
      } catch (err) { console.warn('[SpotChar] Vision bbox failed (non-fatal):', err.message); }
    }

    if (bboxes.length > 1) bboxes = _removeOverlapping(bboxes, findN);

    // Fallback: evenly spread bboxes if vision failed
    if (bboxes.length === 0) {
      const step = 1 / (findN + 1);
      bboxes = Array.from({ length: findN }, (_, i) => ({ x: step*(i+1)-0.06, y: 0.35, w: 0.12, h: 0.25 }));
    }

    res.json({ imageData: imageBase64, mimeType, bboxes, theme: rawTheme, findCount: findN });
  }
);
