import "dotenv/config";

function main(): void {
  console.log("==================================");
  console.log(" PROJET FACTURES IA - DaMS 5");
  console.log("==================================");

  console.log("Node.js :", process.version);
  console.log("Environnement :", process.env.NODE_ENV ?? "development");

  const requiredVariables = [
    "S3_ENDPOINT",
    "S3_BUCKET",
    "DATA_DIR"
  ];

  for (const variable of requiredVariables) {
    const value = process.env[variable];

    if (!value) {
      console.error(`Configuration manquante : ${variable}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Configuration ${variable} : OK`);
  }

  console.log("\nInitialisation réussie !");
}

main();
