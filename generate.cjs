#!/usr/bin/env node
/**
 * ffxidat-to-spritesheet
 *
 * Reads FFXI DAT files directly and produces chunked sprite sheets + global index.
 * No database dependency — everything comes from the DAT files.
 *
 * Usage:
 *   node generate.cjs --ffxi-dir "C:\path\to\FINAL FANTASY XI"
 *   FFXI_DIR="C:\path\to\FINAL FANTASY XI" node generate.cjs
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "output");
const RECORD_SIZE = 0xc00; // 3072 bytes per item record
const COLS = 16;
const ROWS_PER_SHEET = 64;
const ITEMS_PER_SHEET = COLS * ROWS_PER_SHEET; // 1024
const ICON_SIZE = 32;

// English item data file IDs (from ResourceExtractor)
// General, Usable, Weapons, Armor1, Automaton+General2, Armor2, + 4 expansion DATs
const FILE_IDS = [
  0x0049, 0x004a, 0x004b, 0x004c, 0x004d, 0x005b, 0xd973, 0xd974, 0xd975,
  0xd977,
];

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let ffxiDir = process.env.FFXI_DIR || "";
  let outputDir = DEFAULT_OUTPUT_DIR;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ffxi-dir" && args[i + 1]) {
      ffxiDir = args[++i];
    } else if (args[i] === "--output-dir" && args[i + 1]) {
      outputDir = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        "ffxidat-to-spritesheet\n\n" +
          "Extracts item icons from FFXI DAT files and generates sprite sheets.\n\n" +
          "Options:\n" +
          "  --ffxi-dir <path>    Path to FINAL FANTASY XI directory (or set FFXI_DIR)\n" +
          "  --output-dir <path>  Output directory (default: ./output)\n" +
          "  -h, --help           Show this help\n\n" +
          "Example:\n" +
          '  node generate.cjs --ffxi-dir "C:\\Program Files\\FINAL FANTASY XI"\n' +
          '  node generate.cjs --ffxi-dir "C:\\ffxi\\Game\\SquareEnix\\FINAL FANTASY XI" --output-dir ./sprites',
      );
      process.exit(0);
    }
  }

  if (!ffxiDir) {
    console.error(
      "Error: FFXI directory required.\n" +
        "  --ffxi-dir <path>   or   FFXI_DIR=<path>\n" +
        "\nRun with --help for usage info.",
    );
    process.exit(1);
  }

  return { ffxiDir, outputDir };
}

// ---------------------------------------------------------------------------
// FTABLE lookup — maps file IDs to ROM paths
// ---------------------------------------------------------------------------

function readFtable(ffxiDir) {
  const ftablePath = path.join(ffxiDir, "FTABLE.DAT");
  if (!fs.existsSync(ftablePath)) {
    console.error(`FTABLE.DAT not found at: ${ftablePath}`);
    process.exit(1);
  }
  return fs.readFileSync(ftablePath);
}

function getPath(ffxiDir, ftable, fileId) {
  const offset = fileId * 2;
  const fileNum = ftable.readUInt8(offset) | (ftable.readUInt8(offset + 1) << 8);
  const dir = fileNum >> 7;
  const file = fileNum & 0x7f;
  return path.join(ffxiDir, "ROM", dir.toString(), file.toString() + ".DAT");
}

// ---------------------------------------------------------------------------
// Decryption — RotateRight(5)
// ---------------------------------------------------------------------------

function rotateRight(data, count) {
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    data[i] = ((b >>> count) | (b << (8 - count))) & 0xff;
  }
}

// ---------------------------------------------------------------------------
// Icon extraction from a decrypted item record
// ---------------------------------------------------------------------------

function findIconOffset(record) {
  // Look for a BITMAPINFOHEADER: structLength=40, width=32, height=32, planes=1, bitCount=8
  for (let offset = 0x100; offset < record.length - 2088; offset++) {
    const structLen = record.readUInt32LE(offset);
    if (structLen !== 40) continue;

    const width = record.readInt32LE(offset + 4);
    const height = record.readInt32LE(offset + 8);
    if (width !== 32 || height !== 32) continue;

    const planes = record.readUInt16LE(offset + 12);
    if (planes !== 1) continue;

    const bitCount = record.readUInt16LE(offset + 14);
    if (bitCount !== 8) continue;

    return offset;
  }
  return -1;
}

function extractIcon(record) {
  const iconOffset = findIconOffset(record);
  if (iconOffset === -1) return null;

  const headerSize = 40;
  const paletteSize = 256 * 4;

  // Read palette (BGRA format, 256 entries)
  const paletteOffset = iconOffset + headerSize;
  const palette = [];
  for (let i = 0; i < 256; i++) {
    const base = paletteOffset + i * 4;
    palette.push({
      b: record[base],
      g: record[base + 1],
      r: record[base + 2],
      a: record[base + 3] < 0x80 ? record[base + 3] * 2 : 0xff,
    });
  }

  // Read pixel indices (bottom-up bitmap → top-down RGBA)
  const pixelOffset = paletteOffset + paletteSize;
  const width = 32;
  const height = 32;

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcY = height - 1 - y;
      const idx = record[pixelOffset + srcY * width + x];
      const c = palette[idx];
      const destOffset = (y * width + x) * 4;
      rgba[destOffset] = c.r;
      rgba[destOffset + 1] = c.g;
      rgba[destOffset + 2] = c.b;
      rgba[destOffset + 3] = c.a;
    }
  }

  return rgba;
}

// ---------------------------------------------------------------------------
// Scan all item DATs and extract icons into memory
// ---------------------------------------------------------------------------

function extractAllIcons(ffxiDir, ftable) {
  const icons = new Map(); // itemId → RGBA Buffer

  for (const fileId of FILE_IDS) {
    const datPath = getPath(ffxiDir, ftable, fileId);
    if (!fs.existsSync(datPath)) {
      console.log(`  skip: DAT not found for file ID 0x${fileId.toString(16)} → ${datPath}`);
      continue;
    }

    const stat = fs.statSync(datPath);
    const recordCount = Math.floor(stat.size / RECORD_SIZE);
    const datBuf = fs.readFileSync(datPath);

    let found = 0;
    for (let i = 0; i < recordCount; i++) {
      const recordStart = i * RECORD_SIZE;
      const record = Buffer.from(datBuf.subarray(recordStart, recordStart + RECORD_SIZE));
      rotateRight(record, 5);

      const itemId = record.readUInt16LE(0);
      if (itemId === 0 || itemId >= 0xf000) continue;

      const rgba = extractIcon(record);
      if (rgba) {
        icons.set(itemId, rgba);
        found++;
      }
    }

    console.log(`  0x${fileId.toString(16).padStart(4, "0")}: ${recordCount} records, ${found} icons`);
  }

  return icons;
}

// ---------------------------------------------------------------------------
// Generate chunked sprite sheets
// ---------------------------------------------------------------------------

async function generateSheets(icons, outputDir) {
  const sortedIds = [...icons.keys()].sort((a, b) => a - b);
  const sheetCount = Math.ceil(sortedIds.length / ITEMS_PER_SHEET);

  console.log(`\nGenerating ${sheetCount} sprite sheet(s) for ${sortedIds.length} icons...`);

  fs.mkdirSync(outputDir, { recursive: true });

  const globalItems = {};

  for (let s = 0; s < sheetCount; s++) {
    const slug = `items-${s}`;
    const chunk = sortedIds.slice(s * ITEMS_PER_SHEET, (s + 1) * ITEMS_PER_SHEET);
    const numRows = Math.ceil(chunk.length / COLS);
    const width = COLS * ICON_SIZE;
    const height = numRows * ICON_SIZE;

    const composites = [];
    const sheetManifest = {};

    for (let i = 0; i < chunk.length; i++) {
      const itemId = chunk[i];
      const col = i % COLS;
      const row = Math.floor(i / COLS);

      const pngBuf = await sharp(icons.get(itemId), {
        raw: { width: ICON_SIZE, height: ICON_SIZE, channels: 4 },
      })
        .png()
        .toBuffer();

      composites.push({
        input: pngBuf,
        left: col * ICON_SIZE,
        top: row * ICON_SIZE,
      });

      sheetManifest[itemId] = [col, row];
      globalItems[itemId] = [slug, col, row];
    }

    await sharp({
      create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite(composites)
      .png({ compressionLevel: 9 })
      .toFile(path.join(outputDir, `${slug}.png`));

    fs.writeFileSync(
      path.join(outputDir, `${slug}.json`),
      JSON.stringify({ cols: COLS, iconSize: ICON_SIZE, items: sheetManifest }),
    );

    console.log(`  ${slug}: ${chunk.length} icons, ${width}x${height}px`);
  }

  // Write global index.json (merges with existing if present)
  const indexPath = path.join(outputDir, "index.json");
  let globalIndex = { cols: COLS, iconSize: ICON_SIZE, items: {} };
  if (fs.existsSync(indexPath)) {
    try {
      globalIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    } catch (_) {
      // start fresh
    }
  }

  Object.assign(globalIndex.items, globalItems);
  fs.writeFileSync(indexPath, JSON.stringify(globalIndex));

  console.log(`\nGlobal index.json: ${Object.keys(globalIndex.items).length} total items`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { ffxiDir, outputDir } = parseArgs();

  console.log("FFXI Directory:", ffxiDir);
  console.log("Output:        ", outputDir);
  console.log();

  console.log("Reading FTABLE.DAT...");
  const ftable = readFtable(ffxiDir);

  console.log("Extracting icons from DAT files...");
  const icons = extractAllIcons(ffxiDir, ftable);
  console.log(`\nTotal: ${icons.size} icons extracted`);

  await generateSheets(icons, outputDir);

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
