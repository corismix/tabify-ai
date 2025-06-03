# Tabify AI

This repository contains a proof-of-concept extension that groups browser tabs using AI.  
The `scripts/generate-folder-icons.js` utility generates color variants of the folder icons used when tab groups are collapsed or expanded.

Run the script with Node.js to produce the icons:

```bash
node scripts/generate-folder-icons.js
```

The generated SVGs will appear in `icons/generated`. Each file name indicates whether it's for an open or closed group and which Firefox/Chrome group color it matches.

You can copy these SVGs into your profile's `chrome` folder and reference them from `userChrome.css` to override Firefox's default group icons.
