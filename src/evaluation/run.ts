import "dotenv/config";

import {
  readFile,
  writeFile,
  mkdir,
  access
} from "node:fs/promises";

import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { recognizeImage } from "../ocr/client.js";
import {
  parseInvoice,
  type BronzeDocument
} from "../silver/parser.js";

const execFileAsync = promisify(execFile);

const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const EVAL_DIR = join(DATA_DIR, "evaluation");
const RAW_DIR = join(DATA_DIR, "raw");

const RESOLUTIONS = [1024, 1540] as const;

const FIELDS = [
  "invoiceNumber",
  "supplier",
  "client",
  "issueDate",
  "dueDate",
  "status",
  "totalHtCents",
  "totalVatCents",
  "totalTtcCents"
] as const;

type Field = typeof FIELDS[number];
type Reference = Record<Field, string | number> & {
  filename: string;
  sha256: string;
  verified: boolean;
  verificationMethod: string;
};

interface EvaluationResult {
  filename: string;
  sha256: string;
  resolution: number;
  model: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  extracted: Record<Field, string | number | null>;
  text: string;
}

function hash(content: Buffer): string {
  return createHash("sha256")
    .update(content)
    .digest("hex");
}

function normalize(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number") {
    return String(value);
  }

  return String(value)
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("fr");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
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

async function createImage(
  pdfPath: string,
  sha256: string,
  resolution: number
): Promise<string> {
  const imageDir = join(EVAL_DIR, "images");
  await mkdir(imageDir, { recursive: true });

  const prefix = join(
    imageDir,
    `${sha256}_${resolution}`
  );

  const output = `${prefix}.png`;

  if (await exists(output)) {
    return output;
  }

  await execFileAsync(
    "pdftoppm",
    [
      "-f", "1",
      "-l", "1",
      "-scale-to", String(resolution),
      "-png",
      "-singlefile",
      pdfPath,
      prefix
    ],
    { timeout: 120000 }
  );

  return output;
}

function extractFields(
  text: string,
  reference: Reference
): Record<Field, string | number | null> {
  const document: BronzeDocument = {
    documentId: reference.sha256,
    filename: reference.filename,
    documentType: "IMAGE",
    extractedText: text,
    pages: [{
      extractionMethod: "OCR",
      text
    }]
  };

  const invoice = parseInvoice(document);

  return {
    invoiceNumber: invoice.invoiceNumber,
    supplier: invoice.supplier,
    client: invoice.client,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    status: invoice.status,
    totalHtCents: invoice.totalHtCents,
    totalVatCents: invoice.totalVatCents,
    totalTtcCents: invoice.totalTtcCents
  };
}

async function evaluateOne(
  reference: Reference,
  resolution: number
): Promise<EvaluationResult> {
  const model = process.env.OCR_MODEL || "lightonocr-3-1b-test";

  const resultsDir = join(EVAL_DIR, "results");
  await mkdir(resultsDir, { recursive: true });

  const safeModel = model.replace(
    /[^a-zA-Z0-9_-]/g,
    "_"
  );

  const resultPath = join(
    resultsDir,
    `${reference.sha256}_${resolution}_${safeModel}.json`
  );

  if (await exists(resultPath)) {
    const cached = JSON.parse(
      await readFile(resultPath, "utf8")
    ) as EvaluationResult;

    if (
      cached.sha256 !== reference.sha256 ||
      cached.resolution !== resolution ||
      cached.model !== model ||
      !cached.text?.trim() ||
      !cached.extracted
    ) {
      throw new Error("Cache d'évaluation invalide");
    }

    console.log(
      `[CACHE] ${reference.filename} - ${resolution}px`
    );

    return cached;
  }

  const pdfPath = join(RAW_DIR, reference.filename);
  const content = await readFile(pdfPath);

  if (hash(content) !== reference.sha256) {
    throw new Error(
      `Empreinte SHA-256 incorrecte : ${reference.filename}`
    );
  }

  const imagePath = await createImage(
    pdfPath,
    reference.sha256,
    resolution
  );

  console.log(
    `[OCR] ${reference.filename} - ${resolution}px`
  );

  const response = await recognizeImage(imagePath);

  const result: EvaluationResult = {
    filename: reference.filename,
    sha256: reference.sha256,
    resolution,
    model: response.model,
    durationMs: response.durationMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    extracted: extractFields(response.text, reference),
    text: response.text
  };

  await writeFile(
    resultPath,
    JSON.stringify(result, null, 2),
    { encoding: "utf8", flag: "wx" }
  );

  return result;
}

async function main(): Promise<void> {
  console.log("================================");
  console.log(" EVALUATION LIGHTONOCR-3");
  console.log("================================");

  const references = JSON.parse(
    await readFile(
      join(EVAL_DIR, "ground-truth.json"),
      "utf8"
    )
  ) as Reference[];

  if (references.length !== 5) {
    throw new Error("Cinq factures sont attendues");
  }

  const unique = new Set(references.map(r => r.sha256));

  if (unique.size !== references.length) {
    throw new Error("Doublons dans la vérité terrain");
  }

  for (const reference of references) {
    if (
      reference.verified !== true ||
      reference.verificationMethod !== "manual_pdf_review"
    ) {
      throw new Error(
        `Référence non vérifiée : ${reference.filename}`
      );
    }

    for (const field of FIELDS) {
      const value = reference[field];

      if (
        value === null ||
        value === undefined ||
        value === ""
      ) {
        throw new Error(
          `Champ manquant : ${reference.filename} / ${field}`
        );
      }

      if (
        field.endsWith("Cents") &&
        (!Number.isSafeInteger(value) || Number(value) < 0)
      ) {
        throw new Error(
          `Montant de référence invalide : ${reference.filename}`
        );
      }
    }
  }

  const results: EvaluationResult[] = [];
  const failures: Array<{
    filename: string;
    resolution: number;
    error: string;
  }> = [];

  for (const resolution of RESOLUTIONS) {
    console.log(`\n[CONFIG] ${resolution}px`);

    for (const reference of references) {
      try {
        const result = await evaluateOne(
          reference,
          resolution
        );

        results.push(result);

        console.log(
          `[OK] ${result.durationMs} ms`
        );
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error);

        console.error(
          `[ERROR] ${reference.filename}: ${message}`
        );

        failures.push({
          filename: reference.filename,
          resolution,
          error: message
        });
      }
    }
  }

  const report = RESOLUTIONS.map(resolution => {
    const group = results.filter(
      result => result.resolution === resolution
    );

    const fields = FIELDS.map(field => {
      let correct = 0;

      for (const result of group) {
        const reference = references.find(
          r => r.sha256 === result.sha256
        )!;

        if (
          normalize(result.extracted[field]) ===
          normalize(reference[field])
        ) {
          correct++;
        }
      }

      return {
        field,
        correct,
        total: references.length,
        accuracyPercent: Number(
          (100 * correct / references.length).toFixed(2)
        )
      };
    });

    const totalCorrect = fields.reduce(
      (sum, item) => sum + item.correct,
      0
    );

    const durations = group.map(r => r.durationMs);

    return {
      resolution,
      documentsExpected: references.length,
      documentsProcessed: group.length,
      accuracyPercent: Number(
        (
          100 * totalCorrect /
          (references.length * FIELDS.length)
        ).toFixed(2)
      ),
      averageDurationMs: durations.length
        ? Math.round(
            durations.reduce((a, b) => a + b, 0) /
            durations.length
          )
        : null,
      totalInputTokens: group.reduce(
        (sum, r) => sum + (r.inputTokens ?? 0),
        0
      ),
      totalOutputTokens: group.reduce(
        (sum, r) => sum + (r.outputTokens ?? 0),
        0
      ),
      fields
    };
  });

  const output = {
    evaluatedAt: new Date().toISOString(),
    model: process.env.OCR_MODEL || "lightonocr-3-1b-test",
    referenceDocuments: references.length,
    comparisonMethod: "exact_match_normalized",
    totalRequestsExpected: references.length * RESOLUTIONS.length,
    successfulRequests: results.length,
    failures,
    report
  };

  await writeFile(
    join(EVAL_DIR, "report.json"),
    JSON.stringify(output, null, 2)
  );

  console.log("\n================================");
  console.log(" RESULTATS COMPARATIFS");
  console.log("================================");

  for (const item of report) {
    console.log(`\nRésolution : ${item.resolution}px`);
    console.log(
      `Documents : ${item.documentsProcessed}/${item.documentsExpected}`
    );
    console.log(
      `Précision globale : ${item.accuracyPercent}%`
    );
    console.log(
      `Durée moyenne : ${item.averageDurationMs ?? "N/A"} ms`
    );

    for (const field of item.fields) {
      console.log(
        `  ${field.field}: ${field.correct}/${field.total} ` +
        `(${field.accuracyPercent}%)`
      );
    }
  }

  console.log(`\nErreurs API : ${failures.length}`);
  console.log("[OUTPUT] data/evaluation/report.json");

  if (failures.length > 0) {
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
