import "dotenv/config";

import {
  readFile,
  writeFile,
  mkdir,
  rename,
  readdir
} from "node:fs/promises";

import { join } from "node:path";
import { createHash } from "node:crypto";

import { recognizeImage } from "../ocr/client.js";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.DATA_DIR || "./data";

const ANALYSIS_PATH = join(
  DATA_DIR,
  "analysis",
  "pdf-analysis.json"
);

const BRONZE_DIR = join(
  DATA_DIR,
  "bronze",
  "documents"
);

const ERROR_DIR = join(
  DATA_DIR,
  "bronze",
  "errors"
);

const OCR_RESULTS_DIR = join(
  DATA_DIR,
  "ocr",
  "results"
);

const OCR_IMAGES_DIR = join(
  DATA_DIR,
  "ocr",
  "images"
);

const OCR_MODEL =
  process.env.OCR_MODEL || "lightonocr-3-1b-test";

interface PageAnalysis {
  pageNumber: number;
  type: "TEXT" | "IMAGE";
  characters: number;
  words: number;
  text: string;
}

interface PDFAnalysis {
  filename: string;
  sha256: string;
  type: "TEXT" | "IMAGE" | "MIXED" | "ERROR";
  pageCount: number;
  pages: PageAnalysis[];
}

interface BronzePage {
  pageNumber: number;
  extractionMethod: "PDF_TEXT" | "OCR";
  text: string;
  model: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

interface BronzeDocument {
  documentId: string;
  filename: string;
  sha256: string;
  source: string;
  documentType: string;
  pageCount: number;
  status: "SUCCESS";
  pages: BronzePage[];
  extractedText: string;
  ingestedAt: string;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256")
    .update(buffer)
    .digest("hex");
}

async function fileExists(
  path: string
): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

async function convertPage(
  pdfPath: string,
  pageNumber: number,
  sha: string
): Promise<string> {

  await mkdir(OCR_IMAGES_DIR, {
    recursive: true
  });

  const prefix = join(
    OCR_IMAGES_DIR,
    `${sha}_page_${pageNumber}`
  );

  const imagePath = `${prefix}.png`;

  if (await fileExists(imagePath)) {
    return imagePath;
  }

  await execFileAsync("pdftoppm", [
    "-f", String(pageNumber),
    "-l", String(pageNumber),
    "-scale-to", "1540",
    "-png",
    "-singlefile",
    pdfPath,
    prefix
  ], {
    timeout: 120000
  });

  return imagePath;
}

async function extractPage(
  pdf: PDFAnalysis,
  page: PageAnalysis
): Promise<BronzePage> {

  if (page.type === "TEXT") {

    console.log(
      `  [TEXT] Page ${page.pageNumber}`
    );

    if (!page.text.trim()) {
      throw new Error(
        `Texte natif vide : page ${page.pageNumber}`
      );
    }

    return {
      pageNumber: page.pageNumber,
      extractionMethod: "PDF_TEXT",
      text: page.text,
      model: null,
      durationMs: null,
      inputTokens: null,
      outputTokens: null
    };
  }

  const resultPath = join(
    OCR_RESULTS_DIR,
    `${pdf.sha256}_page_${page.pageNumber}.json`
  );

  if (await fileExists(resultPath)) {

    const cached = JSON.parse(
      await readFile(resultPath, "utf8")
    );

    if (
      cached.sourceSha256 !== pdf.sha256 ||
      cached.pageNumber !== page.pageNumber ||
      cached.model !== OCR_MODEL ||
      typeof cached.text !== "string" ||
      !cached.text.trim()
    ) {
      throw new Error(
        `Cache OCR invalide pour la page ${page.pageNumber}`
      );
    }

    console.log(
      `  [OCR CACHE] Page ${page.pageNumber}`
    );

    return {
      pageNumber: page.pageNumber,
      extractionMethod: "OCR",
      text: cached.text,
      model: cached.model,
      durationMs: cached.durationMs ?? null,
      inputTokens: cached.inputTokens ?? null,
      outputTokens: cached.outputTokens ?? null
    };
  }

  console.log(
    `  [OCR API] Page ${page.pageNumber}`
  );

  const pdfPath = join(
    DATA_DIR,
    "raw",
    pdf.filename
  );

  const imagePath = await convertPage(
    pdfPath,
    page.pageNumber,
    pdf.sha256
  );

  const result = await recognizeImage(
    imagePath
  );

  await mkdir(OCR_RESULTS_DIR, {
    recursive: true
  });

  const ocrOutput = {
    sourceFile: pdf.filename,
    sourceSha256: pdf.sha256,
    pageNumber: page.pageNumber,
    imagePath,
    model: result.model,
    text: result.text,
    durationMs: result.durationMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    processedAt: new Date().toISOString()
  };

  const tempPath = `${resultPath}.tmp`;

  await writeFile(
    tempPath,
    JSON.stringify(ocrOutput, null, 2)
  );

  await rename(tempPath, resultPath);

  return {
    pageNumber: page.pageNumber,
    extractionMethod: "OCR",
    text: result.text,
    model: result.model,
    durationMs: result.durationMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens
  };
}

async function processDocument(
  pdf: PDFAnalysis
): Promise<"PROCESSED" | "SKIPPED"> {

  const bronzePath = join(
    BRONZE_DIR,
    `${pdf.sha256}.json`
  );

  if (await fileExists(bronzePath)) {
    console.log(
      `[SKIP] ${pdf.filename}`
    );

    return "SKIPPED";
  }

  console.log(
    `\n[PROCESS] ${pdf.filename}`
  );

  if (pdf.type === "ERROR") {
    throw new Error(
      "Le document présente une erreur d'analyse PDF"
    );
  }

  if (
    pdf.pageCount < 1 ||
    pdf.pages.length !== pdf.pageCount
  ) {
    throw new Error(
      "Analyse PDF incomplète"
    );
  }

  const pdfPath = join(
    DATA_DIR,
    "raw",
    pdf.filename
  );

  const sourceBytes = await readFile(pdfPath);

  if (sha256(sourceBytes) !== pdf.sha256) {
    throw new Error(
      "Empreinte SHA-256 du document incorrecte"
    );
  }

  const pages: BronzePage[] = [];

  for (const page of pdf.pages) {

    const extracted = await extractPage(
      pdf,
      page
    );

    pages.push(extracted);
  }

  const document: BronzeDocument = {
    documentId: pdf.sha256,
    filename: pdf.filename,
    sha256: pdf.sha256,
    source: "hyperfluid-s3",
    documentType: pdf.type,
    pageCount: pdf.pageCount,
    status: "SUCCESS",
    pages,
    extractedText: pages
      .map(page => page.text)
      .join("\n\n"),
    ingestedAt: new Date().toISOString()
  };

  // Écriture exclusive : une donnée Bronze existante
  // ne doit jamais être écrasée silencieusement.
  await writeFile(
    bronzePath,
    JSON.stringify(document, null, 2),
    { encoding: "utf8", flag: "wx" }
  );

  console.log(
    `[SUCCESS] ${pdf.filename}`
  );

  return "PROCESSED";
}

async function main(): Promise<void> {

  console.log("================================");
  console.log(" INGESTION BRONZE");
  console.log("================================");

  await mkdir(BRONZE_DIR, {
    recursive: true
  });

  await mkdir(ERROR_DIR, {
    recursive: true
  });

  const analysis = JSON.parse(
    await readFile(ANALYSIS_PATH, "utf8")
  ) as PDFAnalysis[];

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const pdf of analysis) {

    try {

      const result = await processDocument(
        pdf
      );

      if (result === "PROCESSED") {
        processed++;
      } else {
        skipped++;
      }

    } catch (error) {

      failed++;

      const message = error instanceof Error
        ? error.message
        : String(error);

      console.error(
        `[ERROR] ${pdf.filename}: ${message}`
      );

      const errorRecord = {
        filename: pdf.filename,
        sha256: pdf.sha256,
        error: message,
        failedAt: new Date().toISOString(),
        retryable: true
      };

      await writeFile(
        join(
          ERROR_DIR,
          `${pdf.sha256}.json`
        ),
        JSON.stringify(errorRecord, null, 2)
      );
    }
  }

  const files = await readdir(
    BRONZE_DIR
  );

  const total = files.filter(
    file => file.endsWith(".json")
  ).length;

  console.log("\n================================");
  console.log(" BILAN BRONZE");
  console.log("================================");

  console.log(`Documents analysés : ${analysis.length}`);
  console.log(`Nouveaux documents : ${processed}`);
  console.log(`Déjà traités       : ${skipped}`);
  console.log(`Erreurs            : ${failed}`);
  console.log(`Total Bronze       : ${total}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(
    "[FATAL]",
    error instanceof Error ? error.message : String(error)
  );

  process.exitCode = 1;
});
