import "dotenv/config";

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

type PageType = "TEXT" | "IMAGE";

type DocumentType = "TEXT" | "IMAGE" | "MIXED" | "ERROR";

interface PageAnalysis {
  pageNumber: number;
  type: PageType;
  characters: number;
  words: number;
  text: string;
}

interface PDFAnalysis {
  filename: string;
  sha256: string;
  type: DocumentType;
  pageCount: number;
  pages: PageAnalysis[];
  analyzedAt: string;
  error?: string;
}

const DATA_DIR = process.env.DATA_DIR || "./data";
const RAW_DIR = join(DATA_DIR, "raw");
const OUTPUT_DIR = join(DATA_DIR, "analysis");

function calculateHash(buffer: Buffer): string {
  return createHash("sha256")
    .update(buffer)
    .digest("hex");
}

function classifyPage(text: string): PageType {
  const normalized = text.replace(/\s+/g, " ").trim();

  const characters = normalized.length;
  const words = normalized.split(/\s+/).filter(Boolean).length;

  // Seuil heuristique : une page contenant suffisamment
  // de texte est considérée comme exploitable.
  if (characters >= 40 && words >= 5) {
    return "TEXT";
  }

  return "IMAGE";
}

async function analyzePDF(
  filename: string
): Promise<PDFAnalysis> {

  const filePath = join(RAW_DIR, filename);
  const buffer = await readFile(filePath);

  const sha256 = calculateHash(buffer);

  const result: PDFAnalysis = {
    filename,
    sha256,
    type: "ERROR",
    pageCount: 0,
    pages: [],
    analyzedAt: new Date().toISOString()
  };

  let loadingTask:
    ReturnType<typeof getDocument> | undefined;

  try {
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      stopAtErrors: true
    });

    const pdf = await loadingTask.promise;

    result.pageCount = pdf.numPages;

    for (
      let pageNumber = 1;
      pageNumber <= pdf.numPages;
      pageNumber++
    ) {
      const page = await pdf.getPage(pageNumber);

      const textContent = await page.getTextContent();

      const text = textContent.items
        .map(item => {
          if ("str" in item) {
            return item.str + (item.hasEOL ? "\n" : " ");
          }

          return "";
        })
        .join("")
        .trim();

      const normalized = text.replace(/\s+/g, " ").trim();

      const characters = normalized.length;
      const words = normalized
        ? normalized.split(/\s+/).length
        : 0;

      const type = classifyPage(text);

      result.pages.push({
        pageNumber,
        type,
        characters,
        words,
        text
      });

      page.cleanup();
    }

    const textPages = result.pages.filter(
      page => page.type === "TEXT"
    ).length;

    if (textPages === result.pageCount) {
      result.type = "TEXT";
    } else if (textPages === 0) {
      result.type = "IMAGE";
    } else {
      result.type = "MIXED";
    }

  } catch (error) {
    result.type = "ERROR";

    result.error = error instanceof Error
      ? error.message
      : String(error);

  } finally {
    if (loadingTask) {
      await loadingTask.destroy();
    }
  }

  return result;
}

async function main(): Promise<void> {

  console.log("================================");
  console.log(" ANALYSE DES FACTURES PDF");
  console.log("================================\n");

  await mkdir(OUTPUT_DIR, { recursive: true });

  const files = (await readdir(RAW_DIR))
    .filter(file => file.toLowerCase().endsWith(".pdf"))
    .sort();

  console.log(`PDF à analyser : ${files.length}\n`);

  const results: PDFAnalysis[] = [];

  for (const filename of files) {
    const result = await analyzePDF(filename);

    results.push(result);

    const icon =
      result.type === "TEXT" ? "✅" :
      result.type === "IMAGE" ? "🖼️" :
      result.type === "MIXED" ? "🔀" :
      "❌";

    console.log(
      `${icon} [${result.type}] ${filename}`
    );

    console.log(
      `   Pages : ${result.pageCount}`
    );

    for (const page of result.pages) {
      console.log(
        `   Page ${page.pageNumber}: ` +
        `${page.characters} caractères, ` +
        `${page.words} mots → ${page.type}`
      );
    }

    if (result.error) {
      console.error(`   Erreur : ${result.error}`);
    }

    console.log("");
  }

  const outputPath = join(
    OUTPUT_DIR,
    "pdf-analysis.json"
  );

  await writeFile(
    outputPath,
    JSON.stringify(results, null, 2),
    "utf8"
  );

  const counts = {
    TEXT: results.filter(r => r.type === "TEXT").length,
    IMAGE: results.filter(r => r.type === "IMAGE").length,
    MIXED: results.filter(r => r.type === "MIXED").length,
    ERROR: results.filter(r => r.type === "ERROR").length
  };

  console.log("================================");
  console.log(" BILAN");
  console.log("================================");

  console.log(`PDF natifs     : ${counts.TEXT}`);
  console.log(`PDF scannés    : ${counts.IMAGE}`);
  console.log(`PDF mixtes     : ${counts.MIXED}`);
  console.log(`Erreurs        : ${counts.ERROR}`);

  console.log(`\nRésultats enregistrés : ${outputPath}`);

  if (counts.ERROR > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error("Erreur fatale :", error);
  process.exitCode = 1;
});
