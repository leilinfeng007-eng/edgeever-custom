/**
 * 文字型 PDF 正文提取：纯字节解析，兼容 Cloudflare Worker 与 Bun，不依赖 DOM/canvas。
 * 支持常见 xref/对象流、Flate/ASCIIHex/ASCII85 压缩、Type1/Type0 字体与 ToUnicode 映射。
 * 只提取文本；扫描件、加密件、损坏件与超限件返回明确错误，不做 OCR。
 */
import { AppError } from "../common/app-error";

export const PDF_STREAM_LIMIT = 8 * 1024 * 1024;
export const PDF_TEXT_LIMIT = 2 * 1024 * 1024;
export const PDF_PAGE_LIMIT = 2_000;
const OBJECT_LIMIT = 50_000;

export type PdfTextResult = { pages: string[]; pageCount: number };

type PdfObject = { number: number; value: string; stream?: Uint8Array };

type PdfOperand =
  | number
  | { kind: "string"; value: string }
  | { kind: "name"; value: string }
  | PdfOperand[];

type FontInfo = { codeBytes: 1 | 2; map: Map<string, string> | null };

type PageRef = { number: number; dict: string; resources: string | null };

const invalidPdf = (message = "The PDF file is damaged or unsupported.") =>
  new AppError("attachment_invalid_pdf", message, 422);

const streamTooComplex = () =>
  new AppError("pdf_too_complex", "The PDF contains a stream that exceeds the safe extraction limit.", 413);

export function latin1(bytes: Uint8Array) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return text;
}

function asciiHexDecode(bytes: Uint8Array) {
  const source = latin1(bytes).split(">")[0]!.replace(/[^0-9a-fA-F]/g, "");
  const padded = source.length % 2 ? `${source}0` : source;
  const output = new Uint8Array(padded.length / 2);
  for (let index = 0; index < padded.length; index += 2) {
    output[index / 2] = Number.parseInt(padded.slice(index, index + 2), 16);
  }
  return output;
}

function ascii85Decode(bytes: Uint8Array) {
  let source = latin1(bytes).replace(/\s+/g, "");
  if (source.startsWith("<~")) source = source.slice(2);
  const end = source.indexOf("~>");
  if (end >= 0) source = source.slice(0, end);
  const output: number[] = [];
  let group: number[] = [];
  const flush = (count: number) => {
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + (digit - 33);
    const decoded = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    output.push(...decoded.slice(0, count));
    group = [];
  };
  for (const character of source) {
    if (character === "z" && group.length === 0) {
      output.push(0, 0, 0, 0);
      continue;
    }
    const code = character.charCodeAt(0);
    if (code < 33 || code > 117) throw invalidPdf();
    group.push(code);
    if (group.length === 5) flush(4);
    if (output.length > PDF_STREAM_LIMIT) throw streamTooComplex();
  }
  if (group.length) flush(group.length - 1);
  if (output.length > PDF_STREAM_LIMIT) throw streamTooComplex();
  return Uint8Array.from(output);
}

async function inflateBounded(bytes: Uint8Array) {
  let lastError: unknown;
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const body = new Response(Uint8Array.from(bytes)).body;
      if (!body) throw invalidPdf();
      const reader = body.pipeThrough(new DecompressionStream(format)).getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > PDF_STREAM_LIMIT) {
          await reader.cancel();
          throw streamTooComplex();
        }
        chunks.push(value);
      }
      const output = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return output;
    } catch (error) {
      if (error instanceof AppError) throw error;
      lastError = error;
    }
  }
  throw invalidPdf(lastError instanceof Error ? `The PDF stream could not be decompressed: ${lastError.message}` : undefined);
}

function streamFilters(dict: string) {
  const match = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  if (!match) return [] as string[];
  return [...match[1]!.matchAll(/\/([A-Za-z0-9]+)/g)].map(item => item[1]!);
}

async function decodePdfStream(object: PdfObject | undefined) {
  if (!object?.stream) return null;
  let data = object.stream;
  for (const filter of streamFilters(object.value)) {
    if (filter === "FlateDecode" || filter === "Fl") data = await inflateBounded(data);
    else if (filter === "ASCIIHexDecode" || filter === "AHx") data = asciiHexDecode(data);
    else if (filter === "ASCII85Decode" || filter === "A85") data = ascii85Decode(data);
    else return null;
  }
  return data;
}

function copyRange(bytes: Uint8Array, start: number, end: number) {
  return bytes.subarray(start, end);
}

function parseObjects(text: string, bytes: Uint8Array) {
  const objects = new Map<number, PdfObject>();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let cursor = 0;
  while (objects.size <= OBJECT_LIMIT) {
    header.lastIndex = cursor;
    const match = header.exec(text);
    if (!match) break;
    const number = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const endobj = text.indexOf("endobj", bodyStart);
    const streamStart = text.indexOf("stream", bodyStart);
    if (streamStart >= 0 && (endobj < 0 || streamStart < endobj)) {
      let dataStart = streamStart + "stream".length;
      if (text[dataStart] === "\r") dataStart++;
      if (text[dataStart] === "\n") dataStart++;
      const dict = text.slice(bodyStart, streamStart);
      let dataEnd = -1;
      const directLength = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      if (directLength) {
        const candidate = dataStart + Number(directLength[1]);
        if (candidate <= text.length && /^\s*endstream/.test(text.slice(candidate, candidate + 20))) {
          dataEnd = candidate;
        }
      }
      if (dataEnd < 0) dataEnd = text.indexOf("endstream", dataStart);
      if (dataEnd < 0) throw invalidPdf("A PDF stream is missing its end marker.");
      const end = text.indexOf("endobj", dataEnd + "endstream".length);
      objects.set(number, {
        number,
        value: dict,
        stream: copyRange(bytes, dataStart, dataEnd),
      });
      cursor = end < 0 ? text.length : end + "endobj".length;
      continue;
    }
    const end = endobj < 0 ? text.length : endobj;
    objects.set(number, { number, value: text.slice(bodyStart, end) });
    cursor = endobj < 0 ? text.length : endobj + "endobj".length;
  }
  return objects;
}

async function expandObjectStreams(objects: Map<number, PdfObject>) {
  const streams = [...objects.values()].filter(object => /\/Type\s*\/ObjStm\b/.test(object.value));
  for (const stream of streams) {
    const data = await decodePdfStream(stream);
    if (!data) continue;
    const content = latin1(data);
    const header = /^\s*(\d+)\s+(\d+)/.exec(content);
    if (!header) continue;
    const count = Number(header[1]);
    const first = Number(header[2]);
    if (!Number.isSafeInteger(count) || count < 1 || count > OBJECT_LIMIT) continue;
    const tokens = content.slice(header[0].length).trim().split(/\s+/).slice(0, count * 2);
    if (tokens.length < count * 2) continue;
    const offsets: number[] = [];
    for (let index = 0; index < count; index++) {
      const number = Number(tokens[index * 2]);
      const offset = Number(tokens[index * 2 + 1]);
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(offset)) continue;
      offsets.push(number, offset);
    }
    for (let index = 0; index < offsets.length; index += 2) {
      const number = offsets[index]!;
      const start = first + offsets[index + 1]!;
      const nextStart = index + 3 < offsets.length ? first + offsets[index + 3]! : content.length;
      if (objects.has(number) || start < 0 || nextStart > content.length || start >= nextStart) continue;
      objects.set(number, { number, value: content.slice(start, nextStart) });
    }
  }
}

function reference(dict: string, key: string) {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return match ? Number(match[1]) : null;
}

function references(dict: string, key: string) {
  const array = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(dict);
  if (!array) return [] as number[];
  return [...array[1]!.matchAll(/(\d+)\s+\d+\s+R/g)].map(item => Number(item[1]));
}

function dictionaryAt(text: string, start: number) {
  let depth = 0;
  for (let index = start; index < text.length - 1; index++) {
    if (text[index] === "<" && text[index + 1] === "<") {
      depth++;
      index++;
      continue;
    }
    if (text[index] === ">" && text[index + 1] === ">") {
      depth--;
      index++;
      if (depth === 0) return { value: text.slice(start, index + 1), end: index + 1 };
    }
  }
  return null;
}

function dictionaryAfter(text: string, key: string) {
  const match = new RegExp(`/${key}\\s*<<`).exec(text);
  if (!match) return null;
  return dictionaryAt(text, match.index + match[0].length - 2)?.value ?? null;
}

function resolveResources(objects: Map<number, PdfObject>, dict: string, inherited: string | null) {
  const inline = dictionaryAfter(dict, "Resources");
  if (inline) return inline;
  const ref = reference(dict, "Resources");
  if (ref !== null) return objects.get(ref)?.value ?? inherited;
  return inherited;
}

function collectPages(
  objects: Map<number, PdfObject>,
  start: number,
  inheritedResources: string | null,
  pages: PageRef[],
  seen: Set<number>,
) {
  if (seen.has(start) || pages.length > PDF_PAGE_LIMIT) return;
  seen.add(start);
  const object = objects.get(start);
  if (!object) return;
  const resources = resolveResources(objects, object.value, inheritedResources);
  if (/\/Type\s*\/Page\b/.test(object.value)) {
    pages.push({ number: start, dict: object.value, resources });
    return;
  }
  for (const child of references(object.value, "Kids")) {
    collectPages(objects, child, resources, pages, seen);
  }
}

function pageObjects(objects: Map<number, PdfObject>, source: string) {
  const roots = [...objects.values()];
  const rootTrailer = /\/Root\s+(\d+)\s+\d+\s+R/g;
  let catalogNumber: number | null = null;
  for (const match of source.matchAll(rootTrailer)) catalogNumber = Number(match[1]);
  if (catalogNumber !== null) {
    const catalog = objects.get(catalogNumber);
    const pagesRef = catalog ? reference(catalog.value, "Pages") : null;
    if (pagesRef !== null) {
      const pages: PageRef[] = [];
      collectPages(objects, pagesRef, null, pages, new Set());
      if (pages.length) return pages;
    }
  }
  return roots
    .filter(object => /\/Type\s*\/Page\b/.test(object.value))
    .sort((left, right) => left.number - right.number)
    .map(object => ({ number: object.number, dict: object.value, resources: resolveResources(objects, object.value, null) }));
}

function hexToUnicode(hex: string) {
  let value = "";
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    value += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  if (!value && hex.length) value = String.fromCharCode(Number.parseInt(hex, 16));
  return value;
}

function parseCmap(text: string, fallbackTwoByte: boolean) {
  let codeBytes: 1 | 2 = fallbackTwoByte ? 2 : 1;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (space) {
    const first = /<([0-9a-fA-F]+)>/.exec(space[1]!);
    if (first) codeBytes = first[1]!.length > 2 ? 2 : 1;
  }
  const map = new Map<string, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(pair[1]!.toUpperCase(), hexToUnicode(pair[2]!));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const ranges = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    for (const range of block[1]!.matchAll(ranges)) {
      const start = Number.parseInt(range[1]!, 16);
      const end = Number.parseInt(range[2]!, 16);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) continue;
      const width = range[1]!.length;
      if (range[4] !== undefined) {
        const items = [...range[4]!.matchAll(/<([0-9a-fA-F]+)>/g)].map(item => item[1]!);
        for (let code = start; code <= end && code - start < items.length; code++) {
          map.set(code.toString(16).toUpperCase().padStart(width, "0"), hexToUnicode(items[code - start]!));
        }
        continue;
      }
      const destination = range[3]!;
      const base = hexToUnicode(destination);
      for (let code = start; code <= end && code - start < 65_536; code++) {
        const offset = code - start;
        const suffix = offset === 0 ? "" : String.fromCharCode(base.charCodeAt(base.length - 1) + offset);
        map.set(
          code.toString(16).toUpperCase().padStart(width, "0"),
          offset === 0 ? base : `${base.slice(0, -1)}${suffix}`,
        );
      }
    }
  }
  return { codeBytes, map };
}

function lookupGlyph(map: Map<string, string>, hex: string) {
  return map.get(hex) ?? map.get(hex.padStart(4, "0")) ?? map.get(hex.padStart(2, "0"));
}

async function loadFont(objects: Map<number, PdfObject>, number: number) {
  const dict = objects.get(number)?.value ?? "";
  const fallbackTwoByte = /\/Subtype\s*\/Type0\b/.test(dict) || /\/Encoding\s*\/Identity-[HV]\b/.test(dict);
  const toUnicode = reference(dict, "ToUnicode");
  const data = toUnicode === null ? null : await decodePdfStream(objects.get(toUnicode));
  const parsed = data ? parseCmap(latin1(data), fallbackTwoByte) : null;
  return {
    codeBytes: parsed?.codeBytes ?? (fallbackTwoByte ? 2 : 1),
    map: parsed?.map ?? null,
  } satisfies FontInfo;
}

function pageFontRefs(objects: Map<number, PdfObject>, resources: string | null) {
  const refs = new Map<string, number>();
  if (!resources) return refs;
  let fontBlock = dictionaryAfter(resources, "Font");
  if (!fontBlock) {
    const fontRef = reference(resources, "Font");
    fontBlock = fontRef === null ? null : objects.get(fontRef)?.value ?? null;
  }
  if (!fontBlock) return refs;
  for (const match of fontBlock.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    refs.set(match[1]!, Number(match[2]));
  }
  return refs;
}

function readLiteralString(content: string, start: number) {
  let index = start + 1;
  let depth = 1;
  let value = "";
  while (index < content.length) {
    const character = content[index++]!;
    if (character === "\\") {
      const escaped = content[index++];
      if (escaped === undefined) break;
      if (escaped === "n") value += "\n";
      else if (escaped === "r") value += "\r";
      else if (escaped === "t") value += "\t";
      else if (escaped === "b") value += "\b";
      else if (escaped === "f") value += "\f";
      else if (escaped === "(" || escaped === ")" || escaped === "\\") value += escaped;
      else if (escaped === "\n") continue;
      else if (escaped === "\r") {
        if (content[index] === "\n") index++;
      } else if (/[0-7]/.test(escaped)) {
        let octal = escaped;
        for (let count = 0; count < 2 && /[0-7]/.test(content[index] ?? ""); count++) {
          octal += content[index++]!;
        }
        value += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
      } else value += escaped;
      continue;
    }
    if (character === "(") {
      depth++;
      value += character;
      continue;
    }
    if (character === ")") {
      depth--;
      if (depth === 0) break;
      value += character;
      continue;
    }
    value += character;
  }
  return { value, next: index };
}

function hexBytesToText(hex: string) {
  let value = "";
  for (let index = 0; index < hex.length; index += 2) {
    value += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2).padEnd(2, "0"), 16));
  }
  return value;
}

function decodeString(raw: string, font: FontInfo | null) {
  if (!font?.map) {
    // oxlint-disable-next-line no-control-regex -- strips invisible PDF text controls
    return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  }
  let value = "";
  for (let index = 0; index < raw.length; index += font.codeBytes) {
    const slice = raw.slice(index, index + font.codeBytes);
    const hex = [...slice].map(character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase();
    value += lookupGlyph(font.map, hex) ?? "";
  }
  return value;
}

function skipInlineImage(content: string, start: number) {
  const id = /(?:^|\s)ID\s/.exec(content.slice(start));
  if (!id) return content.length;
  const dataStart = start + id.index + id[0].length;
  const end = /(?:\s)EI(?=[\s]|$)/.exec(content.slice(dataStart));
  return end ? dataStart + end.index + end[0].length : content.length;
}

function extractContentText(content: string, fonts: Map<string, FontInfo>) {
  let output = "";
  let currentFont: FontInfo | null = null;
  let lastY: number | null = null;
  const operands: PdfOperand[] = [];
  const arrays: PdfOperand[][] = [];
  const pushOperand = (value: PdfOperand) => {
    const target = arrays[arrays.length - 1];
    if (target) target.push(value);
    else operands.push(value);
  };

  const append = (value: string) => {
    if (value) output += value;
  };
  const newline = () => {
    if (output && !output.endsWith("\n")) output += "\n";
  };
  const space = () => {
    if (output && !/\s$/.test(output)) output += " ";
  };
  const show = (operand: PdfOperand | undefined) => {
    if (operand && typeof operand === "object" && !Array.isArray(operand) && operand.kind === "string") {
      append(decodeString(operand.value, currentFont));
    }
  };

  let index = 0;
  while (index < content.length) {
    const character = content[index]!;
    if (character === "%") {
      while (index < content.length && content[index] !== "\n" && content[index] !== "\r") index++;
      continue;
    }
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "(") {
      const literal = readLiteralString(content, index);
      pushOperand({ kind: "string", value: literal.value });
      index = literal.next;
      continue;
    }
    if (character === "<") {
      if (content[index + 1] === "<") {
        const dictionary = dictionaryAt(content, index);
        index = dictionary?.end ?? content.length;
        continue;
      }
      const end = content.indexOf(">", index + 1);
      if (end < 0) break;
      const hex = content.slice(index + 1, end).replace(/[^0-9a-fA-F]/g, "");
      pushOperand({ kind: "string", value: hexBytesToText(hex) });
      index = end + 1;
      continue;
    }
    if (character === "[") {
      arrays.push([]);
      index++;
      continue;
    }
    if (character === "]") {
      const array = arrays.pop() ?? [];
      pushOperand(array);
      index++;
      continue;
    }
    if (character === "/") {
      let end = index + 1;
      while (end < content.length && !/[\s/<>[\]()%]/.test(content[end]!)) end++;
      pushOperand({ kind: "name", value: content.slice(index + 1, end) });
      index = end;
      continue;
    }
    if (/[+\-.\d]/.test(character)) {
      const number = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(content.slice(index));
      if (number) {
        pushOperand(Number(number[0]));
        index += number[0].length;
        continue;
      }
    }
    let end = index;
    while (end < content.length && !/[\s<>[\]()/%]/.test(content[end]!)) end++;
    const operator = content.slice(index, end);
    index = end;
    if (!operator) {
      index++;
      continue;
    }
    switch (operator) {
      case "Tf": {
        let name: PdfOperand | undefined;
        for (let operand = operands.length - 1; operand >= 0; operand--) {
          const candidate = operands[operand];
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && candidate.kind === "name") {
            name = candidate;
            break;
          }
        }
        currentFont = name && typeof name === "object" && !Array.isArray(name) && name.kind === "name"
          ? fonts.get(name.value) ?? null
          : null;
        break;
      }
      case "Tj":
        show(operands[operands.length - 1]);
        break;
      case "TJ": {
        const array = operands[operands.length - 1];
        if (Array.isArray(array)) {
          for (const item of array) {
            if (typeof item === "number") {
              if (item <= -180) space();
            } else show(item);
          }
        }
        break;
      }
      case "'":
        newline();
        show(operands[operands.length - 1]);
        break;
      case "\"":
        newline();
        show(operands[operands.length - 1]);
        break;
      case "Td":
      case "TD":
        if (typeof operands[operands.length - 1] === "number" && operands[operands.length - 1] !== 0) newline();
        break;
      case "T*":
        newline();
        break;
      case "Tm": {
        const y = operands[operands.length - 1];
        if (typeof y === "number") {
          if (lastY !== null && y !== lastY) newline();
          lastY = y;
        }
        break;
      }
      case "BT":
        newline();
        lastY = null;
        break;
      case "ET":
        newline();
        break;
      case "BI":
        index = skipInlineImage(content, index);
        break;
      default:
        break;
    }
    if (operator !== "[" && operator !== "]") operands.length = 0;
  }
  return output;
}

const cleanPage = (value: string) => value
  .replace(/\r\n?/g, "\n")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/[ \t]{2,}/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

// Chrome and some PDF generators write CJK glyphs as Kangxi radicals or
// radical-supplement code points in ToUnicode. NFKC repairs the Kangxi block;
// the supplement needs explicit standalone-character equivalents. Apply this
// per character so Chinese punctuation is never converted to ASCII.
const RADICAL_SUPPLEMENT: Record<string, string> = {
  "⻅": "见", "⻉": "贝", "⻋": "车", "⻓": "长", "⻔": "门", "⻚": "页",
  "⻛": "风", "⻜": "飞", "⻘": "青", "⻢": "马", "⻥": "鱼", "⻦": "鸟",
  "⻩": "黄", "⻬": "齐", "⻮": "齿", "⻰": "龙", "⻳": "龟",
};

export function repairPdfCjkGlyphs(text: string) {
  return [...text].map(character => {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x2e80 || code > 0x2fdf) return character;
    return RADICAL_SUPPLEMENT[character] ?? character.normalize("NFKC");
  }).join("");
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextResult> {
  if (bytes.byteLength < 8 || latin1(bytes.subarray(0, 5)) !== "%PDF-") {
    throw invalidPdf("The uploaded file is not a valid PDF.");
  }
  const source = latin1(bytes);
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(source)) {
    throw new AppError("pdf_encrypted", "This PDF is encrypted. Decrypt it before reading its text.", 422);
  }
  const objects = parseObjects(source, bytes);
  if (!objects.size) throw invalidPdf();
  await expandObjectStreams(objects);
  const pages = pageObjects(objects, source);
  if (!pages.length) throw invalidPdf("The PDF has no readable pages.");
  if (pages.length > PDF_PAGE_LIMIT) {
    throw new AppError("pdf_too_complex", `The PDF has more than ${PDF_PAGE_LIMIT} pages.`, 413);
  }

  const fontCache = new Map<number, Promise<FontInfo>>();
  const results: string[] = [];
  let totalCharacters = 0;
  for (const page of pages) {
    const fonts = new Map<string, FontInfo>();
    for (const [name, number] of pageFontRefs(objects, page.resources)) {
      let pending = fontCache.get(number);
      if (!pending) {
        pending = loadFont(objects, number);
        fontCache.set(number, pending);
      }
      fonts.set(name, await pending);
    }
    let raw = "";
    const contents = reference(page.dict, "Contents");
    const streams = contents === null ? references(page.dict, "Contents") : [contents];
    for (const stream of streams) {
      const data = await decodePdfStream(objects.get(stream));
      if (data) raw += `${latin1(data)}\n`;
    }
    const text = repairPdfCjkGlyphs(cleanPage(extractContentText(raw, fonts)));
    totalCharacters += text.length;
    if (totalCharacters > PDF_TEXT_LIMIT) {
      throw new AppError("pdf_text_too_large", "The extracted PDF text exceeds the 2 MiB MCP read limit.", 413);
    }
    results.push(text);
  }
  if (!results.some(text => text.length > 0)) {
    throw new AppError(
      "pdf_no_text_layer",
      "This PDF has no text layer, which usually means it is a scan. OCR is required; no OCR is available here, so the text cannot be fabricated.",
      422,
    );
  }
  return { pages: results, pageCount: results.length };
}

export function slicePdfPages(pages: string[], offset: number, limit: number) {
  const joined = pages.join("\n\n");
  if (offset > joined.length) throw new AppError("invalid_params", "offset is beyond the end of the PDF text.", 400);
  let end = Math.min(joined.length, offset + limit);
  if (end < joined.length && /[\uDC00-\uDFFF]/u.test(joined[end]!)) end--;
  const starts: number[] = [];
  let cursor = 0;
  for (const page of pages) {
    starts.push(cursor);
    cursor += page.length + 2;
  }
  let pageStart = 0;
  let pageEnd = 0;
  for (let index = 0; index < starts.length; index++) {
    if (starts[index]! <= offset) pageStart = index;
    if (starts[index]! < end) pageEnd = index;
  }
  return {
    text: joined.slice(offset, end),
    nextOffset: end < joined.length ? end : null,
    totalCharacters: joined.length,
    pageStart: pageStart + 1,
    pageEnd: Math.max(pageStart, pageEnd) + 1,
    pageCount: pages.length,
  };
}
