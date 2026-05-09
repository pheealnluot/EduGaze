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


  if (!apiKey) return res.status(503).json({ error: 'apiKey not configured' });

  if (!apiKey) return res.status(503).json({ error: 'apiKey not configured' });

  if (!apiKey) return res.status(503).json({ error: 'apiKey not configured' });

  if (!apiKey) return res.status(503).json({ error: 'apiKey not configured' });

  const { theme: rawTheme, scene: rawScene, otherCount = 10, findCount = 1, bgStyle = 'kids', describeVisually = false, describeSceneVisually = false, targetImageUrl } = req.body || {};
  if (!rawTheme || !rawScene) return res.status(400).json({ error: 'theme and scene are required' });

  let inlineTargetImage = null;
  if (targetImageUrl) {
    try {
      const fullPath = path.join(__dirname, 'public', targetImageUrl);
      const fileData = readFileSync(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      let mime = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.webp') mime = 'image/webp';
      inlineTargetImage = { inlineData: { mimeType: mime, data: fileData.toString('base64') } };
      console.log(`[SpotChar] Loaded target image from ${targetImageUrl}`);
    } catch (e) {
      console.warn(`[SpotChar] Failed to load target image ${targetImageUrl}:`, e.message);
    }
  }

  // ── Optional: translate franchise/world names → visual descriptions ────────
  // When enabled, this prevents the franchise's canonical art style from
  // overriding the user's selected art style.
  let theme = rawTheme;
  let scene = rawScene;

  // Helper: call Gemini to translate a name into a visual description
  const _translateVisual = async (name, type) => {
    const typePrompt = type === 'character'
      ? `Convert this franchise/character name into a VISUAL-ONLY description.\n` +
        `Describe ONLY what the character(s) LOOK like: body shape, clothing, colours, accessories, distinctive features.`
      : `Convert this world/location name into a VISUAL-ONLY environment description.\n` +
        `Describe ONLY what the place LOOKS like: architecture, landscape, colours, lighting, atmosphere, key visual elements.`;
    try {
      console.log(`[SpotChar] Translating ${type} → visual description: "${name}"`);
      const resp = await fetch(GEMINI_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text:
            `You are a visual description translator for an AI image generator.\n` +
            `${typePrompt}\n` +
            `DO NOT mention the franchise name, studio, or any copyrighted terms.\n` +
            `Keep it concise (1-2 sentences max).\n\n` +
            `Name: "${name}"\n\n` +
            `Visual description:`
          }] }],
          generationConfig: { maxOutputTokens: 150, temperature: 0.2 },
        }),
      });
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text && text.length > 10) {
        console.log(`[SpotChar] ✅ ${type} translated to: "${text}"`);
        return text;
      }
    } catch (e) {
      console.warn(`[SpotChar] ${type} translation failed (non-fatal): ${e.message}`);
    }
    return null; // fallback to original
  };

  // Run translations in parallel if both are enabled
  const [translatedTheme, translatedScene] = await Promise.all([
    describeVisually      ? _translateVisual(rawTheme, 'character') : Promise.resolve(null),
    describeSceneVisually ? _translateVisual(rawScene, 'scene')     : Promise.resolve(null),
  ]);
  if (translatedTheme) theme = translatedTheme;
  if (translatedScene) scene = translatedScene;

  const bgCount   = Math.min(Math.max(parseInt(otherCount) || 10, 2), 50);
  let findN     = Math.min(Math.max(parseInt(findCount)  || 1,  1), 5);


  // ── Background art style mapping ──────────────────────────────────────────
  const BG_STYLES = {
    wally: {
      prefix:  'CLASSIC "WHERE\'S WALLY / WHERE\'S WALDO" STYLE ILLUSTRATION — ',
      suffix:  'Art style: dense, meticulously detailed hand-drawn crowd illustration exactly like Martin Handford\'s Where\'s Wally books. ' +
               'Overhead or slightly elevated viewpoint over a massive, packed crowd scene. ' +
               'Hundreds of tiny characters fill every inch of the image with no empty space. ' +
               'Bold, flat colours with strong black outlines; cheerful, holiday-fair atmosphere; lots of props, stalls, tents, and activities. ' +
               'The target character(s) must blend into the busy crowd but still be findable. Flat 2-D graphic novel quality.',
    },
    realistic: {
      prefix:  'FULLY PHOTOREALISTIC — ',
      suffix:  'Art style: EVERYTHING in this image must be STRICTLY HYPER-REALISTIC — rendered as a high-resolution photograph or cinematic 3D render. ' +
               'This includes the background, environment, AND all characters (both background and target). ' +
               'Use cinematic lighting, volumetric fog, ray-traced global illumination, physical depth of field (bokeh), ' +
               'real-world textures (skin, fur, fabric, brick, glass, wood, leaves, water reflections), atmospheric perspective, and natural shadows. ' +
               'Characters must look like real animals, real people, or physically plausible 3D-rendered creatures — NOT cartoons, NOT illustrations, NOT anime. ' +
               'The entire scene should look like a high-end nature documentary, wildlife photography, or cinematic CGI film frame. ' +
               'NO cartoon outlines, NO flat colours, NO cel-shading, NO illustrated style anywhere in the image.',
    },
    rogerrabbit: {
      prefix:  'PHOTOREALISTIC BACKGROUND WITH CARTOON TARGETS — ',
      suffix:  'Art style: A HYBRID image. The ENTIRE BACKGROUND, ENVIRONMENT, AND ALL GENERIC BACKGROUND CHARACTERS MUST be STRICTLY HYPER-REALISTIC — rendered as a high-resolution photograph or cinematic 3D render. ' +
               'Use cinematic lighting, real-world textures, physical depth of field, atmospheric perspective, and natural shadows. ' +
               'Background characters must look like real human beings or real animals. ' +
               'However, the TARGET CHARACTERS MUST be rendered as 2D or 3D animated cartoons seamlessly integrated into this highly realistic physical world. ' +
               'CRITICAL RULE: The contrast between the highly realistic photograph background and the cartoon target characters must be stark and obvious.',
    },
    stylistic: {
      prefix:  'BOLD STYLISTIC DIGITAL ILLUSTRATION — ',
      suffix:  'Art style: modern stylistic concept art with a strong graphic design sensibility. ' +
               'Vibrant, curated colour palette (teals, deep purples, warm golds); sweeping compositional shapes; ' +
               'semi-flat characters with expressive silhouettes and subtle gradients. ' +
               'Inspired by award-winning children\'s book covers and animated film concept art. ' +
               'Clean, intentional design language — every element feels hand-composed. Highly decorative and visually striking.',
    },
    comic: {
      prefix:  'BOLD AMERICAN COMIC BOOK STYLE — ',
      suffix:  'Art style: classic superhero comic-book panel art. ' +
               'Strong, dynamic ink outlines with Ben-Day dot shading and halftone textures. ' +
               'Bold primary colours: red, blue, yellow, green. ' +
               'Dramatic low-angle or dynamic perspective; action lines and energy bursts; chunky speech-bubble ready layout. ' +
               'Inspired by classic Marvel/DC golden-age comic books. High contrast; no gradients; print-style flat ink look.',
    },
    kids: {
      prefix:  'JOYFUL CHILDREN\'S PICTURE-BOOK ILLUSTRATION — ',
      suffix:  'Art style: warm, friendly children\'s picture-book style. ' +
               'Soft, rounded character designs with expressive faces and chunky proportions suitable for young children. ' +
               'Pastel-leaning palette with bright accent colours; gentle textures like coloured pencil or watercolour washes. ' +
               'Inspired by the illustration style of Pixar, Studio Ghibli children\'s films, and popular picture-books. ' +
               'Inviting, non-threatening, joyful atmosphere — every detail should make a child smile.',
    },
    scene: {
      prefix:  `ART STYLE OF "${scene}" — `,
      suffix:  `Art style: Replicate the EXACT visual art style, colour palette, line work, textures, and rendering technique of "${scene}". ` +
               `Study what "${scene}" looks like in its original media (animated film, TV show, book, game, etc.) and MATCH that style precisely. ` +
               `For example: if "${scene}" is a Studio Ghibli world, use Ghibli\'s signature watercolour backgrounds with soft edges and luminous skies. ` +
               `If "${scene}" is Minecraft, use blocky pixel-art voxel rendering. If it\'s a Tim Burton film, use gothic, dark, angular stylisation. ` +
               `The entire image — background, environment, AND all characters — must look like it belongs in the world of "${scene}". ` +
               `Match the original art direction as faithfully as possible.`,
    },
    character: {
      prefix:  `ART STYLE OF "${theme}" — `,
      suffix:  `Art style: Replicate the EXACT visual art style, colour palette, line work, textures, and rendering technique of "${theme}"\'s original media. ` +
               `Study what "${theme}" looks like in its source cartoon, anime, film, book, or game and MATCH that style precisely for the ENTIRE image. ` +
               `For example: if "${theme}" is Peppa Pig, use the simple flat 2D vector style with bold outlines and bright primary colours that Peppa Pig uses. ` +
               `If "${theme}" is Pokémon, use the anime cel-shaded style of the Pokémon animated series. ` +
               `If "${theme}" is from a Pixar film, use Pixar\'s 3D rendered CGI style with subsurface scattering and soft ambient occlusion. ` +
               `The entire image — background, environment, AND all characters — must look like it belongs in the world of "${theme}". ` +
               `Match the original art direction as faithfully as possible.`,
    },
  };
  const styleKey   = (typeof bgStyle === 'string' && BG_STYLES[bgStyle]) ? bgStyle : 'kids';
  const styleData  = BG_STYLES[styleKey];

  console.log(`[SpotChar] Model: FREE (Gemini Flash Image) | Style: ${styleKey}`);

    // ── Step 1: Generate landscape scene ──────────────────────────────────────
  // Style description comes FIRST (highest token weight) so the model commits
  // to the art style before reading any scene content.
  // A style-aware quality closer at the end prevents illustration language from
  // overriding photorealistic or other non-cartoon styles.
  const styleQuality = {
    realistic:  'CRITICAL: The ENTIRE image — background AND all characters — must be STRICTLY PHOTOREALISTIC. No cartoons, no illustrations, no anime. Everything must look like a real photograph or cinematic 3D render.',
    rogerrabbit: 'CRITICAL ABSOLUTE RULE: The entire background environment and all non-target background elements MUST be 100% ultra-realistic photorealism, like a real photograph. The ONLY cartoons in the entire image should be the target characters. DO NOT illustrate the background.',
    stylistic:  'Bold graphic design aesthetic throughout — intentional composition, curated colour palette, expressive silhouettes. No cartoons.',
    comic:      'Classic comic-book art throughout — bold ink outlines, halftone shading, flat primary colours. No photorealism, no soft gradients.',
    wally:      'Dense hand-drawn crowd illustration style throughout — hundreds of tiny characters, bold flat colours, packed with meticulous detail.',
    kids:       "Warm children's picture-book illustration throughout — soft rounded characters, pastel palette, colourful, crowded, joyful and inviting.",
    scene:      `The ENTIRE image must faithfully replicate the art style of "${scene}". Every element — background, characters, props — should look like it was drawn/rendered by the original artists of "${scene}".`,
    character:  `The ENTIRE image must faithfully replicate the art style of "${theme}"\'s original media. Every element — background, characters, props — should look like it was drawn/rendered by the original artists of "${theme}".`,
  }[styleKey] || 'High detail, colourful, crowded, joyful.';

  const imagePrompt =
    // ① Full style description FIRST so model commits to it immediately
    `${styleData.suffix}\n` +
    `${styleData.prefix}` +
    // ② Orientation
    `HORIZONTAL WIDESCREEN LANDSCAPE IMAGE ONLY — 16:9 aspect ratio like a cinema screen. ` +
    `DO NOT generate a portrait or square image under any circumstances. ` +
    // ③ Scene content
    (styleKey === 'rogerrabbit'
      ? `STEP 1: Draw a hyper-realistic, physical background environment based on the location: "${scene}". Fill this photorealistic environment with ${bgCount} highly realistic human or animal background characters. NO cartoons allowed in the background or background characters.\nSTEP 2: Superimpose EXACTLY ${findN} 2D/3D animated cartoon characters inspired by "${theme}" into this realistic world. `
      : `Draw an original, richly detailed background scene set in the world of "${scene}". ` +
        `Fill this scene with ${bgCount} unique original characters whose visual design fits the world of "${scene}" — `) +
    `each clearly different from one another, no two alike. ` +
    `ABSOLUTE RULE: NONE of these ${bgCount} background characters may look like, resemble, or be confused with "${theme}". ` +
    `Background characters must be COMPLETELY DIFFERENT species/types/shapes from "${theme}" — ` +
    `for example if "${theme}" is a butterfly, do NOT draw ANY other butterflies, moths, or winged insects anywhere in the scene. ` +
    `CRITICALLY IMPORTANT: draw EXACTLY ${findN} — and ABSOLUTELY NO MORE THAN ${findN} — CHARACTER(S) inspired by "${theme}". ` +
    `COUNT CAREFULLY: the total number of "${theme}"-like characters in the ENTIRE image must be PRECISELY ${findN}. ` +
    `If you draw even one extra, the image is WRONG. Do NOT sneak extra "${theme}" characters into the background, edges, or sky.\n` +
    // ④ Creative placement — spread apart but artistically varied
    `PLACEMENT — be CREATIVE and VARIED with where you place the "${theme}" characters:\n` +
    `- Spread them across DIFFERENT regions of the image (left/centre/right AND foreground/mid-ground/background)\n` +
    `- Use DIFFERENT DEPTHS: one could be small and far away, another large and close, another at mid-distance\n` +
    `- Use INTERESTING POSES: sitting, climbing, peeking from behind something, riding, hanging, looking out a window, on a rooftop, in a tree, on a vehicle, etc.\n` +
    `- INTEGRATE them into the scene naturally — they should be DOING something, not just standing stiffly\n` +
    `- Place them at VARIED heights: street level, elevated (balcony, roof, tree), or below (basement, water, hole)\n` +
    `- Make each one a mini visual discovery — a child should feel clever for spotting them\n` +
    `- Keep at least 20% of the image width between any two "${theme}" characters\n` +
    `- Keep the top-left corner (15%) free (reserved for UI)\n` +
    `KEY RULES for each "${theme}" character:\n` +
    `- Must be clearly recognisable to a 9-year-old child\n` +
    `- Must be ENTIRELY inside the image — no body parts cropped by the frame edge\n` +
    `- Must stand out from generic "${scene}" background characters in colour or shape\n` +
    `- Must NOT be fully hidden behind objects (partially peeking is fine)\n` +
    `No text, no labels, no watermarks.\n` +
    // ⑤ Request character positions as JSON
    `After generating the image, output a JSON array describing where you placed each "${theme}" character. ` +
    `Use the format: [{"box_2d":[ymin, xmin, ymax, xmax], "label":"${theme}"}] ` +
    `where each value is an integer from 0 to 1000 (0 = top/left edge, 1000 = bottom/right edge). ` +
    `The box should tightly enclose each character from head to feet.\n` +
    // ⑤ Style-aware quality closer repeated at end for reinforcement
    `${styleQuality}`;

  console.log(`[SpotChar] Generating: ${findN}x "${theme}"-style in "${scene}"-style + ${bgCount} bg chars (style: ${styleKey})`);

  // ── Helper: human-readable PROHIBITED_CONTENT explanation ──────────────────
  const _buildProhibitedMsg = (rawReason) => {
    // Common reasons the content filter blocks image generation:
    const tips = [
      `“${theme}” or “${scene}” may reference a copyrighted character or brand name`,
      `The combination may depict real-world people, celebrities, or public figures`,
      `The prompt may contain content perceived as violent, sexual, or unsafe for children`,
      `Named franchises (Disney, Peppa Pig, etc.) are often blocked — try describing the visual style instead (e.g. “a pink cartoon pig in a dress” rather than “Peppa Pig”)`,
    ];
    return (
      `❌ Blocked by AI content filter for Theme: “${theme}” / Scene: “${scene}”.\n` +
      `Reason code: ${rawReason}.\n` +
      `Common causes:\n` +
      tips.map((t, i) => `  ${i+1}. ${t}`).join('\n')
    );
  };

  let imageBase64 = null, mimeType = 'image/png', bboxes = [], aiSource = 'generation';
  try {
    {
      // ── Gemini 3.1 Flash Image 🍌 — /generateContent endpoint ──────────
      const imgResp = await fetch(GEMINI_IMAGE_GEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            ...(inlineTargetImage ? [inlineTargetImage] : []),
            { text: imagePrompt }
          ] }],
          generationConfig: {
            responseModalities: ['IMAGE', 'TEXT'],
            imageConfig: {
              aspectRatio: '16:9',
            },
          },
        }),
      });
      const imgData = await imgResp.json();
      if (!imgResp.ok) {
        const errMsg = imgData?.error?.message || 'Image generation failed';
        const friendly = errMsg.includes('PROHIBITED_CONTENT') || errMsg.includes('prohibited')
          ? _buildProhibitedMsg(errMsg)
          : errMsg;
        return res.status(502).json({ error: friendly });
      }
      const parts   = imgData?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
      if (!imgPart) {
        const textPart     = parts.find(p => p.text);
        const finishReason = imgData?.candidates?.[0]?.finishReason || '';
        const rawReason    = textPart?.text || finishReason || 'No image returned';
        const isBlocked    = rawReason.includes('PROHIBITED_CONTENT') || rawReason.includes('prohibited')
                          || finishReason === 'SAFETY' || finishReason === 'OTHER';
        const reason = isBlocked ? _buildProhibitedMsg(rawReason) : rawReason;
        console.error('[SpotChar] No image in response. Reason:', rawReason, JSON.stringify(imgData).slice(0,300));
        return res.status(502).json({ error: isBlocked ? reason : `Image not generated: ${reason}. Try different theme/scene names.` });
      }
      imageBase64 = imgPart.inlineData.data;
      mimeType    = imgPart.inlineData.mimeType || 'image/png';
      console.log(`[SpotChar] ✅ Gemini 3.1 Flash Image 🍌 generated (${Math.round(imageBase64.length/1024)}KB)`);

      // ── Extract character bboxes from the generation model's text output ──
      // The generation model was asked to report positions as JSON alongside the image.
      // It KNOWS where it placed characters, so its positions are more reliable than
      // a separate vision model guessing. We just need to handle code fences properly.
      const genTextPart = parts.find(p => p.text);
      if (genTextPart?.text) {
        console.log(`[SpotChar] Generation text: ${genTextPart.text.slice(0, 400)}`);
        // Strip markdown code fences (```json ... ```)
        const cleanGenText = genTextPart.text.replace(/```(?:json)?\s*/gi, '').trim();
        const genArrMatch = cleanGenText.match(/\[[\s\S]*\]/);
        if (genArrMatch) {
          try {
            const genParsed = JSON.parse(genArrMatch[0]);
            console.log(`[SpotChar] Parsed ${genParsed.length} bbox(es) from generation text`);
            const MARGIN = 0.12;
            const genBboxes = genParsed
              .filter(b => Array.isArray(b.box_2d) && b.box_2d.length >= 4)
              .map(b => {
                const [ymin, xmin, ymax, xmax] = b.box_2d;
                console.log(`[SpotChar]   gen box_2d: [${ymin}, ${xmin}, ${ymax}, ${xmax}]`);
                const x = xmin / 1000, y = ymin / 1000;
                const w = Math.max(0.05, Math.min(0.45, (xmax - xmin) / 1000));
                const h = Math.max(0.05, Math.min(0.45, (ymax - ymin) / 1000));
                let cx = x + w / 2, cy = y + h / 2;
                cx = Math.max(MARGIN, Math.min(1 - MARGIN, cx));
                cy = Math.max(MARGIN, Math.min(1 - MARGIN, cy));
                const fx = Math.max(0.01, Math.min(1 - w - 0.01, cx - w / 2));
                const fy = Math.max(0.01, Math.min(1 - h - 0.01, cy - h / 2));
                return { x: fx, y: fy, w, h, confidence: 1.0 };
              })
              .slice(0, findN);
            if (genBboxes.length > 0) {
              bboxes = genBboxes;
              console.log(`[SpotChar] ✅ Using ${bboxes.length} bbox(es) from generation model:`, JSON.stringify(bboxes));
            }
          } catch (e) {
            console.warn(`[SpotChar] Failed to parse generation bbox JSON:`, e.message);
          }
        }
      }
    }
  } catch (err) {
    return res.status(502).json({ error: `Image generation failed: ${err.message}` });
  }

  // ── Step 2: Vision fallback — only if generation didn't provide bboxes ────
  if (bboxes.length > 0) {
    console.log(`[SpotChar] Skipping vision step — ${bboxes.length} bbox(es) from generation model`);
  } else {
    aiSource = 'vision';

  // Helper: run a single vision detection pass and return parsed bboxes
  async function _visionPass(prompt, passLabel) {
    const vResp = await fetch(GEMINI_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          ...(inlineTargetImage ? [
            { text: "CRITICAL INSTRUCTION: I have provided a reference image for the exact character you need to find. Study the reference image carefully. You must ONLY identify characters in the scene that physically look like the character in the reference image (matching colors, clothing, body shape, species)." },
            inlineTargetImage
          ] : []),
          { text: prompt },
        ]}],
        generationConfig: { thinkingConfig: { thinkingBudget: 2048 }, maxOutputTokens: 8192 },
      }),
    });
    const vData = await vResp.json();
    if (!vResp.ok) {
      console.warn(`[SpotChar] ${passLabel} API error: ${vResp.status}`);
      return [];
    }
    const allParts = vData?.candidates?.[0]?.content?.parts || [];
    const rawText = allParts.filter(p => p.text && !p.thought).map(p => p.text).join('');
    console.log(`[SpotChar] ${passLabel} raw (${rawText.length} chars): ${rawText.slice(0, 400)}`);
    let cleanText = rawText.replace(/```(?:json)?\s*/gi, '').trim();

    // Try to extract JSON array
    const arrMatch = cleanText.match(/\[[\s\S]*\]/);
    let jsonStr = arrMatch ? arrMatch[0] : null;

    // If no complete array found, try to repair truncated JSON
    // (e.g. `[{"box_2d":[1,2,3,4],"label":"x"},{"box_2d":[5,6,7` → close it)
    if (!jsonStr && cleanText.includes('[')) {
      let partial = cleanText.slice(cleanText.indexOf('['));
      // Remove the last incomplete object entry
      const lastComplete = partial.lastIndexOf('},');
      if (lastComplete > 0) {
        jsonStr = partial.slice(0, lastComplete + 1) + ']';
        console.log(`[SpotChar] ${passLabel}: repaired truncated JSON`);
      } else {
        const lastObj = partial.lastIndexOf('}');
        if (lastObj > 0) {
          jsonStr = partial.slice(0, lastObj + 1) + ']';
          console.log(`[SpotChar] ${passLabel}: repaired truncated JSON (single obj)`);
        }
      }
    }

    if (!jsonStr) { console.warn(`[SpotChar] ${passLabel}: no JSON array found`); return []; }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.warn(`[SpotChar] ${passLabel}: JSON parse failed after repair: ${e.message}`);
      return [];
    }

    const MARGIN = 0.12;
    const CONFIDENCE_MIN = 0.70;
    return parsed
      .filter(b => {
        if (!Array.isArray(b.box_2d) || b.box_2d.length < 4) return false;
        // Filter by confidence — reject uncertain detections
        if (typeof b.confidence === 'number' && b.confidence < CONFIDENCE_MIN) {
          console.log(`[SpotChar]   ${passLabel} REJECTED (conf=${b.confidence}): "${b.description || '?'}"`);
          return false;
        }
        return true;
      })
      .map(b => {
        const [ymin, xmin, ymax, xmax] = b.box_2d;
        console.log(`[SpotChar]   ${passLabel} box_2d: [${ymin}, ${xmin}, ${ymax}, ${xmax}] conf=${b.confidence} desc="${(b.description || '').slice(0, 60)}"`);
        let x = xmin/1000, y = ymin/1000;
        let w = Math.max(0.05, Math.min(0.45, (xmax-xmin)/1000));
        let h = Math.max(0.05, Math.min(0.45, (ymax-ymin)/1000));
        let cx = Math.max(MARGIN, Math.min(1-MARGIN, x + w/2));
        let cy = Math.max(MARGIN, Math.min(1-MARGIN, y + h/2));
        x = Math.max(0.01, Math.min(1-w-0.01, cx - w/2));
        y = Math.max(0.01, Math.min(1-h-0.01, cy - h/2));
        return { x, y, w, h, confidence: b.confidence };
      })
      .filter(b => {
        const cx = b.x + b.w/2, cy = b.y + b.h/2;
        return cx >= MARGIN && cx <= 1-MARGIN && cy >= MARGIN && cy <= 1-MARGIN;
      });
  }

  try {
    // ── Pass 1: Find characters WITHOUT a target count ──
    // Key insight: telling the model "find exactly N" causes it to hallucinate
    // to meet the quota. Instead, ask it to find ALL matching characters
    // and describe what it sees. Then we verify the descriptions.
    const visualHint = (theme !== rawTheme)
      ? `\nVISUAL DESCRIPTION of what these characters look like: "${theme}"\n` +
        `Use this description to identify the target characters.\n`
      : '';
    console.log(`[SpotChar] Vision Pass 1: locating "${rawTheme}"${visualHint ? ' (with visual hint)' : ''}…`);
    const pass1Prompt =
      `Look carefully at this image. It is a "Spot the Character" game scene.\n` +
      `Some characters in this image are inspired by "${rawTheme}".\n` +
      visualHint +
      (inlineTargetImage ? `\nA REFERENCE IMAGE is provided above. Find ONLY the characters in the scene that match the provided reference image. Do not guess.\n` : '') +
      `Find ONLY the characters that CLEARLY match "${rawTheme}". ` +
      `Do NOT guess or force matches — if you're not sure, leave it out.\n\n` +
      `For each match, return:\n` +
      `- "box_2d": [ymin, xmin, ymax, xmax] (integers 0–1000)\n` +
      `- "description": briefly describe what this character looks like (clothes, hair, features)\n` +
      `- "confidence": 0.0 to 1.0 — how confident you are this is a "${rawTheme}" character\n\n` +
      `Only include detections with confidence >= 0.7.\n` +
      `If you cannot find ANY matching characters, return an empty array: []\n\n` +
      `Return ONLY a JSON array, no markdown, no code fences:\n` +
      `[{"box_2d":[ymin,xmin,ymax,xmax],"label":"${rawTheme}","description":"...","confidence":0.9}]`;

    let pass1 = await _visionPass(pass1Prompt, 'Pass1');
    pass1 = _removeOverlapping(pass1, findN);
    console.log(`[SpotChar] Pass 1 found ${pass1.length}/${findN} bbox(es)`);

    if (pass1.length >= findN) {
      bboxes = pass1.slice(0, findN);
    } else {
      // ── Pass 2: Appearance-based retry ──
      // Find characters that look most similar to each other (same outfit/species)
      console.log(`[SpotChar] Vision Pass 2: appearance-based retry…`);
      const pass2Prompt =
        `This image is a "Spot the Character" game.\n\n` +
        `TASK: Find all characters that look like they DON'T BELONG in this scene — ` +
        `characters that are visually different from the crowd, possibly from a different franchise or world.\n` +
        `They may share similar outfits, colors, or species with each other but look different from everyone else.\n\n` +
        (visualHint ? `They are inspired by "${rawTheme}": ${theme}\n\n` : '') +
        (inlineTargetImage ? `\nA REFERENCE IMAGE is provided above. Find ONLY the characters in the scene that match the provided reference image. Do not guess.\n` : '') +
        `For each match, return:\n` +
        `- "box_2d": [ymin, xmin, ymax, xmax] (integers 0–1000)\n` +
        `- "description": briefly describe what this character looks like\n` +
        `- "confidence": 0.0 to 1.0\n\n` +
        `Only include detections with confidence >= 0.7.\n` +
        `If you find NOTHING that clearly stands out, return []\n\n` +
        `Return ONLY a JSON array, no markdown, no code fences:\n` +
        `[{"box_2d":[ymin,xmin,ymax,xmax],"label":"${rawTheme}","description":"...","confidence":0.9}]`;

      let pass2 = await _visionPass(pass2Prompt, 'Pass2');
      pass2 = _removeOverlapping(pass2, findN);
      console.log(`[SpotChar] Pass 2 found ${pass2.length}/${findN} bbox(es)`);

      // Use whichever pass found more (up to findN)
      const best = pass2.length > pass1.length ? pass2 : pass1;
      bboxes = best.slice(0, findN);
    }

    console.log(`[SpotChar] ✅ Final vision result: ${bboxes.length}/${findN} bbox(es):`, JSON.stringify(bboxes));
  } catch (err) {
    console.warn('[SpotChar] Vision bbox failed (non-fatal):', err.message);
  }
  } // end vision fallback else

  // Remove overlapping bboxes
  if (bboxes.length > 1) {
    bboxes = _removeOverlapping(bboxes, findN);
  }

  // Reduce findCount to actual detected count — no fake positions
  let aiHard = false;
  if (bboxes.length < findN) {
    if (bboxes.length === 0) {
      console.warn(`[SpotChar] ⚠️ No characters located by AI — game continues without hints`);
      aiHard = true;
    } else {
      console.log(`[SpotChar] ⚠️ Reducing findCount from ${findN} to ${bboxes.length}`);
    }
    findN = bboxes.length;
  }

  res.json({ imageData: imageBase64, mimeType, bboxes, theme: rawTheme, findCount: findN, aiHard, aiSource });
