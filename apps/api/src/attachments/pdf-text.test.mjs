import { describe, expect, test } from "bun:test";
import { AppError } from "../common/app-error.ts";
import { extractPdfText, repairPdfCjkGlyphs, slicePdfPages } from "./pdf-text.ts";

const bytes = (value) => new TextEncoder().encode(value);

const stream = (content) => `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;

function buildPdf({ pages, encrypted = false }) {
  const objects = [];
  const add = (value) => {
    objects.push(value);
    return objects.length;
  };
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pageNumbers = [];
  const pageBodies = pages.map((content) => ({ content }));
  const pagesObjectIndex = objects.length + 1;
  add(""); // placeholder for the Pages node
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  for (const page of pageBodies) {
    const contentNumber = objects.length + 2;
    const pageNumber = add(`<< /Type /Page /Parent ${pagesObjectIndex} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentNumber} 0 R >>`);
    const contentNumberActual = add(stream(page.content));
    if (contentNumberActual !== contentNumber) throw new Error("Unexpected content object number");
    pageNumbers.push(pageNumber);
  }
  objects[pagesObjectIndex - 1] = `<< /Type /Pages /Kids [${pageNumbers.map(number => `${number} 0 R`).join(" ")}] /Count ${pageNumbers.length} >>`;
  if (encrypted) add("<< /Filter /Standard /V 1 /R 2 >>");
  const encrypt = encrypted ? ` /Encrypt ${objects.length} 0 R` : "";
  return `%PDF-1.4\n${objects.map((value, index) => `${index + 1} 0 obj\n${value}\nendobj\n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encrypt} >>\nstartxref\n0\n%%EOF\n`;
}

function buildCidPdf() {
  const cmap = `/CIDInit /ProcSet findresource begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0001> <4E2D>
<0002> <6587>
endbfchar
endcmap`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /TestCid /Encoding /Identity-H /ToUnicode 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    stream("BT /F1 12 Tf 72 720 Td <00010002> Tj ET"),
    stream(cmap),
  ];
  return `%PDF-1.4\n${objects.map((value, index) => `${index + 1} 0 obj\n${value}\nendobj\n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`;
}

describe("PDF text extraction", () => {
  test("extracts one page of text with page numbering", async () => {
    const result = await extractPdfText(bytes(buildPdf({ pages: ["BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET"] })));
    expect(result.pageCount).toBe(1);
    expect(result.pages).toEqual(["Hello PDF"]);
  });

  test("keeps page boundaries and line breaks for multi-page text", async () => {
    const result = await extractPdfText(bytes(buildPdf({
      pages: [
        "BT /F1 12 Tf 72 720 Td (First page) Tj ET",
        "BT /F1 12 Tf 72 720 Td (Second page) Tj 0 -18 Td (Line two) Tj ET",
      ],
    })));
    expect(result.pageCount).toBe(2);
    expect(result.pages[0]).toBe("First page");
    expect(result.pages[1]).toContain("Second page");
    expect(result.pages[1]).toContain("Line two");
    expect(result.pages[1].indexOf("Second page")).toBeLessThan(result.pages[1].indexOf("Line two"));
  });

  test("decodes Type0 text through its ToUnicode CMap", async () => {
    const result = await extractPdfText(bytes(buildCidPdf()));
    expect(result.pages[0]).toBe("中文");
  });

  test("reports scanned PDFs without a text layer instead of faking text", async () => {
    const pdf = buildPdf({ pages: ["q 1 0 0 1 0 0 cm Q"] });
    await expect(extractPdfText(bytes(pdf))).rejects.toMatchObject({ code: "pdf_no_text_layer" });
  });

  test("rejects encrypted and damaged PDFs explicitly", async () => {
    await expect(extractPdfText(bytes(buildPdf({ pages: ["BT /F1 12 Tf 72 720 Td (Secret) Tj ET"], encrypted: true }))))
      .rejects.toMatchObject({ code: "pdf_encrypted" });
    await expect(extractPdfText(bytes("not a pdf"))).rejects.toMatchObject({ code: "attachment_invalid_pdf" });
    await expect(extractPdfText(bytes("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n"))).rejects.toBeInstanceOf(AppError);
  });

  test("repairs CJK radical code points without touching Chinese punctuation", () => {
    expect(repairPdfCjkGlyphs("第⼆⻚中⽂，继续阅读。")).toBe("第二页中文，继续阅读。");
    expect(repairPdfCjkGlyphs("⻓⻔⻢⻉⻅")).toBe("长门马贝见");
  });

  test("paginates by characters and reports the page range and next offset", () => {
    const pages = ["ABCDE", "FGHIJ"];
    const first = slicePdfPages(pages, 0, 7);
    expect(first.text).toBe("ABCDE\n\n");
    expect(first.pageStart).toBe(1);
    expect(first.pageEnd).toBe(1);
    expect(first.nextOffset).toBe(7);
    const second = slicePdfPages(pages, first.nextOffset, 5);
    expect(second.text).toBe("FGHIJ");
    expect(second.pageStart).toBe(2);
    expect(second.pageEnd).toBe(2);
    expect(second.nextOffset).toBeNull();
    let failure;
    try {
      slicePdfPages(pages, 100, 5);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
  });
});
