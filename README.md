# ffxidat-to-spritesheet

Extract all item icons from Final Fantasy XI DAT files and generate optimized sprite sheets. No database or external API required — reads directly from your FFXI installation.

## What it does

1. Reads `FTABLE.DAT` to locate item data files in the ROM directory
2. Scans all 10 item DAT files, decrypts each record (RotateRight 5)
3. Finds the embedded 32x32 8-bit paletted BMP icon in each record and converts it to RGBA
4. Chunks all icons (sorted by item ID) into sprite sheets of 1024 icons each (16 columns x 64 rows, 512x2048px)
5. Outputs PNG sheets, per-sheet JSON manifests, and a global `index.json`

Works with any FFXI installation — retail, private servers (HorizonXI, CatsEye, Eden, etc.).

## Install

```bash
npm install
```

Requires Node.js 18+ and [sharp](https://sharp.pixelplumbing.com/).

## Usage

```bash
# Via flag
node generate.cjs --ffxi-dir "C:\Program Files\FINAL FANTASY XI"

# Via environment variable
FFXI_DIR="/path/to/FINAL FANTASY XI" node generate.cjs

# Custom output directory (default: ./output)
node generate.cjs --ffxi-dir "C:\ffxi\Game\SquareEnix\FINAL FANTASY XI" --output-dir ./sprites

# Diagnostic: hex-dump description bytes for a specific item ID
node generate.cjs --ffxi-dir "C:\path\to\FFXI" --dump-bytes 17659
```

The `--ffxi-dir` should point to the directory containing `FTABLE.DAT` and the `ROM/` folder.

### Common paths

| Installation | Typical path |
|---|---|
| Retail | `C:\Program Files (x86)\PlayOnline\SquareEnix\FINAL FANTASY XI` |
| HorizonXI | `%APPDATA%\HorizonXI-Launcher\HorizonXI\Game\SquareEnix\FINAL FANTASY XI` |
| CatsEyeXI | Varies by launcher — look for the folder containing `FTABLE.DAT` |

## Output

```
output/
  items-0.png          # Sprite sheet 0 (items 1–1024)
  items-0.json         # Per-sheet manifest
  items-1.png          # Sprite sheet 1 (items 1025–2048)
  items-1.json
  ...
  index.json           # Global index mapping itemId → [sheet, col, row]
```

### Sprite sheets

Each PNG is a 512x2048px grid of 32x32 icons (16 columns x 64 rows), compressed at PNG level 9. Typical sheet size is 200KB–1MB depending on icon complexity.

### index.json

```json
{
  "cols": 16,
  "iconSize": 32,
  "items": {
    "1": ["items-0", 0, 0],
    "2": ["items-0", 1, 0],
    "17": ["items-0", 0, 1]
  }
}
```

Each entry maps an item ID to `[sheetSlug, column, row, name, logName, description, rare, ex, jobs, level, races, slot]`.

- `description` — decoded with special FFXI icon bytes (element resistances like Fire, Water, etc.) converted to text
- `slot` — equipment slot for equippable items (e.g. "Head", "Ear", "Ring", "Main/Sub")

To display an icon in CSS:

```css
.icon {
  width: 32px;
  height: 32px;
  background-image: url('/sprites/items-0.png');
  background-position: -64px -32px; /* col * 32, row * 32 */
}
```

### Per-sheet manifest (items-N.json)

```json
{
  "cols": 16,
  "iconSize": 32,
  "items": {
    "1": [0, 0],
    "2": [1, 0]
  }
}
```

Same as the global index but without the sheet slug (since it's implicit).

## Programmatic usage

All examples auto-load `index.json` and resolve the sheet, column, and row for a given item ID — callers only need to provide the item ID.

### JavaScript (browser)

```js
class ItemSpriteSheet {
  constructor(basePath = "/sprites") {
    this.basePath = basePath;
    this._index = null;
  }

  async _load() {
    if (!this._index) {
      const res = await fetch(`${this.basePath}/index.json`);
      this._index = await res.json();
    }
    return this._index;
  }

  async getStyle(itemId) {
    const index = await this._load();
    const entry = index.items[itemId];
    if (!entry) return null;

    const [sheet, col, row] = entry;
    return {
      width: `${index.iconSize}px`,
      height: `${index.iconSize}px`,
      backgroundImage: `url(${this.basePath}/${sheet}.png)`,
      backgroundPosition: `-${col * index.iconSize}px -${row * index.iconSize}px`,
    };
  }
}

// Usage
const sprites = new ItemSpriteSheet("/sprites");

const style = await sprites.getStyle(17088);
if (style) Object.assign(document.getElementById("item-icon").style, style);
```

### TypeScript

```ts
interface SpriteIndex {
  cols: number;
  iconSize: number;
  items: Record<string, [sheet: string, col: number, row: number]>;
}

class ItemSpriteSheet {
  private basePath: string;
  private index: SpriteIndex | null = null;

  constructor(basePath = "/sprites") {
    this.basePath = basePath;
  }

  private async load(): Promise<SpriteIndex> {
    if (!this.index) {
      const res = await fetch(`${this.basePath}/index.json`);
      this.index = await res.json();
    }
    return this.index!;
  }

  async getStyle(itemId: number) {
    const index = await this.load();
    const entry = index.items[itemId];
    if (!entry) return null;

    const [sheet, col, row] = entry;
    return {
      width: index.iconSize,
      height: index.iconSize,
      backgroundImage: `url(${this.basePath}/${sheet}.png)`,
      backgroundPosition: `-${col * index.iconSize}px -${row * index.iconSize}px`,
    };
  }
}
```

### React component

```tsx
import { useEffect, useRef, useState, type CSSProperties } from "react";

// Singleton — loads index.json once, shared across all components
const spriteCache: Record<string, Promise<SpriteIndex>> = {};
function loadIndex(basePath: string): Promise<SpriteIndex> {
  if (!spriteCache[basePath]) {
    spriteCache[basePath] = fetch(`${basePath}/index.json`).then((r) => r.json());
  }
  return spriteCache[basePath];
}

function ItemIcon({ itemId, basePath = "/sprites" }: { itemId: number; basePath?: string }) {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    loadIndex(basePath).then((index) => {
      const entry = index.items[itemId];
      if (!entry) return;
      const [sheet, col, row] = entry;
      setStyle({
        width: index.iconSize,
        height: index.iconSize,
        backgroundImage: `url(${basePath}/${sheet}.png)`,
        backgroundPosition: `-${col * index.iconSize}px -${row * index.iconSize}px`,
      });
    });
  }, [itemId, basePath]);

  return style ? <div style={style} /> : null;
}

// Usage — just pass an item ID
<ItemIcon itemId={17088} />
```

### Node.js (extract a single icon with sharp)

```js
const fs = require("fs");
const sharp = require("sharp");

function extractIcon(itemId, outputDir = "output") {
  const index = JSON.parse(fs.readFileSync(`${outputDir}/index.json`, "utf-8"));
  const entry = index.items[itemId];
  if (!entry) throw new Error(`Item ${itemId} not found in index`);

  const [sheet, col, row] = entry;
  return sharp(`${outputDir}/${sheet}.png`).extract({
    left: col * index.iconSize,
    top: row * index.iconSize,
    width: index.iconSize,
    height: index.iconSize,
  });
}

// Usage — just pass an item ID
extractIcon(17088).toFile("ridill.png");
```

## How it works

FFXI stores item data in encrypted DAT files. Each item record is 3072 bytes (0xC00) and contains metadata, text, and an icon. The icon is a standard Windows BMP structure:

- **BITMAPINFOHEADER** (40 bytes) — identifies the icon location within the record
- **Palette** (256 x 4 bytes) — BGRA color table
- **Pixels** (32 x 32 bytes) — 8-bit palette indices, stored bottom-up

Records are encrypted with a bitwise rotate-right by 5. The script decrypts each record, locates the BMP header by signature scanning, then converts the paletted bitmap to RGBA.

## Item DAT files

The script reads these 10 DAT file IDs (English client):

| File ID | Contents |
|---|---|
| 0x0049 | General items |
| 0x004A | Usable items |
| 0x004B | Weapons |
| 0x004C | Armor (set 1) |
| 0x004D | Automaton + General 2 |
| 0x005B | Armor (set 2) |
| 0xD973–0xD977 | Expansion items |

## License

MIT
