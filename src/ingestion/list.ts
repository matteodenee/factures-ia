import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { s3Client, bucketName } from "../config/s3.js";

async function listInvoices(): Promise<void> {
  console.log("Connexion à Hyperfluid...");
  console.log("Bucket :", bucketName);

  const invoices: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken
      })
    );

    for (const object of response.Contents ?? []) {
      if (object.Key?.toLowerCase().endsWith(".pdf")) {
        invoices.push(object.Key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  invoices.sort();

  console.log("\n===========================");
  console.log("FACTURES DISPONIBLES");
  console.log("===========================");

  console.log(`Nombre de PDF : ${invoices.length}\n`);

  for (const invoice of invoices) {
    console.log("-", invoice);
  }
}

listInvoices().catch((error: unknown) => {
  console.error(
    "Erreur S3 :",
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
