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
// Item type classification by ID range
// ---------------------------------------------------------------------------

function isEquippable(itemId) {
  // Weapon: 0x4000–0x5A00, Armor: 0x2800–0x4000 or 0x5A00–0x7000
  return (
    (itemId >= 0x4000 && itemId < 0x5a00) ||
    (itemId >= 0x2800 && itemId < 0x4000) ||
    (itemId >= 0x5a00 && itemId < 0x7000)
  );
}

// ---------------------------------------------------------------------------
// Job / Race bitmask formatting
// ---------------------------------------------------------------------------

const JOB_BITS = [
  [0x02, "WAR"], [0x04, "MNK"], [0x08, "WHM"], [0x10, "BLM"],
  [0x20, "RDM"], [0x40, "THF"], [0x80, "PLD"], [0x100, "DRK"],
  [0x200, "BST"], [0x400, "BRD"], [0x800, "RNG"], [0x1000, "SAM"],
  [0x2000, "NIN"], [0x4000, "DRG"], [0x8000, "SMN"], [0x10000, "BLU"],
  [0x20000, "COR"], [0x40000, "PUP"], [0x80000, "DNC"], [0x100000, "SCH"],
  [0x200000, "GEO"], [0x400000, "RUN"],
];
const ALL_JOBS = 0x007ffffe;

function formatJobs(bitmask) {
  if ((bitmask & ALL_JOBS) === ALL_JOBS) return "All Jobs";
  const jobs = [];
  for (const [bit, name] of JOB_BITS) {
    if (bitmask & bit) jobs.push(name);
  }
  return jobs.join("/");
}

const RACE_PAIRS = [
  { m: 0x02, f: 0x04, name: "Hume" },
  { m: 0x08, f: 0x10, name: "Elvaan" },
  { m: 0x20, f: 0x40, name: "Taru" },
];
const ALL_RACES = 0x01fe;

function formatRaces(bitmask) {
  if ((bitmask & ALL_RACES) === ALL_RACES) return "All Races";
  const parts = [];
  for (const { m, f, name } of RACE_PAIRS) {
    const hasM = !!(bitmask & m);
    const hasF = !!(bitmask & f);
    if (hasM && hasF) parts.push(name);
    else if (hasM) parts.push(name + "\u2642");
    else if (hasF) parts.push(name + "\u2640");
  }
  if (bitmask & 0x80) parts.push("Mithra");
  if (bitmask & 0x100) parts.push("Galka");
  return parts.join("/");
}

// ---------------------------------------------------------------------------
// Item name extraction from a decrypted item record
// ---------------------------------------------------------------------------

function readNullTermString(buf, offset, maxLen) {
  let end = offset;
  const limit = Math.min(offset + maxLen, buf.length);
  while (end < limit && buf[end] !== 0) end++;
  return buf.subarray(offset, end).toString("ascii");
}

function extractItemName(record) {
  // Find string table header: [numEntries=5(u32)] [headerSize=0x2C(u32)]
  let stOff = -1;
  for (let off = 0; off < 0x80; off += 4) {
    if (record.readUInt32LE(off) === 5 && record.readUInt32LE(off + 4) === 0x2c) {
      stOff = off;
      break;
    }
  }
  if (stOff < 0) return "";

  const dataStart = stOff + 0x2c;
  const e2RelOff = record.readUInt32LE(stOff + 0x1c);
  const nameAreaEnd = stOff + e2RelOff;

  for (let j = dataStart; j < nameAreaEnd && j < record.length; j++) {
    if (record[j] >= 0x20 && record[j] <= 0x7e) {
      return readNullTermString(record, j, Math.min(32, nameAreaEnd - j));
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Log name extraction from a decrypted item record (entry 1: English log singular)
// ---------------------------------------------------------------------------

function extractLogName(record) {
  let stOff = -1;
  for (let off = 0; off < 0x80; off += 4) {
    if (record.readUInt32LE(off) === 5 && record.readUInt32LE(off + 4) === 0x2c) {
      stOff = off;
      break;
    }
  }
  if (stOff < 0) return "";

  // Entry 1 starts at offset stored at stOff + 0x0C, bounded by entry 2 at stOff + 0x1C
  const e1RelOff = record.readUInt32LE(stOff + 0x0c);
  const e2RelOff = record.readUInt32LE(stOff + 0x1c);
  const logStart = stOff + e1RelOff;
  const logEnd = stOff + e2RelOff;

  for (let j = logStart; j < logEnd && j < record.length; j++) {
    if (record[j] >= 0x20 && record[j] <= 0x7e) {
      return readNullTermString(record, j, Math.min(64, logEnd - j));
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Item description extraction from a decrypted item record
// ---------------------------------------------------------------------------

function extractDescription(record) {
  // Find string table header same as extractItemName
  let stOff = -1;
  for (let off = 0; off < 0x80; off += 4) {
    if (record.readUInt32LE(off) === 5 && record.readUInt32LE(off + 4) === 0x2c) {
      stOff = off;
      break;
    }
  }
  if (stOff < 0) return "";

  // String table entry[3] offset at stOff + 0x24 (from ResourceExtractor layout)
  if (stOff + 0x24 + 4 > record.length) return "";
  const descRelOff = record.readUInt32LE(stOff + 0x24);
  const descStart = stOff + descRelOff;
  if (descStart >= record.length) return "";

  // Scan for printable ASCII
  for (let j = descStart; j < record.length; j++) {
    if (record[j] >= 0x20 && record[j] <= 0x7e) {
      return readNullTermString(record, j, Math.min(256, record.length - j));
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Item flags extraction (Rare / Ex)
// ---------------------------------------------------------------------------

function extractFlags(record) {
  const flags = record.readUInt16LE(0x04);
  return {
    rare: !!(flags & 0x8000),
    ex: !!(flags & 0x4000),
  };
}

// ---------------------------------------------------------------------------
// Equipment metadata extraction
// ---------------------------------------------------------------------------

function extractEquipMeta(record, itemId) {
  if (!isEquippable(itemId)) return { jobs: "", level: 0, races: "" };

  const level = record.readUInt16LE(0x0e);
  const races = record.readUInt16LE(0x12);
  const jobs = record.readUInt32LE(0x14);

  return {
    jobs: formatJobs(jobs),
    level,
    races: formatRaces(races),
  };
}

// ---------------------------------------------------------------------------
// Scan all item DATs and extract items into memory
// ---------------------------------------------------------------------------

function extractAllItems(ffxiDir, ftable) {
  const items = new Map(); // itemId → { rgba, name, logName, description, rare, ex, jobs, level, races }

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
        const name = extractItemName(record);
        const logName = extractLogName(record);
        const description = extractDescription(record);
        const { rare, ex } = extractFlags(record);
        const { jobs, level, races } = extractEquipMeta(record, itemId);
        items.set(itemId, { rgba, name, logName, description, rare, ex, jobs, level, races });
        found++;
      }
    }

    console.log(`  0x${fileId.toString(16).padStart(4, "0")}: ${recordCount} records, ${found} icons`);
  }

  return items;
}

// ---------------------------------------------------------------------------
// Generate chunked sprite sheets
// ---------------------------------------------------------------------------

async function generateSheets(items, outputDir) {
  const sortedIds = [...items.keys()].sort((a, b) => a - b);
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
      const item = items.get(itemId);

      const pngBuf = await sharp(item.rgba, {
        raw: { width: ICON_SIZE, height: ICON_SIZE, channels: 4 },
      })
        .png()
        .toBuffer();

      composites.push({
        input: pngBuf,
        left: col * ICON_SIZE,
        top: row * ICON_SIZE,
      });

      sheetManifest[itemId] = [col, row, item.name, item.logName, item.description, item.rare, item.ex, item.jobs, item.level, item.races];
      globalItems[itemId] = [slug, col, row, item.name, item.logName, item.description, item.rare, item.ex, item.jobs, item.level, item.races];
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

  console.log("Extracting items from DAT files...");
  const items = extractAllItems(ffxiDir, ftable);
  console.log(`\nTotal: ${items.size} items extracted`);

  await generateSheets(items, outputDir);

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
