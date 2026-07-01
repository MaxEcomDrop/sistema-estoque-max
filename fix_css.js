const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, 'public', 'new_style.css');
let css = fs.readFileSync(cssPath, 'utf8');

// Replace primary and accent colors with login purple theme
css = css.replace(/--primary: #ffffff;/g, '--primary: #8b5cf6;');
css = css.replace(/--primary-bg: #ffffff;/g, '--primary-bg: #8b5cf6;');
css = css.replace(/--primary-text: #000000;/g, '--primary-text: #ffffff;');
css = css.replace(/--primary-h: #e5e5e5;/g, '--primary-h: #a78bfa;');
css = css.replace(/--accent: #4f46e5;/g, '--accent: #6366f1;');
css = css.replace(/--accent-h: #4338ca;/g, '--accent-h: #8b5cf6;');

// Remove any light theme overrides just in case
css = css.replace(/\[data-theme="light"\][\s\S]*?\}/, '[data-theme="light"] { /* FORCED DARK MODE */ }');

fs.writeFileSync(cssPath, css, 'utf8');
console.log('CSS updated with purple theme.');
