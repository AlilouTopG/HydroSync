// Extracts every inline style="..." attribute in an HTML file into deduplicated
// CSS classes in a new external stylesheet, so a strict CSP (no 'unsafe-inline'
// in style-src) can be enforced without changing any visual output.
//
// Usage: node extract_inline_styles.js path/to/index.html
// Writes: <dir>/extracted-inline.css  and rewrites the HTML in place (.bak kept)

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) { console.error('usage: node extract_inline_styles.js <html file>'); process.exit(1); }
let html = fs.readFileSync(file, 'utf8');

const classMap = new Map();   // normalized style string -> class name
let counter = 0;
const cssRules = [];

function classNameFor(styleStr) {
  const norm = styleStr.trim().replace(/\s+/g, ' ').replace(/;\s*$/, '');
  if (classMap.has(norm)) return classMap.get(norm);
  const cls = 'x-inl-' + (counter++);
  classMap.set(norm, cls);
  cssRules.push(`.${cls} { ${norm}; }`);
  return cls;
}

let converted = 0;
// Match tag="...style="..."..."> — handles style anywhere among a tag's attributes.
html = html.replace(/<([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s+style="([^"]*)"((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*(\/?)>/g,
  (full, tag, before, styleVal, after, selfClose) => {
    converted++;
    const cls = classNameFor(styleVal);
    const attrs = before + after;
    const classMatch = attrs.match(/\sclass="([^"]*)"/);
    let rebuiltAttrs;
    if (classMatch) {
      rebuiltAttrs = attrs.replace(/\sclass="([^"]*)"/, ` class="${classMatch[1]} ${cls}"`);
    } else {
      rebuiltAttrs = attrs + ` class="${cls}"`;
    }
    return `<${tag}${rebuiltAttrs} ${selfClose}>`.replace(/\s+>/, '>').replace(/\s+\/>/, ' />');
  });

const outDir = path.dirname(file);
fs.copyFileSync(file, file + '.bak');
fs.writeFileSync(path.join(outDir, 'extracted-inline.css'), cssRules.join('\n') + '\n');

// link the new stylesheet right after the last existing <link rel="stylesheet"...> or before </head>
if (/<\/head>/.test(html)) {
  html = html.replace('</head>', '  <link rel="stylesheet" href="extracted-inline.css">\n</head>');
}
fs.writeFileSync(file, html);

console.log(`Converted ${converted} inline style attributes into ${classMap.size} deduplicated classes.`);
console.log(`Remaining style="..." attributes: ${(html.match(/\sstyle="/g) || []).length}`);
console.log(`Remaining <style> blocks: ${(html.match(/<style[\s>]/g) || []).length}`);
