import * as fs from 'fs';
import {
  Document, Packer, Paragraph, ImageRun, TextRun,
  PageOrientation, AlignmentType, HeadingLevel,
} from 'docx';

// Usable page area for A4 landscape with 1" margins, expressed in pixels at
// the 96 DPI that docx assumes when converting image dimensions.
const PAGE_W_PX = 930;
const PAGE_H_PX = 590;

export interface WordScreenshot {
  path: string;
  width: number;   // native pixel width
  height: number;  // native pixel height
}

// Scales an image down to fit the printable area while preserving aspect ratio.
// Never upscales — a small screenshot stays its natural size.
function fitToPage(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: PAGE_W_PX, height: PAGE_H_PX };
  const ratio = Math.min(PAGE_W_PX / width, PAGE_H_PX / height, 1);
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

// Builds a .docx where every screenshot gets its own page, captioned with its
// step number. The document is titled with the test case.
export async function exportScreenshotsToWord(
  screenshots: WordScreenshot[],
  outputPath: string,
  testCaseTitle: string
): Promise<void> {
  if (screenshots.length === 0) throw new Error('No screenshots to export');

  const children: Paragraph[] = [];

  screenshots.forEach((shot, i) => {
    const size = fitToPage(shot.width, shot.height);
    // Caption identifying the step; the first page also carries the title.
    // Every caption after the first starts a new page, so each screenshot
    // occupies a page of its own.
    children.push(
      new Paragraph({
        heading: i === 0 ? HeadingLevel.HEADING_1 : undefined,
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        pageBreakBefore: i > 0,
        children: [
          new TextRun({
            text: i === 0 ? testCaseTitle : `Step ${i + 1}`,
            bold: true,
          }),
        ],
      })
    );
    const isJpeg = /\.jpe?g$/i.test(shot.path);
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            type: isJpeg ? 'jpg' : 'png',
            data: fs.readFileSync(shot.path),
            transformation: { width: size.width, height: size.height },
          }),
        ],
      })
    );
  });

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
          },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}
