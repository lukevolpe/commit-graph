// Copies the codicon font into media/ so the webview can load it (node_modules isn't packaged).
const fs = require('node:fs');
const path = require('node:path');
const src = path.join(__dirname, '..', 'node_modules', '@vscode', 'codicons', 'dist');
const dest = path.join(__dirname, '..', 'media', 'codicons');
fs.mkdirSync(dest, { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) fs.copyFileSync(path.join(src, f), path.join(dest, f));
