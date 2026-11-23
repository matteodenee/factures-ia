import "dotenv/config";

import {
  ListObjectsV2Command,
  GetObjectCommand,
  type _Object
} from "@aws-sdk/client-s3";

import {
  mkdir,
  readFile,
  writeFile,
  rename
} from "node:fs/promises";

import { join } from "node:path";
import { createHash } from "node:crypto";

import { s3Client, bucketName } from "../config/s3.js";

interface ManifestEntry {
  s3Key: string;
  etag: string | null;
  sha256: string;
  localPath: string;
  downloadedAt: string;
}

type Manifest = Record<string, ManifestEntry>;

const DATA_DIR = process.env.DATA_DIR || "./data";
const RAW_DIR = join(DATA_DIR, "raw");
const MANIFEST_PATH = join(DATA_DIR, "manifest.json");

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function getLocalName(s3Key: string): string {
  const keyHash = createHash("sha256")
    .update(s3Key)
    .digest("hex")
    .slice(0, 16);

  const basename = s3Key.split("/").pop() || "facture.pdf";
  const safeName = basename.replace(/[^a-zA-Z0-9._-]/g, "_");

  return `${keyHash}_${safeName}`;
}

async function listPDFs(): Promise<_Object[]> {
  const objects: _Object[] = [];
  let token: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: token
      })
    );

    objects.push(
      ...(response.Contents ?? []).filter(
        object => object.Key?.toLowerCase().endsWith(".pdf")
      )
    );

    token = response.NextContinuationToken;
  } while (token);

  return objects.sort((a, b) =>
    (a.Key ?? "").localeCompare(b.Key ?? "")
  );
}

async function loadManifest(): Promise<Manifest> {
  try {
    const content = await readFile(MANIFEST_PATH, "utf8");
    return JSON.parse(content) as Manifest;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

async function saveManifest(manifest: Manifest): Promise<void> {
  const tempPath = `${MANIFEST_PATH}.tmp`;

  await writeFile(
    tempPath,
    JSON.stringify(manifest, null, 2)
  );

  await rename(tempPath, MANIFEST_PATH);
}

async function main(): Promise<void> {
  console.log("=== INGESTION DES FACTURES ===\n");

  await mkdir(RAW_DIR, { recursive: true });

  const manifest = await loadManifest();
  const allPDFs = await listPDFs();

  // Par défaut : 10 factures.
  // Avec --all : toutes les factures.
  const downloadAll = process.argv.includes("--all");
  const selected = downloadAll ? allPDFs : allPDFs.slice(0, 10);

  console.log(`Factures disponibles : ${allPDFs.length}`);
  console.log(`Factures sélectionnées : ${selected.length}\n`);

  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  for (const object of selected) {
    const key = object.Key!;

    const localPath = join(RAW_DIR, getLocalName(key));
    const existing = manifest[key];

    try {
      if (existing && existing.etag === (object.ETag ?? null)) {
        try {
          const existingBytes = await readFile(localPath);

          if (hash(existingBytes) === existing.sha256) {
            console.log(`[SKIP] ${key}`);
            skipped++;
            continue;
          }
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
      }

      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key
        })
      );

      if (!response.Body) {
        throw new Error("Réponse S3 sans contenu");
      }

      const bytes = await response.Body.transformToByteArray();
      const buffer = Buffer.from(bytes);

      if (buffer.subarray(0, 5).toString() !== "%PDF-") {
        throw new Error("Le fichier téléchargé n'est pas un PDF valide");
      }

      const checksum = hash(buffer);
      const tempPath = `${localPath}.tmp`;

      await writeFile(tempPath, buffer);
      await rename(tempPath, localPath);

      manifest[key] = {
        s3Key: key,
        etag: object.ETag ?? null,
        sha256: checksum,
        localPath,
        downloadedAt: new Date().toISOString()
      };

      await saveManifest(manifest);

      console.log(`[OK] ${key}`);
      downloaded++;
    } catch (error) {
      console.error(
        `[ERREUR] ${key}:`,
        error instanceof Error ? error.message : String(error)
      );
      errors++;
    }
  }

  console.log("\n=== BILAN ===");
  console.log(`Téléchargées : ${downloaded}`);
  console.log(`Déjà présentes : ${skipped}`);
  console.log(`Erreurs : ${errors}`);
  console.log(`Total : ${selected.length}`);

  if (errors > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error("Erreur fatale :", error);
  process.exitCode = 1;
});
