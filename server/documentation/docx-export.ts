import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LineRuleType,
  Packer,
  Paragraph,
  TextRun,
  type FileChild,
} from "docx";

import type { DocumentationDraftDto } from "../../shared/contracts.js";

const NUMBERING_REFERENCE = "threadmark-documentation-steps";

export interface DocumentationDocxImage {
  data: Uint8Array;
  type: "jpg" | "png" | "gif" | "bmp";
  caption: string;
  afterHeading: string | null;
  fileName: string | null;
}

export function documentationDocxFileName(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `${slug || "documentacao"}.docx`;
}

export async function buildDocumentationDocx(
  draft: DocumentationDraftDto,
  images: DocumentationDocxImage[] = [],
): Promise<Uint8Array> {
  const pendingImages = new Set(images);
  const body = markdownChildren(draft.bodyMarkdown, pendingImages);
  const remainingImages = [...pendingImages];
  const children: FileChild[] = [
    new Paragraph({
      children: [new TextRun({ text: draft.title || draft.ticketTitle, bold: true, size: 40, color: "1F2937" })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({ text: draft.summary, color: "5F6B7A", italics: true })],
      spacing: { after: 160, line: 300, lineRule: LineRuleType.AUTO },
    }),
  ];

  if (draft.audience.trim()) {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: "Público: ", bold: true }),
        new TextRun(draft.audience.trim()),
      ],
      spacing: { after: 160 },
    }));
  }

  if (draft.prerequisites.some((item) => item.trim())) {
    children.push(heading("Pré-requisitos", HeadingLevel.HEADING_1));
    for (const prerequisite of draft.prerequisites.map((item) => item.trim()).filter(Boolean)) {
      children.push(new Paragraph({
        children: inlineRuns(prerequisite),
        bullet: { level: 0 },
        spacing: { after: 80, line: 300, lineRule: LineRuleType.AUTO },
      }));
    }
  }

  children.push(...body);
  if (remainingImages.length) {
    children.push(heading("Imagens", HeadingLevel.HEADING_1));
    for (const image of remainingImages) children.push(...imageChildren(image));
  }

  const document = new Document({
    creator: "Threadmark",
    lastModifiedBy: "Threadmark",
    title: draft.title || draft.ticketTitle,
    subject: draft.summary,
    description: "Documentação revisada e exportada localmente pelo Threadmark.",
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22, color: "1F2937" },
          paragraph: { spacing: { after: 120, line: 300, lineRule: LineRuleType.AUTO } },
        },
        heading1: {
          run: { font: "Calibri", size: 32, bold: true, color: "2E5AAC" },
          paragraph: { spacing: { before: 360, after: 200 }, keepNext: true },
        },
        heading2: {
          run: { font: "Calibri", size: 26, bold: true, color: "2E5AAC" },
          paragraph: { spacing: { before: 280, after: 140 }, keepNext: true },
        },
        heading3: {
          run: { font: "Calibri", size: 24, bold: true, color: "1F4D78" },
          paragraph: { spacing: { before: 200, after: 100 }, keepNext: true },
        },
      },
    },
    numbering: {
      config: [{
        reference: NUMBERING_REFERENCE,
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: 720, hanging: 360 },
              spacing: { after: 80, line: 300, lineRule: LineRuleType.AUTO },
            },
          },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children,
    }],
  });

  return new Uint8Array(await Packer.toBuffer(document));
}

function markdownChildren(
  markdown: string,
  pendingImages: Set<DocumentationDocxImage>,
): FileChild[] {
  const children: FileChild[] = [];
  const paragraphLines: string[] = [];

  const flushParagraph = () => {
    const text = paragraphLines.splice(0).join(" ").trim();
    if (!text) return;
    children.push(new Paragraph({
      children: inlineRuns(text),
      spacing: { after: 120, line: 300, lineRule: LineRuleType.AUTO },
    }));
  };

  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }

    const headingMatch = /^(#{2,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      const headingText = headingMatch[2]!.trim();
      const level = headingMatch[1]!.length === 2
        ? HeadingLevel.HEADING_1
        : headingMatch[1]!.length === 3
          ? HeadingLevel.HEADING_2
          : HeadingLevel.HEADING_3;
      children.push(heading(headingText, level));
      appendHeadingImages(children, pendingImages, headingText);
      continue;
    }

    const numberedMatch = /^\d+[.)]\s+(.+)$/.exec(line);
    if (numberedMatch) {
      flushParagraph();
      children.push(new Paragraph({
        children: inlineRuns(numberedMatch[1]!),
        numbering: { reference: NUMBERING_REFERENCE, level: 0 },
      }));
      continue;
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(line);
    if (bulletMatch) {
      flushParagraph();
      children.push(new Paragraph({
        children: inlineRuns(bulletMatch[1]!),
        bullet: { level: 0 },
        spacing: { after: 80, line: 300, lineRule: LineRuleType.AUTO },
      }));
      continue;
    }

    paragraphLines.push(line.replace(/^>\s?/, ""));
  }

  flushParagraph();
  return children;
}

function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**")) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true }));
    } else if (part.startsWith("`") && part.endsWith("`")) {
      runs.push(new TextRun({ text: part.slice(1, -1), font: "Consolas", color: "374151" }));
    } else {
      runs.push(new TextRun(part));
    }
  }
  return runs.length ? runs : [new TextRun("")];
}

function heading(
  text: string,
  level: (typeof HeadingLevel)[keyof typeof HeadingLevel],
): Paragraph {
  return new Paragraph({ text, heading: level });
}

function appendHeadingImages(
  children: FileChild[],
  pendingImages: Set<DocumentationDocxImage>,
  headingText: string,
): void {
  const normalizedHeading = normalizeHeading(headingText);
  for (const image of [...pendingImages]) {
    if (!image.afterHeading || normalizeHeading(image.afterHeading) !== normalizedHeading) continue;
    children.push(...imageChildren(image));
    pendingImages.delete(image);
  }
}

function imageChildren(image: DocumentationDocxImage): FileChild[] {
  const caption = image.caption.trim() || image.fileName?.trim() || "Imagem da documentação";
  return [
    new Paragraph({
      children: [new ImageRun({
        type: image.type,
        data: image.data,
        transformation: { width: 560, height: 315 },
        altText: { name: caption, title: caption, description: caption },
      })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 80 },
    }),
    new Paragraph({
      children: [new TextRun({ text: caption, italics: true, color: "667085", size: 20 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
    }),
  ];
}

function normalizeHeading(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR");
}
