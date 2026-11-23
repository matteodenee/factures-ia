import "dotenv/config";

import {
  readFile,
  writeFile,
  mkdir,
  access
} from "node:fs/promises";

import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { recognizeImage } from "./client.js";

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.DATA_DIR || "./data";

interface PageAnalysis {
  pageNumber: number;
  type: "TEXT" | "IMAGE";
}

interface PDFAnalysis {
  filename: string;
  sha256: string;
  type: "TEXT" | "IMAGE" | "MIXED" | "ERROR";
  pageCount: number;
  pages: PageAnalysis[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function convertPageToPNG(
  pdfPath: string,
  pageNumber: number,
  outputPrefix: string
): Promise<string> {

  console.log(
    `[CONVERT] PDF vers PNG, page ${pageNumber}`
  );

  // La dimension maximale est limitée à 1540 pixels.
  // Poppler conserve automatiquement les proportions.
  await execFileAsync("pdftoppm", [
    "-f", String(pageNumber),
    "-l", String(pageNumber),
    "-scale-to", "1540",
    "-png",
    "-singlefile",
    pdfPath,
    outputPrefix
  ], {
    timeout: 120000
  });

  return `${outputPrefix}.png`;
}

async function main(): Promise<void> {

  console.log("================================");
  console.log(" TEST LIGHTONOCR-3");
  console.log("================================\n");

  const analysisPath = join(
    DATA_DIR,
    "analysis",
    "pdf-analysis.json"
  );

  const analysis = JSON.parse(
    await readFile(analysisPath, "utf8")
  ) as PDFAnalysis[];

  const scannedPDF = analysis.find(
    pdf => pdf.pages.some(
      page => page.type === "IMAGE"
    )
  );

  if (!scannedPDF) {
    throw new Error(
      "Aucune facture nécessitant un OCR"
    );
  }

  const page = scannedPDF.pages.find(
    page => page.type === "IMAGE"
  );

  if (!page) {
    throw new Error("Page scannée introuvable");
  }

  console.log(`Facture : ${scannedPDF.filename}`);
  console.log(`SHA-256 : ${scannedPDF.sha256}`);
  console.log(`Page : ${page.pageNumber}\n`);

  const pdfPath = join(
    DATA_DIR,
    "raw",
    scannedPDF.filename
  );

  const imagesDir = join(DATA_DIR, "ocr", "images");
  const resultsDir = join(DATA_DIR, "ocr", "results");

  await mkdir(imagesDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });

  const resultPath = join(
    resultsDir,
    `${scannedPDF.sha256}_page_${page.pageNumber}.json`
  );

  if (await exists(resultPath)) {
    const cached = JSON.parse(
      await readFile(resultPath, "utf8")
    );

    if (
      typeof cached.text !== "string" ||
      !cached.text.trim() ||
      cached.sourceSha256 !== scannedPDF.sha256 ||
      cached.pageNumber !== page.pageNumber ||
      cached.model !== process.env.OCR_MODEL
    ) {
      throw new Error(
        "Cache OCR existant invalide : vérification nécessaire"
      );
    }

    console.log("[CACHE] OCR déjà effectué");
    console.log("[CACHE] Aucun appel API nécessaire\n");

    console.log("=== TEXTE EXTRAIT ===\n");
    console.log(cached.text);

    return;
  }

  const outputPrefix = join(
    imagesDir,
    `${scannedPDF.sha256}_page_${page.pageNumber}`
  );

  const imagePath = await convertPageToPNG(
    pdfPath,
    page.pageNumber,
    outputPrefix
  );

  console.log(`[CONVERT] Image créée : ${imagePath}\n`);

  const result = await recognizeImage(imagePath);

  console.log("\n=== RESULTAT OCR ===");

  console.log(`Durée : ${result.durationMs} ms`);
  console.log(`Tokens entrée : ${result.inputTokens ?? "N/A"}`);
  console.log(`Tokens sortie : ${result.outputTokens ?? "N/A"}`);

  console.log("\n=== TEXTE EXTRAIT ===\n");
  console.log(result.text);

  const output = {
    sourceFile: scannedPDF.filename,
    sourceSha256: scannedPDF.sha256,
    pageNumber: page.pageNumber,
    imagePath,
    model: result.model,
    text: result.text,
    durationMs: result.durationMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    processedAt: new Date().toISOString()
  };

  await writeFile(
    resultPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log("\n=== ENREGISTREMENT ===");
  console.log(`[OK] ${resultPath}`);
}

main().catch(error => {
  console.error(
    "[ERROR]",
    error instanceof Error ? error.message : String(error)
  );

  process.exitCode = 1;
});
