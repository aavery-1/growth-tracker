# Notes co-editing bundle (Nov 20 2026)
`collab.min.js` bundles yjs 13.6.33 (MIT), quill 2.0.3 (BSD-3-Clause), y-quill 1.0.0 (MIT), quill-cursors 4.0.4 (MIT)
and y-protocols 1.0.7 (MIT) into one file that sets `window.GHCollab`. Licenses are kept at the end of the file.
Rebuild: `npm i yjs@13.6.33 quill@2.0.3 y-quill@1.0.0 quill-cursors@4.0.4 y-protocols@1.0.7 esbuild`, then
`npx esbuild entry.js --bundle --minify --format=iife --target=es2019 --legal-comments=eof --outfile=collab.min.js`.
`quill.core.css` is Quill's base stylesheet. The app loads both only when meeting notes open.
