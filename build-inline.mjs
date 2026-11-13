import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const stripJs = (s) => s.replace(/^export\s+/gm, '').replace(/<\/script/gi, '<\\/script');

let html = read('public/index.html');
const leafletCss = read('node_modules/leaflet/dist/leaflet.css');
const appCss = read('public/css/app.css');
const socketJs = read('node_modules/socket.io/client-dist/socket.io.min.js');
const leafletJs = read('node_modules/leaflet/dist/leaflet.js');
const jsqrJs = read('node_modules/jsqr/dist/jsQR.js');
const utilJs = stripJs(read('public/js/util.js'));
const mapJs = stripJs(read('public/js/map.js').replace(/^import[^\n]*\n/gm, ''));
let appJs = read('public/js/app.js').replace(/^import[\s\S]*?from '\.\/map\.js';\n/, '');
appJs = stripJs(appJs);
const bundle = [utilJs, mapJs, appJs].join('\n/* ---- */\n');

html = html.replace('<link rel="stylesheet" href="/vendor/leaflet/leaflet.css">', () => `<style>${leafletCss}</style>`);
html = html.replace(/<link rel="stylesheet" href="\/css\/app\.css[^"]*">/, () => `<style>${appCss}</style>`);
html = html.replace('<script src="/socket.io/socket.io.js"></script>', () => `<script>${socketJs.replace(/<\/script/gi, '<\\/script')}</script>`);
html = html.replace('<script src="/vendor/leaflet/leaflet.js"></script>', () => `<script>${leafletJs.replace(/<\/script/gi, '<\\/script')}</script>`);
html = html.replace('<script src="/vendor/jsqr/jsQR.js"></script>', () => `<script>${jsqrJs.replace(/<\/script/gi, '<\\/script')}</script>`);
html = html.replace(/<script type="module" src="\/js\/app\.js[^"]*"><\/script>/, () => `<script type="module">\n${bundle}\n</script>`);
fs.writeFileSync(path.join(root, 'public/index.inline.html'), html);
console.log('inline bytes', Buffer.byteLength(html));
