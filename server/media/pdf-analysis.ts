import { PDFParse } from "pdf-parse";

export interface PdfAnalysisOptions {
  maxPages?: number;
  maxTextCharacters?: number;
  rasterizeWhenTextBelow?: number;
  maxRasterizedPages?: number;
}

export interface PdfPageImage {
  pageNumber: number;
  width: number;
  height: number;
  png: Buffer;
}

export interface PdfAnalysisResult {
  text: string;
  textTruncated: boolean;
  totalPages: number;
  parsedPages: number;
  rasterizedPages: PdfPageImage[];
}

/**
 * Extracts bounded text and, for scan-like documents, a few page images for
 * the vision-capable support agent. Nothing is uploaded by this function.
 */
export async function analysePdf(
  bytes: Uint8Array,
  options: PdfAnalysisOptions = {},
): Promise<PdfAnalysisResult> {
  const maxPages = options.maxPages ?? 40;
  const maxTextCharacters = options.maxTextCharacters ?? 120_000;
  const rasterizeWhenTextBelow = options.rasterizeWhenTextBelow ?? 80;
  const maxRasterizedPages = options.maxRasterizedPages ?? 3;
  const parser = new PDFParse({ data: new Uint8Array(bytes) });

  try {
    const result = await parser.getText({ first: maxPages });
    const normalizedText = result.text.replace(/\u0000/g, "").trim();
    const textTruncated = normalizedText.length > maxTextCharacters;
    const text = textTruncated
      ? `${normalizedText.slice(0, maxTextCharacters)}\n\n[texto truncado]`
      : normalizedText;
    const parsedPages = Math.min(result.total, maxPages);
    const rasterizedPages: PdfPageImage[] = [];

    if (normalizedText.length < rasterizeWhenTextBelow && result.total > 0) {
      const screenshots = await parser.getScreenshot({
        first: Math.min(result.total, maxRasterizedPages),
        scale: 1.25,
        imageBuffer: true,
        imageDataUrl: false,
      });

      for (const page of screenshots.pages) {
        rasterizedPages.push({
          pageNumber: page.pageNumber,
          width: page.width,
          height: page.height,
          png: Buffer.from(page.data),
        });
      }
    }

    return {
      text,
      textTruncated,
      totalPages: result.total,
      parsedPages,
      rasterizedPages,
    };
  } finally {
    await parser.destroy();
  }
}
