const fs = require('fs');
let c = fs.readFileSync('server.js', 'utf8');

c = c.replace(
    /`Draw an original, richly detailed background scene set in the world of "\$\{scene\}". ` \+\s*`Fill this scene with \$\{bgCount\} unique original characters whose visual design fits the world of "\$\{scene\}" — ` \+\s*`each clearly different from one another, no two alike\. ` \+/,
    `(styleKey === 'rogerrabbit'\n      ? \`STEP 1: Draw a hyper-realistic, physical background environment based on the location: "\${scene}". Fill this photorealistic environment with \${bgCount} highly realistic human or animal background characters. NO cartoons allowed in the background or background characters.\\nSTEP 2: Superimpose EXACTLY \${findN} 2D/3D animated cartoon characters inspired by "\${theme}" into this realistic world. \`\n      : \`Draw an original, richly detailed background scene set in the world of "\${scene}". \` +\n        \`Fill this scene with \${bgCount} unique original characters whose visual design fits the world of "\${scene}" — \`) +\n    \`each clearly different from one another, no two alike. \` +`
);

fs.writeFileSync('server.js', c);
console.log('Fixed');
