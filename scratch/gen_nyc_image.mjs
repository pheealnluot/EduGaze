import fs from 'fs';
import path from 'path';

const GEMINI_API_KEY = 'AIzaSyC9h4y4wC1KFgr3ZbTJeWKIT8oDmF5omBk';
const GEMINI_IMAGE_GEN_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_API_KEY}`;

const imagePrompt =
  // Style first — commits the model to photorealism before any scene details
  `MIXED MEDIA: HYPER-REALISTIC PHOTOGRAPHIC BACKGROUND + STYLISED CHARACTER. ` +
  `HORIZONTAL WIDESCREEN LANDSCAPE IMAGE — 16:9 aspect ratio. ` +

  // Background: NYC photorealism
  `BACKGROUND: Hyper-realistic, cinematic photograph of a New York City street scene — ` +
  `midtown Manhattan, late afternoon golden hour. ` +
  `Show a wide city avenue lined with towering skyscrapers, yellow taxi cabs, busy sidewalks, ` +
  `traffic lights, steam vents rising from manhole covers, street-level shops with neon signage. ` +
  `Volumetric haze, ray-traced global illumination, realistic glass reflections on buildings, ` +
  `wet asphalt catching light, cinematic depth of field, atmospheric perspective. ` +
  `The background should look indistinguishable from a high-resolution DSLR photograph. ` +

  // Character: futuristic metal suit
  `CHARACTER: Standing to the LEFT side of the street on the pavement, a single lone figure ` +
  `wearing a full-body futuristic power armour suit made entirely of polished, segmented metal plates. ` +
  `The armour is sleek and angular — think advanced military exoskeleton crossed with high-fashion couture: ` +
  `mirror-chrome chest plate, articulated pauldrons, glowing blue energy seams at joints, ` +
  `a closed visor helmet with an amber HUD glow behind the visor, and heavy armoured boots. ` +
  `The suit has a cool blue-silver colour scheme with subtle iridescent highlights catching the city light. ` +
  `The figure stands naturally, relaxed — not a combat pose — as if waiting at the edge of the kerb. ` +
  `They are rendered in a stylised, semi-realistic concept-art style so they contrast beautifully against the photorealistic city background. ` +
  `Scale: the figure should be roughly full-body height, occupying about 30–40% of the image height. ` +

  // Quality closers
  `Cinematic composition — rule of thirds. No text, no watermarks, no UI elements. ` +
  `Extremely detailed, award-winning digital art. 8K quality.`;

console.log('🚀 Calling Gemini 3.1 Flash Image (free tier)...');
console.log('Prompt length:', imagePrompt.length, 'chars');

const response = await fetch(GEMINI_IMAGE_GEN_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  signal: AbortSignal.timeout(120000),
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: imagePrompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
    },
  }),
});

const data = await response.json();

if (!response.ok) {
  console.error('❌ API error:', data?.error?.message || JSON.stringify(data).slice(0, 300));
  process.exit(1);
}

const parts = data?.candidates?.[0]?.content?.parts || [];
const textPart = parts.find(p => p.text);
const imgPart  = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

if (textPart) console.log('📝 Model text output:', textPart.text?.slice(0, 300));

if (!imgPart) {
  const finishReason = data?.candidates?.[0]?.finishReason || 'unknown';
  console.error('❌ No image returned. Finish reason:', finishReason);
  console.error('Full response:', JSON.stringify(data).slice(0, 500));
  process.exit(1);
}

const ext = imgPart.inlineData.mimeType === 'image/jpeg' ? 'jpg' : 'png';
const outPath = path.join('scratch', `nyc_futuristic_${Date.now()}.${ext}`);
fs.writeFileSync(outPath, Buffer.from(imgPart.inlineData.data, 'base64'));
console.log(`✅ Image saved → ${outPath}  (${Math.round(imgPart.inlineData.data.length / 1024)} KB base64)`);
